# Cross-Team request-scoped refusal feedback — R1

## Status and scope

This is a new, unapplied source/test candidate. Its proposed repository plan path is `docs/plans/provider-migration/cross-team-submission-feedback-plan.md`. It requires independent source review and a normal checked docs-only publication before associated test or production implementation. No repository file was changed, and no test, compiler, formatter, lint, native provider, UI probe or CI action was run for this candidate.

The inspected Stage 1 source is `36df9dceba8b080e876952fdce619af447c797c0`. The inspected Goal source is `7dfc005b1e5db473bda5531be9cbf90eaaebdbc3`, whose 28 saved direct source/test files are byte-identical to the corresponding `41b59a7a66dae96550aa35841d0a6493196a3b45` files. This does not mean Stage 1 and Goal are identical: Goal has its own preparation refusal and autonomous-goal branches. Both candidate target files are byte-identical between these fixed Stage 1 and Goal revisions. The candidate changes neither Goal's preparation boundary nor its authority checks.

This information-preservation fix is separate from the Taskboard fixture plan. It does not supply missing runtime input policy, weaken Host preflight, or establish the first IPC error in the historical d4b Taskboard run. That exact historical error remains absent from the available receipt.

## Source-proved defect and correction

`src/renderer/store/slices/teamSlice.ts` has different failure contracts for its two send actions. The ordinary `sendTeamMessage` catch records analytics, conditionally updates the current context's failure state, and rethrows the original error. `sendCrossTeamMessage` performs the same first two actions but returns `null`. `useMessagesPanelSend` forwards the Cross-Team promise without rewriting it. The actual MessageComposer calls that path with the persisted original request and passes the result to `runComposerSubmission`.

MessageComposer deliberately uses `useComposerSubmissionFeedback`, keyed by the captured draft address. It does not read the global `sendError` prop. Therefore saving the precise refusal only in `teamSlice.sendMessageError` does not deliver it to the actual Cross-Team composer. The null return is classified as unconfirmed with the generic detail `Delivery was not positively confirmed.` The original error code/outcome text is lost before request-scoped feedback and original attempt settlement.

Replace exactly the Cross-Team catch's `return null;` with `throw error;`. Keep analytics, the current-context guard and `failedMessageState(error)` in their existing order. Preserve the same Error object; do not wrap it, parse its message or synthesize a new refusal. The existing Promise return type can remain: a Promise of the declared result can reject. The only production caller chain already passes rejection to the transport catch in `runComposerSubmission`.

The result remains `unconfirmed`. The change supplies the original error's message to the existing original-attempt settlement and address-scoped UI feedback. A successful result, including its exact message ID, recipient and deduplication flag, is unchanged. Detached refresh failure remains separate from the accepted send result.

## Why no definitely-not-sent classification is added

The Host's `createHostCrossTeamComposition` maps `TeamOwnerError('hold')` to `{ok:false, code:'hold', outcome:'unknown'}`. Its same handler catches failures both before and after effects. The mandatory target input preflight runs inside the original intent preparation callback before publication; later target receive, sender copy, exact-original and completion checks can also fail. The common wire error does not prove which boundary was reached. This fix preserves that distinction.

`createHostCrossTeamApi` keeps the original pair/payload and uncertainty count. An invocation increments uncertainty before `backend.invoke`. A lost acknowledgement remains unknown. A subsequent explicit not-dispatched response does not erase prior uncertainty. Context retirement after dispatch and invalid/incomplete receipts are also unknown. Its `finally` retires a capture only when there are no active invocations and no uncertain attempts. None of these rules changes.

Even a generic `HostTeamOperationError` with `outcome:'not-dispatched'` is not sufficient to release all original attempt debt. The existing `hostCrossTeamProjectRouting.test.ts` case `retains the exact unknown send while completed recovery history is evicted` first loses an acknowledgement, then rejects a changed payload under the same message ID as conflict/not-dispatched, and retains the original unknown capture for exact retry. That refusal describes the attempted changed invocation, not proof that the earlier original had no effect. The adjacent test `keeps a lost acknowledgement uncertain when a later retry is refused before dispatch` explicitly preserves unknown. The separately named `HostTaskSubmissionRefusal` contract is Task-specific and is not imported or reused here.

