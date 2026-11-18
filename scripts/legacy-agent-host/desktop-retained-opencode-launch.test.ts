import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

import { retainedOpenCodeLaunchExpression, RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS } from './desktop-retained-opencode-launch.ts';

type Row = Record<string, unknown>;
const input = {
  intentId: 'TEST-original-choice-once',
  request: { teamName: 'test-retained-opencode-v1', cwd: '/TEST/original-project', providerId: 'opencode' as const,
    model: 'test-legacy/TEST-model' as const, skipPermissions: true as const, runtimeSelectionVersion: 1 as const },
};
const choice = { scopeId: 'TEST-opaque-original-scope', teamName: input.request.teamName,
  mode: 'original-runtime', projectPath: input.request.cwd };
const savedRequest = { ...input.request, members: [{ name: 'bob', role: 'Developer', providerId: 'opencode',
  model: 'test-legacy/TEST-model', mcpPolicy: { mode: 'appOnly' } }] };

// Execute the actual Main admission state machine; only its captured authority ports are finite fixtures.
// Its imports are type-only. Node's transformer handles its parameter properties without a build/install.
const coordinatorSource = readFileSync(new URL(
  '../../src/features/agent-backend/core/application/RetainedLegacyLaunchCoordinator.ts', import.meta.url), 'utf8');
interface Coordinator {
  request(request: Row): Promise<Row>;
  shutdown(): Promise<void>;
}
const { RetainedLegacyLaunchCoordinator, RetainedLegacyLaunchRefusal } = await import(
  'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(coordinatorSource, { mode: 'transform' })).toString('base64')
) as {
  RetainedLegacyLaunchCoordinator: new (ports: {
    capture(): Promise<object>; createId(): string; now(): number;
  }) => Coordinator;
  RetainedLegacyLaunchRefusal: new (reason: string) => Error;
};

function fixture(override?: (request: Row) => unknown | Promise<unknown>) {
  const calls: Row[] = [], alternate: Row[] = [];
  let now = 0, rawLaunches = 0;
  const launch = { runId: 'TEST-new-original-run' };
  const reply = (request: Row, value: unknown) => ({ ok: true, action: request.action, value });
  const backend = {
    async retainedLegacyLaunch(request: Row): Promise<unknown> {
      assert.equal(this, backend, 'the original renderer method keeps its captured receiver');
      const captured = JSON.parse(JSON.stringify(request)) as Row;
      calls.push(captured);
      if (override) {
        const value = await override(captured);
        if (value !== undefined) return value;
      }
      switch (request.action) {
        case 'open': return reply(request, choice);
        case 'read': return reply(request, savedRequest);
        case 'prepare': return reply(request, { ready: true });
        case 'roster': return reply(request, null);
        case 'launch': return reply(request, launch);
        case 'close': case 'closeIntent': return reply(request, null);
        default: assert.fail('Unexpected renderer request');
      }
    },
  };
  const context = { performance: { now: () => now }, Error, AggregateError,
    __TEST_retainedApi: { agentBackend: backend, teams: {
      launchTeam() { rawLaunches++; throw new Error('Original runtime selection is unavailable'); },
    } } };
  return { calls, alternate, launch, context, reply,
    setNow(value: number) { now = value; },
    replaceBackend() {
      context.__TEST_retainedApi.agentBackend = {
        async retainedLegacyLaunch(request: Row) { alternate.push(request); assert.fail('Different owner used'); },
      };
    },
    rawLaunches: () => rawLaunches,
    run: () => runInNewContext(retainedOpenCodeLaunchExpression(input), context) as Promise<Row>,
  };
}

function coordinatorFixture(t: TestContext, options: { unknownRoster?: boolean; changed?: 'source' | 'account' } = {}) {
  const admitted: Row[] = [];
  let sourceCurrent = true, accountCurrent = true, closes = 0, ids = 0;
  const authority = {
    sourceKey: 'TEST-original-physical-source', teamName: input.request.teamName, projectPath: input.request.cwd,
    assertSourceCurrent() { if (!sourceCurrent) throw new RetainedLegacyLaunchRefusal('source-changed'); },
    assertRuntimeCurrent() { if (!accountCurrent) throw new RetainedLegacyLaunchRefusal('account-changed'); },
    readImportAbsence: async () => 'absent', readEligibility: async () => 'native-custody-unverified',
    async run(request: Row) {
      admitted.push(JSON.parse(JSON.stringify(request)) as Row);
      if (request.action === 'read') return structuredClone(savedRequest);
      if (request.action === 'prepare') {
        if (options.changed === 'source') sourceCurrent = false;
        if (options.changed === 'account') accountCurrent = false;
        return { ready: true };
      }
      if (request.action === 'roster') {
        assert.deepEqual(request.request, { members: savedRequest.members });
        if (options.unknownRoster) throw new Error('TEST unknown original roster acknowledgement');
        return null;
      }
      if (request.action === 'launch') return { runId: 'TEST-main-admitted-original-run' };
      assert.fail('Unexpected authority operation');
    },
    async close() { closes++; }, cancelModels: async () => ({ ok: true }),
  };
  const owner = new RetainedLegacyLaunchCoordinator({ capture: async () => authority,
    createId: () => `TEST-main-scope-${++ids}`, now: () => 1000 });
  t.after(() => owner.shutdown());
  return { ...fixture(request => owner.request(request)), owner, admitted, closes: () => closes };
}

