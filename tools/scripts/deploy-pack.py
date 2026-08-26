#!/usr/bin/env python3
"""
Lampas Dedicated Server Pack Deployment & Sync Engine
-----------------------------------------------------
Self-contained, cross-platform Python script for Linux & Windows.
Requires zero third-party dependencies (uses Python standard library).

Features:
- Automatic timestamped world backup before deployment.
- Manifest ingestion (local file or remote Lampas Portal URL).
- Direct streaming chunked downloads with SHA-256 and size verification.
- Zero truncation guarantee with retry backoff and size validation.
- Atomic file staging and replacement.
- Safe cleanup of obsolete managed files while preserving server configuration.
"""

import os
import sys
import time
import json
import shutil
import hashlib
import argparse
import datetime
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(SERVER_DIR, ".lampas")
INSTALLATION_FILE = os.path.join(STATE_DIR, "installation.json")
CACHE_DIR = os.path.join(STATE_DIR, "cache", "sha256")

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36 Lampas-Server/2.0"
)

DEFAULT_PORTAL_URL = os.environ.get("PORTAL_URL", "https://dev.lampas.town")
DEFAULT_CHANNEL = os.environ.get("RELEASE_CHANNEL", "dev")

PROTECTED_PATHS = {
    "world",
    "saves",
    "logs",
    "crash-reports",
    "server.properties",
    "usercache.json",
    "whitelist.json",
    "ops.json",
    "banned-players.json",
    "banned-ips.json",
    "eula.txt",
    "start.py",
    "start.sh",
    "deploy_pack.py",
    ".backups",
}


