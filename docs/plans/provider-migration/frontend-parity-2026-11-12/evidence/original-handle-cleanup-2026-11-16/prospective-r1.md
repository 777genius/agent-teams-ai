# Inert R1 — await the original captured HANDLE before reporting the saved cleanup conjunction

## Authority and exact one-path boundary

This is a prospective source proposal and evidence review, not a canonical selection, publication, executed test result, or permission to advance a branch. Root must bind the then-current parent, preserve every intervening source/documentary leaf, publish the bound documentary R1 and obtain its independent readback R2 before applying the exact source child. The appendix belongs to the existing relevant plan; this packet does not allocate or assume a new Plan55.

The original failure is source-bound to 3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b, Windows x64 Process job133531812580, provider OpenCode, original Team-A stage. The saved parent leaf map is `root/plan53-consumer-parent-3be1-selection.json`. The relevant source and helper pins also remain unchanged through the later consumer3/documentary readbacks supplied by root. That preservation is not a fresh branch lease.

The sole prospective source path is `tools/owned-process-broker/nativeEmulatedSourceScenario.ts`:

| Image | Git blob | Bytes | Physical lines |
| --- | --- | ---: | ---: |
| Before | 9b3a19c372ab3c52e28848b19f67c99fe8bab1f5 | 59,419 | 800 |
| After | b1f0e95ce23ac56ee4ce400157be3316afddbd29 | 59,461 | 800 |

The afterimage SHA256 is `0a23987a84677fc2fc20f44f565cd20150ee6108111dc5793d52bcc9e01ff436`. The full unified patch is `96da4bd5b4277e58629f2116be867ba801b8a296`, 1,166 bytes, SHA256 `533e3ff2b76b4754b232218c1d2dd9ebf2fb3676887449ee48a1cfcdea5c8425`. The entire inverse restores the original source, and every byte outside the four-line window is unchanged. No cap/baseline is raised, no old lines are compacted, and no helper, test, workflow, dependency, policy or production owner is added or changed.

## Actual failure and the evidence boundary

The retained raw log is 12,183 bytes /61 lines, Git `569ec4760cd68d2b653916dc408ef35d24e1e27f`, SHA256 `93e9283e1a2d9562c4742193f7f933d9fa230e4b5df993307780be671e516c7b`. The original receipt is 18,988 bytes, Git `f546527c561dfc5cddbb194ae639a2cba0b48a4c`, SHA256 `ce5ae1f2d42a8d26cb63df038323ba201961d4b8277730df3e4116f16dcd13af`. Their local paths and full source pins are in audit.json. They were reused once from the sole native owner's retained bundle; no log or archive retrieval was repeated.

The first failure remains the original readiness assertion at poll line62, reached through launch489 and Team-A545. The last completed runtime read was number77 at14983.7021ms, with nativeReady=false, phase=held, and attached=false; the next iteration's original deadline check failed. This packet does not infer the latency cause or replace the separate current() cost analysis.

The raw aggregate then contains one secondary nested assertion at close316: “Every original physical Job retains confirmed Stop/drain/release”. The actual conjunction additionally requires root, witness and resumed. Slot2 has a captured root and witness, zero resume calls and resumed=false, while the original Stop/drain/release acknowledgements are all true. The conjunction therefore throws before witness.wait at318. Its final originalHandleAbsent=false is the initialized/unmodified flag. It is not a retained failing HANDLE-wait result and does not establish that the process survived.

| Job slot | Captured original root | Resumed | Stop/drain/release | Logged handle flag | Final handle flag | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | PID4468 /birth01dd75fde406202e | true | all true | true | true | publish-A already awaited the original witness at402 and set the flag at403 |
| 1 | PID964 /birth01dd75fde515e6ad | true | all true | false | true | cleanup log310–315 precedes wait318 and assignment319 |
| 2 | PID4004 /birth01dd75fdebd127c7 | false | all true | false | false | conjunction316 prevents this witness wait |

Slot1's false-to-true transition is source-explained observation order, not evidence of a measured late process disappearance. Slot2's Stop, drain and release callbacks completed by17639.5403ms, before firstClose21398.299ms; their acknowledged state does not substitute for the missing original-HANDLE observation.

The inner scenario status remains INCOMPLETE and cleanup=false. The root receipt cleanup=true comes from the outer Gate's sentinel exit await, and the final controller row is drained/rootExitCode1/activeProcesses0. Neither outer fact transfers to the skipped inner assertion. The original main failure is retained first by the existing AggregateError construction at739.

## What the existing original-HANDLE oracle proves

The complete exact helper is `nativeGateContext.ts`, Git `27c6da3bac59ac276c40e79f7c4e1c548adb9d31`, 7,278 bytes. One immutable blob read was retained with its complete response; a peer concurrently located the identical existing cached body. Both texts and the current saved leaf match. The actor body was reused locally, not fetched again: `nativeFixture.cpp`, Git `8fc74b25d5334395b455ee189e333b53ec9e4d36`, 19,440 bytes.

