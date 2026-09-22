#!/usr/bin/env bash

set -eu

prior_base='42ec333848e29e97c41699b9fed73ed199740e3f'
paths=(
  test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts
  test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts
  test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts
  tsconfig.json
  package.json
  pnpm-lock.yaml
)

export PHASE0_RECONCILIATION_HEAD="$(git rev-parse HEAD)"
for index in "${!paths[@]}"; do
  path="${paths[$index]}"
  export "PHASE0_RECONCILIATION_${index}_PRIOR=$(git rev-parse "$prior_base:$path")"
  export "PHASE0_RECONCILIATION_${index}_HEAD=$(git rev-parse "HEAD:$path")"
done

node scripts/hosted-web/phase-0/final-gate/verify-typecheck-reconciliation.mjs --captured-git
