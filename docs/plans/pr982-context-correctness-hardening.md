# PR #982: context and usage correctness

## Scope

Repair the existing behavior in `feat/provider-migration-stage-1` without adding
MCP tools, changing provider contracts, updating pinned provider archives, or
introducing a new usage analytics subsystem. The reviewed starting tree is
`38bb47e53a80c697d29fccc41d63597c19475ea2` (published head
`dee94bf14ddbe81143ed2c3c9029a74e66158e1e`). Keep the PR open and unmerged.

## Changes and estimates

Estimates are changed production lines and regression-test lines, not total file
sizes. Scores are out of 10; higher complexity means more difficult, while higher
confidence/reliability means stronger evidence. Reliability is a target until
the validation below is complete.

| Existing defect | Minimal correction | Production / tests | Complexity | Confidence | Reliability target |
| --- | --- | ---: | ---: | ---: | ---: |
| A large task board blocks the next input after compaction | Replace only oversized advisory board/roster snapshots with existing canonical read instructions; keep mandatory rules intact | 80–160 / 160–240 | 5 | 8 | 9 |
| The 128 retained context epochs become a lifetime limit | Retire only represented epochs, preserving exact durable proofs and duplicate/conflict detection | 180–300 / 220–320 | 7 | 8 | 9 |
| Bootstrap clipping can lose both operating context and its truncation warning | Reserve an indivisible recovery instruction within the existing budget and retrieve complete context only after readiness | 80–130 / 100–180 | 4 | 9 | 9 |
| Raw Codex usage counts cached input twice | Normalize raw inclusive input separately from canonical disjoint input; preserve stable ledger identities | 25–45 / 100–180 | 3 | 9 | 9 |
| Host statistics present Codex's last usage slice as a complete aggregate | Mark unavailable aggregates explicitly using captured source identity, including retained historical events | 35–55 / 120–180 | 5 | 8 | 9 |
| An oversized Codex log looks like an empty, successfully refreshed source | Use the existing degraded-refresh path and preserve the last successful usage timestamp and ledger | 10–20 / 30–60 | 3 | 9 | 9 |

## Invariants

- The immutable admitted input, binding, operation identity and preparation
  fingerprints remain unchanged. Recovery must never create a second native
  submit or an additional model turn.
- An epoch can leave the bounded active list only after its representation is
  durably recorded. Exact duplicate observations remain idempotent; conflicting,
  corrupt or missing proof material must hold safely.
- A crash between archive persistence and active-state persistence is recoverable
  without accepting a different proof or dropping a pending epoch.
- One proof covering 120–128 resets must not overflow the unchanged 1 MiB Team
  state limit. Retirement also responds to byte pressure, and candidate-only
  state can reconcile with a represented archive only through the exact original
  Runtime proof, never through ordinary observation or validation.
- Standing prompts, roles, workflows and action-mode restrictions are never
  silently truncated. The small-context reminder stays compatible.
- Bootstrap recovery does not prove readiness, start work during bootstrap, or
  change task completion/message delivery semantics.
- Raw Codex inclusive usage and canonical assistant disjoint usage remain
  distinct. Reimport replaces the same ledger event rather than duplicating it.
- An oversized source marks the existing refresh as degraded; it must not advance
  the successful usage timestamp or erase previously imported usage.
- Provider classification follows the captured runtime lineage, not the current
  provider of a reused member name. Claude statistics and known costs survive.

## Deliberate boundaries

A saved mandatory prompt/workflow can itself exceed the existing 64 KiB reminder
budget. Current paged Team reads do not expose all saved standing instructions.
Until a complete bounded recovery route exists, this case must continue to hold
explicitly instead of silently dropping instructions. The board fallback does
not claim to fix this separate capacity mismatch.

The pinned Codex adapter does not expose enough information to reconstruct
reliable cumulative input/output totals. This patch must show incomplete data
rather than invent totals or modify the external provider contract.

Existing bad ledger rows are corrected when their original JSONL is successfully
reimported. Missing or oversized source logs cannot be safely reconstructed from
the old metadata. Previously published command receipts remain immutable.

MCP response slimming, role-specific tool catalogs, new task-detail views,
broader reasoning-token chart semantics, and performance optimizations belong to
separate work. No stacked optimization PR is required for these corrections.

## Review and verification

1. Review the proposed recovery/retention design independently before editing.
2. Add targeted failing regressions for the confirmed defects.
3. Review the exact patch for crash recovery, multi-epoch proofs, identity reuse,
   historical source classification, Unicode boundaries and byte/character caps.
4. Build with pinned Node 24.21.0 and native TypeScript 7.0.2; run affected Host
   tests, bootstrap/importer tests, type checks, lint and applicable source guards.
5. Recheck the live PR head before publishing. Publish only the reviewed changes
   to the existing PR branch using a non-forced update with an expected-head
   lease; preserve concurrent changes.

All fixtures use isolated TEST data. Native provider launches and full desktop
E2E qualification are outside this local regression pass; do not report them as
passing without corresponding evidence.

## Results

Implemented without public API, provider pin, dependency or compiler-option
changes. Independent reviews covered the context-retirement protocol, bootstrap
recovery instructions and Codex accounting/provider lineage. Root review also
found and corrected the 120/128-epoch single-proof byte-pressure failure and
removed unnecessary roster-history pagination from the recovery instruction.

Completed checks on Node 24.21.0 / TypeScript 7.0.2:

- Host production build passed, including the task-change-ledger prerequisite.
- Bootstrap/native/OpenCode focused cohort: 22 tests passed.
- Codex importer, real JSON ledger and analytics service: 32 tests passed.
- Context recovery/retention, activity reads, session history and the corrected
  OpenCode fixture suites passed their focused executions. Coverage includes real
  filesystem persistence, cold reads and injected partial publication failures.
- A strict, affected-file typecheck of all six changed Host test files and their
  transitive dependencies passed using the unchanged project compiler options.
- Fast lint, targeted formatting, diff whitespace, source-size, provisioning
  architecture and runtime-artifact checks passed.

The broad Host Node run reported 1,847 passing tests, two existing skips, and two
test-file workers that failed without assertion diagnostics. A serial TAP
recheck passed all 16 group-chat tests; the Team-snapshot worker was terminated
with `SIGKILL`. This is not a successful full-suite qualification.

The complete root typecheck, complete Host test typecheck and type-aware lint
were terminated with exit 137 / `SIGKILL` in this environment. An earlier Host
test typecheck did produce actionable diagnostics: the new fixture lacked
`teamName`, and existing OpenCode/session-history fixtures had invalid types.
Those fixtures were corrected using complete values and actual discriminants,
without suppressions or relaxed compiler settings; the affected-file typecheck
then passed. Temporary validation configs were removed.

Full CI and native desktop/provider E2E qualification remain required before
declaring the entire PR ready to merge. No successful result is inferred from a
terminated compiler, test worker or native flow that was not executed.
