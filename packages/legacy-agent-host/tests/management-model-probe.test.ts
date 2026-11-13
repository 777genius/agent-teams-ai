import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner, nativeCoordinationPurpose } from '../dist/management/ModelProbeOwner.js';
import { closeCoordinationByDeadline, OpenCodeCoordinationEndpoint, coordinationPrompt } from '../dist/adapters/providers/OpenCodeCoordinationEndpoint.js';
import { runNativeCoordination } from '../dist/adapters/providers/OpenCodeCoordinationProbe.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import type { ManagementCommandStore } from '../src/management/commandRecords.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const start = {
  commandId: 'TEST-model-probe',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  modelId: 'TEST-provider/TEST-model',
};
const lookup = {
  commandId: start.commandId,
  profileId: start.profileId,
  configRevision: start.configRevision,
};

test('a Team model probe binds its context and cannot publish a result after its captured authority is revoked', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.throws(() => f.owner.start({ ...start, context: 'd'.repeat(64) }, () => false), {
    code: 'held',
  });
  assert.equal(f.runs(), 0);
  assert.equal(Array.from(f.base.list()).length, 0);
  let current = true;
  f.owner.start(
    { ...start, context: 'd'.repeat(64), effort: 'medium', modelContext: 'model-default' },
    () => current
  );
  assert.equal(f.owner.read(lookup)?.context, 'd'.repeat(64));
  current = false;
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  assert.equal(f.base.read(start.commandId)?.resourceHeld, false);
  assert.throws(() => f.make().start({ ...start, context: 'e'.repeat(64) }), { code: 'conflict' });
  assert.equal(f.runs(), 1);
  const privateProbe = fixture();
  t.after(privateProbe.cleanup);
  let original = true;
  privateProbe.owner.startNativeCoordination({ ...start, context: 'd'.repeat(64) }, () => original);
  original = false; privateProbe.result.resolve(true);
  await until(() => privateProbe.owner.read(lookup)?.phase === 'cancelled');
  assert.throws(() => privateProbe.owner.readNativeCoordination({ ...lookup, context: 'd'.repeat(64) }), { code: 'held' });
  assert.equal(privateProbe.base.read(start.commandId)?.resourceHeld, false);
  assert.equal(privateProbe.runs(), 1);
});
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise<void>((done) => setImmediate(done));
  assert.ok(check());
}
function fixture(
  options: {
    timeoutMs?: number;
    cleanupFails?: boolean;
    failRun?: boolean;
    blockClose?: boolean;
    store?: (base: ManagementCommandStore) => ManagementCommandStore;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-probe-')));
  const base = new FileManagementCommandStore(root),
    store = options.store?.(base) ?? base;
  const target = {
    profileId: start.profileId,
    configRevision: start.configRevision,
    selectionDigest: 'a'.repeat(64),
    resourceId: 'b'.repeat(64),
  };
  let current = true,
    runs = 0,
    closes = 0;
  const purposes: (string | undefined)[] = [];
  const deadlines: { phase: 'run' | 'close'; deadline: number | undefined }[] = [];
  const result = deferred<boolean>(),
    close = deferred<boolean>();
  const fence = new ManagementResourceFence(store.list());
  const writer = () => {
    if (!current) throw new Error('TEST revoked');
  };
  const make = () =>
    new ModelProbeOwner({
      store,
      fence,
      assertWriter: writer,
      select: () => ({ ...target }),
      prepare: (_input, _current, purpose) => {
        purposes.push(purpose);
        return {
          timeoutMs: options.timeoutMs ?? 10000,
          async run(_signal: AbortSignal, deadline?: number) {
            assert.equal(base.read(start.commandId)?.phase, 'running');
            deadlines.push({ phase: 'run', deadline });
            runs++;
            if (options.failRun) throw new Error('TEST native observation unavailable');
            return result.promise;
          },
          async close(deadline?: number) {
            deadlines.push({ phase: 'close', deadline });
            closes++;
            return options.blockClose ? close.promise : !options.cleanupFails;
          },
          };
      },
    });
  const owner = make();
  const credentials = new CredentialCommandOwner({
    store,
    fence,
    assertCurrent: writer,
    select: () => ({ ...target }),
    perform: async () => ({ ok: true, settled: true }),
  });
  return {
    root,
    base,
    purposes,
    deadlines,
    owner,
    make,
    credentials,
    result,
    close,
    runs: () => runs,
    closes: () => closes,
    revoke: () => {
      current = false;
    },
    changeTarget: () => {
      target.selectionDigest = 'c'.repeat(64);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('model probe claims before native work and returns original result without a second model request on replay', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(f.owner.start(start).phase, 'running');
  assert.equal(f.runs(), 1);
  assert.equal(f.owner.start(start).phase, 'running');
  assert.equal(f.runs(), 1);
  assert.throws(() => f.owner.start({ ...start, modelId: 'TEST-other' }), { code: 'conflict' });
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'busy' }
  );
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.equal(f.owner.read(lookup)?.ok, true);
  assert.equal(f.closes(), 1);
  assert.equal(f.make().start(start).ok, true);
  assert.equal(f.runs(), 1);
  const journal = readdirSync(join(f.root, 'management-commands'))
    .map((name) => readFileSync(join(f.root, 'management-commands', name), 'utf8'))
    .join('');
  assert.equal(journal.includes('sessionID'), false);
  assert.throws(() => f.owner.readNativeCoordination({ ...lookup, context: 'd'.repeat(64) }), { code: 'conflict' },
    'an original text-only success cannot qualify the stronger purpose');
  assert.throws(() => f.owner.startNativeCoordination({ ...start, context: 'd'.repeat(64) }, () => true), { code: 'conflict' });
  await f.owner.close();
  const historical = fixture(); t.after(historical.cleanup);
  const historicalInput = { ...start, context: 'e'.repeat(64) };
  historical.owner.start(historicalInput); historical.result.resolve(true);
  await until(() => historical.owner.read(lookup)?.phase === 'completed');
  assert.throws(() => historical.owner.readNativeCoordination({ ...lookup, context: historicalInput.context }),
    { code: 'conflict' }, 'same context text-only receipt still has the wrong purpose');
  assert.throws(() => historical.owner.startNativeCoordination(historicalInput, () => true), { code: 'conflict' });
  assert.equal(historical.runs(), 1); await historical.owner.close();
  const stronger = fixture();
  t.after(stronger.cleanup);
  const context = 'e'.repeat(64), input = { ...start, context }, exact = { ...lookup, context };
  assert.throws(() => stronger.owner.start({ ...input, purpose: nativeCoordinationPurpose }));
  assert.throws(() => stronger.owner.startNativeCoordination(start, () => true));
  assert.equal(stronger.purposes.length, 0); assert.equal(stronger.runs(), 0);
  const before = Date.now(), first = stronger.owner.startNativeCoordination(input, () => true), after = Date.now();
  assert.ok(first.expiresAt >= before + 10000 && first.expiresAt <= after + 10000);
  assert.deepEqual(stronger.purposes, [nativeCoordinationPurpose]);
  assert.deepEqual(stronger.deadlines, [{ phase: 'run', deadline: first.expiresAt }]);
  const claimed = stronger.base.read(start.commandId);
  assert.ok(claimed?.kind === 'model.probe'); assert.equal(claimed.purpose, nativeCoordinationPurpose);
  assert.equal(claimed.resourceHeld, true);
  assert.throws(() => stronger.owner.readNativeCoordination(exact), { code: 'held' });
  assert.throws(() => stronger.owner.start(input), { code: 'conflict' });
  stronger.owner.startNativeCoordination(input, () => true);
  assert.equal(stronger.runs(), 1); assert.equal(stronger.purposes.length, 1);
  stronger.result.resolve(true);
  await until(() => stronger.owner.read(lookup)?.phase === 'completed');
  assert.equal(stronger.owner.readNativeCoordination(exact)?.ok, true);
  assert.equal(stronger.base.read(start.commandId)?.resourceHeld, false);
  assert.deepEqual(stronger.deadlines, ['run', 'close'].map(phase => ({ phase, deadline: first.expiresAt })));
  assert.equal(stronger.make().readNativeCoordination(exact)?.ok, true);
  assert.equal(stronger.make().startNativeCoordination(input, () => true).ok, true);
  assert.equal(stronger.runs(), 1);
  assert.throws(() => stronger.owner.readNativeCoordination({ ...exact, context: 'f'.repeat(64) }), { code: 'conflict' });
  stronger.changeTarget();
  assert.throws(() => stronger.owner.readNativeCoordination(exact), { code: 'conflict' });
  await stronger.owner.close();
  for (const mode of ['valid', 'text-json', 'second-first', 'wrong-nonce', 'duplicate',
    'duplicate-message', 'wrong-message', 'result-before-tool',
    'foreign-session', 'foreign-input', 'revoked', 'cancelled', 'foreign-token'] as const)
    await syntheticCoordination(mode);
});

test('cancel retains auth namespace until physical close and a late model response cannot publish success', async (t) => {
  const f = fixture({ blockClose: true });
  t.after(f.cleanup);
  f.owner.start(start);
  const cancel = f.owner.cancel(lookup);
  f.result.resolve(true);
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'busy' }
  );
  f.close.resolve(true);
  assert.equal((await cancel).phase, 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  assert.equal(f.closes(), 1);
  assert.equal(
    (
      await f.credentials.execute({
        ...lookup,
        providerId: start.providerId,
        kind: 'credential.forget',
        commandId: 'TEST-forget',
      })
    ).phase,
    'completed'
  );
});