The existing runner may still emit not-sent for its own proved pre-transport branches, such as changed working revision/context. Goal's existing nominal preparation refusal remains not-sent before durable attempt creation. Those branches are unchanged. This candidate introduces no classifier and no new replay authority.

## Original identity, recovery and stale-context boundaries

The actual renderer chain is `MessagesPanel` → `useMessagesPanelSend.handleCrossTeamSend` → `teamSlice.sendCrossTeamMessage` → `api.crossTeam.send`; completion returns through the same Promise to `runComposerSubmission`. The prepared original includes source/target Teams, recipient, text, action mode, summary, task references, message ID and conversation/reply identity. The candidate does not recapture any of them.

`runComposerSubmission` owns the existing repository active marker and context latch. It invokes preparation once, invokes transport once, then calls `settleAttempt` with the original address and attempt ID. Its transport catch changes the failure into the existing unconfirmed outcome with the exact Error message; its `finally` releases its own markers. It does not restore a draft, send again or mint a second ID.

The actual repository changes the original recovery's reason/outcome/time and keeps its saved snapshot and prepared request. `composerOutbox` continues to project unconfirmed as delivery-unknown with duplicate risk and the original prepared message ID. Automatic canonical reconciliation only applies to an accepted/syncing item, not an unknown item. This candidate does not change repository persistence, reconciliation, recovery restoration or message-ID rules.

A late rejection after a context switch still skips global send-state mutation because `isContextRequestScopeCurrent` compares both context ID and epoch. It must nevertheless reach the old request's runner so the old attempt settles. `useComposerSubmissionFeedback` displays that result only for its captured address key. The new context's draft and feedback do not inherit the old failure. No global error fallback is added.

## Exact changed-path manifest

