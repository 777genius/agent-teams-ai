# 47. Windows reference checks: nested passive attribution

**Selected narrow diagnostic follow-up; no source applied yet.** Parent: `168bf0cbcb9c51e9c4a4120e0932b8f2cf26eb27`, tree `4bdc48a85b663f66ddd963c87565e3e74b4a4c1c`. The source-derived call graph is recorded separately with SHA256 `e5d1f89e8aeb8734420d8df51845d25d8ceb0441a55b362f5c1c00d29ec0d940`.

## Original evidence and one remaining question

The exact `a07e2d68ece77d08e152d7b0de1eb4b85d72ca06` Windows x64 [original process job 133387301022](https://github.com/777genius/agent-teams-ai/actions/runs/43892535299/job/133387301022) reached OpenCode Team A and refused readiness at its unchanged boundary. Original artifact `14245686314` has 56,342 bytes and SHA256 `fef7dc080982fc8a614b7b2e5ca78ac343bf9724a7bca41875bd0edf3aa0f05f`.

Plan36's retained spans identify 34 synchronous consumer-current calls, 11,524 ms total, including 10,625 ms in the reference region. The first reference refusal is the original probe-expiry check, 180 ms after its cutoff; the containing consumer had checked that same cutoff 119 ms before expiry. Runtime is held, custody unknown, unattached, with `open-unknown`. This differs from the separate ARM Codex pending post-attachment check.

The remaining unknown is how much reference time belongs to nested original authority checks versus account/configuration/policy/target inspection and other reference bookkeeping. The original spans do not measure those components. Neither a timer change nor a performance repair follows from this evidence.

## Exact existing source boundary

The prospective base is `168bf0cbcb9c51e9c4a4120e0932b8f2cf26eb27`. Preserve every incoming Plan43 explicit plugin pin, environment verifier and Plan45 change. Only these four existing paths are selected:

| Path | Complete preimage Git blob | Existing physical lines |
| --- | --- | ---: |
| `packages/legacy-agent-host/src/composition/prepareTeamModelReadiness.ts` | `90e0ccba36eb51c60dd4f0251b2cc5de995a47b6` | 739 |
| `packages/legacy-agent-host/tests/saved-team-model-probe.test.ts` | `0b346f8b6db221c602f7a6d9cc8b628da62099cb` | 1703 |
| `tools/owned-process-broker/nativeEmulatedSourceProfile.ts` | `afe5134ed023b0732ec195a0f25604f3655b7116` | 291 |
| `tools/owned-process-broker/nativeEmulatedSourceScenario.ts` | `ca0c93b66d7cd7c51fe0e72c70ab26c3a02bf5c2` | 800 |

No ModelProbeOwner/public API, workflow, native fixture, transport, provider contract or new module change is selected. The existing validation commands already cover these operands. Before source publication, rebind all four complete preimages to the actual parent and preserve other work.

## Existing synchronous call graph

`inspectMemberModelReadiness.current()` performs the original authority and consumer checks, then calls `readPreparedModelReference()`. That function reads the retained probe, derives the member's management profile and checks its mechanism before calling `ModelProbeOwner.captureReadinessReference()`. The owner rereads the original receipt and invokes the existing account/target inspector before its target, completion, expiry and reference projection checks.

For the configured-key V1 member branch exercised by this fixture, account inspection contains four complete native-configuration observations and two original policy/origin observations. Their locations and owner brackets differ and all remain. Native configuration observes its original donor paths and hashes their bytes/identities; the policy reader independently reopens its captured Main references. The selected target checks the four original HOME/XDG directories. Nested owner callbacks retain the original Team/Runtime authority and allocation checks. These source-derived multiplicities are not new per-call runtime measurements.

Two retained-record reads, all schema/hash comparisons, source reads, native directory inquiries and every original authority callback remain in the same order. The prospective change does not combine snapshots, memoize freshness, hold a new fence or treat a successful prior check as present authority.

## Selected passive intervals

Extend only the existing optional `currentCalls.regions` object with two paired regions:

- `referenceAccountCount/Ms`: one interval around the existing `captureOpenCodeProbeAccountInspection()` call, only when that original branch actually calls it.
- `referenceAccountAuthorityCount/Ms`: sum the intervals around the original `options.assertCurrent()` callbacks made while that account interval is active.

Each added Count increments at most once per measured outer current call that actually entered its interval; it is not a count of individual authority callbacks. Thus both Counts remain bounded by the existing `currentCalls.count`. Authority milliseconds are nested inside account milliseconds, which are nested inside reference milliseconds. Accumulate raw nested authority durations within one outer call and round once when that outer call settles; do not round each callback. Round the account duration at the same outer-call boundary. The regions must not be added together, and rounded differences are not an exhaustive partition.

Use the same subscriber, first-refusal latch and original 4,096-call measurement gate. Preserve every existing counter and business Date.now call. No diagnostic clock runs after the latch or without the subscriber. The optional third argument of private readPreparedModelReference stays within the same source module; public capturePreparedModelReference options remain unchanged. It creates no policy input or externally callable owner.

All interval endings run in `finally`, including partial throws. Observational clock/aggregation failures remain contained and cannot replace, suppress or remap the exact original thrown Error, manufacture a positive result or change original cleanup. Invalid measurement follows the existing truncated-diagnostic behavior. Preserve the original 64-record/64KiB refusal ledger and all original deadlines, actions, source observations and check order. Diagnostic overhead remains inside the unchanged budget; no timing improvement is promised.

Both existing readers accept the previous exact eight-field region object and the new exact twelve-field variant. Missing pairs, extra keys, noninteger/nonfinite/negative values and counts beyond the existing outer count remain rejected. Extend their existing names lists in place: Scenario stays at its established 800 physical lines, with no unrelated formatting, baseline change or guard bypass.

## Inert regression and original gates

Extend the existing `saved-team-model-probe.test.ts` deterministic retained-inspector case. Give original authority/target calls distinguishable clock costs; assert the nested interval totals, once-per-outer-call counts, original authority/target call counts and original total spans. Retain first-refusal and exact Error identity assertions, add a partial throw during account inspection, and prove that later calls after unsubscribe/latch add no diagnostic clocks.

Preserve the actual source/owner/expiry/shadowed-config/credential counterexamples, unchanged saved receipt bytes, single admitted model probe and close, zero business allocations and original consumption behavior. This is an extension of the existing substantive boundary tests, not a substitute native gate.

Expected source delta is roughly 35–50 Host source lines (739 to at most 789), two reader list edits, and a small test extension; every production file remains within the established 800-line limit. Exact postimages, actual counts and independent source R2 precede publication.

Use the unchanged original Process workflow Host build, Host test compiler, retained-host reader compiler and full existing contract command, plus the existing Team types/lint scopes. A completed diagnostic test does not qualify OpenCode readiness; the original resulting-source Windows receipt and unchanged 15-second observation still decide that row.

The PR remains Draft, Stage1/default-off. Real Claude/Codex execution, Stage2, Ready, main merge/release and ad hoc dispatch/rerun are outside this cut. The separately accepted exact-a07 finite I386 four-tuple result does not close this OpenCode failure or Darwin P09.
