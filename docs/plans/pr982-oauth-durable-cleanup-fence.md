# PR #982: OAuth original durable receipt fencing at cleanup

## Scope and evidence

Fix the open P1 review on OAuthOperationOwner: expiry timers, cancellation and close can publish to a deleted/replaced FileManagementCommandStore record; asynchronous native completion can publish after a competing record mutation. Existing explicit/browser completion tests check only paths that first notice a conflict; the real timer and cleanup path are not covered.

Keep the original native session cleanup mandatory and its captured namespace held if durable state is unknown. Never select a new profile/native host; never recreate or overwrite a changed command record. No provider behavior or management journal schema changes.

## Implementation

1. Add a single exact-original durable equality gate for the active stored OAuth record before every publication (authorize result, completing, finishing, timer/cancel/close). A read error, absence or changed data fences the entry, rather than publishing.
2. Stop writing by mutating `entry.saved` in place. Build the next receipt first, recheck the original, write synchronously, then advance in-memory `saved` only on confirmed publication. A write that may have partially succeeded must retain custody and avoid further writes.
3. On `stop`, retire/abort the native path before any await. Revalidate independently both before its cancellation write and after asynchronous `native.close()`, immediately before its final write. Always close the original native capture; journal conflict must never suppress native close.
4. Keep already-confirmed successful completion and idempotent cold replay immutable; preserve ordinary cancel -> cancelled when record is still the same and native close confirms.
5. Add TEST-only FileManagementCommandStore regressions for unchanged expiry and cancellation, changed/missing receipt before timer/cancel, mutation while blocked close, and a late native completion after durable replacement. Assert exact pre/post file bytes, no new completion, namespace custody held on uncertain outcome.
6. Run pinned Host build, typecheck, focused tests and then required exact-head CI/native acceptance. Publish evidence; do not merge while gates are unproven.

## Review R1 (invariant)

Checking the in-memory `saved` fingerprint is not enough; the journal can be replaced between awaits. Every write must compare the exact persisted original immediately before it. Avoid a read-then-write TOCTOU across await by executing them synchronously.

## Review R2 (failure semantics)

A failed journal write is outcome-unknown, not guaranteed unwritten; do not retry with another state and risk overwriting an external writer. Preserve held custody and make `close()` report unresolved cleanup. Native close still occurs exactly once.

## Review R3 (regression compatibility)

The usual cancel flow emits cancelling progress synchronously and later cancelled on confirmed native close. Original record shape, sequence increments, and explicit completion/retained replay semantics stay unchanged. A missing/replaced receipt must never be recreated even by a timer. Avoid touching process pagination, Restart, macOS native, Runtime delivery, or credential KDF owner files.

Estimated change: 70-130 production LOC and ~100-150 test LOC; complexity 6/10; reliability target 9/10 after tests; confidence in diagnosed bug 9/10. No readiness claim before tests.