| Path                                     | Change                                                                                                | Original bytes / SHA-256                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/renderer/store/slices/teamSlice.ts` | One catch statement, `return null` → `throw error`; no other production change                        | 179,366 / `2c686241546bcf0c455dd885d0edaf9fa447ecb652173275b6730515557e70f1` |
| `test/renderer/store/teamSlice.test.ts`  | Imports existing real APIs and adds one bounded test group beside the existing Cross-Team result test | 417,371 / `394838c139c8b1e0d6d188ab2f9a26bc3833b457c78d51c990021ec8b3a9810f` |

These are two existing paths. The separate docs-only plan publication adds the named plan document. No workflow, IPC schema, Host, provider, timeout, new production module or exception is added. Production physical line count remains exactly 4,888 in the existing large store file; this is not a claim that that file is below 800 lines. Keep the actual existing repository size rules unchanged and run their normal gate. No new exception is requested.

The off-repository full production candidate is 179,366 bytes, SHA-256 `a4393d6386a4ebceb732388b28a6e0649ed0338d92bdcf7c800244224321c586`. `candidate-r1.patch` is the exact one-line semantic change. `test-candidate-r1.patch` and `test-replacements-r1.json` reconstruct the complete test candidate from the fixed original. Reversing all saved insertions recovers the entire original test file byte-for-byte; existing test bodies are preserved.

## Finite test candidate

The eight new cases live in the existing `teamSlice.test.ts` harness. They use the real `createTeamSlice`, real `runComposerSubmission` and real `useComposerSubmissionFeedback`. The existing API boundary is mocked, so no Host or provider is started. The submission repository is an explicitly observable finite port with a Set-backed active marker and typed settlement spy; it is not represented as actual IndexedDB persistence or proof of Host effects. The prepared snapshot is the input to this boundary, not a newly fabricated native authority.

1. Three direct store cases inject the actual `HostTeamOperationError` class with busy/not-dispatched, invalid/rejected and hold/unknown. Require rejection with the very same object, one exact API request, unchanged request fields, existing current-context failure state and no post-send refresh.
2. Three current-context integrated cases send each of those outcomes through the real store and real runner. Require the exact detail and still-unconfirmed result, one original settlement, structurally equal prepared snapshot/request, no automatic restore/save/reconcile, and release of both observable active markers. All three intentionally retain unconfirmed; no generic error becomes not-sent.
3. One integrated hold/unknown case retires the context while the actual API promise is pending. Require the old attempt to settle and the new context's sentinel state to remain exact. Record the real result through the real feedback hook: it is invisible at the new address and visible only at the original address.
4. One integrated accepted control rejects detached refresh. Require the accepted original message ID and deduplication result, one send and one original settlement; refresh failure cannot turn acceptance into unknown or trigger another send.

While each integrated failure is pending, require both active markers and zero settlement. A second submission in the same context must return blocked without running its prepare or transport. After settlement the latch can be reacquired and released; this is an explicit latch test, not a claim of an actual second send. The fake repository is never used to claim durable storage or native cleanup.

The three direct rejection cases and exact-detail integrated cases are expected to be meaningful RED against the unchanged production file: the original returns null, so the direct Promise resolves and the runner receives generic detail. This is a source-derived expectation, not an executed RED. The stale-context and accepted cases are behavior-preservation controls. They are not claimed as independent product defects.

## Qualification and publication order

1. Re-read current target refs and exact original target files. Preserve unrelated TeamOwnerStore/lifecycle/WorkSync work and Goal's existing preparation guards. If either target file changed, reconcile the exact narrow hunk before applying anything; do not replace a newer whole file from this checkpoint.
2. Complete independent R2/R3 and publish the reviewed plan alone with normal repository checks/hooks. Only after that docs-only publication may the associated test/production implementation proceed under the assigned owner.
3. Add the existing-file test candidate first and run its finite new group under the repository's prescribed root Node/Vitest environment. Capture assertion-level baseline RED caused by the resolved null/generic detail, not missing imports, types or a harness error. Repair only a concrete test construction defect if needed and re-review that delta.
4. Apply the one production statement. Run the same eight cases for GREEN, plus the existing ordinary send error and exact Cross-Team accepted controls. Run the existing `composerSubmission.test.ts` and `hostCrossTeamProjectRouting.test.ts` cohorts for latch, original uncertainty and retry boundaries. Existing `MessageComposer.pendingSend.test.tsx` contains the stale-global-error isolation control; use that focused control if the actual test filter supports it. Do not broaden execution without a concrete remaining risk or a required gate.
5. Run canonical applicable typing, formatter, targeted lint, production-size checks and normal hooks. Formatting may change test layout; preserve every assertion and old test body. Do not bypass hooks or raise deadlines. The test candidate has not yet been formatted or compiled.
6. Publish only the reviewed and qualified implementation through the normal checked path. Integrate into Goal by the real parent/merge relationship or a reviewed one-line reconciliation; do not overwrite its whole store, test, runner or composer from a stale baseline. No native E2E PASS is inferred from these unit/API controls.

## Evidence limits

All evidence here is source inspection and checkpoint byte verification. No runtime RED/GREEN, type, lint, formatter, production-cap or current-source E2E result is claimed. The historical Taskboard first IPC error remains unknown. The separate fixture's missing captured runtime-policy issue and the historical UI observation are not causally resolved by preserving this error message. This candidate improves truthful, original-request feedback while retaining every existing uncertainty and effect-admission boundary.

## Completed source review before implementation publication

Independent provider R2 and root R3 approved the exact R1 plan, one-statement production change and eight-case test candidate. Root additionally confirmed the only actual renderer caller chain and its existing transport catch. Both original target files remain unchanged in the target branch. These are source/design/test-candidate verdicts; runtime baseline, candidate, formatting, types and lint remain the subsequent gates described above.