test('serialized helper satisfies the actual Coordinator roster-before-Launch admission', async t => {
  const f = coordinatorFixture(t);
  assert.deepEqual(await f.run(), { runId: 'TEST-main-admitted-original-run' });
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'launch', 'close']);
  assert.deepEqual(f.admitted.map(row => row.action), ['read', 'prepare', 'roster', 'launch']);
  assert.deepEqual(f.admitted[2]!.request, { members: savedRequest.members });
  assert.equal(f.closes(), 1);
});

test('actual Coordinator refuses an omitted roster without dispatching original Launch', async t => {
  const f = coordinatorFixture(t);
  const opened = await f.owner.request({ action: 'open', teamName: input.request.teamName, intentId: input.intentId });
  const scopeId = (opened.value as Row).scopeId;
  await f.owner.request({ action: 'read', scopeId });
  await f.owner.request({ action: 'prepare', scopeId, args: [] });
  assert.deepEqual(await f.owner.request({ action: 'launch', scopeId, request: input.request }),
    { ok: false, reason: 'not-eligible', outcome: 'not-dispatched' });
  assert.deepEqual(f.admitted.map(row => row.action), ['read', 'prepare']);
  assert.deepEqual(await f.owner.request({ action: 'close', scopeId }), { ok: true, action: 'close', value: null });
});

test('unknown original roster acknowledgement retains actual Coordinator debt and cannot retry or Launch', async t => {
  const f = coordinatorFixture(t, { unknownRoster: true });
  await assert.rejects(f.run(), error => error instanceof AggregateError &&
    /roster was not confirmed/.test(error.errors[0].message) && /close was not confirmed/.test(error.errors[1].message));
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'close']);
  const roster = f.calls.find(row => row.action === 'roster')!;
  assert.deepEqual(await f.owner.request(roster), { ok: false, reason: 'outcome-unknown', outcome: 'unknown' });
  assert.deepEqual(await f.owner.request({ action: 'launch', scopeId: roster.scopeId, request: input.request }),
    { ok: false, reason: 'not-eligible', outcome: 'not-dispatched' });
  assert.deepEqual(f.admitted.map(row => row.action), ['read', 'prepare', 'roster']);
  assert.equal(f.closes(), 0, 'dialog cleanup cannot certify unknown roster effects absent');
});

for (const changed of ['source', 'account'] as const)
  test(`actual Coordinator ${changed} change during preparation prevents roster and Launch`, async t => {
    const f = coordinatorFixture(t, { changed });
    await assert.rejects(f.run(), /prepare was not confirmed/);
    assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'close']);
    assert.deepEqual(f.admitted.map(row => row.action), ['read', 'prepare']);
    assert.equal(f.closes(), 1);
  });

test('configured Host relaunch chooses, reads, prepares and launches the original owner exactly once', async () => {
  const f = fixture();
  assert.throws(() => runInNewContext('globalThis.__TEST_retainedApi.teams.launchTeam()', f.context),
    /Original runtime selection is unavailable/);
  const result = await f.run();
  assert.equal(result, f.launch);
  assert.equal(f.rawLaunches(), 1, 'the scoped sequence never retries the refused raw legacy API');
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'launch', 'close']);
  assert.deepEqual(f.calls[0], { action: 'open', teamName: input.request.teamName, intentId: input.intentId });
  assert.deepEqual(f.calls[2], { action: 'prepare', scopeId: choice.scopeId, args: [
    input.request.cwd, 'opencode', ['opencode'], [input.request.model], null, 'compatibility',
    [{ providerId: 'opencode', model: input.request.model }], { kind: 'team', teamName: input.request.teamName },
  ] });
  assert.deepEqual(f.calls[3], { action: 'roster', scopeId: choice.scopeId, request: { members: savedRequest.members } });
  assert.deepEqual(f.calls[4], { action: 'launch', scopeId: choice.scopeId, request: input.request });
  assert.equal(JSON.stringify(result).includes(choice.scopeId), false, 'opaque choice is not returned as launch evidence');
  assert.equal(RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS, 240_000);
});