test('cold pending probe is held and never reruns inference; unknown physical cleanup holds the account', async (t) => {
  const f = fixture({ cleanupFails: true });
  t.after(f.cleanup);
  f.owner.start(start);
  const cold = f.make();
  assert.equal(cold.start(start).phase, 'held');
  assert.equal(f.runs(), 1);
  assert.equal((await f.owner.cancel(lookup)).phase, 'held');
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'held' }
  );
  await assert.rejects(f.owner.close(), { code: 'held' });
  const original = JSON.stringify(f.base.read(start.commandId));
  const withoutProfile = new ProviderManagementCoordinator([], () => {}, f.root);
  assert.equal(withoutProfile.probes.read(lookup)?.phase, 'held',
    'original unknown probe stays discoverable after its runnable profile is removed');
  assert.throws(() => withoutProfile.assertTargetAvailable(lookup), { code: 'held' });
  assert.throws(() => withoutProfile.probes.start({ ...start, commandId: 'TEST-unavailable-fresh' }),
    { code: 'held' });
  assert.equal(f.base.read('TEST-unavailable-fresh'), undefined);
  await assert.rejects(withoutProfile.close(), { code: 'held' },
    'filtered profile does not erase the original resource fence or cleanup debt');
  assert.equal(JSON.stringify(f.base.read(start.commandId)), original);
  assert.equal(f.runs(), 1);
  const stronger = fixture({ cleanupFails: true });
  t.after(stronger.cleanup);
  const input = { ...start, context: 'e'.repeat(64) };
  stronger.owner.startNativeCoordination(input, () => true);
  const reopened = stronger.make();
  assert.equal(reopened.startNativeCoordination(input, () => true).phase, 'held');
  assert.throws(() => reopened.readNativeCoordination({ ...lookup, context: input.context }), { code: 'held' });
  assert.equal((await stronger.owner.cancel(lookup)).phase, 'held');
  assert.equal(stronger.base.read(start.commandId)?.resourceHeld, true);
  assert.equal(reopened.startNativeCoordination(input, () => true).phase, 'held');
  assert.equal(stronger.runs(), 1);
  await assert.rejects(stronger.owner.close(), { code: 'held' });
});

