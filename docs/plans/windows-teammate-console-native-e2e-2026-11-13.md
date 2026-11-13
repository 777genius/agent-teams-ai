# Windows direct-process teammate console integration — 2026-11-13

## Goal and boundaries

Preserve the existing contributor fix in [#1185](https://github.com/777genius/agent-teams-ai/pull/1185), without pretending that spawn-option unit tests establish native GUI behavior or descendant retirement. The contributor fork is not writable through the connected GitHub integration. Integrate its exact authored HEAD `d6700e0592241dfedb2f8233022d37b2b9a8ee67` through the existing synthetic merge parent, then current `main=87f6b763dc5100cdc4e31b3a6bb2c3e82ba3adc0`.

**Scope:** retain `TeamProvisioningMemberLifecycle` Windows-only non-detached `spawnCli` change; retain `CliUsageImporters` `windowsHide:true`; retain the existing contributor's focused regression tests. Correct only the changelog's unsupported force-kill guarantee. Add a narrow real Windows native-process fixture with bounded cleanup, preserving process identity evidence. Do not change unrelated provider runtimes, process brokers, API contracts or default routes.

**Not in scope:** install/launch genuine Claude or Codex models, paid inference, assuming `detached:false` guarantees grandchild termination, or silently treating a noninteractive CI fixture as a human-visible GUI.

## Acceptance gates

1. GitHub compare against current main must contain only the four contributor files, plus this plan and narrowly scoped fixture/workflow; original contributor commit remains in ancestry.
2. Changed-file tests, TS typecheck, CodeQL and required exact-HEAD CI pass. No queued, skipped, cancelled or partially successful job counts as proof of an applicable gate.
3. A Windows GitHub-hosted runner must exercise actual native launch of a disposable teammate-shaped subprocess and repeated Bash-equivalent `cmd.exe`, Git and PowerShell child calls. Capture exact PID, original process identity, exit codes and bounded cleanup. Do not mutate user data or invoke real provider binaries.
4. **Separate GUI/product acceptance before merge:** actual Windows Electron teammate tool calls produce no console flash, focus theft or unexpected taskbar window; importers also do not flash. Observe the original teammate and live tool descendants after normal Stop and forced app termination. If the interactive desktop is unavailable or grandchildren survive, report this explicitly; do not claim a pass from mock/fixture evidence.
5. Only after required independent review and native GUI proof, merge the integration PR with expected-head CAS and verify post-merge CI on main. Do not separately merge the original fork PR.

## Implementation budget

| Item | Estimated changed LOC | Risk / confidence |
| --- | ---: | --- |
| Correct unsupported changelog wording | 2–4 | Low / 9 of 10 |
| Add bounded native process fixture + CI entry | 90–170 | Medium / 7 of 10 |
| Preserve contributor fix and existing tests | 0 rewritten | Low / 9 of 10 |
| Real Electron GUI/product observation | existing harness + manual evidence | High / 4 of 10 without an interactive Windows session |

## Review rounds

- **Round 1 — behavior:** libuv `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` means direct teammate enrollment does not establish all grandchildren retire; narrow documentation, keep separate process-tree gate. Do not change production process custody beyond the contributor fix.
- **Round 2 — CI credibility:** a synthetic subprocess is not a live Claude/Codex tool call. Native process tests may qualify only spawn mechanics; explicit visual/focus and original app lifecycle evidence remains mandatory.
- **Round 3 — scope and regressions:** no new dependency, no cross-platform behavior change, no test that reuses an exited PID for cleanup, no forced Git branch update. Use targeted tests first and official workflow results, then independent review.

## Rollback

Single source rollback is the four-file contributor change. Keep this integration Draft until original Windows GUI evidence and process-tree acceptance are attached.
