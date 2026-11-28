# Desktop retry attempt precondition parity

## Finding and scope

Source baseline: `445cee42ce70f7021052d61c4df6484a1ac80520`.
The renderer's `createHostMemberActions` sends `expectedAttemptId` when Retry
is bound to the displayed failed attempt. Main's operation parser and the
inner `executeTeamLaunch` parser preserve that field. The outer
`executeRuntimeLaunch` retry-members parser is strict but omits it, so the
request is rejected before the original launch owner can check the attempt.

The correction stays in `composition/executeRuntimeLaunch.ts`, a source path
already assigned to root for the separately published Family B work. Accept
the existing optional nonempty ID and preserve the existing single-member
restriction. Forward the original input without dropping or substituting the
precondition. The existing owner continues to decide stale-attempt conflict,
identical replay, fingerprint conflict and the finite retry budget. No owner,
public DTO, renderer behavior, deadline or native retry identity changes.

## Verification and ordering

Publish this plan before the correction. Add a focused actual Host RPC case
to `tests/runtime-team-host.test.ts`, using its existing isolated fixture and
controlled provider. Prove the unchanged source rejects a valid bound retry,
then verify the corrected source accepts it. Verify stale expected attempts,
changed preconditions under the original command, and multiple-member bound
requests refuse without another native allocation. Identical original replay
must preserve the selected attempt; the existing unbound retry case stays
green. A parse/import/setup failure is not the behavioral RED.

Run those cases on checked Host output, strict changed-fixture types, and the
existing launch/retry controls after integration with Family B. Review the
exact combined source diff so asynchronous readiness preparation cannot erase
or replace the renderer's original precondition.

## Review

Root source review identified the outer/inner parser disagreement. Independent
frontend review approved the exact path from renderer through Main and both
Host parsers to the original owner's replay and stale-attempt check. The
review confirmed the minimal optional field and single-member refinement.
This plan does not claim the correction or its test has already run.
