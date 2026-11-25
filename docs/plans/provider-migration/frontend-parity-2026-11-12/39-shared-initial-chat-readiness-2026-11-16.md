# Share exact initial chat readiness across the four BOOT callers

## Original gap and selected scope

Continue the original frontend-parity E2E journey on app content base `f9c4f0b95071ea9d34e6651e65ae330ba9d139cc` (tree `64dc6bbdbd6562f5e398528fbe3d47c7f546d2e2`). The reviewed eight source preimages are unchanged from `b5791b2`; the checked-provider adoption and its provenance remain intact.

The original B852 [packaged macOS x64 job 133295289376](https://github.com/777genius/agent-teams-ai/actions/runs/43856040242/job/133295289376) reached native BOOT completion, then the lifecycle caller attempted to admit a lead-row click while its preview still contained the user BOOT prompt. The strict final geometry check refused an 8.5 px movement before any physical chat press; the failure screenshot contains the terminal preview. Relaunch was not reached. This identifies a missing renderer-readiness boundary, not a proven layout mechanism.

A source scan found the same initial ordering in Runtime and Collaboration; Selection already had a bounded correction. Extract that correction into one 32-line domain-specific helper and use it only at these four initial BOOT boundaries. Native BOOT polling and every later stream/reload/cold-Resume open remain unchanged.

## Implementation and original budgets

The helper requires exactly one captured lead row and exactly one descendant span whose text is the complete `TEST boot ready` preview. Existing navigation, preview, original opening action and original visible-reply observation share one absolute cutoff. Fresh original renderer guards still precede physical presses, and the original release remains paired with its press.

| Initial caller | Original budget | Original opening sequence |
| --- | ---: | --- |
| Selection A and B | 60,000 ms | Captured lead scroll and one click |
| Lifecycle | 30,000 ms | Alice click, with no added scroll |
| Runtime | 60,000 ms | Alice click, with no added scroll |
| Collaboration | 60,000 ms | One conditional Back probe/navigation before preview, then Alice scroll and click |

Change exactly eight paths: the new helper, four callers, existing Team helper tests, proof-source roster and existing scoped-lint operand list (106 → 107). Keep controls blob `1c11809c6458f829bd9bb6995aea2ad60b85511e` byte-identical, including final target geometry and the single press/release pair. The previously selected C8 steps, full Runtime/type/lint scopes, source guards and all producer pins are preserved.

Estimated change: 84 net lines, including 32 helper and 52 net test lines. Largest changed scenario: 794/800 lines. Complexity 3/10; source confidence 9/10. No generic deadline framework, app feature, new provider call, retry or timeout increase is introduced.

## Review and verification

Exact source/patch review and forward/inverse checks passed. The existing correction cases and both C8 cases remain byte-identical. The three initial-chat assertion bodies retain their checks; their shared fixture now executes the actual extracted helper and caller source.

Final supplemental execution under Node 24.22.1: 8 PASS, 0 FAIL, 0 SKIP, using the exact original controls with finite DOM and clocks. Coverage retains delayed exact preview, one physical chat click, decreasing original budget, wrong/duplicate preview refusal, post-read cutoff checks, correction authority and C8 closure. The added case covers actual Lifecycle/Runtime/Collaboration caller budgets and conditional Back navigation, including expiry before the chat press.

This is supplemental source-level evidence. The original resulting-source Desktop, installer and packaged relaunch workflows must still execute their complete business actions, receipt verification and physical cleanup under their existing deadlines. Unrelated later geometry movement must continue to refuse; no overall E2E PASS is claimed here.
