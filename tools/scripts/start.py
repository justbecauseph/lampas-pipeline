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

    return None


def main():
    parser = argparse.ArgumentParser(description="Lampas Minecraft Server Starter")
    parser.add_argument("--no-sync", action="store_true", help="Skip automatic pack synchronization before launch")
    parser.add_argument("--memory", default=os.getenv("JAVA_MEMORY", "2560M"), help="JVM heap memory (default: 2560M)")
    parser.add_argument("--portal-url", default=os.getenv("PORTAL_URL", "https://dev.lampas.town"), help="Lampas Portal URL for sync")
    parser.add_argument("--channel", default=os.getenv("RELEASE_CHANNEL", "dev"), help="Release channel (stable/beta/dev)")

    args, extra_java_args = parser.parse_known_args()

    # 1. Synchronize Pack if deploy_pack.py exists
    if not args.no_sync:
        deploy_script = os.path.join(SERVER_DIR, "deploy_pack.py")
        if os.path.exists(deploy_script):
            sync_cmd = [sys.executable, deploy_script, "--channel", args.channel]
            if args.portal_url:
                sync_cmd.extend(["--portal-url", args.portal_url])

            print("[Starter] Checking for server pack updates...")
            ret = subprocess.call(sync_cmd)
            if ret != 0:
                print(f"[Starter] Warning: Pack synchronization exited with code {ret}")

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