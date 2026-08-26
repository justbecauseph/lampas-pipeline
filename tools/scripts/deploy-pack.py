#!/usr/bin/env python3
"""
Lampas Dedicated Server Pack Deployment & Sync Engine
-----------------------------------------------------
Self-contained, cross-platform Python script for Linux & Windows.
Requires zero third-party dependencies (uses Python standard library).

Features:
- Deterministic manifest source resolution (Portal channel vs explicit path).
- Pre-mutation manifest validation (paths, hashes, sizes, UUIDs, CAS URLs).
- Path traversal protection ensuring all paths remain strictly inside server directory.
- Automatic timestamped world backup performed only after validation succeeds.
- Chunked streaming downloads with byte length and SHA-256 validation.
- Atomic file staging and replacement.
- Safe reconciliation of managed resource-pack properties in server.properties.
- Final post-mutation verification pass before committing installation state.
"""

import os
import sys
import time
import json
import shutil
import hashlib
import argparse
import datetime
import re
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

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
    "deploy-pack.py",
    ".backups",
    ".lampas",
}

UUID_REGEX = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def compute_sha256(filepath):
    """Computes SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def is_valid_uuid(val):
    """Checks if a string is a valid UUID."""
    if not val or not isinstance(val, str):
        return False
    return bool(UUID_REGEX.match(val.strip()))


def validate_safe_path(rel_path, base_dir):
    """Validates that a relative path stays strictly within base_dir."""
    if not rel_path or not isinstance(rel_path, str):
        raise ValueError("Path must be a non-empty string")
    norm = os.path.normpath(rel_path).replace("\\", "/")
    if norm.startswith("../") or norm == ".." or os.path.isabs(rel_path):
        raise ValueError(f"Path traversal detected: '{rel_path}'")
    if ":" in rel_path or rel_path.startswith("//") or rel_path.startswith("\\\\"):
        raise ValueError(f"Invalid path syntax: '{rel_path}'")

    full_path = os.path.abspath(os.path.join(base_dir, rel_path))
    try:
        common = os.path.commonpath([base_dir, full_path])
        if common != base_dir:
            raise ValueError(f"Path '{rel_path}' escapes directory {base_dir}")
    except ValueError as err:
        raise ValueError(f"Path '{rel_path}' escapes directory: {err}")


def is_protected(rel_path):
    """Checks if a relative path is protected from generic deletion/overwriting."""
    norm = rel_path.replace("\\", "/").strip("/")
    parts = norm.split("/")
    if parts[0] in PROTECTED_PATHS:
        return True
    return norm in PROTECTED_PATHS


def validate_server_manifest(manifest, server_dir):
    """
    Strict validation of server manifest schema, file paths, hashes, policies,
    and server resource-pack configuration before any mutations occur.
    """
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be a JSON object")

    schema_version = manifest.get("schemaVersion")
    if schema_version not in (1, "1"):
        raise ValueError(f"Unsupported manifest schemaVersion: {schema_version}")

    target = manifest.get("target")
    if target != "server":
        raise ValueError(f"Expected server manifest (target='server'), got '{target}'")

    if not manifest.get("pack"):
        raise ValueError("Manifest missing 'pack' name")
    if not manifest.get("version"):
        raise ValueError("Manifest missing 'version'")
    if not manifest.get("minecraft"):
        raise ValueError("Manifest missing 'minecraft' version")

    loader = manifest.get("loader")
    if not isinstance(loader, dict) or not loader.get("version"):
        raise ValueError("Manifest missing loader configuration")

    # Validate files
    files = manifest.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Manifest 'files' must be an array")

    seen_paths = set()
    for f in files:
        if not isinstance(f, dict):
            raise ValueError("Each manifest file entry must be an object")

        rel_path = f.get("path")
        if not rel_path or not isinstance(rel_path, str):
            raise ValueError("File entry missing 'path'")

        validate_safe_path(rel_path, server_dir)

        if rel_path in seen_paths:
            raise ValueError(f"Duplicate file path in manifest: '{rel_path}'")
        seen_paths.add(rel_path)

        hashes = f.get("hashes")
        if not isinstance(hashes, dict) or not hashes.get("sha256"):
            raise ValueError(f"File '{rel_path}' missing SHA-256 hash")

        sha256 = hashes["sha256"]
        if len(sha256) != 64 or not all(c in "0123456789abcdefABCDEF" for c in sha256):
            raise ValueError(f"File '{rel_path}' has invalid SHA-256: '{sha256}'")

        size = f.get("size")
        if size is not None and (not isinstance(size, int) or size < 0):
            raise ValueError(f"File '{rel_path}' has invalid size: {size}")

        policy = f.get("policy", "MANAGED")
        if policy not in ("MANAGED", "PRESERVE", "OPTIONAL", "GENERATED"):
            raise ValueError(f"File '{rel_path}' has invalid policy: '{policy}'")

        download = f.get("download")
        if not isinstance(download, dict) or not download.get("url"):
            raise ValueError(f"File '{rel_path}' missing download URL")

    # Validate server resourcePack configuration if present
    srp = manifest.get("resourcePack")
    if srp is not None:
        if not isinstance(srp, dict):
            raise ValueError("Manifest 'resourcePack' must be an object")
        if not srp.get("artifact"):
            raise ValueError("resourcePack missing 'artifact'")

        url = srp.get("url")
        if not url or not isinstance(url, str):
            raise ValueError("resourcePack missing 'url'")

        sha256 = srp.get("sha256")
        if not sha256 or len(sha256) != 64 or not all(c in "0123456789abcdefABCDEF" for c in sha256):
            raise ValueError(f"resourcePack has invalid SHA-256: '{sha256}'")

        sha1 = srp.get("sha1")
        if not sha1 or len(sha1) != 40 or not all(c in "0123456789abcdefABCDEF" for c in sha1):
            raise ValueError(f"resourcePack has invalid SHA-1: '{sha1}'")

        pack_id = srp.get("id") or srp.get("uuid")
        if not pack_id or not is_valid_uuid(pack_id):
            raise ValueError(f"resourcePack has invalid UUID id: '{pack_id}'")

        if "required" in srp and not isinstance(srp["required"], bool):
            raise ValueError(f"resourcePack 'required' must be boolean, got {type(srp['required'])}")

        if srp.get("prompt"):
            prompt = srp["prompt"]
            try:
                json.loads(prompt)
            except Exception as err:
                raise ValueError(f"resourcePack 'prompt' is not valid JSON: {prompt}") from err

        # CAS URL validation: verify blob hash in URL matches declared sha256
        if "/api/v1/blobs/" in url:
            url_blob_hash = url.split("/api/v1/blobs/")[-1].split("?")[0].strip()
            if url_blob_hash.lower() != sha256.lower():
                raise ValueError(
                    f"resourcePack URL blob hash '{url_blob_hash}' does not match declared sha256 '{sha256}'"
                )


def backup_world(server_dir):
    """Creates a timestamped backup of the world directory."""
    world_dir = os.path.join(server_dir, "world")
    if not os.path.isdir(world_dir):
        print("[World Backup] No world directory found; skipping backup.")
        return

    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    backups_dir = os.path.join(server_dir, ".backups")
    os.makedirs(backups_dir, exist_ok=True)

    dest = os.path.join(backups_dir, f"world_{timestamp}")
    print(f"[World Backup] Creating world backup -> {dest} ...")
    shutil.copytree(world_dir, dest)
    print("  ✓ World backup complete.")


def load_manifest(manifest_path, portal_url, channel, allow_local_fallback=False, server_dir=None):
    """
    Loads server manifest from local path or remote portal.
    Deterministic source resolution: explicit --manifest wins; otherwise Portal channel.
    """
    if manifest_path:
        if not os.path.exists(manifest_path):
            raise FileNotFoundError(f"Explicit manifest file not found: '{manifest_path}'")
        print(f"[Manifest] Loading explicit manifest: {manifest_path}")
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # Remote Portal Fetch
    effective_portal_url = portal_url or DEFAULT_PORTAL_URL
    effective_channel = channel or DEFAULT_CHANNEL
    if effective_portal_url:
        portal_clean = effective_portal_url.rstrip("/")
        channel_url = f"{portal_clean}/api/v1/channels/{effective_channel}"
        print(f"[Manifest] Querying portal channel '{effective_channel}': {channel_url}")

        try:
            req = urllib.request.Request(
                channel_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                channel_data = json.loads(resp.read().decode("utf-8"))

            target_ver = channel_data.get("version")
            if not target_ver:
                raise RuntimeError(
                    f"Channel '{effective_channel}' returned no target version from {channel_url}"
                )

            manifest_url = f"{portal_clean}/api/v1/releases/{target_ver}/server-manifest"
            print(f"  Fetching server manifest v{target_ver}: {manifest_url}")

            req = urllib.request.Request(
                manifest_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as portal_err:
            if allow_local_fallback and server_dir:
                rel_pipeline_manifest = os.path.join(
                    server_dir, "..", "lampas-pipeline", "manifest", "server-manifest.json"
                )
                if os.path.exists(rel_pipeline_manifest):
                    print(f"[Manifest Fallback] Portal failed ({portal_err}); using {rel_pipeline_manifest}")
                    with open(rel_pipeline_manifest, "r", encoding="utf-8") as f:
                        return json.load(f)
            raise RuntimeError(
                f"Failed to fetch server manifest from portal channel '{effective_channel}' ({effective_portal_url}): {portal_err}"
            )

    raise RuntimeError("No manifest source available. Provide --manifest or configure --portal-url and --channel.")


def download_single_file(file_entry, cache_dir, portal_url, pipeline_dir, retries=3):
    """
    Downloads or retrieves a single file with direct streaming to cache.
    Guarantees zero truncation by strictly validating both byte length and SHA-256.
    """
    rel_path = file_entry["path"]
    expected_sha256 = file_entry["hashes"]["sha256"]
    expected_size = file_entry.get("size")
    download_url = file_entry["download"]["url"]

    # 1. Check local blob cache
    cache_path = os.path.join(cache_dir, expected_sha256[:2], expected_sha256)
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

    # 2. Check local pipeline repository candidate files first if directory is present
    if pipeline_dir and os.path.exists(pipeline_dir):
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


def reconcile_server_properties(server_dir, srp_config, prev_srp_state=None):
    """
    Safely reconciles only the 5 Lampas-managed resource pack keys in server.properties:
    - resource-pack
    - resource-pack-sha1
    - resource-pack-id
    - resource-pack-prompt
    - require-resource-pack

    Preserves comments, unknown properties, ordering, line endings, and user configuration.
    Performs atomic update with backup.
    """
    props_path = os.path.join(server_dir, "server.properties")
    lines = []
    eol = "\n"

    if os.path.exists(props_path):
        with open(props_path, "rb") as f:
            raw = f.read()
        if b"\r\n" in raw:
            eol = "\r\n"
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()

        # Backup existing server.properties
        backups_dir = os.path.join(server_dir, ".lampas", "backups")
        os.makedirs(backups_dir, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        shutil.copy2(props_path, os.path.join(backups_dir, f"server.properties.{ts}"))

    keys_to_set = {}
    if srp_config:
        keys_to_set["resource-pack"] = srp_config.get("url", "")
        keys_to_set["resource-pack-sha1"] = srp_config.get("sha1", "")
        keys_to_set["resource-pack-id"] = srp_config.get("id") or srp_config.get("uuid", "")
        keys_to_set["resource-pack-prompt"] = srp_config.get("prompt", "")
        keys_to_set["require-resource-pack"] = str(srp_config.get("required", True)).lower()
    elif prev_srp_state and prev_srp_state.get("managed"):
        # Server resource pack removed: cleanly reset managed properties
        keys_to_set["resource-pack"] = ""
        keys_to_set["resource-pack-sha1"] = ""
        keys_to_set["resource-pack-id"] = ""
        keys_to_set["resource-pack-prompt"] = ""
        keys_to_set["require-resource-pack"] = "false"

    if not keys_to_set:
        return

    seen_keys = set()
    new_lines = []
    for line in lines:
        trimmed = line.strip()
        if trimmed.startswith("#") or trimmed.startswith("!") or "=" not in line:
            new_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in keys_to_set:
            seen_keys.add(key)
            new_lines.append(f"{key}={keys_to_set[key]}")
        else:
            new_lines.append(line)

    for key, val in keys_to_set.items():
        if key not in seen_keys:
            new_lines.append(f"{key}={val}")

    content = eol.join(new_lines) + eol
    tmp_path = f"{props_path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, props_path)

    if srp_config:
        print("  ⚙ [Server Config] Configured resource-pack settings in server.properties")
        print(f"      artifact: {srp_config.get('artifact')}")
        print(f"      url:      {srp_config.get('url')}")
        print(f"      sha1:     {srp_config.get('sha1')}")
    else:
        print("  ⚙ [Server Config] Reset Lampas resource-pack settings in server.properties")


def read_server_properties_map(server_dir):
    """Reads server.properties as a dictionary of key-value pairs."""
    props_path = os.path.join(server_dir, "server.properties")
    if not os.path.exists(props_path):
        return {}
    res = {}
    with open(props_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            trimmed = line.strip()
            if trimmed.startswith("#") or trimmed.startswith("!") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            res[k.strip()] = v.strip()
    return res


def sync_server(manifest, server_dir, portal_url, pipeline_dir, max_workers=8, skip_backup=False):
    """
    Reconciles the server directory against the server manifest.
    Validation -> Planning -> Backup -> Execution -> server.properties -> Verification -> Commit.
    """
    state_dir = os.path.join(server_dir, ".lampas")
    installation_file = os.path.join(state_dir, "installation.json")
    cache_dir = os.path.join(state_dir, "cache", "sha256")

    # 1. Validate manifest before any mutations or backups
    print("[1/5] Validating server manifest...")
    validate_server_manifest(manifest, server_dir)
    print(f"  ✓ Manifest validated: {manifest['pack']} v{manifest['version']} (mc: {manifest['minecraft']})")

    os.makedirs(state_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    prev_state = {"files": {}}
    if os.path.exists(installation_file):
        try:
            with open(installation_file, "r", encoding="utf-8") as f:
                prev_state = json.load(f)
        except Exception:
            pass

    desired_files = {f["path"]: f for f in manifest.get("files", [])}
    to_download = []
    to_keep = []

    # 2. Compute deployment plan
    for path_key, entry in desired_files.items():
        local_path = os.path.join(server_dir, path_key)
        policy = entry.get("policy", "MANAGED")
        expected_size = entry.get("size")
        expected_sha256 = entry["hashes"]["sha256"]

        if policy == "PRESERVE" or is_protected(path_key):
            if os.path.exists(local_path):
                to_keep.append(path_key)
                continue

        if os.path.exists(local_path):
            local_size = os.path.getsize(local_path)
            if expected_size is not None and local_size != expected_size:
                to_download.append(entry)
                continue

            if compute_sha256(local_path) == expected_sha256:
                to_keep.append(path_key)
                continue

        to_download.append(entry)

    # Detect obsolete managed files from previous state
    to_delete = []
    for prev_path, info in prev_state.get("files", {}).items():
        if info.get("policy", "MANAGED") == "MANAGED" and prev_path not in desired_files and not is_protected(prev_path):
            to_delete.append(prev_path)

    print(
        f"[2/5] Deployment plan: {len(to_download)} to download, "
        f"{len(to_keep)} up-to-date, {len(to_delete)} obsolete to delete."
    )

    # 3. Create world backup only now (after validation succeeds)
    if not skip_backup:
        print("[3/5] Backing up server world...")
        backup_world(server_dir)
    else:
        print("[3/5] World backup skipped by flag.")

    # 4. Concurrent chunked streaming downloads to cache
    print("[4/5] Synchronizing server files...")
    downloaded_cache_paths = {}
    if to_download:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_file = {
                executor.submit(download_single_file, f, cache_dir, portal_url, pipeline_dir): f for f in to_download
            }
            for future in as_completed(future_to_file):
                rel_path, cached_file_path, cached = future.result()
                downloaded_cache_paths[rel_path] = cached_file_path
                status = "⚡ [Cache Hit]" if cached else "✓ [Downloaded]"
                size_bytes = os.path.getsize(cached_file_path)
                size_kb = size_bytes / 1024
                print(f"  {status} {rel_path} ({size_kb:.1f} KB)")

    # Atomic copy from cache to server directory
    for rel_path, cached_file_path in downloaded_cache_paths.items():
        dest_path = os.path.join(server_dir, rel_path)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        tmp_dest = f"{dest_path}.tmp.{os.getpid()}"
        shutil.copy2(cached_file_path, tmp_dest)
        os.replace(tmp_dest, dest_path)
        print(f"  ✓ [Replaced] {rel_path}")

    # Delete obsolete managed files
    for rel_path in to_delete:
        full_path = os.path.join(server_dir, rel_path)
        if os.path.exists(full_path):
            os.remove(full_path)
            print(f"  🗑 [Deleted Obsolete] {rel_path}")

    # 5. Reconcile server.properties resource-pack settings
    srp_config = manifest.get("resourcePack")
    prev_srp_state = prev_state.get("serverResourcePack")
    reconcile_server_properties(server_dir, srp_config, prev_srp_state)

    # 6. Final verification pass: ensure all MANAGED files exist and match hashes
    print("[5/5] Performing final verification pass...")
    for f in manifest.get("files", []):
        if f.get("policy", "MANAGED") == "MANAGED":
            local_path = os.path.join(server_dir, f["path"])
            if not os.path.exists(local_path):
                raise RuntimeError(f"Final verification failed: missing managed file '{f['path']}'")
            if f.get("size") is not None and os.path.getsize(local_path) != f["size"]:
                raise RuntimeError(f"Final verification failed: size mismatch for '{f['path']}'")
            actual_hash = compute_sha256(local_path)
            if actual_hash != f["hashes"]["sha256"]:
                raise RuntimeError(
                    f"Final verification failed: SHA-256 mismatch for '{f['path']}' "
                    f"(expected: {f['hashes']['sha256']}, actual: {actual_hash})"
                )

    if srp_config:
        props = read_server_properties_map(server_dir)
        if props.get("resource-pack") != srp_config.get("url", ""):
            raise RuntimeError("Final verification failed: server.properties 'resource-pack' mismatch")
        if props.get("resource-pack-sha1") != srp_config.get("sha1", ""):
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-sha1' mismatch")
        expected_id = srp_config.get("id") or srp_config.get("uuid", "")
        if props.get("resource-pack-id") != expected_id:
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-id' mismatch")
        expected_prompt = srp_config.get("prompt", "")
        if props.get("resource-pack-prompt") != expected_prompt:
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-prompt' mismatch")
        expected_req = str(srp_config.get("required", True)).lower()
        if props.get("require-resource-pack") != expected_req:
            raise RuntimeError("Final verification failed: server.properties 'require-resource-pack' mismatch")
    elif prev_srp_state and prev_srp_state.get("managed"):
        props = read_server_properties_map(server_dir)
        if props.get("resource-pack", "") != "":
            raise RuntimeError("Final verification failed: server.properties 'resource-pack' was not cleared on pack removal")
        if props.get("resource-pack-sha1", "") != "":
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-sha1' was not cleared on pack removal")
        if props.get("resource-pack-id", "") != "":
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-id' was not cleared on pack removal")
        if props.get("resource-pack-prompt", "") != "":
            raise RuntimeError("Final verification failed: server.properties 'resource-pack-prompt' was not cleared on pack removal")
        if props.get("require-resource-pack", "false").lower() != "false":
            raise RuntimeError("Final verification failed: server.properties 'require-resource-pack' was not reset to false on pack removal")

    # 7. Write installation state LAST (only after all mutations & verification succeed)
    new_state = {
        "pack": manifest.get("pack", "Lampas"),
        "version": manifest.get("version", "2.0.0"),
        "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": {
            f["path"]: {
                "sha256": f["hashes"]["sha256"],
                "size": f["size"],
                "policy": f.get("policy", "MANAGED"),
            }
            for f in manifest.get("files", [])
        },
    }

    if srp_config:
        new_state["serverResourcePack"] = {
            "managed": True,
            "artifact": srp_config["artifact"],
            "url": srp_config["url"],
            "sha1": srp_config.get("sha1", ""),
            "sha256": srp_config["sha256"],
            "id": srp_config.get("id") or srp_config.get("uuid", ""),
            "required": srp_config.get("required", True),
        }
    elif prev_srp_state and prev_srp_state.get("managed"):
        new_state["serverResourcePack"] = {"managed": False}

    with open(installation_file, "w", encoding="utf-8") as f:
        json.dump(new_state, f, indent=2)

    print("\n" + "=" * 60)
    print(f" [OK] Server successfully synchronized to {manifest.get('pack')} v{manifest.get('version')}!")
    print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="Lampas Dedicated Server Pack Deployment & Sync Engine")
    parser.add_argument("--manifest", help="Path to server-manifest.json", default="")
    parser.add_argument(
        "--server-dir",
        help="Path to dedicated server directory (default: current directory or script directory)",
        default="",
    )
    parser.add_argument(
        "--portal-url",
        help="Lampas Portal URL (default: https://dev.lampas.town)",
        default=DEFAULT_PORTAL_URL,
    )
    parser.add_argument("--channel", help="Release channel (stable/beta/dev)", default=DEFAULT_CHANNEL)
    parser.add_argument(
        "--pipeline-dir",
        help="Path to lampas-pipeline repo (for local artifact development cache)",
        default="",
    )
    parser.add_argument(
        "--allow-local-fallback",
        action="store_true",
        help="Allow fallback to nearby pipeline checkout if Portal is unreachable",
    )
    parser.add_argument("--skip-backup", action="store_true", help="Skip creating a world backup")
    parser.add_argument("--workers", type=int, default=8, help="Concurrent download worker count")

    args = parser.parse_args()

    # Determine effective server directory
    if args.server_dir:
        server_dir = os.path.abspath(args.server_dir)
    elif os.path.exists(os.path.join(os.getcwd(), "server.properties")) or os.path.exists(
        os.path.join(os.getcwd(), ".lampas")
    ):
        server_dir = os.path.abspath(os.getcwd())
    else:
        server_dir = os.path.dirname(os.path.abspath(__file__))

    print("=" * 60)
    print(" Lampas Server Deployment Pipeline (Linux / Windows)")
    print(f" Server Directory: {server_dir}")
    print("=" * 60)

    manifest = load_manifest(
        args.manifest,
        args.portal_url,
        args.channel,
        allow_local_fallback=args.allow_local_fallback,
        server_dir=server_dir,
    )
    sync_server(
        manifest,
        server_dir,
        args.portal_url,
        args.pipeline_dir,
        max_workers=args.workers,
        skip_backup=args.skip_backup,
    )


if __name__ == "__main__":
    main()