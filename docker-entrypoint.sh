#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  su-exec node mkdir -p /app/data/media
  exec su-exec node "$@"
fi

mkdir -p /app/data/media
exec "$@"
