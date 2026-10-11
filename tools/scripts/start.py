#!/usr/bin/env python3
"""
Lampas Dedicated Server Launcher
--------------------------------
Cross-platform startup script for Linux (systemd / Docker / bare-metal) and Windows.

Sizes the JVM from the host: usable CPUs and RAM are detected (honoring cgroup v1/v2
limits), the heap is computed from RAM minus OS and non-heap reserves, and GC/JIT thread
counts are left to JDK 25 ergonomics. Baseline runtime is Java 25 (GraalVM for JDK 25).

Usage:
    python3 start.py
    python3 start.py --no-sync
    python3 start.py --memory 3G
    python3 start.py --no-sync --dry-run

Environment overrides:
    JAVA_MEMORY            Heap size (same as --memory), e.g. 4096M or 4G
    LAMPAS_GC              g1 (default) or zgc (same as --gc)
    LAMPAS_RAM             Treat the host as having this much RAM, e.g. 8G
    LAMPAS_CPUS            Treat the host as having this many CPUs (-XX:ActiveProcessorCount)
    LAMPAS_EXTRA_RESERVE   Extra RAM kept off the heap for co-located services, e.g. 512M
    LAMPAS_COMPACT_HEADERS 0 disables -XX:+UseCompactObjectHeaders
"""

import os
import sys
import math
import shutil
import signal
import subprocess
import argparse

# Ensure immediate line-buffering for stdout and stderr (useful when running under systemd)
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))

MiB = 1 << 20
GiB = 1 << 30

# Heap sizing constants (see PROGRESS.md / JVM flag tuning report). Unmeasured judgement
# calls: recalibrate from NMT (-XX:NativeMemoryTracking=summary) on the live host.
OS_RESERVE_CONTAINER = 256 * MiB    # cgroup limit covers only the JVM
OS_RESERVE_SMALL = 512 * MiB        # hosts with <= 4 GiB
OS_RESERVE_DEFAULT = 1 * GiB        # dedicated VM / bare metal
NONHEAP_MIN = 1536 * MiB            # metaspace + code cache + libgraal + Netty + GC structures
NONHEAP_FRACTION = 0.15
MIN_HEAP = 2 * GiB
MAX_HEAP = {"g1": 16 * GiB, "zgc": 24 * GiB}
HEAP_ALIGN = 256 * MiB
G1_LARGE_HEAP = 12 * GiB            # Aikar's >12G profile threshold

CGROUP_UNLIMITED = 1 << 62


def find_java_binary():
    """Locates the preferred Java binary (JAVA_BIN, JAVA_HOME, SDKMAN GraalVM, system Java, etc.)."""
    env_bin = os.getenv("JAVA_BIN")
    if env_bin and os.path.exists(env_bin):
        return env_bin

    java_home = os.getenv("JAVA_HOME")
    if java_home:
        candidate = os.path.join(java_home, "bin", "java.exe" if sys.platform == "win32" else "java")
        if os.path.exists(candidate):
            return candidate

    sdkman_java = os.path.expanduser("~/.sdkman/candidates/java/current/bin/java")
    if os.path.exists(sdkman_java) and os.access(sdkman_java, os.X_OK):
        return sdkman_java

    which_java = shutil.which("java")
    if which_java:
        return which_java

    return "java"


def find_fabric_server_jar():
    """Locates the Lampas-managed Fabric server launcher JAR."""
    managed_jar = os.path.join(SERVER_DIR, ".lampas", "runtime", "fabric-server-launch.jar")
    if os.path.exists(managed_jar):
        return managed_jar
    return None

