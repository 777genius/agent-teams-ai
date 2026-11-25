# Team budget enforcement - implementation plan

Status: two design-review passes completed. Implementation and E2E tracked in this PR.

## Goal and existing capabilities
Existing monthly global/team/project token and API-equivalent USD budgets alert, but do not enforce general team stopping. Reuse canonical team IDs, monthly UTC usage ledger, realtime status, existing budget settings, CAS updates, launch admission, the team stop lifecycle and team cards. Do not duplicate the ledger.

## Scope
1. Extend the monthly team budget with optional `onExceeded: notify | block_launch | stop_team`. Default is `notify`; only real teams may opt into enforcement. Global/project/anonymous/legacy budgets stay alert-only. Preserve old JSON.
2. Add a pure selector over existing budget status with `under_limit`, `exceeded`, and `unknown` outcomes. Exceedance is *any* configured metric >=100%. Missing/incomplete/stale metering is unknown, not zero. With opt-in enforcement, unknown blocks **new launches**, but does not kill active work without observed exceedance.
3. Check the budget inside the existing serialized team create/launch admission, before spawn, so API/IPC/scheduler and runtime recovery cannot bypass the guard. Increasing/removing the limit or UTC month rollover permits new admission without launching an idle team automatically.
4. On fresh complete status updates, a `stop_team` policy may request stop of its active, profile-owned team through the existing lifecycle, verifying that it stopped; failures are surfaced and retried only on future normal updates. No new stop implementation or unsafe unrelated-process kill.
5. On each configured team card display the most relevant monthly usage limit and progress, including blocked/unknown/stale warnings and realtime event updates. Unconfigured team cards remain clean.
6. Tests: compatibility and validation, enforcement selector, create and launch rejection and recovery path, rollover/unknown, stop failures/retry, card status/render and event updates. Run focused E2E plus CI before merge.

## Explicit non-goals
- No exact billed-USD guarantee (provider meters may be estimated or lag); no subscription quota fiction. This is a best-effort local safety mechanism.
- No daily/per-run budget periods, per-agent enforcement, nested team hierarchy, or a second ledger in this PR. Existing scheduled one-shot CLI budget cap is unchanged.
- No automatic process restart on period rollover (would incur unexpected charges); only the gate resets.
- No mass rewrite of provisioning or team-stop code, no background retry loop.

## Acceptance gates
- Old budgets retain behavior when policy is absent. No unauthorized non-team policy values. Concurrent settings updates retain CAS semantics.
- Real team identity is canonical. Admission is guarded within per-team lock; new team start, scheduled and recovery starts respect the same boundary.
- Unknown data cannot be treated as safely under budget; no destructive stop from unknown data.
- Stop succeeds only with observed runtime termination, or records a failure; no false PASS.
- UI cannot report stale/incomplete metering as green; updates follow event ordering. No change to teams without budgets.
- CI and relevant E2E actually complete. No queued/skipped/cancelled status reported as a successful test.

## Design review pass 1 - product and safety
- Removed automatic restart on new month: could surprise the user with new spend.
- Replaced misleading “pause new tasks” with “block launches”; tasks in an already-running process are not guaranteed to stop from that choice.
- Avoided unqualified “hard cap” promise for estimated/subscription usage.

## Design review pass 2 - architecture and races
- Keep budget accounting in existing token-usage feature and enforce in main process, not renderer.
- Perform admission check inside serialized per-team launch lock, before spawn.
- Use canonical `team:<name>` ID, not a display label; ignore anonymous/legacy.
- Separate read-only policy evaluation from stop side effect, and do not block usage-service queue while stopping.

## Estimate / engineering quality
Production 650–1150 LOC plus 350–700 LOC tests, complexity 5/10, reliability target 8/10, design confidence 8/10. Keep any new UI helper focused; avoid growing the large team-list file substantially.
