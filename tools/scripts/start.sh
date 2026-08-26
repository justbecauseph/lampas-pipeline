#!/usr/bin/env bash
# Lampas Minecraft Server Startup Wrapper for Linux
set -e
cd "$(dirname "$0")"

# Force unbuffered standard streams for Python
export PYTHONUNBUFFERED=1

# Source SDKMAN if available
export SDKMAN_DIR="${HOME:-/home/server}/.sdkman"
if [ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]; then
    source "$SDKMAN_DIR/bin/sdkman-init.sh"
fi

# Load environment variables if available
if [ -f "./.minecraft-env" ]; then
    set -a
    source "./.minecraft-env"
    set +a
fi

exec python3 start.py "$@"