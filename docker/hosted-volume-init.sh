#!/bin/sh

set -eu

readonly initializer_mode="${1:-}"

if [ "$#" -ne 1 ]; then
  echo 'usage: hosted-volume-init <caddy-trust|oidc-client-secret>' >&2
  exit 64
fi

case "$initializer_mode" in
  caddy-trust)
    if [ "$(id -u)" -ne 1000 ]; then
      echo 'caddy-trust initialization requires the Caddy volume owner uid' >&2
      exit 65
    fi

    readonly caddy_root='/caddy-data/caddy/pki/authorities/local'
    readonly root_certificate="$caddy_root/root.crt"
    readonly trust_directory='/caddy-trust'
    readonly trust_certificate="$trust_directory/root.crt"

    if [ ! -s "$root_certificate" ] || [ -L "$root_certificate" ]; then
      echo 'Caddy local root certificate is unavailable' >&2
      exit 66
    fi
    if [ ! -d "$trust_directory" ] || [ -L "$trust_directory" ]; then
      echo 'Caddy trust volume is unavailable' >&2
      exit 67
    fi
    if [ ! -f "$trust_certificate" ] || [ -L "$trust_certificate" ]; then
      echo 'Caddy trust placeholder is unavailable' >&2
      exit 68
    fi
    case "$(stat -c '%u:%g:%a' "$trust_certificate")" in
      1000:1000:600|1000:1000:444) ;;
      *)
        echo 'Caddy trust placeholder permissions are unsafe' >&2
        exit 69
        ;;
    esac
    if [ -n "$(find "$trust_directory" -mindepth 1 -maxdepth 1 ! -name root.crt -print -quit)" ]; then
      echo 'Caddy trust volume contains an unexpected entry' >&2
      exit 70
    fi

    umask 022
    chmod 0600 "$trust_certificate"
    install -m 0444 "$root_certificate" "$trust_certificate"
    if [ "$(stat -c '%u:%g:%a' "$trust_certificate")" != '1000:1000:444' ]; then
      echo 'Caddy trust handoff permissions are unsafe' >&2
      exit 71
    fi
    ;;
  oidc-client-secret)
    if [ "$(id -u)" -ne 1000 ]; then
      echo 'OIDC secret initialization must run as the application uid' >&2
      exit 72
    fi

    readonly source_secret='/run/secrets/oidc_client_secret'
    readonly runtime_directory='/run/agent-teams-oidc'
    readonly runtime_secret="$runtime_directory/oidc-client-secret"

    if [ ! -f "$source_secret" ] || [ -L "$source_secret" ]; then
      echo 'OIDC source secret is not a regular file' >&2
      exit 73
    fi
    if [ ! -d "$runtime_directory" ] || [ -L "$runtime_directory" ]; then
      echo 'OIDC runtime directory is unavailable' >&2
      exit 74
    fi
    if [ ! -f "$runtime_secret" ] || [ -L "$runtime_secret" ]; then
      echo 'OIDC runtime secret placeholder is unavailable' >&2
      exit 75
    fi
    if [ "$(stat -c '%u:%g' "$runtime_secret")" != '1000:1000' ]; then
      echo 'OIDC runtime secret placeholder has an unsafe owner' >&2
      exit 76
    fi

    umask 077
    chmod 0600 "$runtime_secret"
    install -m 0400 "$source_secret" "$runtime_secret"
    if [ "$(stat -c '%u:%g:%a' "$runtime_secret")" != '1000:1000:400' ]; then
      echo 'OIDC runtime secret handoff permissions are unsafe' >&2
      exit 77
    fi
    ;;
  *)
    echo 'unknown hosted volume initializer mode' >&2
    exit 64
    ;;
esac
