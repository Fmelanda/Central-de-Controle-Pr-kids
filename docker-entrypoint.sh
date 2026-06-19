#!/bin/sh
set -e

mkdir -p /app/data /app/data/media

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  exec su-exec node "$@"
fi

exec "$@"