Scenario235–237 captures the query-wait-gated witness using the original prepare root PID and FILETIME birth before returning preparation to Host/resume. The actor verifies original outer Job membership, opens one process HANDLE with SYNCHRONIZE and PROCESS_QUERY_LIMITED_INFORMATION, checks creation identity, and reports captured. Its bounded optional Q observations and eventual W wait refer to that same held HANDLE. There is no later PID reopen or target signal.

The actor's nonvendor W branch performs WaitForSingleObject on that HANDLE with the existing15000ms bound, closes the HANDLE, and exits0 only for WAIT_OBJECT_0. The JavaScript helper memoizes wait(); it sends at most one W, then awaits the original actor exit. Existing independent10000ms wrappers cover the write and exit awaits. These timers are unchanged; there is no new hard real-time or cancellation claim.

An awaited actor exit0 qualifies termination of this original captured root process object. It does not assert that the target process itself exited0, that every descendant terminated, or that every system HANDLE was closed. Other original custody/drain/cleanup requirements remain independent.

## Exact correction and preserved acceptance

The new four-line window is:

```ts
            const custodyConfirmed = job.root && job.witness && job.resumed && job.stopped && job.drained && job.released;
            assert.equal(await job.witness?.wait(), 0);
            job.handleAbsent = true;
            assert.ok(custodyConfirmed, 'Every original physical Job retains confirmed Stop/drain/release');
```

The original conjunction is evaluated at its original point before the wait. Storing that primitive value prevents later custody acknowledgements during the wait from changing a previously false acceptance predicate. The original assertion message is retained.

The existing witness wait is now reached even when this captured Job has not resumed. Optional access does not admit a missing witness: undefined cannot equal0, so the strict assertion fails and the flag remains false. A nonzero or null actor exit also fails. A thrown or rejected wait remains a cleanup error. Only a completed wait returning0 sets originalHandleAbsent=true.

The saved conjunction is then asserted. Thus an unresumed Job still fails even if its captured HANDLE is now observed signaled. Every successful cleanup still requires the original pre-wait root, witness, resumed, stopped, drained and released conditions. The primary readiness failure is neither repaired nor removed, and the original scenario cannot become PASS merely because this observation becomes reachable.

If the witness wait itself fails, the later composite assertion is not reached. This proposal does not claim that every old cleanup assertion executes after a wait failure. When both defects exist, cleanup error ordering changes; the independent original readiness error remains first in the outer aggregate. No error is converted to success.

## Cost and containment

The change makes a previously skipped captured-failure-path wait run. That is real additional failure-path work, inside the existing helper/native/controller limits. It may consume the existing write/exit timeout intervals before the failure is reported. There is no zero-extra-work claim.

The normal successful path retains one original wait, and a previously awaited slot such as slot0 reuses the same memoized promise without sending another W. No new actor, process, Job, native query, signal, retry, deadline, clock call, timestamp, external read, source admission, provider action or helper framework is introduced. The one local primitive snapshot evaluates the same conjunction operands as the original assertion.

Host shutdown, physical.close, the cleanup log position, epoch iteration, error collection, source/pin checks, observer-child termination, the runtime projection reader, first-refusal diagnostics, the original15000ms readiness poll and25ms polling delay remain byte-identical. No cleanup result or eligibility is inferred from outer controller drain.

## Existing qualification route; no added cycle

This source is already an explicit operand of the resulting Host Team fast-lint invocation: current source workflow `a1513210012356a5178620b1f370bd1daf0de9d9` retains it at line120. No workflow operand amendment is needed.

The unchanged retained-host type project `905f1a1489f3b37d651a9984169b0321c9915a15` includes nativeEmulatedProviderGate.ts. That exact Gate `31a6c30bd3962500e20e99786353cb9ec418adaf` imports nativeEmulatedSourceScenario directly, so the dedicated original retained-host compiler reaches this source. The broad broker project `4936675ad8af5a71d8c001a414836e90250a5daf` excludes this scenario directly; it must not be cited alone as its compiler coverage.

Preserve the complete existing Process build/contracts/type checks, the original Windows source A/B native gates in Host Node on x64 and ARM, and the separate original Job/control gates in Host Node and Electron Node on those platforms. Preserve the existing Host scoped lint/static gates and all other current plan obligations. This packet selects no new job, test suite, isolated replay, manual action, separate RED-only cycle, or changed original invocation. No local project command has been run.

Resulting-source original CI must establish its own actual outcomes. A successful cleanup must still satisfy the saved composite and original-HANDLE oracle; any captured pre-resume failure must retain the original business/deadline failure while reporting only the HANDLE fact actually observed. If the native wait fails or the original readiness remains failed, preserve the raw errors and diagnose them; no budget increase, oracle relaxation, replay, or broader cleanup authority is pre-approved.

## What this review does not close

This source/data review does not establish original slot2 physical absence, fix the original15s failure, qualify every provider/source case, grant P08/P09/P10/P11/vendor/release completion, or advance any branch. It creates an exact, reviewable one-path candidate. Root still owns fresh parent/ref/cohort preservation, the bound documentary R1 and published-R1 R2, source publication, and the existing original CI evidence.
