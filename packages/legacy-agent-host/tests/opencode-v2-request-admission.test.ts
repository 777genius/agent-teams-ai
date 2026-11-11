import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeV2RequestAdmission } from '../dist/adapters/providers/OpenCodeV2RequestAdmission.js';

test('request reservation survives await gap and prevents a probe from invalidating in-flight credentials', async () => {
  const reattestations = new Set<Promise<void>>();
  const probe = Promise.withResolvers<void>();
  const abort = new AbortController();
  let ready = true;
  const admission = createOpenCodeV2RequestAdmission({
    reattestations, signal: abort.signal, isCurrent: () => true, isReady: () => ready,
  });
  const first = admission.beforeRequest(abort.signal);
  reattestations.add(probe.promise);
  let probing = false;
  const draining = admission.waitForDrain(abort.signal).then(ok => { probing = ok; ready = !ok; });
  const release = await first;
  assert.equal(probing, false, 'a probe waits for the transport that already owns verified admission');
  let nextAdmitted = false;
  const next = admission.beforeRequest(abort.signal).then(value => { nextAdmitted = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(nextAdmitted, false, 'later native polling cannot read credentials during a queued probe');
  release(); release();
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
    reattestations, signal: abort.signal, isCurrent: () => true, isReady: () => true,
  });
  const release = await admission.beforeRequest(new AbortController().signal);
  reattestations.add(new Promise(() => {}));
  const queued = admission.beforeRequest(new AbortController().signal);
  const draining = admission.waitForDrain(new AbortController().signal);
  abort.abort();
  await assert.rejects(queued, /custody revoked/);
  assert.equal(await draining, false);
  release();
  assert.equal(admission.hasRequest(), false, 'late transport release remains safe after revocation');
  await assert.rejects(admission.beforeRequest(new AbortController().signal), /custody revoked/);
});
