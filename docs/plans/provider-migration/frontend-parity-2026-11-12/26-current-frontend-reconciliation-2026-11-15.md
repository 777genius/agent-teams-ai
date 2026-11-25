# Current frontend reconciliation and remaining acceptance

## Frozen inputs and scope

The completion branch remains PR #1192 into #1186, then Stage 1. This cut
reconciles the current frontend snapshot into that branch; it does not merge
the branch into main or authorize default activation, release or Stage 2.

- Completion source: `32c2af517766f86116b4b6441e686e493ad1c9c8`.
- Current frontend snapshot: `7408b30b34d2ff280a429766fdbb51976d899af8`.
- Parent #1186: `def734338f13bcc3209e78079a0cedbc48f05a5b`.
- Corrections and original failed receipts: [plan 25](25-original-ui-and-finite-peer-corrections-2026-11-15.md).

The incoming main delta touches 332 paths, including the Create layout,
Settings lazy loading, provider readiness invalidation, CLI argument validation,
schedule shutdown, localization and current runtime assets. These are existing
upstream features, not new product scope. Freeze this snapshot for acceptance.
Preserve both Git parents and every author's ancestry. Use a detached integration
worktree, an isolated frozen dependency install, and an expected-head fast-forward
publication. Root owns the branch ref; parallel owners do not commit or stage.

## Semantic reconciliation

| Boundary | Required composition |
| --- | --- |
| CLI arguments | Port main's protected short clusters, missing operands and allowed explicit teammate mode into the canonical Host parser; keep the shared re-export |
| Schedule shutdown | Preserve Host admission/cancellation, captured targets and lifecycle epochs; upstream finalization/retry fixes already exist in that superset |
| Settings | Keep main's lazy content/deep-link ownership and preserve the mounted gateway/provider forms and Host account capture |
| Create/Launch | Retain Host context, captured readiness and submission fencing in one preflight effect; include main's settings invalidation epoch, current layout and organization validation |
| Model selection | Keep extracted responsive/virtualized grids and project-scoped readiness refresh; preserve the Host scope indicator |
| Cached model feedback | Align existing option-badge readers with the same context-qualified cache key as preparation; preserve context/settings isolation and never grant launch authority from a cache |
| Store | Keep the Host tool-approval event owner and current Codex startup revalidation |
| Workflows | Keep the independent original scenarios and pre-staged Host/runtime inputs; accept main's runner default and deployment guards |

No new owner, process manager, storage or generic compatibility layer is needed.
Do not resolve conflicts by dropping a current control or weakening launch,
cleanup, source provenance, deadline or singleton-CDP assertions.

## Review and verification

R1 assigned schedule/parser and frontend conflicts to separate owners. The
parser owner compared 46 argument inputs against main's exact implementation,
including protected clusters and missing values. Root removed an auto-merged
duplicate preflight effect and moved gateway content into the new Settings owner.

R2 independently compares the composed frontend against both parents, including
automatically merged paths. Review already found a lost invalid organization
placement guard; it is restored before any submission. Remaining review findings
must be resolved before publication of executable changes.
The review also found an older P05 parity defect: Create's option-badge reader
uses an unqualified key while its preparation stores a context-qualified key.
Inspect Launch for the same mismatch and repair the existing key owner/readers,
without another cache, a new preparation path or relaxed freshness checks.

The completed P05 correction uses one existing key owner for both plans and
presentation reads. Create reuses the Launch issue reader, including its original
configuration-only hints, instead of duplicating the cache loop. Launch forwards
its existing settings epoch to both paths. The regression first reproduced
missing badges, then proved matching-context hints remain visible while separate
create drafts/Teams and later settings epochs cannot reuse earlier results.
desktop_fixes independently reviewed the final diff with no blocking objection.
Root removed an unused future constant and inlined a single-use scalar diagnostic
clone; the three affected legacy file caps are lowered, never increased.

R3 uses the canonical TS7 workspace compiler, affected existing behavior suites,
finite Main/Host regression, bounded diagnostic regressions, changed-file lint,
and unchanged source-size/provisioning guards. Run resource-heavy checks
sequentially. A killed or incomplete check is not a pass. The original 18
Desktop lanes, four safe frontend shards and relevant native/platform workflows
then qualify the exact published integration SHA and require screenshot and
cleanup review. Do not rerun a successful source matrix without a changed risk.

