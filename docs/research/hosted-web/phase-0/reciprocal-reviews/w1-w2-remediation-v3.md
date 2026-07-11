# Phase 0 remediation review: W1 and W2

## Decision

- Review ID: `P0.R12R.W1_W2.V3`
- Review timestamp: `2026-07-11T19:25:00Z`
- Producer base: `0e8431b1935c71a2e77bea1384b134ee25c8aa12`
- W1: **remediate; do not adopt as a lane**
- W2: **remediate; do not adopt as a lane**
- Selective approval: nine files are approved below. No other producer file is approved.
- Integration, broad/final gates, Phase 1 work, terminal implementation, and producer writes were not
  performed.

The registry has no terminal result for either remediation producer. Both progress files still say
`running`, but PIDs `1314177` and `1321607` were absent at review time and their heartbeats stopped at
`2026-07-11T18:58:08Z` and `2026-07-11T18:56:38Z`. This review therefore freezes and assesses the dirty
worktree outputs directly; it does not infer completion from the stale registry state.

## Exact approved files

These files are semantically reviewed and formatting-clean. The controller may selectively adopt only
these paths, subject to its normal integration policy:

1. W1 `docs/research/hosted-web/phase-0/parity-renderer/selection-reconciliation-invariants.md`
2. W2 `docs/research/hosted-web/phase-0/provider-runtime/execution-topology.json`
3. W2 `docs/research/hosted-web/phase-0/provider-runtime/schemas/execution-topology.schema.json`
4. W2 `docs/research/hosted-web/phase-0/provider-runtime/runtime-ingress-inventory.json`
5. W2 `docs/research/hosted-web/phase-0/provider-runtime/schemas/runtime-ingress-inventory.schema.json`
6. W2 `docs/research/hosted-web/phase-0/provider-runtime/credential-exposure-matrix.json`
7. W2 `docs/research/hosted-web/phase-0/provider-runtime/schemas/credential-exposure-matrix.schema.json`
8. W2 `docs/research/hosted-web/phase-0/provider-runtime/estimate-input.json`
9. W2 `docs/research/hosted-web/phase-0/provider-runtime/schemas/estimate-input.schema.json`

The W2 estimate is approved as an input, not as a frozen controller estimate. It correctly contributes
`4.3k-6.75k` net lines to `EST-LIFECYCLE-RUNTIME`, excludes W4 primitives, and retains the required
greater-than-20-percent scope-review warning.

## Every dirty producer filename

There are 31 dirty files: 13 in W1 and 18 in W2. All are untracked; neither producer has a tracked
diff.

### W1

| Path                                                                                             | Decision  | Reason                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `.codex-handoff/phase-00-w1.json`                                                                | remediate | Overclaims complete visible-control coverage and 11 W1 files are not formatting-clean.                                                    |
| `docs/research/hosted-web/phase-0/parity-renderer/README.md`                                     | remediate | Describes the four-file scan as exhaustive even though immediate child controls are omitted.                                              |
| `docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json`                        | hold      | The 109-member count and ownership repair are useful, but this minified generated output is coupled to the rejected scanner package.      |
| `docs/research/hosted-web/phase-0/parity-renderer/estimate-input.json`                           | hold      | Arithmetic and variance escalation are corrected, but the file references the rejected action/scanner proof and fails formatting.         |
| `docs/research/hosted-web/phase-0/parity-renderer/legacy-bypass-inventory.json`                  | hold      | Reproducible compact/hash treatment is corrected, but the generated file fails formatting and remains coupled to the scanner package.     |
| `docs/research/hosted-web/phase-0/parity-renderer/renderer-action-inventory.json`                | reject    | Covers only four source files and 106 sites, not the visible team composition/child-control closure.                                      |
| `docs/research/hosted-web/phase-0/parity-renderer/schemas/api-parity-ledger.schema.json`         | hold      | No independent defect found; hold with its unapproved generated artifact and formatting remediation.                                      |
| `docs/research/hosted-web/phase-0/parity-renderer/schemas/estimate-input.schema.json`            | hold      | No independent defect found; hold with its unapproved generated artifact and formatting remediation.                                      |
| `docs/research/hosted-web/phase-0/parity-renderer/schemas/legacy-bypass-inventory.schema.json`   | hold      | No independent defect found; hold with its unapproved generated artifact and formatting remediation.                                      |
| `docs/research/hosted-web/phase-0/parity-renderer/schemas/renderer-action-inventory.schema.json` | reject    | Schema acceptance cannot make the incomplete source-file closure exhaustive.                                                              |
| `docs/research/hosted-web/phase-0/parity-renderer/selection-reconciliation-invariants.md`        | adopt     | Explicit selection/snapshot/tombstone/pagination/event-poll invariants and proof gaps; formatting passes.                                 |
| `scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts`                             | reject    | Hard-codes four control files; therefore its passing repository gate does not prove every visible team control.                           |
| `test/architecture/hosted-web/phase-0/parity-renderer/scan-api-and-actions.test.ts`              | reject    | Seven tests pass, but the semantic missing/duplicate tests use a synthetic three-site fixture and never challenge omitted child controls. |

