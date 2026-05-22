#!/bin/bash
set -e

# Fix chrome-sandbox permissions for SUID sandbox on Linux
# See: https://github.com/electron/electron/issues/17972

SANDBOX_PATH="/opt/${sanitizedProductName}/chrome-sandbox"

if [ -f "$SANDBOX_PATH" ]; then
  chown root:root "$SANDBOX_PATH"
  chmod 4755 "$SANDBOX_PATH"
fi