test('explicit cancellation settles held observations only after native custody is released', async (t) => {
  const f = fixture({ failRun: true });
  t.after(f.cleanup);
  f.owner.start(start);
  await until(() => f.owner.read(lookup)?.phase === 'held');
  assert.equal(f.base.read(start.commandId)?.resourceHeld, false);
  assert.equal((await f.owner.cancel(lookup)).phase, 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  const cold = f.make();
  assert.equal(cold.start(start).phase, 'cancelled');
  assert.equal((await cold.cancel(lookup)).phase, 'cancelled');
  assert.equal(f.runs(), 1);
  assert.equal(f.closes(), 1);
});

test('expiry and orderly shutdown cancel only their original probe', async (t) => {
  const f = fixture({ timeoutMs: 10 });
  t.after(f.cleanup);
  f.owner.start(start);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.closes(), 1);
  const second = fixture();
  t.after(second.cleanup);
  second.owner.start(start);
  await second.owner.close();
  assert.equal(second.base.read(start.commandId)?.phase, 'cancelled');
  const stronger = fixture({ timeoutMs: 20, blockClose: true });
  t.after(stronger.cleanup);
  const input = { ...start, context: 'e'.repeat(64) };
  const admitted = stronger.owner.startNativeCoordination(input, () => true);
  stronger.result.resolve(true);
  await until(() => stronger.closes() === 1);
  await until(() => Date.now() >= admitted.expiresAt);
  stronger.close.resolve(true);
  await until(() => stronger.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(stronger.owner.read(lookup)?.ok, false);
  assert.throws(() => stronger.owner.readNativeCoordination({ ...lookup, context: input.context }), { code: 'held' });
  assert.deepEqual(stronger.deadlines, ['run', 'close'].map(phase => ({ phase, deadline: admitted.expiresAt })));
  // A delayed timer callback must not let an already resolved cleanup Promise renew the deadline.
  const deadline = Date.now() + 5;
  const late = closeCoordinationByDeadline(Promise.resolve(true), deadline);
  while (Date.now() <= deadline) { /* Keep this one timer callback pending. */ }
  assert.equal(await late, false);
});

test('failed initial claim allocates nothing; writer revocation or target change cannot publish a completed model proof', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write() {
        throw new Error('TEST publication refused');
      },
    }),
  });
  t.after(f.cleanup);
  assert.throws(() => f.owner.start(start));
  assert.equal(f.runs(), 0);
  const revoked = fixture();
  t.after(revoked.cleanup);
  revoked.owner.start(start);
  revoked.revoke();
  revoked.result.resolve(true);
  await until(() => revoked.closes() === 1);
  assert.equal(revoked.base.read(start.commandId)?.phase, 'running');
  const changed = fixture();
  t.after(changed.cleanup);
  changed.owner.start(start);
  changed.changeTarget();
  changed.result.resolve(true);
  await until(() => changed.closes() === 1);
  assert.equal(changed.base.read(start.commandId)?.phase, 'running');
});

