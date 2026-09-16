#!/usr/bin/env python3
"""
Lampas Minecraft Server Discord Status Monitor
----------------------------------------------
Continuously polls the Minecraft server via Server List Ping (SLP) on port 25576.
Sends Discord webhook notifications when the server transitions between
ONLINE & JOINABLE and OFFLINE.

Features:
- Pure Python standard library (no external pip dependencies).
- Native Minecraft SLP ping verification (tests actual player join gateway).
- Debouncing to prevent false alerts during momentary tick stalls.
- Persistent state tracking across daemon restarts.
"""

import os
import sys
import time
import json
import socket
import struct
import urllib.request
from datetime import datetime, timezone

def get_webhook_url():
    """Resolves DISCORD_WEBHOOK_URL from environment or /home/server/.minecraft-env."""
    url = os.getenv("DISCORD_WEBHOOK_URL")
    if url:
        return url.strip()

    env_path = "/home/server/.minecraft-env"
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DISCORD_WEBHOOK_URL="):
                        return line.split("=", 1)[1].strip().strip("\"'")
        except Exception:
            pass
    return ""


WEBHOOK_URL = get_webhook_url()
MC_HOST = os.getenv("MC_HOST", "127.0.0.1")
MC_PORT = int(os.getenv("MC_PORT", "25576"))
PUBLIC_ADDRESS = os.getenv("MC_PUBLIC_ADDRESS", "play.lampas.town:25576")

# State persistence path
STATE_FILE = os.getenv("MONITOR_STATE_FILE", os.path.expanduser("~/.lampas-monitor-state.json"))

# Timing configuration
POLL_INTERVAL_SEC = 10      # How often to check the server
FAILURE_THRESHOLD = 2       # Number of consecutive failures required before declaring OFFLINE
SOCKET_TIMEOUT_SEC = 4      # Timeout for SLP ping socket


def pack_varint(val):
    """Encodes an integer into Minecraft VarInt format."""
    total = b""
    while True:
        b = val & 0x7F
        val >>= 7
        if val != 0:
            b |= 0x80
        total += struct.pack("B", b)
        if val == 0:
            break
    return total


def read_varint(sock):
    """Reads a VarInt from a network socket."""
    val = 0
    for i in range(5):
        b = sock.recv(1)
        if not b:
            raise ConnectionError("Connection closed while reading VarInt")
        byte = ord(b)
        val |= (byte & 0x7F) << (7 * i)
        if not (byte & 0x80):
            break
    return val