def find_lampasctl():
    """Locates the lampasctl executable (LAMPASCTL_BIN, co-located binary, PATH, or development Bun source)."""
    env_ctl = os.getenv("LAMPASCTL_BIN")
    if env_ctl and os.path.exists(env_ctl):
        return env_ctl

    # 1. Prefer co-located pinned binary in server directory
    local_exe = os.path.join(SERVER_DIR, "lampasctl.exe" if sys.platform == "win32" else "lampasctl")
    if os.path.exists(local_exe) and (sys.platform == "win32" or os.access(local_exe, os.X_OK)):
        return local_exe

    # 2. System PATH
    which_ctl = shutil.which("lampasctl")
    if which_ctl:
        return which_ctl

    # 3. Development Bun source fallback
    bun_bin = shutil.which("bun")
    source_cli = os.path.join(SERVER_DIR, "..", "lampasctl", "src", "cli.ts")
    if not os.path.exists(source_cli):
        source_cli = os.path.join(SERVER_DIR, "tools", "lampasctl", "src", "cli.ts")
    if bun_bin and os.path.exists(source_cli):
        return [bun_bin, "run", source_cli]

    return None


def run_recovery(lampasctl):
    """Executes lampasctl recover on SERVER_DIR and returns the exit code."""
    recover_cmd = lampasctl if isinstance(lampasctl, list) else [lampasctl]
    if sys.platform == "win32" and isinstance(recover_cmd[0], str) and (recover_cmd[0].lower().endswith(".bat") or recover_cmd[0].lower().endswith(".cmd")):
        recover_cmd = ["cmd.exe", "/c"] + recover_cmd
    recover_cmd.extend(["recover", "--target", SERVER_DIR])
    return subprocess.call(recover_cmd)


# --- Host detection ---------------------------------------------------------------------

def parse_size(value):
    """Parses a JVM-style size (4096M, 4G, 512m, 1073741824) into bytes. Bare numbers are bytes."""
    text = str(value).strip().upper()
    if text.endswith("B"):
        text = text[:-1]
    units = {"K": 1 << 10, "M": MiB, "G": GiB, "T": 1 << 40}
    if text and text[-1] in units:
        return int(float(text[:-1]) * units[text[-1]])
    return int(text)


def format_size(num_bytes):
    """Formats bytes as a JVM size, preferring whole gigabytes."""
    if num_bytes % GiB == 0:
        return f"{num_bytes // GiB}G"
    return f"{num_bytes // MiB}M"


def _read_text(path):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except (OSError, ValueError):
        return None


def _read_int(path):
    text = _read_text(path)
    if text is None or text == "max":
        return None
    try:
        value = int(text)
    except ValueError:
        return None
    if value < 0 or value >= CGROUP_UNLIMITED:
        return None
    return value


def _cgroup_entries(root):
    """Returns [(hierarchy_id, controllers, path)] from /proc/self/cgroup."""
    text = _read_text(os.path.join(root, "proc", "self", "cgroup"))
    entries = []
    if not text:
        return entries
    for line in text.splitlines():
        parts = line.split(":", 2)
        if len(parts) == 3:
            path = parts[2].replace(" (deleted)", "")
            entries.append((parts[0], parts[1].split(","), path))
    return entries


def _walk_up(base, rel):
    """Yields directories from base/rel up to base (inclusive)."""
    rel = rel.strip("/")
    while True:
        yield os.path.join(base, rel) if rel else base
        if not rel:
            return
        rel = rel.rsplit("/", 1)[0] if "/" in rel else ""


def _v1_dirs(root, entries, controller):
    for _, controllers, path in entries:
        if controller in controllers:
            for mount in (",".join(controllers), controller):
                base = os.path.join(root, "sys", "fs", "cgroup", mount)
                if os.path.isdir(base):
                    nested = os.path.join(base, path.strip("/"))
                    return [nested, base] if os.path.isdir(nested) else [base]
    return []


