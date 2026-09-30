# Phase 0 estimate ledger

## Status

This is the 0A accounting baseline, not the post-inventory Phase 0 estimate freeze. It preserves the
parent plan's non-duplicated v1 range and gives each line one unique bucket. W1-W6 must replace the
assumptions with evidence-backed `estimate-input.json` records; 0D then regenerates this ledger.

Generated/vendor bundles, lockfile churn, mechanical formatting and post-v1 terminal work are
excluded. Production, focused tests, E2E, native guards and required docs/migrations are included.

## Unique v1 buckets

| Bucket ID | Packages / owned surface | Production/test/deleted net lines | Overlap rule | Confidence | Assumptions | Evidence refs |
| --- | --- | ---: | --- | --- | --- | --- |
| `EST-CONTRACTS` | Shared kernel; feature contracts; capability/route/architecture gates | 2.0k-3.0k | Count contract/schema/fixture edits once even when consumed by later phases. | high | ADR-19 scanner stays bounded and no mega-interface is introduced. | Parent plan estimate table; `P0.W1.ESTIMATE` pending |
| `EST-IDENTITY-WORKSPACE` | Team/member/workspace identity; workspace registry; ADR-28 guard | 3.5k-5.5k | Guard and identity fixtures belong here, not again in hosted composition. | medium | Legacy adoption remains compatible; final Linux probes do not force a new deployment model. | Parent plan; `P0.W4.ESTIMATE` pending |
| `EST-LIFECYCLE-RUNTIME` | Team lifecycle; runtime control; provider ingress; ADR-30/31 | 5.0k-8.0k | Provider fixtures and process ownership counted once across launch and security phases. | medium | Deterministic provisioning stays behind compatibility adapters. | Parent plan; `P0.W2.ESTIMATE` and `P0.W4.ESTIMATE` pending |
| `EST-RECOVERY-STATE` | Command/event recovery; external writers; SQLite coordination/backup | 4.5k-7.5k | Shared receipts, journals and state fixtures are not repeated per feature. | medium-low | Required provider JSON operations can be classified without a universal repository. | Parent plan; `P0.W3.ESTIMATE` and `P0.W5.ESTIMATE` pending |
| `EST-HOSTED-OPS` | Hosted composition; auth/proxy; build/package/runtime operations | 3.5k-5.5k | Build fixtures and auth topology counted once, not in E2E again. | medium | Existing standalone path can be evolved in place and required ABI artifacts are supportable. | Parent plan; `P0.W6.ESTIMATE` pending |
| `EST-RENDERER-LIFECYCLE` | Team console; transport reconciler; lifecycle-screen migration | 3.0k-5.0k | Renderer fixtures reused by parity closure stay in this bucket. | medium | Existing teamSlice/TeamDetail invariants can be preserved behind narrow facets. | Parent plan; `P0.W1.ESTIMATE` pending |
| `EST-REMAINING-PARITY` | Tasks, messaging, review, approvals, members and attachments | 4.0k-6.5k | A visible action belongs to one owning feature, never one row per old method and phase. | medium-low | W1 action inventory does not reveal a larger visible-screen dependency closure. | Parent plan; `P0.W1.ESTIMATE` pending |
| `EST-RELEASE-E2E` | Real-browser E2E; desktop regression; rollout docs/tooling | 2.5k-4.0k | Production-shape harnesses counted here only when not already native/feature fixtures. | medium | Most deterministic fixtures are reusable in production-shape tests. | Parent plan; all lane estimate inputs pending |
| **`EST-V1-TOTAL`** | **All non-terminal v1 scope** | **28k-45k** | **Net integrated diff; shared work counted once.** | **7/10** | **Lower bound retains strangler adapters; upper bound splits unsafe legacy authority.** | **Parent plan accepted range** |

Arithmetic lower/upper sums are 28k/45k. The plan's 33.9k-57.6k phase-touch range is deliberately not
used because it repeats work across phases; the table is the unique-bucket net model.

## Re-estimation triggers

- Regenerate after W1 parity/action inventory and all lane estimate inputs are reviewed.
- Regenerate after Phase 7.
- A projected total outside 28k-45k or any unique bucket variance above 20% requires explicit
  scope/design review before capacity expands.
- ADR-35 and every hosted-terminal implementation or packaging line contribute zero to v1.
