#!/usr/bin/env bash
# Lampas Minecraft Server Scheduled Restart Script with In-Game Warnings
# Intended to be triggered daily at 09:55:00 UTC by lampas-server-restart.timer

set -euo pipefail

log() {
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [ScheduledRestart] $*"
}

send_announcement() {
    local msg="$1"
    log "Broadcasting: $msg"
    if /usr/local/bin/rcon "say $msg" >/dev/null 2>&1; then
        log "Broadcast sent successfully."
    else
        log "Notice: RCON unreachable or server offline. Skipping broadcast."
    fi
}

send_command() {
    local cmd="$1"
    log "Executing RCON command: $cmd"
    if /usr/local/bin/rcon "$cmd" >/dev/null 2>&1; then
        log "RCON command executed successfully."
    else
        log "Notice: RCON command failed (server may be offline)."
    fi
}

log "=================================================="
log "Starting scheduled daily restart countdown (Target: 10:00:00 UTC)"
log "=================================================="

# 1. 5-minute warning (09:55 UTC)
send_announcement "[Scheduled Restart] Server will restart in 5 minutes (at 10:00 UTC)."
sleep 120

# 2. 3-minute warning (09:57 UTC)
send_announcement "[Scheduled Restart] Server will restart in 3 minutes."
sleep 120

# 3. 1-minute warning (09:59 UTC)
send_announcement "[Scheduled Restart] Server will restart in 1 minute. Please find a safe place to disconnect!"
sleep 60

# 4. Final restart sequence (10:00 UTC)
log "Target time (10:00 UTC) reached. Initiating restart sequence..."
send_announcement "[Scheduled Restart] Server is restarting now..."
send_command "save-all"
sleep 3

# 5. Restart systemd service
log "Restarting lampas-server.service..."
systemctl restart lampas-server.service
sleep 3

# 6. Verify service status
if systemctl is-active --quiet lampas-server.service; then
    log "✓ lampas-server.service restart triggered successfully."
else
    log "✗ Error: lampas-server.service failed to restart!"
    exit 1
fi

log "=================================================="
log "Scheduled restart procedure finished."
log "=================================================="