Merge glue estimate: 80–160 production lines excluding upstream changes and
plan-25 corrections; no new production file. Complexity 6/10, expected
reliability 8/10, confidence before executed acceptance 7/10. These are planning
judgments, not results.

## Local candidate verification

The canonical workspace TS7 typecheck completed successfully on Node 24.22.1,
including the Host build, application/tooling projects, Host scripts/tests and
MCP projects. The initial attempt identified an optional array access in the new
finite regression; that test-only access was corrected before the successful run.

Executed groups, reported separately rather than as a sum of overlapping suites:

| Group | Observed result |
| --- | --- |
| Current Create/Launch, Settings, installer/status and startup revalidation: ten complete existing suites | 346 passed, zero skipped |
| CLI parser, safe schedules, captured preparation/status, actual finite Main-to-Host transfer, installer resolver and reply visibility | 137 passed, zero skipped |
| Finite Codex, Settings/import and child-trace scripts | 18 passed, zero skipped |
| Captured-context/cache/preflight regression group | 93 passed; selected dialog checks were followed by the complete dialog suite above |
| Late passive failure retention with exact locked Node 24.21.0 | 1 passed, zero skipped |
| Existing optional-workflow and required-gate contracts | 17 passed, zero skipped |

These results are local behavioral/type evidence, not native-platform or Desktop
acceptance. The previously published source's 14 Desktop failures and unqualified
platform/packaged paths remain historical failures; only new exact-source
receipts can close those gates. No real Claude or Codex binary was invoked.

P09 section 75's selected-source writer contract remains unresolved and separate
from this integration. Original Darwin source mutation failures and unconfirmed
Windows/Linux cleanup remain failures. This cut neither authorizes new source
freezing/ACLs/FD aliases nor turns unknown cleanup into released state. Real
Claude/Codex execution remains prohibited, including version checks.

## Concurrent acceptance follow-up reconciliation

While the verified current-frontend tree was being published, the completion
branch advanced from plan commit `93e4d174` to `b3f29d45425dd19cd2dc08c366f27e3d1fbb523d`.
The expected-head update did not replace that work. The prepared commit
`b978fce66e54c2fbe3af0cef0d61b79c7f2c5916` was retained, and a separate integration
worktree reconciles both histories. The final merge must have both commits as
parents; the main snapshot is already an ancestor of b978.

Plan 27 and its original receipts remain intact. Its bounded CDP, readiness,
installer, credential and Windows diagnostics preserve the failed outcomes and
original deadlines. Its inventory-parent correction identifies the one existing
harness `plugin list` child by its actual PID, pinned executable and original
effects; that child remains in the cleanup census. Every other provider birth
still requires its captured Host parent.

The union keeps one shared finite auth helper for Extensions and saved import,
one selected-package admission import, and one finite Codex RPC test helper.
The broader incoming standalone checks retain the empty MCP status and refuse
pre-start/foreign-thread work, Team authority and persistent threads. Original
UI drivers keep exact-card expansion and bounded viewport reveal before the
same single physical action. Three independent reviewers found no lost checks
or widened authority in these resolved boundaries.

The application and Host production source bytes remain those of the verified
b978 tree; this reconciliation changes TEST drivers, fixtures and diagnostics.
The reconciled finite Codex group passed 6/6 and the Settings, observation,
readiness/privacy and child-trace group passed 53/53, each with zero skips.
The source-size and provisioning guards passed. Three final-workspace compiler
attempts ended with exit 137, including attempts with 4 GiB and 1200 MiB heap
targets. The latter reached 3,994,996 KiB maximum RSS and ran 148.62 seconds.
The installed compiler's supported single-threaded mode was then attempted with
the same twelve projects and strictness; its first project was killed by signal
9 after 11.60 seconds (1,293,528 KiB maximum RSS). These are terminated/incomplete
checks, not PASS or reported type errors. The final full compiler gate remains
required on the exact published source. Earlier successful typing and behavior
evidence for b978 is not relabeled as this gate's success.
