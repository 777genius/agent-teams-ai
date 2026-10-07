#!/bin/bash
set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_DIR="${1:-release}"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-teams-archives.XXXXXX")"
MOUNT_POINT=""
cleanup() {
    local status=$?
    if [ -n "$MOUNT_POINT" ]; then
        if ! hdiutil detach "$MOUNT_POINT"; then
            echo "Could not detach owned mount; retaining $TEMP_ROOT" >&2
            exit 1
        fi
    fi
    rm -rf "$TEMP_ROOT"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_contents() {
    local bundles=("$1"/*.app)
    if [ "${#bundles[@]}" -ne 1 ] || [ "${bundles[0]}" != "$1/Agent Teams AI.app" ] ||
        [ ! -d "${bundles[0]}" ] || [ -L "${bundles[0]}" ]; then
        echo "Expected exactly one Agent Teams AI.app in $1" >&2
        return 1
    fi
    bash "$SCRIPT_DIR/verify-macos-signing.sh" "${bundles[0]}" --notarized
}

archives=("$ARCHIVE_DIR"/*.zip "$ARCHIVE_DIR"/*.dmg)
if [ "${#archives[@]}" -eq 0 ]; then
    echo "No macOS ZIP or DMG archives found in $ARCHIVE_DIR" >&2
    exit 1
fi
for archive in "${archives[@]}"; do
    echo "Verifying transported app: $archive"
    case "$archive" in
        *.zip)
            extract_root="$(mktemp -d "$TEMP_ROOT/zip.XXXXXX")"
            ditto -x -k "$archive" "$extract_root"
            verify_contents "$extract_root"
            ;;
        *.dmg)
            MOUNT_POINT="$(mktemp -d "$TEMP_ROOT/mount.XXXXXX")"
            hdiutil attach "$archive" -readonly -nobrowse -mountpoint "$MOUNT_POINT"
            verify_contents "$MOUNT_POINT"
            hdiutil detach "$MOUNT_POINT"
            MOUNT_POINT=""
            ;;
    esac
done