### W2

| Path                                                                                                | Decision  | Reason                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.codex-handoff/phase-00-w2.json`                                                                   | reject    | Stale: declares 14 paths while 18 exist, names a nonexistent envelope schema, omits five actual schemas, and reports the old three-test result.      |
| `docs/research/hosted-web/phase-0/provider-runtime/README.md`                                       | remediate | Claims all environment keys are removal-sensitive and the provider matrix is corrected; both claims are disproved below.                             |
| `docs/research/hosted-web/phase-0/provider-runtime/credential-exposure-matrix.json`                 | adopt     | Source-observed execution-unit exposure and browser/runtime/provider ownership are explicit and cross-lane consistent.                               |
| `docs/research/hosted-web/phase-0/provider-runtime/environment-provenance.json`                     | reject    | Eight explicit keys can be removed without the completeness validator detecting the omission.                                                        |
| `docs/research/hosted-web/phase-0/provider-runtime/estimate-input.json`                             | adopt     | Canonical bucket, arithmetic, W4 exclusion, uncertainty, and replacement-not-addition rule are explicit.                                             |
| `docs/research/hosted-web/phase-0/provider-runtime/execution-topology.json`                         | adopt     | Separates four provider identities from two backend families and keeps claims source-observed.                                                       |
| `docs/research/hosted-web/phase-0/provider-runtime/fake-runtime-fixture-matrix.json`                | reject    | Three required cases have `positiveProof: missing` and `negativeControl: missing`; this is an honest gap ledger, not the required complete matrix.   |
| `docs/research/hosted-web/phase-0/provider-runtime/runtime-ingress-inventory.json`                  | adopt     | Five operations have the required nested fields; the proposed operator/runtime authority sets are disjoint and target-unverified status is explicit. |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/credential-exposure-matrix.schema.json`  | adopt     | Requires the exposure and canonical-ownership fields used by the approved artifact.                                                                  |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/environment-provenance.schema.json`      | reject    | Shape validation does not repair source-discovery completeness.                                                                                      |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/estimate-input.schema.json`              | adopt     | Requires the canonical W2 contribution and W4 reconciliation structure.                                                                              |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/execution-topology.schema.json`          | adopt     | Enforces the provider/topology alternative and pinned source-observed envelope.                                                                      |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/fake-runtime-fixture-matrix.schema.json` | reject    | Explicitly permits `gap_only` rows whose positive and negative proofs are both missing.                                                              |
| `docs/research/hosted-web/phase-0/provider-runtime/schemas/runtime-ingress-inventory.schema.json`   | adopt     | Requires all operation field families and the disjoint-authority proof fields.                                                                       |
| `scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.ts`                              | reject    | Completeness removal check misses eight explicit environment keys and accepts three missing-proof matrix rows; it also fails formatting.             |
| `test/architecture/hosted-web/phase-0/provider-runtime/fixtures/surfaces-negative.json`             | hold      | Useful route negative fixture, but not sufficient for the rejected environment/matrix acceptance claims.                                             |
| `test/architecture/hosted-web/phase-0/provider-runtime/fixtures/surfaces-positive.json`             | hold      | Useful route surface fixture, but not a positive provider-runtime matrix.                                                                            |
| `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`               | reject    | Eight tests pass but omit removal tests for every classified key and treat missing provider proofs as acceptable.                                    |

## Findings requiring correction

### `R12R-W1-001` — high — visible-control closure remains incomplete

`scan-api-and-actions.ts:11-17` limits semantic scanning to `TeamListView`, `TeamDetailView`,
`CreateTeamDialog`, and `RuntimeProviderManagementPanelView`. The packet's required read/acceptance
surface includes the team views and their child controls. `TeamListView` directly imports
`TeamListFilterPopover`; independently running the producer's `scanControls` on that child found five
interaction sites, none present in `renderer-action-inventory.json`. The same composition roots import
many other interactive dialogs, kanban, member, message, schedule, and sidebar children.

Required correction: derive or explicitly declare the reachable visible team-control closure, list
every included/excluded child surface, map every site to exactly one semantic action or deliberate
absence, and add a repository negative fixture that fails when an immediate child control is omitted.

This leaves `R12-W1-001` and `P0.REQ.W1.003` unresolved. Stable semantic IDs, stop/provider ownership,
estimate arithmetic, and external raw-bypass treatment are otherwise materially corrected.

### `R12R-W1-002` — medium — W1 output is not adoption-formatted

`prettier --check` fails the W1 handoff, four generated evidence JSON files, four schemas, scanner, and
test (11 files). The two Markdown evidence files pass.

Required correction: format only the W1-owned files, regenerate/check hashes as needed, and rerun the
focused scanner/test. Do not broaden formatting.

### `R12R-W2-001` — high — environment omission detection is still incomplete

