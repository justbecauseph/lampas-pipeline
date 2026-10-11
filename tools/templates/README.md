
# Systemd Units & Timers:

- `/etc/systemd/system/lampas-server.service`
- `/etc/systemd/system/lampas-server-restart.timer`
- `/etc/systemd/system/lampas-server-restart.service`
- `/etc/systemd/system/lampas-discord-monitor.service`

# Scripts:

- `/usr/local/bin/lampasctl start`
- `/usr/local/bin/lampasctl restart`
- `/usr/local/bin/lampasctl monitor`

# Env

- `/home/server/.minecraft-env`

# Extra config

- `/home/server/log4j2.xml`

# Requirements

- Java (OpenJDK 25)
- `lampasctl` (standalone executable placed at `/usr/local/bin/lampasctl`)
