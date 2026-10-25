#!/bin/bash
set -euo pipefail

APP_BUNDLE="${1:?Usage: verify-signing.sh APP_BUNDLE [--notarized]}"
EXPECTED_TEAM="86399583GS"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ ! -d "$APP_BUNDLE" ] || [[ "$APP_BUNDLE" != *.app ]]; then
    echo "Expected an existing .app bundle: $APP_BUNDLE" >&2
    exit 1
fi
if [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != --notarized ]; }; then
    echo "Usage: verify-signing.sh APP_BUNDLE [--notarized]" >&2
    exit 1
fi

# Apple's ticket and Gatekeeper services sometimes drop connections from hosted
# runners. Only these NSURLErrorDomain codes are retried: timed out (-1001),
# host not found (-1003), cannot connect (-1004), connection lost (-1005) and
# offline (-1009). Any other failure, including a missing ticket or a Gatekeeper
# rejection, fails on the first attempt.
APPLE_NETWORK_FAILURE='NSURLErrorDomain Code=-10(01|03|04|05|09)([^0-9]|$)'
APPLE_NETWORK_ATTEMPTS=3
APPLE_NETWORK_RETRY_DELAY_SECONDS=20

run_apple_network_check() {
    local attempt output status
    for ((attempt = 1; ; attempt += 1)); do
        output="$("$@" 2>&1)" && status=0 || status=$?
        printf '%s\n' "$output"
        if [ "$status" -eq 0 ]; then
            return 0
        fi
        if [ "$attempt" -ge "$APPLE_NETWORK_ATTEMPTS" ] || ! grep -Eq "$APPLE_NETWORK_FAILURE" <<< "$output"; then
            return "$status"
        fi
        echo "Transient Apple network failure from '$*' (attempt $attempt/$APPLE_NETWORK_ATTEMPTS); retrying in $((attempt * APPLE_NETWORK_RETRY_DELAY_SECONDS))s" >&2
        sleep "$((attempt * APPLE_NETWORK_RETRY_DELAY_SECONDS))"
    done
}

verify_publisher() {
    local metadata
    metadata="$(codesign --display --architecture "$2" --verbose=4 "$1" 2>&1)" || return 1
    if ! grep -Fxq "TeamIdentifier=$EXPECTED_TEAM" <<< "$metadata" ||
        ! grep -Eq '^Authority=Developer ID Application: .+ \(86399583GS\)$' <<< "$metadata"; then
        echo "Wrong publisher or ad-hoc signature: $1" >&2
        return 1
    fi
    if [ "$1" = "$APP_BUNDLE" ] && ! grep -Eq '^CodeDirectory .*flags=.*\(.*runtime.*\)' <<< "$metadata"; then
        echo "Missing hardened runtime: $1" >&2
        return 1
    fi
}

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_BUNDLE/Contents/Info.plist")"
outer_archs="$(lipo -archs "$APP_BUNDLE/Contents/MacOS/$executable")"
for arch in $outer_archs; do
    verify_publisher "$APP_BUNDLE" "$arch"
done

# Ask file(1) only about files that start with a Mach-O magic number. The
# bundled runtime ships about 95k files, and one file(1) process per file took
# up to 33 minutes per bundle on the 4-vCPU Intel runner. The pre-filter and
# find(1) must count the same regular files, every announced candidate must be
# read, and the main executable must be among the verified binaries; otherwise
# the check fails closed.
candidate_report="$(mktemp "${TMPDIR:-/tmp}/verify-macos-signing.XXXXXX")"
trap 'rm -f "$candidate_report"' EXIT
node "$SCRIPT_DIR/list-macho-candidates.mjs" "$APP_BUNDLE" > "$candidate_report"
regular_files="$(find "$APP_BUNDLE" -type f -print0 | tr -cd '\0' | wc -c | tr -d ' ')"

candidates_read=0
mach_o_binaries=0
main_executable_checked=false
{
    IFS= read -r -d '' scanned_files <&3 || scanned_files=missing
    IFS= read -r -d '' announced_candidates <&3 || announced_candidates=missing
    if [ "$scanned_files" != "$regular_files" ] || [[ ! "$announced_candidates" =~ ^[0-9]+$ ]]; then
        echo "Mach-O scan covered $scanned_files of $regular_files regular files ($announced_candidates candidates)" >&2
        exit 1
    fi
    while IFS= read -r -d '' binary <&3; do
        candidates_read=$((candidates_read + 1))
        if [[ "$binary" != "$APP_BUNDLE"/* ]] || [ -L "$binary" ] || [ ! -f "$binary" ]; then
            echo "Unexpected Mach-O candidate: $binary" >&2
            exit 1
        fi
        description="$(file -b "$binary")"
        if [[ "$description" != *Mach-O* ]]; then
            # Java class files share the universal-binary magic number, and
            # file(1) also calls a universal header with many architectures
            # Java. Skip only what lipo cannot read as a universal binary; any
            # other file with a Mach-O magic number must be a real binary.
            if [[ "$description" != "compiled Java class data"* ]]; then
                echo "File with a Mach-O magic number is not a Mach-O binary: $binary ($description)" >&2
                exit 1
            fi
            if ! lipo -archs "$binary" > /dev/null 2>&1; then
                echo "Skipping Java class file: $binary"
                continue
            fi
        fi
        mach_o_binaries=$((mach_o_binaries + 1))
        if [ "$binary" = "$APP_BUNDLE/Contents/MacOS/$executable" ]; then
            main_executable_checked=true
        fi
        codesign --verify --strict --verbose=2 "$binary"
        archs="$(lipo -archs "$binary")"
        for arch in $archs; do
            verify_publisher "$binary" "$arch"
        done
    done
} 3< "$candidate_report"

if [ "$candidates_read" -ne "$announced_candidates" ]; then
    echo "Read $candidates_read of $announced_candidates Mach-O candidates" >&2
    exit 1
fi
if [ "$main_executable_checked" != true ]; then
    echo "Main executable was not among the verified Mach-O binaries" >&2
    exit 1
fi
echo "Verified $mach_o_binaries Mach-O binaries among $regular_files files"

if [ "${2:-}" = --notarized ]; then
    run_apple_network_check xcrun stapler validate "$APP_BUNDLE"
    run_apple_network_check spctl --assess --type execute --verbose=2 "$APP_BUNDLE"
fi
