#!/bin/sh
set -eu
# Explicit output only. The selected supervisor closure must subsequently pin this ELF.
test "$#" -eq 1
case "$1" in /*) ;; *) exit 64 ;; esac
test -d "$1"
test ! -e "$1/owner-launch"
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cc -std=c17 -O2 -Wall -Wextra -Werror -fstack-protector-strong \
  "$source_dir/owner-launch.c" -o "$1/owner-launch"
chmod 0500 "$1/owner-launch"
