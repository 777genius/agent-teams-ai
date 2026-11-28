import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeV2RequestAdmission } from '../dist/adapters/providers/OpenCodeV2RequestAdmission.js';

test('request reservation survives await gap and prevents a probe from invalidating in-flight credentials', async () => {
  const reattestations = new Set<Promise<void>>();
  const probe = Promise.withResolvers<void>();
  const abort = new AbortController();
  let ready = true;
  const admission = createOpenCodeV2RequestAdmission({
    reattestations,
    signal: abort.signal,
    isCurrent: () => true,
    isReady: () => ready,
  });
  const first = admission.beforeRequest(abort.signal);
  reattestations.add(probe.promise);
  let probing = false;
  const draining = admission.waitForDrain(abort.signal).then((ok) => {
    probing = ok;
    ready = !ok;
  });
  const release = await first;
  assert.equal(
    probing,
    false,
    'a probe waits for the transport that already owns verified admission'
  );
  let nextAdmitted = false;
  const next = admission.beforeRequest(abort.signal).then((value) => {
    nextAdmitted = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    nextAdmitted,
    false,
    'later native polling cannot read credentials during a queued probe'
  );
  release();
  release();
  await draining;
  assert.equal(probing, true);
  assert.equal(admission.hasRequest(), false, 'release is idempotent');
  ready = true;
  reattestations.delete(probe.promise);
  probe.resolve();
  const releaseNext = await next;
  assert.equal(nextAdmitted, true);
  releaseNext();
});

test('revocation cancels queued native requests and draining without renewing admission', async () => {
  const reattestations = new Set<Promise<void>>();
  const abort = new AbortController();
  const admission = createOpenCodeV2RequestAdmission({
    reattestations,
    signal: abort.signal,
    isCurrent: () => true,
    isReady: () => true,
  });
  const release = await admission.beforeRequest(new AbortController().signal);
  reattestations.add(new Promise(() => {}));
  const queued = admission.beforeRequest(new AbortController().signal);
  const draining = admission.waitForDrain(new AbortController().signal);
  abort.abort();
  await assert.rejects(queued, /custody revoked/);
  assert.equal(await draining, false);
  release();
  assert.equal(
    admission.hasRequest(),
    false,
    'late transport release remains safe after revocation'
  );
  await assert.rejects(admission.beforeRequest(new AbortController().signal), /custody revoked/);
});

test('normal close rejects queued admission and waits only for the original admitted body', async () => {
  const reattestations = new Set<Promise<void>>();
  const abort = new AbortController();
  const admission = createOpenCodeV2RequestAdmission({
    reattestations,
    signal: abort.signal,
    isCurrent: () => true,
    isReady: () => true,
  });
  const release = await admission.beforeRequest(new AbortController().signal);
  reattestations.add(new Promise(() => {}));
  const queued = admission.beforeRequest(new AbortController().signal);
  let finished = false;
  const closing = admission.close(new AbortController().signal).then((value) => {
    finished = true;
    return value;
  });
  await assert.rejects(queued, /custody revoked/);
  await assert.rejects(admission.beforeRequest(new AbortController().signal), /custody revoked/);
  assert.equal(abort.signal.aborted, false, 'existing finite native I/O is not cancelled first');
  assert.equal(finished, false, 'unreleased HTTP body still owns its original lease');
  release();
  release();
  assert.equal(await closing, true, 'a suspended owner probe cannot deadlock closing admission');
  assert.equal(admission.hasRequest(), false);
});

test('normal close deadline cannot certify outstanding native request custody', async () => {
  const abort = new AbortController(),
    deadline = new AbortController();
  const admission = createOpenCodeV2RequestAdmission({
    reattestations: new Set(),
    signal: abort.signal,
    isCurrent: () => true,
    isReady: () => true,
  });
  const release = await admission.beforeRequest(new AbortController().signal);
  const closing = admission.close(deadline.signal);
  deadline.abort();
  assert.equal(await closing, false);
  release();
  assert.equal(
    await closing,
    false,
    'a late release cannot replace the original UNKNOWN close result'
  );
  await assert.rejects(admission.beforeRequest(new AbortController().signal), /custody revoked/);
});
