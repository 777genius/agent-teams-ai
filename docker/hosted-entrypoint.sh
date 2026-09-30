#!/bin/sh

set -eu

lock_parent=/data/.agent-teams/instance-lock
lock_name=instance.lock
lock_anchor="${lock_parent}/${lock_name}"

if [ "$#" -eq 0 ]; then
  echo 'instance_lock:entrypoint_refused:missing_command' >&2
  exit 64
fi

case "$1" in
  /*) ;;
  *)
    echo 'instance_lock:entrypoint_refused:command_must_be_absolute' >&2
    exit 64
    ;;
esac

runtime_gid="$(/usr/bin/id -g)" || {
  echo 'instance_lock:entrypoint_refused:runtime_gid_failed' >&2
  exit 74
}
state_security="$(/usr/bin/stat -c '%u:%g:%a' -- /data/.agent-teams)" || {
  echo 'instance_lock:entrypoint_refused:persistent_state_stat_failed' >&2
  exit 74
}
if [ "$state_security" != "0:${runtime_gid}:1770" ]; then
  echo 'instance_lock:entrypoint_refused:persistent_state_security_invalid' >&2
  exit 74
fi
if [ "$(/usr/bin/stat -c '%u:%g:%a' -- "$lock_parent")" != '0:0:555' ] \
  || [ "$(/usr/bin/stat -c '%u:%g:%a' -- "$lock_anchor")" != '0:0:444' ]; then
  echo 'instance_lock:entrypoint_refused:anchor_security_invalid' >&2
  exit 74
fi

lock_device="$(/usr/bin/stat -c '%d' -- "$lock_anchor")" || {
  echo 'instance_lock:entrypoint_refused:anchor_stat_failed' >&2
  exit 74
}
lock_inode="$(/usr/bin/stat -c '%i' -- "$lock_anchor")" || {
  echo 'instance_lock:entrypoint_refused:anchor_stat_failed' >&2
  exit 74
}

case "$lock_device:$lock_inode" in
  *[!0-9:]* | :* | *: | *:*:*)
    echo 'instance_lock:entrypoint_refused:anchor_identity_invalid' >&2
    exit 74
    ;;
esac

exec /app/bin/agent-teams-instance-lock \
  "$lock_parent" "$lock_name" "$lock_device" "$lock_inode" -- "$@"
