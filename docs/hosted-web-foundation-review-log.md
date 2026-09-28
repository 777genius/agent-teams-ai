# PR #252 foundation plan: three review rounds

Plan under review: `FOUNDATION_DELIVERY_PLAN.md`. Source baseline: PR #252 `e5f7d5890a2de3ed03b0ef43119081fbae1c33fd` on 2026-09-28. This log records review findings and the plan edits made between rounds. It is not implementation or runtime evidence.

## Round 1 - domain, authority, package

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact PR #252 source. No P0, four P1 and one P2.

1. Hosted create's transparent stale-revision rebase retained original -> rebased only in process memory. A committed rebased create with lost ACK could return idempotency mismatch on exact replay. Plan now removes transparent rebase in F2, asks for explicit refresh/reconfirm after proven no-effect conflict, and tests lost ACK/restart.
2. Desktop move-back-to-done used two renderer commands with refresh between placement clear and status write. F1 now includes a bounded authoritative Desktop move facade under existing board lock, prevalidates before first write, and explicitly avoids claiming crash atomicity. Added 500-900 changed LOC reserve, additive Desktop API/IPC, regression for rejected move preserving placement.
3. Globally enabling direct-facet public classification would expose older adapter reexports across roughly twenty facets. F0 now inventories first and cleans the actual browser-consumed index/facet; all-facets ratchet F0b requires an explicit measured inventory and budget. No new baseline exceptions are presumed.
4. A rejected replay after an uncertain prior commit does not prove original non-application. Plan separates original outcome from recovery-attempt result, preserves uncertain state on stale generation/mismatch, and adds the relevant regression.
5. Session owner inside keyed HostedTeamWorkspace would be destroyed on workspace switch. Registry now lives in HostedApplicationShell above the keyed workspace; A -> B -> A unresolved-command scenario is required.

Estimates were recalculated without double counting: foundation 4,250-7,300 changed LOC; foundation + D1/N1 + integration 7,350-12,600; full Dashboard/Chooser package including provisional main-conflict reserve 9,150-17,000. All-facets F0b remains unestimated until read-only inventory.

## Round 2 - behavior, UX, tests, estimates

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact source. No P0, one P1 and three P2.

1. After lost ACK and generation change, existing Hosted `getPage` cannot correlate a task with the original create. F2 now specifies a scoped read-only lookup of deterministic task ID plus persisted creation metadata. Exact match confirms task write only. Absence/mismatch/read failure remains unresolved. The UI provides a visible `operator_required` resolution path; it does not infer safe retry from page absence. Round 3 narrowed this to Product's existing descriptor-bound read source, avoiding a new Owner wire operation.
2. Late mutation error for team A could disable team B's capability inside one workspace. Availability updates now require captured scope/authority; added same-workspace A/B composition regression.
3. Desktop TeamDetail and graph form still had separate submit owners. Plan now places one Desktop feature-session registry above both view lifetimes, keyed by active context/team/authority. Post-confirm output is once per intent, not once per session; added detail-to-graph and sequential-intent tests.
4. D2/N2 had no independent behavior or acceptance and overlapped D1/N1. Removed them from chosen milestone/budget. Future Dashboard/Chooser work must first name a distinct observable flow and test.

New selected estimate: foundation 4,890-8,540 changed LOC; foundation + D1/N1 + integration 7,990-13,840; with provisional main-conflict reserve 8,290-15,040. Confidence in prospective LOC 5/10 for foundation, 5-6/10 for D/N. Full-screen historical estimates remain low-confidence context, not additive selected work.

## Round 3 - delivery, enforcement, final consistency

Reviewer: independent `gpt-6-astra`, `xhigh`; read-only exact source. No P0; one P1 and one P2 in the version read, both fixed during review and acknowledged by reviewer.

1. Existing Owner socket protocol accepts only message_send/task_mutate, so an Owner observation operation would add unbudgeted cross-process protocol/runtime work. The plan now uses Product's existing descriptor-bound read source under current `HostedAuthorizedTaskBoardAuthority` grant, derives task ID server-side, validates exact creation metadata and revalidates mount/team/snapshot. Historical submitted generation is evidence for the old intent, while current read authorization is checked separately. Mutation stale-generation gate is untouched.
2. An exact match on a soft-deleted task confirms a past write but says the task is currently deleted. The plan and regression table now distinguish this from absent/mismatched/unreadable results, which remain unresolved. No automatic restore or fresh create follows.

Reviewer confirmed estimate arithmetic, scope boundaries, actual test commands, one final PR #252, final exact-SHA gates and sandbox-only E2E. No runtime or tests were executed during planning/review.