for (const field of ['teamName', 'cwd', 'providerId', 'model', 'skipPermissions', 'runtimeSelectionVersion']) {
  test(`changed saved ${field} refuses preparation and Launch through the same choice`, async () => {
    const f = fixture(request => request.action === 'read'
      ? { ok: true, action: 'read', value: { ...savedRequest, [field]: 'changed' } } : undefined);
    await assert.rejects(f.run(), /saved runtime selection changed/);
    assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'close']);
  });
}

test('missing original saved roster is refused without synthesizing an empty roster', async () => {
  for (const members of [undefined, null, {}]) {
    const f = fixture(request => request.action === 'read'
      ? { ok: true, action: 'read', value: { ...savedRequest, members } } : undefined);
    await assert.rejects(f.run(), /saved roster is unavailable/);
    assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'close']);
  }
});

test('foreign choice and original project mismatch cannot authorize Launch', async () => {
  for (const changed of [{ teamName: 'foreign' }, { projectPath: '/TEST/foreign-project' }]) {
    const f = fixture(request => request.action === 'open'
      ? { ok: true, action: 'open', value: { ...choice, ...changed } } : undefined);
    await assert.rejects(f.run(), /choice does not belong|project changed/);
    assert.deepEqual(f.calls.map(row => row.action), ['open', 'teamName' in changed ? 'closeIntent' : 'close']);
  }
});

test('scoped preparation refusal closes the original choice without dispatching Launch', async () => {
  for (const result of [{ ok: true, action: 'prepare', value: { ready: false } },
    { ok: false, reason: 'account-changed', outcome: 'not-dispatched' }]) {
    const f = fixture(request => request.action === 'prepare' ? result : undefined);
    await assert.rejects(f.run(), /preparation is not ready|prepare was not confirmed/);
    assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'close']);
  }
});

test('one original cutoff is enforced after awaited preparation and no native launch is retried', async () => {
  let resolve!: (value: unknown) => void;
  let entered!: () => void;
  const pending = new Promise<void>(done => { entered = done; });
  const f = fixture(request => request.action === 'prepare' ? new Promise(done => { resolve = done; entered(); }) : undefined);
  const result = f.run();
  await pending;
  f.setNow(RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS);
  resolve({ ok: true, action: 'prepare', value: { ready: true } });
  await assert.rejects(result, /deadline expired/);
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'close']);
});

test('lost open acknowledgement closes only its original intent and never invents another open', async () => {
  const failure = new Error('TEST lost original open acknowledgement');
  const f = fixture(request => { if (request.action === 'open') throw failure; });
  await assert.rejects(f.run(), error => error === failure);
  assert.deepEqual(f.calls, [{ action: 'open', teamName: input.request.teamName, intentId: input.intentId },
    { action: 'closeIntent', teamName: input.request.teamName, intentId: input.intentId }]);
});

test('confirmed close at the original cutoff cannot qualify a late Launch result', async () => {
  let resolve!: (value: unknown) => void;
  let entered!: () => void;
  const pending = new Promise<void>(done => { entered = done; });
  const f = fixture(request => request.action === 'close' ? new Promise(done => { resolve = done; entered(); }) : undefined);
  const result = f.run();
  await pending;
  f.setNow(RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS);
  resolve({ ok: true, action: 'close', value: null });
  await assert.rejects(result, /deadline expired/);
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'launch', 'close']);
});

test('lost Launch acknowledgement cannot dispatch another native start', async () => {
  const failure = new Error('TEST lost original Launch acknowledgement');
  const f = fixture(request => { if (request.action === 'launch') throw failure; });
  await assert.rejects(f.run(), error => error === failure);
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'launch', 'close']);
});

test('all reads, execution and stop-only cleanup retain the initially captured renderer transport', async () => {
  const f = fixture(request => { if (request.action === 'read') f.replaceBackend(); });
  await f.run();
  assert.deepEqual(f.alternate, []);
  assert.deepEqual(f.calls.map(row => row.action), ['open', 'read', 'prepare', 'roster', 'launch', 'close']);
});

test('unconfirmed scope cleanup cannot turn a successful Launch reply into a qualified result', async () => {
  const f = fixture(request => request.action === 'close'
    ? { ok: false, reason: 'outcome-unknown', outcome: 'unknown' } : undefined);
  await assert.rejects(f.run(), /close was not confirmed/);
  assert.equal(f.calls.filter(row => row.action === 'launch').length, 1);
  assert.equal(f.calls.filter(row => row.action === 'close').length, 1);
});

test('primary refusal is preserved alongside a failed cleanup acknowledgement', async () => {
  const failure = new Error('TEST original authority changed'), cleanup = new Error('TEST original close unknown');
  const f = fixture(request => { if (request.action === 'prepare') throw failure;
    if (request.action === 'close') throw cleanup; });
  await assert.rejects(f.run(), error => error instanceof AggregateError &&
    error.errors[0] === failure && error.errors[1] === cleanup);
  assert.equal(f.calls.some(row => row.action === 'launch'), false);
});