def read_cgroup_limits(root="/"):
    """
    Reads CPU quota (in CPUs, float) and memory limit (bytes) from cgroup v2 or v1.
    Returns (cpu_quota or None, memory_limit or None, version or None).
    """
    entries = _cgroup_entries(root)
    cgroup_base = os.path.join(root, "sys", "fs", "cgroup")
    cpu_quota = None
    mem_limit = None

    if os.path.exists(os.path.join(cgroup_base, "cgroup.controllers")):
        rel = next((path for hid, _, path in entries if hid == "0"), "/")
        for directory in _walk_up(cgroup_base, rel):
            cpu_max = _read_text(os.path.join(directory, "cpu.max"))
            if cpu_max:
                fields = cpu_max.split()
                if len(fields) == 2 and fields[0] != "max":
                    try:
                        quota = int(fields[0]) / int(fields[1])
                        cpu_quota = quota if cpu_quota is None else min(cpu_quota, quota)
                    except (ValueError, ZeroDivisionError):
                        pass
            for name in ("memory.max", "memory.high"):
                value = _read_int(os.path.join(directory, name))
                if value is not None:
                    mem_limit = value if mem_limit is None else min(mem_limit, value)
        return cpu_quota, mem_limit, 2

    if not entries:
        return None, None, None

    for directory in _v1_dirs(root, entries, "cpu"):
        quota = _read_int(os.path.join(directory, "cpu.cfs_quota_us"))
        period = _read_int(os.path.join(directory, "cpu.cfs_period_us"))
        if quota and period:
            cpu_quota = quota / period
            break

    for directory in _v1_dirs(root, entries, "memory"):
        candidates = [_read_int(os.path.join(directory, "memory.limit_in_bytes"))]
        stat = _read_text(os.path.join(directory, "memory.stat")) or ""
        for line in stat.splitlines():
            if line.startswith("hierarchical_memory_limit "):
                try:
                    value = int(line.split()[1])
                    candidates.append(value if value < CGROUP_UNLIMITED else None)
                except ValueError:
                    pass
        candidates = [c for c in candidates if c is not None]
        if candidates:
            mem_limit = min(candidates)
            break

    return cpu_quota, mem_limit, 1


def read_meminfo_total(root="/"):
    text = _read_text(os.path.join(root, "proc", "meminfo"))
    if not text:
        return None
    for line in text.splitlines():
        if line.startswith("MemTotal:"):
            try:
                return int(line.split()[1]) * 1024
            except (IndexError, ValueError):
                return None
    return None


def read_windows_total_memory():
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.ullTotalPhys)
    except Exception:
        pass
    return None


def base_cpu_count():
    if hasattr(os, "process_cpu_count"):
        count = os.process_cpu_count()
        if count:
            return count
    if hasattr(os, "sched_getaffinity"):
        try:
            return len(os.sched_getaffinity(0))
        except OSError:
            pass
    return os.cpu_count() or 1


def detect_host(root="/"):
    """
    Detects usable CPUs and RAM. Returns a dict with cpus, cpu_source, ram, ram_source, container.
    LAMPAS_CPUS / LAMPAS_RAM override detection.
    """
    cpus = base_cpu_count()
    cpu_source = "affinity"
    ram = None
    ram_source = "unknown"
    container = False

    if sys.platform.startswith("linux") or root != "/":
        cpu_quota, mem_limit, version = read_cgroup_limits(root)
        if cpu_quota is not None and math.ceil(cpu_quota) < cpus:
            cpus = max(1, math.ceil(cpu_quota))
            cpu_source = f"cgroup v{version} quota"
        ram = read_meminfo_total(root)
        ram_source = "meminfo"
        if mem_limit is not None and (ram is None or mem_limit < ram):
            ram = mem_limit
            ram_source = f"cgroup v{version} limit"
            container = True
    elif sys.platform == "win32":
        ram = read_windows_total_memory()
        ram_source = "GlobalMemoryStatusEx"

    if ram is None and hasattr(os, "sysconf"):
        try:
            ram = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
            ram_source = "sysconf"
        except (ValueError, OSError):
            pass

    env_cpus = os.getenv("LAMPAS_CPUS")
    if env_cpus:
        cpus = max(1, int(env_cpus))
        cpu_source = "LAMPAS_CPUS"
    env_ram = os.getenv("LAMPAS_RAM")
    if env_ram:
        ram = parse_size(env_ram)
        ram_source = "LAMPAS_RAM"
        container = False

    return {"cpus": cpus, "cpu_source": cpu_source, "ram": ram, "ram_source": ram_source, "container": container}


def read_thp_mode(root="/"):
    """Returns (enabled, shmem_enabled) active THP modes, or (None, None) when unavailable."""
    def active(name):
        text = _read_text(os.path.join(root, "sys", "kernel", "mm", "transparent_hugepage", name))
        if text and "[" in text:
            return text.split("[", 1)[1].split("]", 1)[0]
        return None
    return active("enabled"), active("shmem_enabled")