A mutation check removed each classified key in turn and called
`validateEnvironmentCompleteness`. Removing any of these eight keys produced no error:

- `NODE_ENV`
- `AWS_PROFILE`
- `AWS_REGION`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
- `CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES`
- `CODEX_API_KEY`
- `CLAUDE_TEAM_APP_INSTANCE_ID`
- `AGENT_TEAMS_MCP_CLAUDE_DIR`

The scanner discovers many source literals, but the remaining row-level `sourceToken` check proves
only that one token per row exists. It does not make every listed key removal-sensitive.

Required correction: make every explicit classified key source-discovered or bind it to a checked
source occurrence; add a looped negative test over all non-wildcard keys. This leaves `R12-W2-001` and
`P0.REQ.W2.003` unresolved.

### `R12R-W2-002` — high — required positive/negative provider cases remain missing

`malformed_capability_response`, `restart_adoption`, and `opencode_secondary_lane_recovery` are
`gap_only` rows with both proofs set to `missing`. The scanner intentionally accepts that state. It is
good gap reporting, but it is not the complete positive/negative fake-runtime provider matrix required
by `P0.REQ.W2.006`.

Required correction: add focused deterministic positive and failing-negative fixtures for all three
cases, or keep W2 explicitly failed/blocked rather than claiming the requirement satisfied.

### `R12R-W2-003` — high — structured handoff does not describe the dirty output

The handoff declares 14 changed paths while Git reports 18. It lists the nonexistent
`schemas/evidence-envelope.schema.json`, omits five actual artifact schemas, reports three tests rather
than the current eight, and contains the original pre-remediation review state.

Required correction: regenerate the handoff from the final dirty snapshot, enumerate all 18 paths,
record resolution status per original finding and requirement, and include the actual narrow results.

### `R12R-W2-004` — low — scanner formatting

Only `scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.ts` fails the W2 formatting
check. Format that file only and rerun lint/test/scanner.

## Filename and semantic overlap audit

- Exact relative-path collisions: none.
- Duplicate basenames: `README.md`, `estimate-input.json`, and `estimate-input.schema.json`. Each is
  contained in its lane-owned directory; there is no write collision.
- Script/test ownership: W1 uses `parity-renderer/**`; W2 uses `provider-runtime/**`. No duplicate
  script, fixture, or test path exists.
- `team.lifecycle.stop`: W1 assigns it to `team-lifecycle`; W2 includes it only in the operator-only
  authority set. Consistent, no duplicated implementation ownership.
- Provider controls: W1 owns renderer action semantics under `provider.management.*`; W2 owns
  execution topology, child environment, credential exposure, and runtime ingress. The split is
  consistent, though W1's UI reachability proof is incomplete.
- Credentials: W1's renderer action treats credential entry as provider management; W2 prohibits
  runtime ingress from operator decisions and keeps canonical runtime bearer material out of provider
  exposure. Consistent.
- Estimates: W1 contributes `EST-CONTRACTS`, `EST-RENDERER-LIFECYCLE`, and
  `EST-REMAINING-PARITY`; W2 contributes only `EST-LIFECYCLE-RUNTIME` and excludes W4 primitives.
  There is no bucket collision or detected double count.

## Narrow verification record

| Check                                                      | Result                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Producer `git status --porcelain=v1 -uall`                 | W1 13 untracked files; W2 18 untracked files; no tracked diffs.                                                                     |
| Registry progress, process, and result check               | Both progress files stale at `running`; both PIDs absent; neither latest-result exists.                                             |
| W1 scanner in an isolated `/tmp` copy                      | Pass: 109 API members, 106 catalogued control sites, raw bypass hash reproduced; generated JSON hashes match the producer snapshot. |
| W1 Vitest                                                  | Pass: 1 file, 7 tests.                                                                                                              |
| W2 scanner                                                 | Pass under its current acceptance rules: 4 providers, 2 backend families, 5 operations, 13 rows.                                    |
| W2 Vitest                                                  | Pass: 1 file, 8 tests.                                                                                                              |
| Focused ESLint                                             | Pass for both scanners and both test files with `--no-cache`.                                                                       |
| JSON parse                                                 | All producer JSON outputs parsed.                                                                                                   |
| `git diff --check` plus per-untracked-file no-index checks | No whitespace diagnostics.                                                                                                          |
| Prettier                                                   | W1 fails 11 files; W2 fails the scanner only.                                                                                       |
| W1 omitted-child probe                                     | `TeamListFilterPopover.tsx` has 5 scanner-visible sites but is absent from the four-file catalog.                                   |
| W2 all-key removal probe                                   | 8 classified keys can be removed without a completeness error.                                                                      |
| Bounded secret/real-project-path scan                      | No private-key, bearer/token-shaped value, or prohibited real-project path match.                                                   |

Broad CI, typecheck, build, standalone/runtime smoke, final-image/provider execution, and terminal tests
were deliberately not run.
