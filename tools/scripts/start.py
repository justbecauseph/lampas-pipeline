#!/usr/bin/env python3
"""
Lampas Dedicated Server Launcher
--------------------------------
Cross-platform startup script for Linux (systemd / Docker / bare-metal) and Windows.

Usage:
    python3 start.py
    python3 start.py --no-sync
    python3 start.py --memory 3G
"""

import os
import sys
import glob
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


def find_java_binary():
    """Locates the preferred Java binary (SDKMAN GraalVM, system Java, etc.)."""
    sdkman_java = os.path.expanduser("~/.sdkman/candidates/java/current/bin/java")
    if os.path.exists(sdkman_java) and os.access(sdkman_java, os.X_OK):
        return sdkman_java

    which_java = shutil.which("java")
    if which_java:
        return which_java

    return "java"


def find_fabric_server_jar():
    """Locates the Fabric server launcher JAR."""
    candidates = glob.glob(os.path.join(SERVER_DIR, "fabric-server-*.jar"))
    if candidates:
        return candidates[0]

    server_jar = os.path.join(SERVER_DIR, "server.jar")
    if os.path.exists(server_jar):
        return server_jar

def find_lampasctl():
    """Locates the lampasctl executable (co-located binary, PATH, or development Bun source)."""
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


def main():
    parser = argparse.ArgumentParser(description="Lampas Minecraft Server Starter")
    parser.add_argument("--no-sync", action="store_true", help="Skip automatic pack synchronization before launch")
    parser.add_argument("--allow-stale", action="store_true", help="Allow server launch even if pack synchronization fails")
    parser.add_argument("--memory", default=os.getenv("JAVA_MEMORY", "2560M"), help="JVM heap memory (default: 2560M)")
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
                    print("[Starter Warning] Continuing server launch despite deployment failure (--allow-stale enabled).")
        else:
            # Fallback check for deprecated deploy_pack.py
            deploy_script = os.path.join(SERVER_DIR, "deploy_pack.py")
            if os.path.exists(deploy_script):
                print("[Starter Warning] 'lampasctl' not found. Falling back to deprecated deploy_pack.py...", file=sys.stderr)
                sync_cmd = [sys.executable, deploy_script, "--channel", args.channel]
                if args.portal_url:
                    sync_cmd.extend(["--portal-url", args.portal_url])
                ret = subprocess.call(sync_cmd)
                if ret != 0 and not args.allow_stale:
                    print(f"[Starter Error] Pack deployment failed with exit code {ret}.", file=sys.stderr)
                    sys.exit(ret)
            else:
                print("[Starter Error] 'lampasctl' executable not found. Install lampasctl or launch with --no-sync.", file=sys.stderr)
                if not args.allow_stale:
                    sys.exit(1)

    # 2. Locate Java and Fabric Server JAR
    java_bin = find_java_binary()
    server_jar = find_fabric_server_jar()
    if not server_jar:
        print("[Starter Error] No Fabric server JAR found in directory.", file=sys.stderr)
        sys.exit(1)

    jar_name = os.path.basename(server_jar)
    print(f"\n[Starter] Using Java: {java_bin}")
    print(f"[Starter] Starting Minecraft Fabric Server ({jar_name}) with {args.memory} heap...")

    # 3. Optimized Aikar G1GC Flags for Minecraft + GraalVM (Tuned for 2 vCPUs)
    optimized_jvm_flags = [
        f"-Xmx{args.memory}",
        f"-Xms{args.memory}",
        "-XX:+ExitOnOutOfMemoryError",
        "-XX:+UseG1GC",
        "-XX:+UseCompactObjectHeaders",
        "-XX:ParallelGCThreads=2",
        "-XX:ConcGCThreads=1",
        "-XX:CICompilerCount=2",
        "-XX:+ParallelRefProcEnabled",
        "-XX:MaxGCPauseMillis=200",
        "-XX:+UnlockExperimentalVMOptions",
        "-XX:+DisableExplicitGC",
        "-XX:+AlwaysPreTouch",
        "-XX:G1NewSizePercent=30",
        "-XX:G1MaxNewSizePercent=40",
        "-XX:G1ReservePercent=20",
        "-XX:G1HeapRegionSize=8M",
        "-XX:G1HeapWastePercent=5",
        "-XX:G1MixedGCCountTarget=4",
        "-XX:InitiatingHeapOccupancyPercent=15",
        "-XX:G1MixedGCLiveThresholdPercent=90",
        "-XX:G1RSetUpdatingPauseTimePercent=5",
        "-XX:SurvivorRatio=32",
        "-XX:+PerfDisableSharedMem",
        "-Dgraal.TuneInlinerExploration=1",
        "-Dusing.aikars.flags=https://mcflags.emc.gs",
        "-Daikars.new.flags=true",
        "-Dchunky.maxWorkingCount=768",
        "-Dfile.encoding=UTF-8",
        "-Dlog4j2.formatMsgNoLookups=true",
    ]

    # Combine flags and extra arguments
    jvm_cmd = [java_bin] + optimized_jvm_flags + extra_java_args + [
        "-jar",
        server_jar,
        "nogui",
    ]

    # 4. Launch with Signal Handling for Graceful Shutdown
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