def is_oracle_graalvm(java_bin):
    """Detects Oracle GraalVM from the runtime's release file (CE reports a different IMPLEMENTOR)."""
    resolved = shutil.which(java_bin) or java_bin
    try:
        resolved = os.path.realpath(resolved)
    except OSError:
        return False
    release = _read_text(os.path.join(os.path.dirname(os.path.dirname(resolved)), "release")) or ""
    return "GRAALVM_VERSION=" in release and 'IMPLEMENTOR="Oracle Corporation"' in release


# --- Sizing and flags -------------------------------------------------------------------

def plan_heap(ram, container, extra_reserve=0, gc="g1"):
    """Computes the heap in bytes: RAM - OS reserve - non-heap reserve - extra reserve, capped and aligned."""
    if container:
        os_reserve = OS_RESERVE_CONTAINER
    elif ram > 4 * GiB:
        os_reserve = OS_RESERVE_DEFAULT
    else:
        os_reserve = OS_RESERVE_SMALL
    nonheap = max(NONHEAP_MIN, int(NONHEAP_FRACTION * ram))
    heap = min(ram - os_reserve - nonheap - extra_reserve, MAX_HEAP[gc])
    return max(0, heap // HEAP_ALIGN * HEAP_ALIGN)


def chunky_working_count(cpus):
    if cpus <= 2:
        return 1024
    if cpus <= 4:
        return 1536
    return 2048


def build_jvm_flags(heap, gc, cpus, cpu_override, thp, oracle_graal, compact_headers):
    """Builds the JVM flag list. Thread counts are left to JDK 25 ergonomics."""
    heap_arg = heap if isinstance(heap, str) else format_size(heap)
    flags = [
        f"-Xms{heap_arg}",
        f"-Xmx{heap_arg}",
        "-XX:+ExitOnOutOfMemoryError",
        "-XX:+AlwaysPreTouch",
        "-XX:+DisableExplicitGC",
        "-XX:+PerfDisableSharedMem",
    ]
    if compact_headers:
        flags.append("-XX:+UseCompactObjectHeaders")
    if cpu_override:
        flags.append(f"-XX:ActiveProcessorCount={cpus}")

    thp_enabled, thp_shmem = thp
    if thp_enabled in ("always", "madvise") and (gc != "zgc" or thp_shmem in ("advise", "within_size", "always")):
        flags.append("-XX:+UseTransparentHugePages")

    if gc == "zgc":
        flags.append("-XX:+UseZGC")
    else:
        try:
            large = parse_size(heap_arg) > G1_LARGE_HEAP
        except ValueError:
            large = False
        flags += [
            "-XX:+UseG1GC",
            "-XX:+UnlockExperimentalVMOptions",
            f"-XX:G1NewSizePercent={40 if large else 30}",
            f"-XX:G1MaxNewSizePercent={50 if large else 40}",
            f"-XX:G1HeapRegionSize={'16M' if large else '8M'}",
            "-XX:G1ReservePercent=15",
            "-XX:G1HeapWastePercent=5",
            "-XX:G1MixedGCCountTarget=4",
            f"-XX:InitiatingHeapOccupancyPercent={20 if large else 15}",
            "-XX:G1MixedGCLiveThresholdPercent=90",
            "-XX:G1RSetUpdatingPauseTimePercent=5",
            "-XX:SurvivorRatio=32",
            "-XX:MaxTenuringThreshold=1",
            "-Dusing.aikars.flags=https://mcflags.emc.gs",
            "-Daikars.new.flags=true",
        ]

    if oracle_graal:
        # Oracle GraalVM-only option; GraalVM CE rejects it.
        flags.append("-Djdk.graal.TuneInlinerExploration=1")

    flags += [
        f"-Dchunky.maxWorkingCount={chunky_working_count(cpus)}",
        "-Dfile.encoding=UTF-8",
        "-Dlog4j2.formatMsgNoLookups=true",
    ]
    return flags


def main():
    parser = argparse.ArgumentParser(description="Lampas Minecraft Server Starter")
    parser.add_argument("--no-sync", action="store_true", help="Skip automatic pack synchronization before launch")
    parser.add_argument("--allow-stale", action="store_true", help="Allow server launch even if pack synchronization fails")
    parser.add_argument("--memory", default=os.getenv("JAVA_MEMORY"), help="JVM heap size, e.g. 4G (default: computed from detected RAM)")
    parser.add_argument("--gc", choices=["g1", "zgc"], default=os.getenv("LAMPAS_GC", "g1"), help="Garbage collector (default: g1)")
    parser.add_argument("--dry-run", action="store_true", help="Print the computed Java command and exit without launching")
    parser.add_argument("--portal-url", default=os.getenv("PORTAL_URL", "https://dev.lampas.town"), help="Lampas Portal URL for sync")
    parser.add_argument("--channel", default=os.getenv("RELEASE_CHANNEL", "dev"), help="Release channel (stable/beta/dev)")
    parser.add_argument("--version", default=None, help="Specific pack release version to deploy (overrides --channel)")
    parser.add_argument("--no-backup", action="store_true", help="Skip world backup during deployment")
    parser.add_argument("--verify", choices=["fast", "full"], default="fast", help="Verification mode (default: fast)")

    args, extra_java_args = parser.parse_known_args()

    # 1. Synchronize Pack via lampasctl deploy
    if not args.no_sync:
        lampasctl = find_lampasctl()
        if lampasctl:
            sync_cmd = lampasctl if isinstance(lampasctl, list) else [lampasctl]
            if sys.platform == "win32" and isinstance(sync_cmd[0], str) and (sync_cmd[0].lower().endswith(".bat") or sync_cmd[0].lower().endswith(".cmd")):
                sync_cmd = ["cmd.exe", "/c"] + sync_cmd
            sync_cmd.extend([
                "deploy",
                "--target", SERVER_DIR,
                "--portal", args.portal_url,
            ])
            if args.version:
                sync_cmd.extend(["--version", args.version])
            else:
                sync_cmd.extend(["--channel", args.channel])
            if args.no_backup:
                sync_cmd.append("--no-backup")
            if args.verify:
                sync_cmd.extend(["--verify", args.verify])

            print(f"[Starter] Checking for server pack updates via lampasctl deploy...")
            ret = subprocess.call(sync_cmd)
            if ret != 0:
                print(f"[Starter Error] Pack deployment failed with exit code {ret}.", file=sys.stderr)
                if not args.allow_stale:
                    print("[Starter Error] Aborting server launch to prevent inconsistent state. (Use --allow-stale or --no-sync to bypass)", file=sys.stderr)
                    sys.exit(ret)
                else:
                    print("[Starter Warning] Deployment failed. Attempting transaction recovery before stale launch (--allow-stale enabled)...")
                    rec_ret = run_recovery(lampasctl)
                    if rec_ret != 0:
                        print(f"[Starter Error] Failed to recover deployment transaction (exit code {rec_ret}). Aborting launch to prevent running corrupted server.", file=sys.stderr)
                        sys.exit(rec_ret)
                    print("[Starter Warning] Continuing server launch with recovered installation state (--allow-stale enabled).")
        else:
            print("[Starter Error] 'lampasctl' executable not found. Install lampasctl or launch with --no-sync.", file=sys.stderr)
            if not args.allow_stale:
                sys.exit(1)

    # 2. Ensure no interrupted deployment transaction journal exists before launching
    journal_path = os.path.join(SERVER_DIR, ".lampas", ".tx-rollback", "journal.json")
    if os.path.exists(journal_path):
        print("[Starter Warning] Detected interrupted deployment transaction journal. Running recovery before launch...")
        lampasctl = find_lampasctl()
        if not lampasctl:
            print("[Starter Error] Cannot recover interrupted deployment: 'lampasctl' binary not found. Aborting launch to prevent running corrupted server.", file=sys.stderr)
            sys.exit(1)
        rec_ret = run_recovery(lampasctl)
        if rec_ret != 0:
            print(f"[Starter Error] Transaction recovery failed with exit code {rec_ret}. Aborting server launch.", file=sys.stderr)
            sys.exit(rec_ret)
        print("[Starter] Transaction recovery completed successfully.")

    # 3. Locate Java and Fabric Server JAR
    java_bin = find_java_binary()
    server_jar = find_fabric_server_jar()
    if not server_jar:
        print("[Starter Error] No managed Fabric runtime is installed. Run start.py without --no-sync first.", file=sys.stderr)
        sys.exit(1)

    # 4. Size the JVM from the host
    host = detect_host()
    ram_text = format_size(host["ram"]) if host["ram"] else "unknown"
    print(f"\n[Starter] Host: {host['cpus']} CPUs ({host['cpu_source']}), {ram_text} RAM ({host['ram_source']})")

    if args.memory:
        heap = args.memory
        heap_source = "--memory/JAVA_MEMORY"
    else:
        if not host["ram"]:
            print("[Starter Error] Could not detect system RAM. Set --memory or JAVA_MEMORY.", file=sys.stderr)
            sys.exit(1)
        extra_reserve = parse_size(os.getenv("LAMPAS_EXTRA_RESERVE", "0"))
        heap_bytes = plan_heap(host["ram"], host["container"], extra_reserve, args.gc)
        if heap_bytes < MIN_HEAP:
            print(f"[Starter Error] Computed heap {format_size(heap_bytes)} is below the {format_size(MIN_HEAP)} minimum for this modpack. Add RAM or set --memory explicitly.", file=sys.stderr)
            sys.exit(1)
        heap = format_size(heap_bytes)
        heap_source = "computed"

    thp = read_thp_mode() if sys.platform.startswith("linux") else (None, None)
    oracle_graal = is_oracle_graalvm(java_bin)
    compact_headers = os.getenv("LAMPAS_COMPACT_HEADERS", "1") != "0"

    jar_name = os.path.basename(server_jar)
    print(f"[Starter] Using Java: {java_bin}{' (Oracle GraalVM)' if oracle_graal else ''}")
    print(f"[Starter] Starting Minecraft Fabric Server ({jar_name}) with {heap} heap ({heap_source}), GC {args.gc}...")

    optimized_jvm_flags = build_jvm_flags(
        heap,
        args.gc,
        host["cpus"],
        bool(os.getenv("LAMPAS_CPUS")),
        thp,
        oracle_graal,
        compact_headers,
    )

    log4j_cfg = os.path.join(SERVER_DIR, "log4j2.xml")
    if os.path.exists(log4j_cfg):
        optimized_jvm_flags.append(f"-Dlog4j2.configurationFile={log4j_cfg}")

    # Rotated GC log; an unwritable -Xlog file aborts JVM startup, so only add it when logs/ is writable.
    # Relative path because the JVM runs in SERVER_DIR and -Xlog splits on ':' (Windows drive letters).
    logs_dir = os.path.join(SERVER_DIR, "logs")
    try:
        os.makedirs(logs_dir, exist_ok=True)
    except OSError:
        pass
    if os.access(logs_dir, os.W_OK):
        optimized_jvm_flags.append("-Xlog:gc*:file=logs/gc.log:time,uptime:filecount=5,filesize=10m")

    # Combine flags and extra arguments (extra arguments come last so they win)
    base_cmd = ["cmd.exe", "/c", java_bin] if (sys.platform == "win32" and (java_bin.lower().endswith(".bat") or java_bin.lower().endswith(".cmd"))) else [java_bin]
    jvm_cmd = base_cmd + optimized_jvm_flags + extra_java_args + [
        "-jar",
        server_jar,
        "nogui",
    ]

    if args.dry_run:
        print("[Starter] Dry run: " + " ".join(jvm_cmd))
        return

    # 5. Launch with Signal Handling for Graceful Shutdown
    try:
        proc = subprocess.Popen(jvm_cmd, cwd=SERVER_DIR)

        def handle_signal(sig, frame):
            print(f"\n[Starter] Received signal {sig}, forwarding to Minecraft server...")
            proc.send_signal(sig)

        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)

        exit_code = proc.wait()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