test('cancelled probe receipts cannot claim confirmed cancellation while retaining unknown process custody', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.owner.start(start);
  await f.owner.cancel(lookup);
  const saved = f.base.read(start.commandId)!;
  assert.ok(saved.kind === 'model.probe');
  assert.throws(() => f.base.write({ ...saved, resourceHeld: true }));
  assert.equal(f.owner.read(lookup)?.phase, 'cancelled');
});

test('model limit identity is durable: changed limits conflict and invalid bounds never reach native', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const limits = { contextTokens: 4096, outputTokens: 128 };
  assert.deepEqual(f.owner.start({ ...start, limits }).limits, limits);
  assert.throws(() => f.owner.start({ ...start, limits: { ...limits, outputTokens: 256 } }), {
    code: 'conflict',
  });
  assert.equal(f.runs(), 1);
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.deepEqual(f.make().start({ ...start, limits }).limits, limits);
  for (const limits of [
    { contextTokens: 0, outputTokens: 1 },
    { contextTokens: 1, outputTokens: 2 },
    { contextTokens: 100_000_001, outputTokens: 1 },
  ])
    assert.throws(() => f.owner.start({ ...start, commandId: 'TEST-invalid', limits }));
  assert.equal(f.runs(), 1);
  await f.owner.close();
});

type SyntheticCoordinationMode = 'valid' | 'text-json' | 'second-first' | 'wrong-nonce' |
  'duplicate' | 'duplicate-message' | 'wrong-message' | 'result-before-tool' |
  'foreign-session' | 'foreign-input' | 'revoked' | 'cancelled' | 'foreign-token';