def ping_minecraft(host, port, timeout=SOCKET_TIMEOUT_SEC):
    """
    Performs a Minecraft Server List Ping (SLP) handshake.
    Returns parsed status JSON if joinable, raises Exception if offline.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect((host, port))

        # Handshake Packet: ID 0, Protocol 767 (MC 1.21.x / 26.2), Host, Port, Next State = 1 (Status)
        encoded_host = host.encode("utf-8")
        handshake_data = (
            pack_varint(0) +
            pack_varint(767) +
            pack_varint(len(encoded_host)) +
            encoded_host +
            struct.pack(">H", port) +
            pack_varint(1)
        )
        sock.sendall(pack_varint(len(handshake_data)) + handshake_data)

        # Status Request Packet: ID 0
        status_req = pack_varint(0)
        sock.sendall(pack_varint(len(status_req)) + status_req)

        # Read Response Packet
        packet_len = read_varint(sock)
        packet_id = read_varint(sock)
        json_len = read_varint(sock)

        response_bytes = bytearray()
        while len(response_bytes) < json_len:
            chunk = sock.recv(min(json_len - len(response_bytes), 4096))
            if not chunk:
                break
            response_bytes.extend(chunk)

        if not response_bytes:
            raise ConnectionError("Empty status response from server")

        return json.loads(response_bytes.decode("utf-8", errors="replace"))


def send_discord_webhook(payload):
    """Dispatches payload to configured Discord webhook endpoint."""
    if not WEBHOOK_URL:
        print("[Monitor Error] No webhook URL configured.", file=sys.stderr)
        return False

    req = urllib.request.Request(
        WEBHOOK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "LampasStatusMonitor/1.0"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status in (200, 204)
    except Exception as err:
        print(f"[Monitor Error] Failed to send Discord webhook: {err}", file=sys.stderr)
        return False


def notify_server_online(info):
    """Sends green online alert embed to Discord."""
    now_iso = datetime.now(timezone.utc).isoformat()
    players = info.get("players", {})
    version_info = info.get("version", {})
    ver_name = version_info.get("name", "26.2 (Fabric)")
    online_players = players.get("online", 0)
    max_players = players.get("max", 300)

    payload = {
        "username": "Lampas Status",
        "embeds": [
            {
                "title": "🟢 Lampas 2 Server is Online",
                "description": "The Minecraft server has initialized and is accepting player connections.",
                "color": 3066993,  # Green (#2ecc71)
                "fields": [
                    {"name": "Server Address", "value": f"`{PUBLIC_ADDRESS}`", "inline": True},
                    {"name": "Version", "value": f"{ver_name}", "inline": True},
                    {"name": "Players Online", "value": f"{online_players} / {max_players}", "inline": True}
                ],
                "timestamp": now_iso,
                "footer": {"text": "play.lampas.town • System Health Monitor"}
            }
        ]
    }
    return send_discord_webhook(payload)


def notify_server_offline():
    """Sends red offline alert embed to Discord."""
    now_iso = datetime.now(timezone.utc).isoformat()
    now_epoch = int(time.time())

    payload = {
        "username": "Lampas Status",
        "embeds": [
            {
                "title": "🔴 Lampas 2 Server is Offline",
                "description": "The Minecraft server is currently stopped or unreachable. Player connections are unavailable.",
                "color": 15158332,  # Red (#e74c3c)
                "fields": [
                    {"name": "Server Address", "value": f"`{PUBLIC_ADDRESS}`", "inline": True},
                    {"name": "Status", "value": "Offline / Unreachable", "inline": True},
                    {"name": "Downtime Started", "value": f"<t:{now_epoch}:R>", "inline": True}
                ],
                "timestamp": now_iso,
                "footer": {"text": "play.lampas.town • System Health Monitor"}
            }
        ]
    }
    return send_discord_webhook(payload)


def load_state():
    """Loads previous state from disk."""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"status": "UNKNOWN", "last_changed": 0}


def save_state(state):
    """Saves current state to disk."""
    try:
        os.makedirs(os.path.dirname(os.path.abspath(STATE_FILE)), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as err:
        print(f"[Monitor Warning] Could not save state: {err}", file=sys.stderr)


def main():
    print(f"[Monitor] Starting Lampas Minecraft Server Discord Monitor...")
    print(f"[Monitor] Polling target: {MC_HOST}:{MC_PORT} every {POLL_INTERVAL_SEC}s (Threshold: {FAILURE_THRESHOLD})")
    print(f"[Monitor] Public address advertised: {PUBLIC_ADDRESS}")

    state = load_state()
    consecutive_failures = 0
    current_status = state.get("status", "UNKNOWN")

    while True:
        try:
            status_info = ping_minecraft(MC_HOST, MC_PORT)
            # Ping succeeded -> Server is ONLINE & JOINABLE
            consecutive_failures = 0

            if current_status != "ONLINE":
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Server transitioned from {current_status} -> ONLINE")
                notify_server_online(status_info)
                current_status = "ONLINE"
                state["status"] = "ONLINE"
                state["last_changed"] = time.time()
                save_state(state)

        except Exception as err:
            consecutive_failures += 1
            if current_status == "ONLINE":
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Server ping failed ({consecutive_failures}/{FAILURE_THRESHOLD}): {err}")

            if consecutive_failures >= FAILURE_THRESHOLD and current_status != "OFFLINE":
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Failure threshold reached. Transitioning -> OFFLINE")
                notify_server_offline()
                current_status = "OFFLINE"
                state["status"] = "OFFLINE"
                state["last_changed"] = time.time()
                save_state(state)

        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()