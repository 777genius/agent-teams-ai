#!/bin/sh

set -eu

readonly initializer_mode="${1:-}"

if [ "$#" -ne 1 ]; then
  echo 'usage: hosted-volume-init <caddy-trust|lifecycle-trust-anchor|oidc-client-secret>' >&2
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
  lifecycle-trust-anchor)
    if [ "$(id -u)" -ne 1000 ]; then
      echo 'lifecycle trust initialization must run as the application uid' >&2
      exit 78
    fi

    readonly source_anchor='/run/secrets/lifecycle_orchestrator_trust_anchor'
    readonly source_release_pin='/run/secrets/lifecycle_owner_release_pin'
    readonly runtime_directory='/run/agent-teams-lifecycle-trust'
    readonly runtime_anchor="$runtime_directory/trust-anchor"
    readonly runtime_release_pin="$runtime_directory/release-owner-pin.json"

    if [ ! -f "$source_anchor" ] || [ -L "$source_anchor" ]; then
      echo 'lifecycle trust source is not a regular file' >&2
      exit 79
    fi
    if [ ! -f "$source_release_pin" ] || [ -L "$source_release_pin" ]; then
      echo 'lifecycle release pin source is not a regular file' >&2
      exit 79
    fi
    if [ ! -d "$runtime_directory" ] || [ -L "$runtime_directory" ]; then
      echo 'lifecycle trust runtime directory is unavailable' >&2
      exit 80
    fi
    if [ ! -f "$runtime_anchor" ] || [ -L "$runtime_anchor" ]; then
      echo 'lifecycle trust placeholder is unavailable' >&2
      exit 81
    fi
    if [ ! -f "$runtime_release_pin" ] || [ -L "$runtime_release_pin" ]; then
      echo 'lifecycle release pin placeholder is unavailable' >&2
      exit 81
    fi
    for runtime_trust_file in "$runtime_anchor" "$runtime_release_pin"; do
      case "$(stat -c '%u:%g:%a' "$runtime_trust_file")" in
        1000:1000:600|1000:1000:400) ;;
        *)
          echo 'lifecycle trust placeholder permissions are unsafe' >&2
          exit 82
          ;;
      esac
    done
    if [ -n "$(find "$runtime_directory" -mindepth 1 -maxdepth 1 ! -name trust-anchor ! -name release-owner-pin.json -print -quit)" ]; then
      echo 'lifecycle trust volume contains an unexpected entry' >&2
      exit 83
    fi

    readonly source_size="$(stat -c '%s' "$source_anchor")"
    case "$source_size" in
      64) ;;
      65)
        if [ "$(tail -c 1 "$source_anchor" | od -An -tu1 | tr -d '[:space:]')" != '10' ]; then
          echo 'lifecycle trust source must contain exactly 64 lowercase hexadecimal characters' >&2
          exit 84
        fi
        ;;
      *)
        echo 'lifecycle trust source must contain exactly 64 lowercase hexadecimal characters' >&2
        exit 84
        ;;
    esac
    if ! LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$source_anchor"; then
      echo 'lifecycle trust source must contain exactly 64 lowercase hexadecimal characters' >&2
      exit 84
    fi
    readonly release_pin_size="$(stat -c '%s' "$source_release_pin")"
    case "$release_pin_size" in
      ''|*[!0-9]*)
        echo 'lifecycle release pin must be a bounded non-empty file' >&2
        exit 84
        ;;
    esac
    if [ "$release_pin_size" -lt 1 ] || [ "$release_pin_size" -gt 1024 ]; then
      echo 'lifecycle release pin must be a bounded non-empty file' >&2
      exit 84
    fi

    umask 077
    chmod 0600 "$runtime_anchor"
    chmod 0600 "$runtime_release_pin"
    install -m 0400 "$source_anchor" "$runtime_anchor"
    install -m 0400 "$source_release_pin" "$runtime_release_pin"
    for runtime_trust_file in "$runtime_anchor" "$runtime_release_pin"; do
      if [ "$(stat -c '%u:%g:%a' "$runtime_trust_file")" != '1000:1000:400' ]; then
        echo 'lifecycle trust handoff permissions are unsafe' >&2
        exit 85
      fi
    done
    ;;
  *)
    echo 'unknown hosted volume initializer mode' >&2
    exit 64
    ;;
esac
