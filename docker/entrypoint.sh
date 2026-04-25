#!/usr/bin/env bash
# tocco-mate Docker entrypoint
# LinuxServer.io-style PUID/PGID handling so the in-container `app` user
# matches the host UID/GID that owns the bind-mounted ./data volume.
#
# Without this, the container's `app` user (whatever UID Linux happened
# to assign) cannot write to a host directory owned by a different user
# (Unraid: 99/100, typical Linux: 1000/1000, etc).

set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
TZ="${TZ:-Europe/Zurich}"

# Apply timezone so logs + Telegram timestamps render in local time.
if [[ -f "/usr/share/zoneinfo/$TZ" ]]; then
    ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime
    echo "$TZ" > /etc/timezone
else
    echo "[entrypoint] WARN: unknown TZ '$TZ' — falling back to Europe/Zurich"
    TZ="Europe/Zurich"
    ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime
    echo "$TZ" > /etc/timezone
fi
export TZ

current_uid="$(id -u app)"
current_gid="$(id -g app)"

if [[ "$current_gid" != "$PGID" ]]; then
    groupmod -o -g "$PGID" app
fi

if [[ "$current_uid" != "$PUID" ]]; then
    usermod -o -u "$PUID" app
fi

# Recursive chown so existing files written by an older container UID get
# repaired on upgrade. The data volume only holds SQLite + a few small JSON
# files, so this stays fast.
chown -R app:app /app/data /home/app

echo "[entrypoint] running as app (uid=$PUID gid=$PGID, tz=$TZ)"

exec gosu app "$@"
