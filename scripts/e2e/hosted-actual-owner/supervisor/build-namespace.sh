#!/bin/sh
set -eu
# Root-only materialization command, not an implementation-worker gate.
test "$#" -eq 1
case "$1" in /*) ;; *) exit 64 ;; esac
test -d "$1"
test ! -e "$1/namespace-entry"
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cc -std=c17 -O2 -Wall -Wextra -Werror -fstack-protector-strong \
  "$source_dir/namespace-entry.c" -o "$1/namespace-entry"
chmod 0500 "$1/namespace-entry"
