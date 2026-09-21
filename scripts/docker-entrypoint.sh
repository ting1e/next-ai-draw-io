#!/bin/sh
# Runs as root on start so a bind-mounted ./data directory (which keeps the
# host's ownership) can be made writable by the unprivileged app user, then
# drops privileges before running migrations and the server.
set -e

if [ "$(id -u)" = "0" ]; then
    mkdir -p /app/data
    chown -R nextjs:nodejs /app/data

    # Migrations must succeed before the app serves traffic.
    su-exec nextjs:nodejs node scripts/migrate.mjs

    # exec so the server becomes PID 1 and receives shutdown signals.
    exec su-exec nextjs:nodejs node server.js
fi

node scripts/migrate.mjs
exec node server.js
