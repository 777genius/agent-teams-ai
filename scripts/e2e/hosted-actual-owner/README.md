# Hosted actual-owner E2E harness

This is the isolated P3.C product harness. It accepts only a fully integrated, exact-identity
manifest and runs real product, built orchestrator owner, immutable OpenCode, and Playwright Chromium
processes inside the marker-owned disposable sandbox. It never changes production gates or locks.

The checked-in `integration-manifest.unintegrated.json` is intentionally non-runnable. A controller
must replace every nullable identity with independently reviewed full commits, artifact-layer hashes,
and absolute single-link inputs. The parser pins upstream OpenCode `v1.18.23` at
`ef2880f379129aa048be9e9353e30aa168d42c17`, orchestrator PR 45, one controller nonce, one sandbox,
and one final run. `finalRunAuthorized` remains false until the exact-input freeze is accepted.

Run focused contracts with:

`pnpm exec vitest run test/e2e/fixtures/hosted-actual-owner/harness.test.ts`

The final command, only after separate run authority, is:

`node --import tsx scripts/e2e/hosted-actual-owner/run.ts --integration-manifest /absolute/private/integration-manifest.json`

Pass is derived from raw HTTP, SSE, owner WAL, OpenCode effect, supervisor, and browser records. The
summary and Playwright exit code are indexes only. Ambiguous provider delivery never retries without
an explicit `not_delivered` reconciliation result.