/** Explicit synthetic Session events exercise the proof gate; this is not native qualification. */
async function syntheticCoordination(mode: SyntheticCoordinationMode) {
  const endpoint = new OpenCodeCoordinationEndpoint(), abort = new AbortController();
  const deadline = Date.now() + 5000;
  let current = true, submitted: Input | undefined, submissions = 0;
  const client = new Client({ name: 'TEST-inert-coordination', version: '1.0.0' });
  const content = (value: unknown): string => {
    assert.ok(Array.isArray(value) && value.length === 1);
    const block = value[0] as Record<string, unknown>;
    assert.equal(block.type, 'text'); assert.equal(typeof block.text, 'string');
    return block.text as string;
  };
  try {
    await endpoint.start(deadline, abort.signal, () => current);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + endpoint.bearerToken } },
    }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['task_briefing', 'message_send']);
    endpoint.bindSession('TEST-native-session');
    assert.equal(endpoint.catalogCurrent(), true);
    if (mode === 'foreign-token') {
      const response = await fetch(endpoint.url, { method: 'POST',
        headers: { Authorization: 'Bearer TEST-foreign', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
      assert.equal(response.status, 400); await response.text();
      assert.equal(endpoint.completed('TEST-native-session'), false);
      return;
    }
    const driver: Session = {
      sessionRef: 'TEST-SPI-session',
      async submit(input) {
        assert.equal(++submissions, 1); assert.equal(input.content, coordinationPrompt);
        submitted = input;
        return { ok: true, value: { inputId: input.inputId, operationRef: input.operationRef,
          delivery: 'client-consumed', providerAcceptance: 'unknown' } };
      },
      async *observe(): AsyncGenerator<Event> {
        assert.ok(submitted);
        const bound = { sessionRef: mode === 'foreign-session' ? 'foreign' : driver.sessionRef,
          inputId: mode === 'foreign-input' ? 'foreign' : submitted.inputId, operationRef: submitted.operationRef };
        if (mode === 'text-json') {
          yield { ...bound, kind: 'text', messageRef: 'message-text', block: 0, phase: 'complete',
            text: '{"tool":"coordination_task_briefing","then":"coordination_message_send"}' };
          yield { ...bound, kind: 'result', outcome: 'succeeded' };
          return;
        }
        // Both pinned OpenCode adapters use original message ID + ':' + native call ID.
        const firstRef = 'message-1:native-tool-1', secondMessage = mode === 'duplicate-message' ? 'message-1' : 'message-2';
        const secondRef = secondMessage + ':native-tool-2';
        if (mode === 'result-before-tool') {
          const result = await client.callTool({ name: 'task_briefing', arguments: {} });
          assert.notEqual(result.isError, true);
          yield { ...bound, kind: 'tool-result', toolRef: firstRef, isError: false, content: result.content };
          return;
        }
        yield { ...bound, kind: 'tool', messageRef: mode === 'wrong-message' ? 'foreign-message' : 'message-1',
          toolRef: firstRef,
          name: mode === 'second-first' ? 'coordination_message_send' : 'coordination_task_briefing', input: {} };
        const first = await client.callTool({ name: 'task_briefing', arguments: {} });
        assert.notEqual(first.isError, true);
        if (mode === 'revoked') current = false;
        if (mode === 'cancelled') abort.abort();
        yield { ...bound, kind: 'tool-result', toolRef: firstRef, isError: false, content: first.content };
        const challenge = JSON.parse(content(first.content)) as { nonce: string; destination: string };
        const wrongNonce = challenge.nonce === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        const input = { nonce: mode === 'wrong-nonce' ? wrongNonce : challenge.nonce,
          destination: challenge.destination };
        yield { ...bound, kind: 'tool', messageRef: secondMessage,
          toolRef: mode === 'duplicate' ? firstRef : secondRef,
          name: 'coordination_message_send', input };
        const second = await client.callTool({ name: 'message_send', arguments: input });
        yield { ...bound, kind: 'tool-result', toolRef: secondRef,
          isError: second.isError === true, content: second.content };
        yield { ...bound, kind: 'text', messageRef: 'message-3', block: 0, phase: 'complete', text: 'OK' };
        yield { ...bound, kind: 'result', outcome: 'succeeded' };
      },
      respondToInteraction() { throw new Error('TEST no permission authority in inert coordination'); },
      async interrupt() { return { ok: false, code: 'unsupported' }; },
      async checkReadiness() { return { ok: true, value: undefined }; },
      checkpoint() { return { ok: false, code: 'unsupported' }; },
      async close() { return { logicallyClosed: true, cleanup: 'confirmed' }; },
    };
    const work = runNativeCoordination(driver, 'TEST-native-session', endpoint, 'e'.repeat(64),
      abort.signal, deadline, () => current);
    if (mode === 'revoked' || mode === 'cancelled') await assert.rejects(work);
    else assert.equal(await work, mode === 'valid');
    assert.equal(submissions, 1);
    assert.equal(endpoint.completed('TEST-native-session'), mode === 'valid');
    assert.equal(endpoint.completed('TEST-foreign-session'), false);
  } finally {
    await client.close();
    assert.equal(await endpoint.close(), true, 'original synthetic endpoint and requests are closed');
  }
}