def compute_sha256(filepath):
    """Computes SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def is_protected(rel_path):
    """Checks if a relative path is protected from deletion/overwriting."""
    norm = rel_path.replace("\\", "/").strip("/")
    parts = norm.split("/")
    if parts[0] in PROTECTED_PATHS:
        return True
    return norm in PROTECTED_PATHS


def backup_world():
    """Creates a timestamped backup of the world directory."""
    world_dir = os.path.join(SERVER_DIR, "world")
    if not os.path.isdir(world_dir):
        print("[1/3] No world directory found; skipping backup.")
        return

    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backups_dir = os.path.join(SERVER_DIR, ".backups")
    os.makedirs(backups_dir, exist_ok=True)

    dest = os.path.join(backups_dir, f"world_{timestamp}")
    print(f"[1/3] Creating world backup -> {dest} ...")
    shutil.copytree(world_dir, dest)
    print("  ✓ World backup complete.")


def load_manifest(manifest_path, portal_url, channel):
    """Loads server manifest from local path or remote portal."""
    if manifest_path and os.path.exists(manifest_path):
        print(f"[2/3] Loading local manifest: {manifest_path}")
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # Fallback to relative pipeline directory
    rel_pipeline_manifest = os.path.join(SERVER_DIR, "..", "lampas-pipeline", "manifest", "server-manifest.json")
    if os.path.exists(rel_pipeline_manifest):
        print(f"[2/3] Loading pipeline manifest: {rel_pipeline_manifest}")
        with open(rel_pipeline_manifest, "r", encoding="utf-8") as f:
            return json.load(f)

    # Remote Portal Fetch
    effective_portal_url = portal_url or DEFAULT_PORTAL_URL
    effective_channel = channel or DEFAULT_CHANNEL
    if effective_portal_url:
        portal_clean = effective_portal_url.rstrip("/")
        channel_url = f"{portal_clean}/api/v1/channels/{effective_channel}"
        print(f"[2/3] Querying portal channel '{effective_channel}': {channel_url}")

        req = urllib.request.Request(channel_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            channel_data = json.loads(resp.read().decode("utf-8"))

        target_ver = channel_data.get("version")
        if not target_ver:
            raise RuntimeError(f"Channel '{effective_channel}' returned no target version from {channel_url}")

        manifest_url = f"{portal_clean}/api/v1/releases/{target_ver}/server-manifest"
        print(f"  Fetching server manifest v{target_ver}: {manifest_url}")

        req = urllib.request.Request(manifest_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

    raise RuntimeError(
        f"Server manifest not found. Checked: '{manifest_path}', '{rel_pipeline_manifest}' and portal '{effective_portal_url}'"
    )


def download_single_file(file_entry, portal_url, pipeline_dir, retries=3):
    """
    Downloads or retrieves a single file with direct streaming to cache.
    Guarantees zero truncation by strictly validating both byte length and SHA-256.
    """
    rel_path = file_entry["path"]
    expected_sha256 = file_entry["hashes"]["sha256"]
    expected_size = file_entry.get("size")
    download_url = file_entry["download"]["url"]

    # 1. Check local blob cache
    cache_path = os.path.join(CACHE_DIR, expected_sha256[:2], expected_sha256)
    if os.path.exists(cache_path):
        actual_size = os.path.getsize(cache_path)
        if expected_size is None or actual_size == expected_size:
            if compute_sha256(cache_path) == expected_sha256:
                return rel_path, cache_path, True

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    # 1b. Handle zero-byte empty marker files directly
    EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    if expected_size == 0 or expected_sha256 == EMPTY_SHA256:
        with open(cache_path, "wb") as f:
            pass
        return rel_path, cache_path, False

    temp_download_path = f"{cache_path}.tmp.{os.getpid()}.{int(time.time() * 1000)}"

    # 2. Check local pipeline repository candidate files first
    candidate_paths = [
        os.path.join(pipeline_dir, "pack", "common", rel_path),
        os.path.join(pipeline_dir, "pack", "server", rel_path),
        os.path.join(pipeline_dir, "pack", "custom", os.path.basename(rel_path)),
        os.path.join(pipeline_dir, "pack", "custom", rel_path),
    ]

    for candidate in candidate_paths:
        if os.path.exists(candidate):
            cand_size = os.path.getsize(candidate)
            if expected_size is None or cand_size == expected_size:
                if compute_sha256(candidate) == expected_sha256:
                    shutil.copy2(candidate, temp_download_path)
                    os.replace(temp_download_path, cache_path)
                    return rel_path, cache_path, False

    # 3. Download via Network with chunked streaming and retry logic
    target_url = download_url
    if target_url.startswith("/"):
        effective_portal = portal_url or DEFAULT_PORTAL_URL
        if not effective_portal:
            raise RuntimeError(f"Cannot resolve local blob '{rel_path}' ({download_url}) without --portal-url")
        target_url = f"{effective_portal.rstrip('/')}{target_url}"

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                    "Accept-Encoding": "identity",
                },
            )

            hasher = hashlib.sha256()
            total_bytes = 0

            with urllib.request.urlopen(req, timeout=60) as resp:
                with open(temp_download_path, "wb") as out_f:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        out_f.write(chunk)
                        hasher.update(chunk)
                        total_bytes += len(chunk)

            # Verification 1: Byte Length
            if expected_size is not None and total_bytes != expected_size:
                raise ValueError(
                    f"Incomplete download for {rel_path}! Expected {expected_size} bytes, got {total_bytes} bytes"
                )

            # Verification 2: SHA-256
            actual_sha256 = hasher.hexdigest()
            if actual_sha256 != expected_sha256:
                raise ValueError(
                    f"SHA-256 mismatch for {rel_path}!\n  Expected: {expected_sha256}\n  Got:      {actual_sha256}"
                )

            # Atomic rename into permanent cache
            os.replace(temp_download_path, cache_path)
            return rel_path, cache_path, False

        except Exception as err:
            last_error = err
            if os.path.exists(temp_download_path):
                try:
                    os.remove(temp_download_path)
                except Exception:
                    pass
            time.sleep(attempt * 1.5)

    raise RuntimeError(f"Failed to download '{rel_path}' from '{target_url}' after {retries} attempts: {last_error}")


def sync_server(manifest, portal_url, pipeline_dir, max_workers=8):
    """Reconciles the server directory against the server manifest."""
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)

    prev_state = {"files": {}}
    if os.path.exists(INSTALLATION_FILE):
        try:
            with open(INSTALLATION_FILE, "r", encoding="utf-8") as f:
                prev_state = json.load(f)
        except Exception:
            pass

    desired_files = {f["path"]: f for f in manifest.get("files", [])}
    to_download = []
    to_keep = []

    for path_key, entry in desired_files.items():
        local_path = os.path.join(SERVER_DIR, path_key)
        policy = entry.get("policy", "MANAGED")
        expected_size = entry.get("size")
        expected_sha256 = entry["hashes"]["sha256"]

        if policy == "PRESERVE" or is_protected(path_key):
            if os.path.exists(local_path):
                to_keep.append(path_key)
                continue

        if os.path.exists(local_path):
            local_size = os.path.getsize(local_path)
            # Detect truncated files (e.g. 1KB corrupted downloads)
            if expected_size is not None and local_size != expected_size:
                to_download.append(entry)
                continue

            if compute_sha256(local_path) == expected_sha256:
                to_keep.append(path_key)
                continue

        to_download.append(entry)

    # Detect obsolete managed files to remove
    to_delete = []
    for prev_path, info in prev_state.get("files", {}).items():
        if info.get("policy") == "MANAGED" and prev_path not in desired_files and not is_protected(prev_path):
            to_delete.append(prev_path)

    print(
        f"[3/3] Synchronizing server: {len(to_download)} to download, "
        f"{len(to_keep)} up-to-date, {len(to_delete)} obsolete to delete."
    )

    # Concurrent chunked streaming downloads
    downloaded_cache_paths = {}
    if to_download:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_file = {
                executor.submit(download_single_file, f, portal_url, pipeline_dir): f for f in to_download
            }
            for future in as_completed(future_to_file):
                rel_path, cached_file_path, cached = future.result()
                downloaded_cache_paths[rel_path] = cached_file_path
                status = "⚡ [Cache Hit]" if cached else "✓ [Downloaded]"
                size_bytes = os.path.getsize(cached_file_path)
                size_kb = size_bytes / 1024
                print(f"  {status} {rel_path} ({size_kb:.1f} KB)")

    # Atomic copy to server directory
    for rel_path, cached_file_path in downloaded_cache_paths.items():
        dest_path = os.path.join(SERVER_DIR, rel_path)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        tmp_dest = f"{dest_path}.tmp.{os.getpid()}"
        shutil.copy2(cached_file_path, tmp_dest)
        os.replace(tmp_dest, dest_path)

    # Delete obsolete managed files
    for rel_path in to_delete:
        full_path = os.path.join(SERVER_DIR, rel_path)
        if os.path.exists(full_path):
            os.remove(full_path)
            print(f"  🗑 [Deleted Obsolete] {rel_path}")

    # Write installation state
    new_state = {
        "pack": manifest.get("pack", "Lampas"),
        "version": manifest.get("version", "2.0.0"),
        "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": {
            f["path"]: {
                "sha256": f["hashes"]["sha256"],
                "size": f["size"],
                "policy": f["policy"],
            }
            for f in manifest.get("files", [])
        },
    }

    with open(INSTALLATION_FILE, "w", encoding="utf-8") as f:
        json.dump(new_state, f, indent=2)

    print("\n" + "=" * 60)
    print(f" [OK] Server successfully synchronized to {manifest.get('pack')} v{manifest.get('version')}!")
    print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="Lampas Dedicated Server Pack Deployment & Sync Engine")
    parser.add_argument("--manifest", help="Path to server-manifest.json", default="")
    parser.add_argument("--portal-url", help="Lampas Portal URL (default: https://dev.lampas.town)", default=DEFAULT_PORTAL_URL)
    parser.add_argument("--channel", help="Release channel (stable/beta/dev)", default=DEFAULT_CHANNEL)
    parser.add_argument("--pipeline-dir", help="Path to lampas-pipeline repo", default=os.path.join(SERVER_DIR, "..", "lampas-pipeline"))
    parser.add_argument("--skip-backup", action="store_true", help="Skip creating a world backup")
    parser.add_argument("--workers", type=int, default=8, help="Concurrent download worker count")

    args = parser.parse_args()

    print("=" * 60)
    print(" Lampas Server Deployment Pipeline (Linux / Windows)")
    print("=" * 60)

    if not args.skip_backup:
        backup_world()

    manifest = load_manifest(args.manifest, args.portal_url, args.channel)
    sync_server(manifest, args.portal_url, args.pipeline_dir, max_workers=args.workers)


if __name__ == "__main__":
    main()