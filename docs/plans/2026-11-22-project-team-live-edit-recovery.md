# Project team live edits and recovery — 2026-11-22

Base: `ba1b357c466a6373b9cdd99467b16bea8c5e8467` (`main`).

## Scope and delivery

Implement the four reproduced bugs (preflight before persistence, actionable interrupted launch,
attempt-scoped provisioning errors, authored role readback) and supported HTTP/MCP live edits.
The user explicitly assigned CI/CD qualification to another agent. The initial delivery used local
checks and independent source reviews. On 2026-11-23 the user also authorized finishing and merging
the existing PR. Do not manually dispatch or rerun workflows, or merge on local checks alone;
the normal protected-branch qualification still applies.
External trash, automatic team stop/relaunch, new storage, and new recovery queues are excluded.

## Implementation decisions

- Share operation-aware preflight and the existing native roster mutation. Hold logical and
  runtime configuration gates before creating the existing pending marker. Recheck run identity
  after asynchronous preflight. Keep native execution checks and the real partial-write marker.
- Keep metadata as the authority for authored role; preserve the existing runtime identity fields
  and config-only fallback. No copy-history migration or runtime configuration rewrite.
- Derive pending reasons in main from launch tracking and runtime liveness. Renderer presents
  progress, safe retry, or unknown ownership without interpreting elapsed time as process death.
- Reconcile provisioning progress and errors using the verified run identity of each view;
  preserve another project's error and ignore delayed terminal events from an older attempt.
- HTTP/MCP preserve context and revision admission, check the revision again immediately before
  a live write, and use the desktop operation gates/journal. Repeated stale requests do not repeat
  native effects. Starter instructions explicitly return `application: next_launch`.
- A partial native application must remain an error even when the saved definition matches the
  requested value. HTTP/MCP return its stable code, outcome and readback revision.
- Reuse native rename notification and cache invalidation for both desktop and external updates.

## Plan / sizing

The original handoff estimated 270–470 production lines and 300–500 test lines. The shared native
operation is extracted from the large IPC file rather than duplicated. Measured initial code diff
(including moved code and existing test-file formatting):

| Category                                                | Files | Added | Removed |
| ------------------------------------------------------- | ----: | ----: | ------: |
| Production TypeScript, excluding generated localization |    34 | 1,444 |     700 |
| Tests                                                   |    14 | 1,606 |     243 |
| Locale files and generated keys                         |    31 |   272 |      34 |

The extracted native roster operation is 324 lines. `teams.ts` shrinks from 5,402 to 4,941 lines,
and its frozen size cap is lowered to match. No cap is raised. The broader regression matrix
covers cross-project attempts and both API team modes, including real transport serialization.

Complexity: 6/10. Reliability target: 9/10. Initial confidence: 8/10, dependent on race and partial
failure checks. Provider-backed proof is distinct from finite lifecycle fixtures.

## Initial implementation review and validation record

- R1: confirmed the authored-role read mismatch; minimal field-only fix.
- R1: caught logical readback incorrectly masking failed live effects; typed failures now survive.
- R1: caught returned runtime name not matched to the request and missing native rename notice;
  both corrected through shared operations.
- R1 recovery review: preserve the logical team's ignored-attempt owner when adopting a new
  physical run; reject equal/older cross-project progress; never infer safe retry from failed R1
  while a different R2 owner is tracked. Added regressions for each case.
- R2: independently rechecked the corrected API transport, native operation, runtime/revision
  races and partial outcome handling. No remaining confirmed correctness findings.
- Final combined local run: **21 suites, 843 tests passed, zero skipped**. It covers native IPC
  and stop concurrency, operation preflight, role persistence/projection, launch recovery,
  attempt-scoped store state, dialog navigation, and HTTP/MCP management.
- The HTTP/MCP integration suite starts the real local Fastify listener and uses the controller
  HTTP client with the production management composition. Native lifecycle effects are bounded
  test doubles. It covers shared and per-project live updates, revision/context refusals,
  runtime/revision changes during preflight, one-effect retries, alias refusal, OpenCode refusal
  without writes/marker, unchanged A/B histories, and durable partial failure.
- Actual built MCP stdio protocol: **2 selected cases passed**; the other 23 cases were excluded
  by the test filter, not qualified. These checks exercise FastMCP serialization of
  `RESTART_REQUIRED` and `TEAM_MUTATION_UNCERTAIN`, including structured partial outcome and
  revision, one HTTP request, and clean process shutdown. The local MCP build also passed.
- Full canonical local `pnpm typecheck` was killed with exit 137 on both the initial and
  memory-bounded attempt, without type diagnostics. Neither attempt is a pass.
- A scoped production check completed successfully with the same pinned TypeScript **7.0.2**:
  a temporary config extending `tsconfig.json` includes the changed main, management, project
  context, store and MCP source entry points plus declaration files, excluding tests. This does
  not replace whole-workspace/test type qualification. The temporary config is not committed.
- Final fast lint of 32 changed production source files: zero errors; 13 existing warnings in
  Create/Launch dialogs remain. MCP lint: zero errors and four existing warnings. Unused imports
  left by the extraction were removed and the affected import group was sorted.
- Source-file-size guard, Team Provisioning architecture guard and `git diff --check`: passed.
  Existing broad formatting drift in frozen legacy files is preserved rather than expanding
  this behavior change into an unrelated reformat.

## Initial qualification handoff

The initial handoff published only the feature branch because CI/CD belonged to the other agent.
That agent subsequently opened PR #1267 and recorded additional source and provider validation.
Those results and the later authorization to merge do not replace the normal required checks.

Reproduce the transport cases locally with:

```sh
pnpm exec vitest run --maxWorkers=1 test/main/http/teamMcpControl.integration.test.ts
pnpm --filter agent-teams-mcp build
pnpm --filter agent-teams-mcp exec vitest run --config vitest.e2e.config.ts test/stdio.e2e.test.ts --maxWorkers=1 -t 'preserves .* through the MCP stdio serializer'
```

The initial executor did **not** rerun the provider-backed Electron A → B → A cycle: it had no
desktop display or access to the saved Hetzner provider profile. The older handoff's successful
provider answers were baseline evidence, not evidence for the initial patch. The handoff requested
a fresh cycle using
Electron CDP and new sandbox projects on the existing authorized test host. Verify unsupported
live edits leave both files and marker unchanged; supported-provider edits reach the current
participant; interrupted launch names the correct project; successful R2 stays clear of a late
R1 error; displayed role survives reload; and each project's tasks/messages remain separate.
Do not transfer credentials manually or use real user projects.

## PR #1267 follow-up — 2026-11-23

The follow-up starts from `05bb7fe49c9d863d00895eaf456a6478e675f50b`, which includes `main`
at `9d96267e7e387e28dcc944b05eb0971e4566ecff`. All 15 inline review threads were resolved,
but the full review also contained three store findings outside the diff and one minor preload
finding. Source inspection and failing local regressions confirmed that all four still applied.

- Preserve a rejected predecessor's progress record while any provisioning alias still owns
  that run. Equal timestamps must not allow one view to delete another view's current progress.
- Clearing a missing run removes every matching provisioning/runtime pointer and its stale
  snapshots, even when the progress record is already absent. Owners that have advanced to a
  successor retain their state. Existing ignored-run maps retain all affected owners so delayed
  events cannot resurrect the invalidated alias; raw run IDs remain the map keys.
- When agent runtime refresh adopts a successor before member-spawn refresh, request its missing
  provisioning status. Only the refresh that actually adopts the run starts the request, so the
  two response orders do not duplicate it.
- Real Electron `contextBridge` discards custom properties on a rejected `Error`. A headless
  sandbox BrowserWindow using the production preload reproduced the lost `failure.code` and
  missing recovery action. The six existing definition-edit methods now also expose an optional,
  typed transport that returns the specific recovery refusal as a plain tagged value. The
  renderer adapter constructs its local `Error` after the bridge. Existing raw methods preserve
  their rejection messages and successful return values, and unrelated failures remain errors.

The [PR description](https://github.com/777genius/agent-teams-ai/pull/1267) records the other agent's
provider-backed qualification on `5267d64` and follow-up launch/deferred-role checks on `fbf57edf`,
plus a full pinned-compiler typecheck on `fbf57edf`. These are evidence for those recorded heads;
they are not fresh provider runs of this follow-up. The six-file merge delta from `fbf57edf` to
`05bb7fe` imported existing main workflow-policy changes and Ukrainian translations, without a
feature runtime change. This follow-up does not change workflow policy or provider credentials.

Before publication, `main` advanced to `cc02c007e2ed2de979ba73fbb6b6434276bf16a8` (PR #1269).
It is integrated through an ordinary merge. The three overlapping files (`CreateTeamDialog.tsx`,
English team translations and generated translation types) merged cleanly; the new template
controls and this feature's launch-error presentation are both retained. The store and definition
edit transport fixes do not overlap that main change.

Follow-up validation:

- The initial store regression set failed before the fix (5 failures, 1 pass). Independent review
  also found redundant status fetches for cached progress and inherited-property lookups in the
  new owner helper; their focused before-fix set had 5 failures and 12 passes. Both were fixed.
- Final store/event/runtime/cleanup run: **355 tests, 5 suites, zero failures or skips**. It covers
  both response orders, cached terminal progress, shared aliases, missing records, split run
  authorities and raw-ID collisions. Independent final source review found no remaining issue
  in the six changed store files.
- Preload/renderer transport and existing queued-message tests: **15 tests, 3 suites passed**.
- `node scripts/e2e/team-definition-edit-bridge.mjs`: **passed** against the production preload
  and renderer adapter in a real isolated Electron BrowserWindow. It verifies configuration and
  void success, the known recovery refusal, unrelated failures and raw API compatibility, with
  exactly one existing-channel IPC per call (nine total). It uses disposable local data, removes
  its sandbox, and needs no provider connection or new dependency.
- After integrating `main` at `cc02c007`, the same unmodified Electron regression passed again.
  The template picker and template-to-team application tests also passed: **20 tests, 2 suites**.
  The normal Electron bootstrap is `node scripts/ensure-electron-install.cjs --strict` after
  the frozen dependency installation. An intermediate local dependency-installation failure and
  one timed-out Electron attempt are not counted as successful verification.
- Scoped fast lint passed for all changed production sources and bridge tests/script with zero
  errors or warnings. Formatting of the bridge files and `git diff --check` passed; frozen store
  files retain unrelated existing formatting. Source-size and provisioning architecture guards
  passed. The four affected legacy caps are lowered to their resulting sizes: preload 2,058,
  store index 2,535, team slice 4,957, and shared API types 1,063 lines.
- Final TypeScript **7.0.2** check passed for every changed production/test TypeScript entry point
  and ambient declarations (19 entries, including their transitive imports). Three incomplete
  transport test fixtures were corrected to use a full typed fixture, and their four tests passed
  again. The wider 67-entry and merged-UI 20-entry attempts were killed with exit 137 and are not
  counted as passes; whole workspace qualification remains the required PR gate. Both store and bridge changes received
  an independent final source review with no remaining correctness finding.
