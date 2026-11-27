import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDesktopQuitWithObservation } from './startup-passive-observer.ts';

const expression = 'window.electronAPI.windowControls.close()';
type Row = Record<string, unknown>;

test('records the original deferred Quit reply with one call and unchanged evidence', async () => {
  const evidence: Row = { status: 'INCOMPLETE', cleanup: { appExitCode: null } };
  let reply!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { reply = resolve; });
  const calls: unknown[][] = [];
  const quit = requestDesktopQuitWithObservation({
    evaluate(...args: [string]) { calls.push(args); return pending; },
  }, evidence);
  const observation = evidence.originalRequestedQuitReply as Row;
  assert.deepEqual(calls, [[expression]]);
  assert.equal(observation.reply, 'pending');
  assert.equal(observation.finishedAtMs, undefined);
  reply({ private: 'TEST-secret-reply' });
  assert.equal(await quit, undefined);
  assert.equal(observation.reply, 'acknowledged');
  assert.equal(typeof observation.startedAtMs, 'number');
  assert.equal(typeof observation.finishedAtMs, 'number');
  assert.equal(evidence.status, 'INCOMPLETE');
  assert.deepEqual(evidence.cleanup, { appExitCode: null });
  assert.equal(JSON.stringify(evidence).includes('TEST-secret-reply'), false);
  assert.equal(calls.length, 1);
});

for (const message of ['CDP connection closed', 'CDP command timed out: Runtime.evaluate',
  'Renderer evaluation failed']) {
  test('preserves consumed Quit rejection: ' + message, async () => {
    const evidence: Row = { status: 'INCOMPLETE' };
    let calls = 0;
    await requestDesktopQuitWithObservation({
      evaluate(...args: [string]) {
        calls++;
        assert.deepEqual(args, [expression]);
        return Promise.reject(Object.assign(new Error(message), { secret: 'TEST-private' }));
      },
    }, evidence);
    const observation = evidence.originalRequestedQuitReply as Row;
    assert.equal(observation.reply, 'rejected');
    assert.equal(observation.reason, message);
    assert.equal(typeof observation.finishedAtMs, 'number');
    assert.equal(evidence.status, 'INCOMPLETE');
    assert.equal(JSON.stringify(evidence).includes('TEST-private'), false);
    assert.equal(calls, 1);
  });
}

for (const error of [new Error('CDP connection closed TEST-private'), { secret: 'TEST-private' }]) {
  test('does not store or misclassify arbitrary rejection details', async () => {
    const evidence: Row = {};
    await requestDesktopQuitWithObservation({ evaluate: () => Promise.reject(error) }, evidence);
    const observation = evidence.originalRequestedQuitReply as Row;
    assert.equal(observation.reply, 'rejected');
    assert.equal(observation.reason, 'unclassified');
    assert.equal(JSON.stringify(evidence).includes('TEST-private'), false);
  });
}

test('preserves the original propagation of a synchronous CDP error', async () => {
  const original = new Error('synchronous failure');
  let calls = 0;
  await assert.rejects(requestDesktopQuitWithObservation({
    evaluate() { calls++; throw original; },
  }, {}), error => error === original);
  assert.equal(calls, 1);
});
