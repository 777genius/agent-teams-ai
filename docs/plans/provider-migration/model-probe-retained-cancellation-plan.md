# Model-probe retained cancellation: preserve the actual original

Status: source/design proposal only. Not implemented, executed or published. Baseline checked once through official GitHub: PR982 head 0e7f75f837e2f9079bcc6bb98d4e6e57334c53b5; the Owner and existing original-receipt fixture are unchanged from edafe97b3921bd2fb86b49631167beae9893e2a6. Execution was unavailable during source review and was restored on 2026-11-28. Both original files remain unchanged at current source ed6af11110f95d448486934cf451e0f730b2ccd3. This is a separate finite correction, not C S1 implementation.

## 1. Two concrete defects and actual caller consequence

ModelProbeOwner.cancelRetained currently reads by command/context, writes readinessRetired:true, then joins original native close. It does not compare the read row with the active entry before that first write.

A valid replacement with the SAME command/context/fingerprint but changed expiresAt or resourceId passes FileManagementCommandStore/schema validation. Cancellation then changes that foreign row's retirement flag. The incoming edafe assertOriginal correctly detects the mismatch during finish, but cannot undo the earlier write.

A second defect is the final acknowledgement: after finish, cancelRetained checks only kind/context/resourceHeld. A valid same-context replacement with phase:'held', ok:false and resourceHeld:false can therefore make cancellation RESOLVE even though finish marked the original entry lost, retained its fence and added cleanup debt.

This resolution is consequential: executeLiveRosterMembership.releaseProbe returns true when cancelRetained resolves and false on rejection; its compensation path may proceed after that result. cancelTeamPreparations also trusts each resolution, and createRuntimeLifecyclePorts.cancelPreparations forwards that aggregate cleanup outcome. No caller changes are necessary; the owner must return a truthful result.

## 2. Exact source manifest

Production: packages/legacy-agent-host/src/management/ModelProbeOwner.ts only.
Tests: packages/legacy-agent-host/tests/management-model-probe-original.test.ts only.
The plan document may be materialized separately at docs/plans/provider-migration/model-probe-retained-cancellation-plan.md for the normal reviewed publication.

No schema/store/fence/caller/native-provider/C capsule change. No new journal, owner, timeout, hash, KDF or public result field. Preserve all incoming edafe guards and its twelve existing file-backed cases.

## 3. Required control algorithm

Keep the existing writer-only entry point and strict command parsing. Capture the current ActiveProbe, if any, before choosing the durable row.

For an ACTIVE entry, first compare the requested context with entry.saved.context. A foreign selector refuses with conflict BEFORE a write, abort or close; matching a foreign replacement's context must not authorize closing the coherent original entry.

For a matching active selector, use the existing assertOriginal(entry) BEFORE deriving or writing the retirement candidate. It checks current writer, same active object and actual complete durable equality, and keeps loss sticky. Derive the retired candidate from that verified entry.saved, not from a separate stale read. Write it, then update entry.saved only after the write returns successfully. No await may separate that qualification from the retirement write.

If qualification/read fails, or the retirement write throws, do not write any repair or claim a completed cancellation. Mark the same entry's original loss sticky, fence it through the existing finish(entry,'held',false), join ONLY its existing close promise and reject held. This cleanup remains owned even when the durable original is missing/replaced. A write may have published before throwing: retain exactly the bytes actually left by the store and hold the original resource; no rollback, recreation or success inference.

After a successful own retirement write, join the existing finish(entry,'cancelled',false). Do not create a second close, replace an existing closing promise or override its already-selected phase. Following that await, read the actual original again under the existing writer guard. Success requires no sticky loss, complete equality with the same entry's resulting saved record, readinessRetired:true, and resourceHeld:false. A foreign released record cannot supply acknowledgement for this entry. Existing close failure/debt stays held.

For NO ACTIVE entry, preserve original-only cleanup: read the actual strict stored model.probe, require the requested context, capture that exact row, and form its retirement-only candidate. There is no active object to compare and no new target/profile/native selection. After the write, the existing final read must equal that exact retirement candidate and be resource-released. A cold held/running receipt still cannot claim native cleanup; a released completed/cancelled/held original can be retired as before. Missing/foreign originals refuse; never fabricate a ProbeSnapshot or cancelled receipt.

