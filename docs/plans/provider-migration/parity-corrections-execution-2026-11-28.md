# Provider parity corrections: execution record, 2026-11-28

## Scope and review

The reviewed plans were published before these implementation changes: the stopped-snapshot and Windows OAuth read plans were already in Stage 1; the lint, retained-cancellation and shared-budget plans were published in PR #1318 at `233333eb618d5d72d726366c599171e252eb6840`. Root applied the reviewed candidates after checking their exact source baselines. An independent final review checked all sixteen implementation/workflow files, including their complete bytes and line counts, and approved the assembled source.

The current Stage 1 Edit Team correction, `b749699cef973dfbbca85cbb6311e83b8c8e7dea`, was integrated with a normal merge. Its two files do not overlap the correction candidates. The review includes the genuinely captured V1 snapshot and the strict-test compilation fix described below. This record describes local results; published-head CI remains a separate required gate.

| Change                             | Resulting behavior                                                                                                                                                                                                                   | Plan                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| OAuth intent reader                | A real Windows regular file is not rejected by a POSIX-only permission rule; observed-file loss, replacement, short reads and late close failures remain unavailable. Exact bigint identity and bounded physical reads are retained. | [Original-file read plan](oauth-intent-windows-original-read-plan.md) |
| Retained model-probe cancellation  | Qualify the active original before retirement; preserve replaced or uncertain stored bytes; close only the owned original and acknowledge cleanup only from its actual released receipt.                                             | [Cancellation plan](model-probe-retained-cancellation-plan.md)        |
| Stopped snapshot V2                | Excluded rows contain metadata only; private export censuses still reject changes during one export. Existing V1 bytes and recovery identities remain unchanged.                                                                     | [Snapshot plan](stopped-snapshot-excluded-metadata-plan.md)           |
| Existing feature lint corrections  | Correct the scoped type/import issues while preserving immediate OAuth preparation, one owned promise and existing failure behavior.                                                                                                 | [Lint plan](current-feature-lint-corrections-plan.md)                 |
| Shared expansion-budget regression | Detect accidental resets between strings, provider/model branches or nested model sections. Production selector code and its limits are unchanged by this supplement.                                                                | [Budget plan](opencode-non-key-shared-budget-regression-plan.md)      |

## Meaningful baseline failures and compatibility evidence

- The unchanged OAuth reader produced **10 failures and 15 passes** in the new 25-case fixture. Failures observed real original-file identity/read boundaries; they were not missing imports or invalid fixture schemas.
- The unchanged retained-probe owner produced **9 failures and 15 passes** in the complete 24-case file. The controls demonstrated writes to replaced originals, missing owned cleanup, and a false cleanup acknowledgement.
- Against the unchanged snapshot exporter, the focused V2 privacy assertion failed because excluded-content verifiers were retained. The genuine V1 compatibility control passed on that baseline.
- The shared-budget supplement failed on a normal build of `dadfe7440f237d47e4acd6b66d8f4cc236fe2f75`: after nine 64 KiB values, the old selector read the late sentinel. Three separately compiled diagnostic mutations of the current selector also failed the same assertion: reset per string, reset at the model branch, and reset at nested sections. Those mutations existed only in a separate disposable worktree; the exact original source was restored and verified. They are not part of this PR.

The V1 fixture was produced by the real exporter at `617b15d65e3d1e40d94ee3470eb5fc8399836b68`, using Node `24.21.0` and a normal Host build. Its exact JSON is 1,866 bytes, SHA256 `3a85867873246991dd7de7c4f63edb3e81730c4682643626c3d77dac2d4ed106`, with snapshot digest `b79259ede0bf4b3283498e02b959119fb1b6015e4597f6b7f439a4688f9e679f`. The original source directory was removed before the capture was handed to the compatibility fixture. The assembled test proves real staging, an installed-but-held import, cold retry after both source and staging removal, exact retained original bytes, and original-only lookup/replay.

The plan review's non-ASCII concern was checked against both historical and current selectors. The historical selector already has a final UTF-8 `Buffer.byteLength` limit; the embedded-profile schema's separate UTF-16 check is not the acceptance boundary used in the proof. The existing ASCII/three-byte-BMP alias-boundary test passes on the historical build and on current source. A finite diagnostic using the actual two compiled selectors accepts a **210,050-byte** result and refuses a **630,056-byte** result whose UTF-16 length is only **210,056**. Both versions preserve their inputs. The budget plan now identifies both original byte-checking boundaries explicitly.

