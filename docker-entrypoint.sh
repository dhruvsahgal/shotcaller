#!/bin/sh
set -eu
# Only the application's dedicated persistent mount is owned by this service.
if [ "${DATA_DIR:-/data}" != /data ]; then
  echo 'Container DATA_DIR must be /data' >&2
  exit 1
fi
mkdir -p /data
chown -R pwuser:pwuser /data
chmod 700 /data
exec runuser -u pwuser -- node /app/app/server.mjs
