#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Caddy volume ownership initialization requires root' >&2
  exit 65
fi

# Docker copy-up can leave these fixed Caddy directories root-owned. Change only
# these directory entries; certificates, keys, and other descendants are untouched.
for directory in /data /config /data/caddy /config/caddy; do
  case "$directory" in
    /data/caddy|/config/caddy)
      if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
        continue
      fi
      ;;
  esac
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then
    echo "Caddy volume path is not a directory: $directory" >&2
    exit 66
  fi
  case "$(stat -c '%u:%g' "$directory")" in
    0:0) chown 1000:1000 "$directory" ;;
    1000:1000) ;;
    *)
      echo "Caddy volume path has an unexpected owner: $directory" >&2
      exit 67
      ;;
  esac
  if [ "$(stat -c '%u:%g' "$directory")" != '1000:1000' ]; then
    echo "Caddy volume ownership initialization failed: $directory" >&2
    exit 68
  fi
done