## Completed local checks

Host runtime: Node `24.21.0`; Main/renderer runtime: Node `26.12.1`; package manager: Corepack-selected pnpm `11.22.0`; compiler: pinned native TypeScript `7.0.2`.

| Check                                                                                          | Actual result                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Normal Host production build                                                                   | PASS                                                                          |
| Complete strict Host test graph, `pnpm --filter @agent-teams/legacy-agent-host typecheck:test` | PASS                                                                          |
| Seven Host regression files                                                                    | **118 passed, 0 failed, 0 skipped**                                           |
| Eight Main/renderer regression files                                                           | **140 passed, 0 failed**                                                      |
| Fast ESLint on the nine changed Main/renderer source/test paths                                | PASS; this is not typed-lint qualification                                    |
| Prettier on thirteen applicable changed source/test files                                      | PASS                                                                          |
| Source-size guard                                                                              | PASS: 5,565 production files, unchanged 139 frozen exceptions, 800-line limit |
| Team Provisioning architecture guard                                                           | PASS; existing architecture limits unchanged                                  |
| Whitespace/diff check                                                                          | PASS                                                                          |

The seven Host files are `management-model-probe-original`, `management-model-probe`, `saved-team-model-probe`, `stopped-team-import`, `stopped-team-import-rpc`, `import-publication`, and `opencode-v2-model-environment` under `packages/legacy-agent-host/tests/`.

The eight Main/renderer files are the two OAuth suites, `CodexJsonlUsageImporter`, both feature/renderer `teamSessionHistory` suites, `hostCrossTeamProjectRouting`, `hostCrossTeamTransport`, and `EditTeamDialog.configuredSettings`. The 59-case captured-OAuth suite includes two preparation-failure preservation controls; the file-store suite has 25 cases. Edit Team contributes 22 cases from the integrated current Stage 1 correction.

The first eight-file Vitest attempt timed out in one file-store case and ended with SIGKILL. Its log is retained as a failure. The successful complete run used `--maxWorkers=1 --no-file-parallelism`; the existing 15-second test timeout, assertions, environment and included tests were unchanged. Strict Host test compilation initially found a TypeScript assertion-narrowing issue in the new compatibility helper. Reading/asserting the snapshot before the independent whole-record assertion preserves both checks and fixes the type error.

Only the changed `cancelRetained` method was formatted in `ModelProbeOwner.ts`, preserving all unrelated bytes and the 800-line rule. That production file is 645 physical lines. The shared-budget test retains its twelve original tests byte-for-byte. No broad formatting or new size exception was introduced.

## Required remaining qualification

Full canonical Main typechecking and typed ESLint did **not** pass locally: executions ended with SIGKILL or exit 137, and one bounded-heap ESLint attempt explicitly exhausted its heap. The exact external cause of each SIGKILL was not established. Normal compiler graphs, strict options, lint rules, hooks and test deadlines were not weakened. Lower native-Go GC memory targets helped the isolated Host diagnostic builds but did not complete the full canonical command. These failures are retained as unqualified gates, not converted to success by the passing fast lint or focused suites. Normal published-head CI must complete before integration.

The existing Windows workflow receives exactly two additional test paths, for the file-store and captured-OAuth fixtures. Its runners, timeouts, setup, triggers and evidence-reuse rules are unchanged. Linux fixture passes do not qualify actual Windows filesystem behavior; the ordinary Windows job on the published correction remains required. Native provider, physical Desktop and broader current-head checks remain their own gates.

Parallel Goal work was preserved: `245d32aa207eb260bcd3e8ed071cc73ea56f4ebb` already contains the independently reviewed preparation-refusal correction. Its two production files match the approved candidates exactly. The redundant docs-only PR #1319 was closed without duplicating that implementation. Independently running its two existing creation-helper files on Node `24.21.0` produced **45 passes**, with no skipped cases; this is finite helper qualification, not physical Windows acceptance.

This correction does not merge PR #982 into `main`, enable a default runtime, publish a release, or qualify the separately planned Family C and Work Sync work. Those boundaries retain their existing plans and gates.
