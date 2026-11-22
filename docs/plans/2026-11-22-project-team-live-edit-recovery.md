# Project team live edits and recovery — 2026-11-22

Base: `ba1b357c466a6373b9cdd99467b16bea8c5e8467` (`main`).

## Scope and delivery

Implement the four reproduced bugs (preflight before persistence, actionable interrupted launch,
attempt-scoped provisioning errors, authored role readback) and supported HTTP/MCP live edits.
The user explicitly assigned CI/CD qualification to another agent. This change uses local checks
and independent source reviews only; do not dispatch workflows or merge on those checks alone.
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
operation is extracted from the large IPC file rather than duplicated. Measured final code diff
(including moved code and existing test-file formatting):

| Category | Files | Added | Removed |
| --- | ---: | ---: | ---: |
| Production TypeScript, excluding generated localization | 34 | 1,444 | 700 |
| Tests | 14 | 1,606 | 243 |
| Locale files and generated keys | 31 | 272 | 34 |

The extracted native roster operation is 324 lines. `teams.ts` shrinks from 5,402 to 4,941 lines,
and its frozen size cap is lowered to match. No cap is raised. The broader regression matrix
covers cross-project attempts and both API team modes, including real transport serialization.

Complexity: 6/10. Reliability target: 9/10. Initial confidence: 8/10, dependent on race and partial
failure checks. Provider-backed proof is distinct from finite lifecycle fixtures.

## Review and validation record

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

## Qualification handoff

CI/CD belongs to the other agent at the user's request. Publish only the feature branch; opening
a PR would start the repository's automatic qualification workflows. Do not merge from these
local checks alone.

Reproduce the transport cases locally with:

```sh
pnpm exec vitest run --maxWorkers=1 test/main/http/teamMcpControl.integration.test.ts
pnpm --filter agent-teams-mcp build
pnpm --filter agent-teams-mcp exec vitest run --config vitest.e2e.config.ts test/stdio.e2e.test.ts --maxWorkers=1 -t 'preserves .* through the MCP stdio serializer'
```

The provider-backed Electron A → B → A cycle has **not** been rerun in this executor: it has no
desktop display or access to the saved Hetzner provider profile. The older handoff's successful
provider answers are baseline evidence, not evidence for this patch. Run the fresh cycle using
Electron CDP and new sandbox projects on the existing authorized test host. Verify unsupported
live edits leave both files and marker unchanged; supported-provider edits reach the current
participant; interrupted launch names the correct project; successful R2 stays clear of a late
R1 error; displayed role survives reload; and each project's tasks/messages remain separate.
Do not transfer credentials manually or use real user projects.
