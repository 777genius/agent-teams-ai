import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readRendererBackendConnections } from './desktop-backend-observations.ts';

test('read-only discovery survives navigation during the actual IPC read, then reads the new context', async () => {
  let reads = 0;
  const cdp = { async evaluate(expression: string) {
    if (expression.startsWith('Boolean(')) return true;
    reads++;
    if (reads === 1) throw new Error('Execution context was destroyed.');
    return { state: 'ready', bindings: [{ handle: 'original-owner' }] };
  } };
  assert.deepEqual(await readRendererBackendConnections(cdp), { kind: 'pending', reason: 'context-replaced' });
  assert.deepEqual(await readRendererBackendConnections(cdp), { kind: 'read', value: { state: 'ready', bindings: [{ handle: 'original-owner' }] } });
  assert.equal(reads, 2);
});

test('unregistered initial discovery waits, but owner failures are never hidden as navigation', async () => {
  const cdp = (failure: string) => ({ async evaluate(expression: string) {
    if (expression.startsWith('Boolean(')) return true;
    throw new Error(failure);
  } });
  assert.deepEqual(await readRendererBackendConnections(cdp("No handler registered for 'agentBackend:connections'")), { kind: 'pending', reason: 'handler-not-ready' });
  await assert.rejects(readRendererBackendConnections(cdp('Owner read forbidden')), /Owner read forbidden/);
});


test('initial discovery passes only its remaining captured budget to the IPC await', async (t) => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const budgets: Array<number | undefined> = [];
  const cdp = {async evaluate(expression: string, timeoutMs?: number) {
    budgets.push(timeoutMs);
    if (expression.startsWith('Boolean(')) {clock += 10_000; return true;}
    assert.equal(timeoutMs, 50_000, 'bridge lookup time is charged to the original60s deadline');
    clock += 40_000;
    return {state:'ready', bindings:[]};
  }};
  assert.deepEqual(await readRendererBackendConnections(cdp, 60_000),
    {kind:'read', value:{state:'ready', bindings:[]}});
  assert.deepEqual(budgets, [60_000, 50_000]);
});

test('exhausted initial observation never dispatches the backend IPC', async (t) => {
  let clock = 0, calls = 0;
  t.mock.method(performance, 'now', () => clock);
  const cdp = {async evaluate(_expression: string, timeoutMs?: number) {
    calls++; assert.equal(timeoutMs, 100); clock = 100; return true;
  }};
  await assert.rejects(readRendererBackendConnections(cdp, 100), /initial backend discovery observation deadline/);
  assert.equal(calls, 1);
});

test('other discovery callers retain the default CDP budget', async () => {
  const budgets: Array<number | undefined> = [];
  await readRendererBackendConnections({async evaluate(expression, timeoutMs) {
    budgets.push(timeoutMs); return expression.startsWith('Boolean(') ? true : {state:'hold'};
  }});
  assert.deepEqual(budgets, [undefined, undefined]);
});


class CdpFixtureSocket extends EventEmitter {
  readonly sent: Array<{id:number; method:string}> = [];
  send(value: string): void { this.sent.push(JSON.parse(value) as {id:number; method:string}); }
  answer(id: number, value: unknown): void {
    this.emit('message', JSON.stringify({id, result:{result:{value}}}));
  }
}
const { CdpClient } = createRequire(import.meta.url)('../e2e/comment-notification/cdp.mjs') as {
  CdpClient: new(socket: CdpFixtureSocket) => {
    evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  };
};

test('an explicit IPC observation budget lets the same read settle after30s within60s', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const socket = new CdpFixtureSocket(), client = new CdpClient(socket);
  const pending = client.evaluate('readOnlyConnections()', 60_000);
  // Observe rejection immediately as well, so old-code RED has no unhandled rejection.
  const outcome = pending.then(value => ({ok:true as const, value}),
    () => ({ok:false as const}));
  t.mock.timers.tick(30_001);
  assert.equal(socket.sent.length, 1, 'one original read; no resend or replacement');
  socket.answer(socket.sent[0]!.id, {state:'ready'});
  assert.deepEqual(await outcome, {ok:true, value:{state:'ready'}});
});

test('default CDP evaluations still reject at30s without a resend', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const socket = new CdpFixtureSocket(), client = new CdpClient(socket);
  let settled = false;
  const pending = client.evaluate('ordinaryObservation()');
  void pending.then(() => {settled=true;}, () => {settled=true;});
  const rejection = assert.rejects(pending, /CDP command timed out: Runtime.evaluate/);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(socket.sent.length, 1);
});
