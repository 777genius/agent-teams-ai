#!/usr/bin/env bash

set -eu

export PHASE0_OWNED_CHANGES_HEAD="$(git rev-parse HEAD)"
export PHASE0_OWNED_CHANGES_STATUS="$(git status --porcelain=v1 --untracked-files=all)"

node scripts/hosted-web/phase-0/final-gate/verify-owned-changes.mjs --captured-git
