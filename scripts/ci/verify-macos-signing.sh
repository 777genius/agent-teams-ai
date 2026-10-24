#!/bin/bash
set -euo pipefail

APP_BUNDLE="${1:?Usage: verify-signing.sh APP_BUNDLE [--notarized]}"
EXPECTED_TEAM="86399583GS"
if [ ! -d "$APP_BUNDLE" ] || [[ "$APP_BUNDLE" != *.app ]]; then
    echo "Expected an existing .app bundle: $APP_BUNDLE" >&2
    exit 1
fi
if [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != --notarized ]; }; then
    echo "Usage: verify-signing.sh APP_BUNDLE [--notarized]" >&2
    exit 1
fi

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
while IFS= read -r -d '' binary; do
    if file -b "$binary" | grep -q 'Mach-O'; then
        codesign --verify --strict --verbose=2 "$binary"
        archs="$(lipo -archs "$binary")"
        for arch in $archs; do
            verify_publisher "$binary" "$arch"
        done
    fi
done < <(find "$APP_BUNDLE" -type f -print0)

if [ "${2:-}" = --notarized ]; then
    xcrun stapler validate "$APP_BUNDLE"
    spctl --assess --type execute --verbose=2 "$APP_BUNDLE"
fi