This is the existing single-writer, synchronous read/write boundary, not a new filesystem compare-and-swap guarantee against actors violating the profile lease.

## 4. Finite regression matrix

Extend the SAME real FileManagementCommandStore/ModelProbeOwner fixture. Construct every replacement with the real validator; keep the request fingerprint unchanged where applicable. Any store fault wrapper delegates to the real store at the stated boundary. Use deferred native run/close; no sleeps, SDK, external endpoint or time-budget increase.

1. Two active pre-retirement replacements: changed expiresAt; changed resourceId, same command/context/fingerprint. Assert actual bytes unchanged before and after close, only initial claim write, one run/one original close, cancellation held and original namespace held. These are meaningful baseline REDs on foreign-byte preservation.
2. Two matching-active failures: actual receipt deletion; actual read failure. Assert zero retirement/repair writes, close starts once without waiting for a native result, rejection held, and no released fence. The baseline's early refusal without starting owned cleanup is also observable.
3. Restore the exact old bytes while close is pending after an observed pre-retirement mismatch. Assert sticky loss prevents retirement/final publication and successful cancellation.
4. Begin valid own cancellation, then during the blocked close replace its retired receipt with a strict same-context held/released record. Assert replacement bytes stay exact, cancellation rejects rather than resolving, and original fence/debt stays held. This is the second decisive baseline RED: false cleanup acknowledgement.
5. Two uncertain retirement-write faults: throw before delegating; delegate real publication then throw. Both close the original once and reject held; retain the exact pre-write or actually-published retired bytes respectively, with no finish rewrite.
6. Two foreign-selector controls: wrong context against the coherent original; requested context matches a replacement but not the active original. Both refuse conflict with zero cancellation writes/abort/close at that call. Later fixture-owned cleanup remains separate.
7. Cold released original positive: complete a real probe, create a cold owner/store view whose fresh select/prepare seams throw if invoked, retire the exact original context, and require unchanged identity/evidence plus only readinessRetired:true. No run/close/select/preparation is caused by cold retirement. Missing/mismatched context remains refusal.
8. Duplicate own cancellation during one pending close: both calls join the same physical close; both may resolve only after the same exact released original, never a replacement. Preserve the existing own-cancel positive and unchanged native-completion positive.

These are twelve additional bounded cases, alongside the existing twelve incoming cases. If a fault case cannot reach its stated production boundary without invalid fixture data, repair the fixture construction rather than weakening a validator.

## 5. Execution and publication

First publish the source-reviewed plan through root's normal workflow. Only then apply the two-path candidate after rechecking the then-current blobs and independent source review.

When executor and heavy slot are available: run the added cases against unchanged checked edafe-equivalent Owner to record the two intended product assertions failing; preserve the exact baseline source/runtime evidence. Then apply the narrow owner fix, run the same complete 24-case file and the existing focused model-probe admission/readiness controls, canonical Host build, strict scoped test compilation and changed-file checks. Broaden only for a concrete failure. No native/pinned-runtime or full C qualification is claimed by these tests.

## 6. Source ledger

- ModelProbeOwner.ts: feeb6b85b72be0bcadbd3377aeaa3aa927046e34.
- management-model-probe-original.test.ts: be1bb6bcc57789bced1b39307f76343c9c2edee5.
- FileManagementCommandStore.ts: 5311cc3770605998a7491e282640856db46f0bf0.
- ManagementResourceFence.ts: 303cca9973a60cb7d3258cdcd16c5c639220e3c8.
- commandRecords.ts: f7e6e99bebfb093b85e28bf700191c707ff72ac5.
- executeLiveRosterMembership.ts: 28448e28944f9815c5af909f66308d9016e53ec5.
- createRuntimeLifecyclePorts.ts: 2353eb333b3cc5b91c03c8ae78624b8fd8948c55.

All listed paths are under packages/legacy-agent-host/src except the named tests path. No new runtime result.
