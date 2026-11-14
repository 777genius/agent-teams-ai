import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner, nativeCoordinationPurpose, nativeLocalReadinessPurpose } from '../dist/management/ModelProbeOwner.js';
import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { createOpenCodeLocalModelReadiness } from '../dist/adapters/providers/OpenCodeLocalModelReadiness.js';
import { closeCoordinationByDeadline, OpenCodeCoordinationEndpoint, coordinationPrompt } from '../dist/adapters/providers/OpenCodeCoordinationEndpoint.js';
import { runNativeCoordination } from '../dist/adapters/providers/OpenCodeCoordinationProbe.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import type { ManagementCommandStore, NativeLocalReadinessEvidence } from '../src/management/commandRecords.ts';
import type { OpenCodeManagementProfile } from '../src/management/profile.ts';
import type { ModelProbePreparation } from '../src/management/ModelProbeOwner.ts';

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
    readiness?: NativeLocalReadinessEvidence;
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
  const prepare: ModelProbePreparation = (_input, _current, purpose) => {
    purposes.push(purpose);
    return {
      timeoutMs: options.timeoutMs ?? 10000,
      ...(options.readiness ? { readiness: () => structuredClone(options.readiness!) } : {}),
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
  };
  const make = () =>
    new ModelProbeOwner({
      store,
      fence,
      assertWriter: writer,
      select: () => ({ ...target }),
      prepare,
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
    prepare,
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
  const journalBytes = () => readdirSync(join(f.root, 'management-commands')).sort()
    .map((name) => ({ name, bytes: readFileSync(join(f.root, 'management-commands', name)) }));
  let preparations = 0;
  const original: ModelProbePreparation = (input, current) => {
    preparations++;
    assert.deepEqual(input, start);
    assert.equal(f.base.read(start.commandId), undefined);
    return f.prepare(input, current);
  };
  const replacement: ModelProbePreparation = () => {
    assert.fail('Replay or refused admission must not prepare another native operation');
  };
  assert.equal(f.owner.start(start, () => true, original).phase, 'running');
  assert.equal(preparations, 1);
  assert.equal(f.runs(), 1);
  const pendingBytes = journalBytes();
  assert.equal(f.owner.start(start, () => true, replacement).phase, 'running');
  assert.equal(f.make().start(start, () => true, replacement).phase, 'held');
  assert.deepEqual(journalBytes(), pendingBytes, 'live and cold replay retain exact original bytes');
  assert.equal(f.runs(), 1);
  assert.throws(() => f.owner.start({ ...start, modelId: 'TEST-other' }, () => true, replacement),
    { code: 'conflict' });
  assert.throws(() => f.owner.start({ ...start, commandId: 'TEST-competing-probe' }, () => true, replacement),
    { code: 'busy' });
  assert.equal(f.base.read('TEST-competing-probe'), undefined);
  assert.deepEqual(journalBytes(), pendingBytes, 'resource refusal precedes preparation and publication');
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
  const completedBytes = journalBytes();
  assert.equal(f.make().start(start, () => true, replacement).ok, true);
  assert.deepEqual(journalBytes(), completedBytes, 'cold completion replay is read-only');
  assert.equal(preparations, 1);
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
  assert.throws(() => historical.owner.readNativeReadiness({ ...lookup, context: historicalInput.context }), { code: 'conflict' });
  assert.throws(() => historical.owner.startNativeReadiness(historicalInput, () => true), { code: 'conflict' });
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
  assert.throws(() => stronger.owner.readNativeReadiness(exact), { code: 'conflict' });
  await stronger.owner.close();
  const compound = fixture({ readiness: syntheticReadinessEvidence() }); t.after(compound.cleanup);
  assert.throws(() => compound.owner.start({ ...input, purpose: nativeLocalReadinessPurpose }));
  assert.throws(() => compound.owner.start({ ...input, readiness: syntheticReadinessEvidence() }));
  assert.throws(() => compound.owner.startNativeReadiness(start, () => true));
  assert.equal(compound.runs(), 0);
  const admitted = compound.owner.startNativeReadiness(input, () => true);
  compound.owner.startNativeReadiness(input, () => true);
  assert.equal(compound.runs(), 1);
  assert.deepEqual(compound.purposes, [nativeLocalReadinessPurpose]);
  assert.throws(() => compound.owner.readNativeReadiness(exact), { code: 'held' });
  compound.result.resolve(true);
  await until(() => compound.owner.read(lookup)?.phase === 'completed');
  const receipt = compound.owner.readNativeReadiness(exact);
  assert.equal(receipt?.readiness.evidence.decision, 'allow');
  assert.equal(receipt?.readiness.context, context);
  assert.equal(receipt?.readiness.selectionDigest, 'a'.repeat(64));
  assert.equal(compound.base.read(start.commandId)?.resourceHeld, false);
  assert.deepEqual(compound.deadlines, ['run', 'close'].map(phase => ({ phase, deadline: admitted.expiresAt })));
  assert.deepEqual(compound.make().readNativeReadiness(exact), receipt);
  assert.equal(compound.make().startNativeReadiness(input, () => true).ok, true);
  assert.equal(compound.runs(), 1);
  assert.throws(() => compound.owner.readNativeCoordination(exact), { code: 'conflict' });
  assert.throws(() => compound.owner.readNativeReadiness({ ...exact, context: 'f'.repeat(64) }), { code: 'conflict' });
  compound.changeTarget();
  assert.throws(() => compound.owner.readNativeReadiness(exact), { code: 'conflict' });
  await compound.owner.close();
  const missing = fixture(); t.after(missing.cleanup);
  missing.owner.startNativeReadiness(input, () => true); missing.result.resolve(true);
  await until(() => missing.owner.read(lookup)?.phase === 'held');
  assert.throws(() => missing.owner.readNativeReadiness(exact), { code: 'held' });
  assert.equal(missing.base.read(start.commandId)?.resourceHeld, false);
  await missing.owner.close();
  for (const mode of ['valid', 'text-json', 'second-first', 'wrong-nonce', 'duplicate',
    'duplicate-message', 'wrong-message', 'result-before-tool',
    'foreign-session', 'foreign-input', 'revoked', 'cancelled', 'foreign-token'] as const)
    await syntheticCoordination(mode);
  for (const mode of ['compatible', 'configured-key', 'stored-key', 'effective-key', 'remote',
    'native-authless', 'native-key', 'native-options-key', 'native-route-drift',
    'native-builtin-alias', 'native-remote-alias', 'native-model-drift',
    'tools-false', 'context-small', 'ollama-loaded', 'model-missing', 'inventory-unavailable',
    'native-rejected', 'native-unavailable', 'native-missing', 'ordinary-failed',
    'key-drift', 'source-drift', 'unclean', 'private-unapproved'] as const)
    await syntheticLocalReadiness(mode);
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
  const compound = fixture({ cleanupFails: true, readiness: syntheticReadinessEvidence() });
  t.after(compound.cleanup);
  compound.owner.startNativeReadiness(input, () => true);
  const coldCompound = compound.make();
  assert.equal(coldCompound.startNativeReadiness(input, () => true).phase, 'held');
  assert.throws(() => coldCompound.readNativeReadiness({ ...lookup, context: input.context }), { code: 'held' });
  assert.equal((await compound.owner.cancelContextual(input.commandId, input.context)).phase, 'held');
  compound.result.resolve(true);
  assert.equal(compound.base.read(input.commandId)?.resourceHeld, true);
  assert.equal(coldCompound.startNativeReadiness(input, () => true).phase, 'held');
  assert.equal(compound.runs(), 1);
  await assert.rejects(compound.owner.close(), { code: 'held' });
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
    // Keep the SDK object: its sessionId getter allows undefined beyond the exact optional interface.
    const transport: Omit<StreamableHTTPClientTransport, 'sessionId'> = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + endpoint.bearerToken } },
    });
    await client.connect(transport);
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

function syntheticReadinessEvidence(): NativeLocalReadinessEvidence {
  return { schemaVersion: 1, ordinary: 'confirmed', coordination: 'compatible', decision: 'allow', reasons: [],
    routeDigest: 'c'.repeat(64), configurationDigest: 'd'.repeat(64), accountDigest: 'e'.repeat(64),
    metadata: { provider: 'custom', tools: null, modelListed: true, contextTokens: null,
      parameterCount: null, configuredContextTokens: null, trainedContextTokens: null, contextSource: 'unknown' } };
}

class ReadinessChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] =
    [this.stdin, this.stdout, this.stderr, undefined, undefined];
}

type LocalReadinessMode = 'compatible' | 'configured-key' | 'stored-key' | 'effective-key' | 'remote' |
  'native-authless' | 'native-key' | 'native-options-key' | 'native-route-drift' |
  'native-builtin-alias' | 'native-remote-alias' | 'native-model-drift' |
  'tools-false' | 'context-small' | 'ollama-loaded' | 'model-missing' | 'inventory-unavailable' |
  'native-rejected' | 'native-unavailable' | 'native-missing' | 'ordinary-failed' |
  'key-drift' | 'source-drift' | 'unclean' | 'private-unapproved';

/** Real captured config/auth files and the production policy; native phases are explicitly synthetic. */
async function syntheticLocalReadiness(mode: LocalReadinessMode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-local-readiness-')));
  const directory = (name: string) => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const cwd = directory('project'), home = directory('home'), configHome = directory('config'), data = directory('data');
  const authDirectory = join(data, 'opencode'); mkdirSync(authDirectory, { mode: 0o700 });
  const authPath = join(authDirectory, 'auth.json'), configPath = join(cwd, 'opencode.json');
  const providerId = mode === 'tools-false' || mode === 'context-small' ? 'lmstudio'
    : mode === 'ollama-loaded' ? 'ollama' : mode === 'native-builtin-alias' ? 'TEST-builtin' : 'local';
  const url = ['remote', 'native-builtin-alias', 'native-remote-alias'].includes(mode)
    ? 'https://example.invalid/v1' : mode === 'private-unapproved'
    ? 'http://192.168.1.10:8181/v1' : 'http://127.0.0.1:8181/v1';
  const provider = { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: url, ...(mode === 'configured-key' ? { apiKey: 'TEST-config-key' } : {}) },
    models: { 'TEST-model': { name: 'TEST-model' } } };
  const configuredProviders = mode === 'native-builtin-alias' ? {} : { [providerId]: provider };
  writeFileSync(configPath, JSON.stringify({ provider: configuredProviders }), { mode: 0o600 });
  writeFileSync(authPath, JSON.stringify(mode === 'stored-key'
    ? { [providerId]: { type: 'api', key: 'TEST-stored-key' } } : {}), { mode: 0o600 });
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode', profileId: start.profileId, configRevision: start.configRevision,
    accountBinding: 'TEST-original-account', cwd, endpoint: 'http://127.0.0.1:8182',
    timeoutMs: 5000, modelProbeTimeoutMs: 5000,
    executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    environment: { HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: data, XDG_CACHE_HOME: directory('cache') },
  };
  const input = { ...start, providerId, modelId: providerId + '/TEST-model', context: 'b'.repeat(64) };
  let ordinaryRuns = 0, ordinaryCloses = 0, coordinationRuns = 0, coordinationCloses = 0;
  const requests: string[] = [], sequence: string[] = [], nativeRequests: string[] = [];
  const deadline = Date.now() + 5000;
  const adapters: Parameters<typeof createOpenCodeLocalModelReadiness>[3] = {
    ordinary(observe, current) {
      assert.notEqual(mode, 'private-unapproved', 'original private approval refuses before native preparation');
      if (['native-authless', 'native-key', 'native-options-key', 'native-route-drift',
        'native-builtin-alias', 'native-remote-alias', 'native-model-drift'].includes(mode)) {
        let running = false, sealed = false, nativeConfig: unknown;
        const host = new OpenCodeManagementHost(profile, { canAllocate: current, isCurrent: current }, {
          createProcess(captured, canAllocate) {
            nativeConfig = { ...JSON.parse(captured.environment.OPENCODE_CONFIG_CONTENT!), provider: configuredProviders };
            return { launch() {
              assert.equal(canAllocate() && !sealed, true); assert.equal(running, false);
              running = true; return new ReadinessChild();
            }, seal() { sealed = true; }, isRunning: () => running, async confirmStopped() { running = false; return true; } };
          },
          async fetchImpl(value, init) {
            const request = new Request(value, init), target = new URL(request.url);
            assert.equal(target.origin, profile.endpoint); assert.equal(request.redirect, 'error');
            assert.equal(request.headers.get('x-opencode-directory'), cwd);
            nativeRequests.push(request.method + ' ' + target.pathname);
            if (target.pathname === '/config') return Response.json(nativeConfig);
            if (target.pathname === '/provider') return Response.json({ all: [{
              id: providerId, ...(['native-key', 'native-builtin-alias'].includes(mode) ? { key: 'TEST-native-key' } : {}),
              options: { ...provider.options,
                ...(mode === 'native-options-key' ? { apiKey: 'TEST-native-key' } : {}),
                ...(mode === 'native-route-drift' ? { baseURL: 'http://127.0.0.1:8183/v1' } : {}) },
              models: { 'TEST-model': { api: { id: mode.endsWith('-alias') || mode === 'native-model-drift' ? 'TEST-base-model' : 'TEST-model',
                npm: mode === 'native-builtin-alias' ? '@ai-sdk/anthropic' : provider.npm, url } } },
            }] });
            if (target.pathname === '/experimental/tool/ids') return Response.json(['bash']);
            assert.equal(request.method, 'POST');
            if (target.pathname === '/session') return Response.json({ id: 'ses_TESTreadiness' });
            assert.equal(target.pathname, '/session/ses_TESTreadiness/message');
            const body = await request.json();
            assert.deepEqual(body.model, { providerID: providerId, modelID: 'TEST-model' });
            assert.deepEqual(body.tools, { '*': false, bash: false });
            return Response.json({ info: { sessionID: 'ses_TESTreadiness', role: 'assistant',
              providerID: providerId, modelID: 'TEST-model', time: { completed: 1 } },
              parts: [{ type: 'text', text: 'OK' }] });
          },
        });
        return { timeoutMs: 5000, run(signal, originalDeadline) {
          assert.equal(originalDeadline, deadline); assert.equal(++ordinaryRuns, 1); sequence.push('ordinary');
          return host.probeModel(input, signal, 5000, current, { deadline, observeProvider: observe });
        }, async close(originalDeadline) {
          assert.equal(originalDeadline, deadline); ordinaryCloses++; sequence.push('ordinary-close'); return host.close();
        } };
      }
      return { timeoutMs: 5000, async run(_signal, originalDeadline) {
        assert.equal(originalDeadline, deadline); assert.equal(++ordinaryRuns, 1); assert.equal(current(), true);
        sequence.push('ordinary');
        observe({ ...provider, options: { ...provider.options,
          ...(mode === 'effective-key' ? { apiKey: 'TEST-effective-key' } :
            mode === 'stored-key' ? { apiKey: 'TEST-stored-key' } : {}) } });
        if (mode === 'key-drift') writeFileSync(authPath,
          JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-new-key' } }), { mode: 0o600 });
        if (mode === 'source-drift') writeFileSync(configPath, JSON.stringify({ provider: {} }), { mode: 0o600 });
        return mode !== 'ordinary-failed';
      }, async close(originalDeadline) {
        assert.equal(originalDeadline, deadline); ordinaryCloses++; sequence.push('ordinary-close');
        return mode !== 'unclean';
      } };
    },
    coordination(selected, key, current) {
      assert.equal(ordinaryRuns, 1); assert.ok(ordinaryCloses >= 1);
      assert.equal(current(), true); assert.equal(key, undefined);
      assert.deepEqual(selected, provider); assert.ok(requests.length > 0);
      return { timeoutMs: 5000, async run(_signal, originalDeadline) {
        assert.equal(originalDeadline, deadline); assert.equal(++coordinationRuns, 1);
        sequence.push('coordination'); return mode !== 'native-rejected' && mode !== 'native-unavailable';
      }, coordinationObservation: () => mode === 'native-missing' ? undefined
        : mode === 'native-rejected' ? { status: 'incompatible', reason: 'request-rejected' }
          : mode === 'native-unavailable' ? { status: 'unavailable', reason: 'native-rejected' }
            : { status: 'compatible', reason: 'complete' },
      async close(originalDeadline) {
        assert.equal(originalDeadline, deadline); coordinationCloses++; sequence.push('coordination-close'); return true;
      } };
    },
    async fetchImpl(target, init) {
      assert.equal(ordinaryRuns, 1); assert.ok(ordinaryCloses >= 1);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      assert.equal(init?.redirect, 'error');
      const path = new URL(String(target)).pathname; requests.push(path); sequence.push(path);
      if (path === '/v1/models') {
        assert.equal(init?.method, 'GET');
        return Response.json({ data: [{ id: mode === 'model-missing' ? 'TEST-other' : 'TEST-model' }] },
          { status: mode === 'inventory-unavailable' ? 503 : 200 });
      }
      if (path === '/api/v1/models') return Response.json({ models: [{ key: 'TEST-model',
        loaded_instances: [{ id: 'TEST-model', config: { context_length: mode === 'context-small' ? 16383 : 65536 } }],
        capabilities: { trained_for_tool_use: mode !== 'tools-false' } }] });
      if (path === '/api/show') {
        assert.equal(init?.method, 'POST'); assert.deepEqual(JSON.parse(String(init?.body)), { model: 'TEST-model' });
        return Response.json({ capabilities: ['tools'], parameters: 'num_ctx 64000',
          model_info: { 'TEST.context_length': 128000, 'TEST.parameter_count': 7_000_000_000 } });
      }
      assert.equal(path, '/api/ps'); assert.equal(coordinationRuns, 1); assert.equal(coordinationCloses, 1);
      return Response.json({ models: [{ name: 'TEST-model:latest', context_length: 8192 }] });
    },
  };
  let probe: ReturnType<typeof createOpenCodeLocalModelReadiness> | undefined;
  try {
    if (mode === 'private-unapproved') {
      assert.throws(() => createOpenCodeLocalModelReadiness(profile, input, () => true, adapters), { code: 'held' });
      assert.equal(ordinaryRuns, 0); return;
    }
    probe = createOpenCodeLocalModelReadiness(profile, input, () => true, adapters);
    assert.equal(ordinaryRuns, 0); assert.equal(requests.length, 0);
    const run = probe.run(new AbortController().signal, deadline);
    assert.equal(probe.run(new AbortController().signal, deadline), run, 'one admitted purpose cannot repeat either phase');
    if (mode === 'native-route-drift' || mode === 'native-model-drift') {
      await assert.rejects(run, { code: 'unavailable' }); assert.equal(probe.readiness?.(), undefined);
      assert.deepEqual(nativeRequests, ['GET /config', 'GET /config', 'GET /config', 'GET /provider']);
      assert.equal(requests.length, 0); assert.equal(coordinationRuns, 0); return;
    }
    if (['key-drift', 'source-drift', 'unclean', 'native-missing'].includes(mode)) {
      await assert.rejects(run, { code: 'held' }); assert.equal(probe.readiness?.(), undefined);
      assert.equal(requests.length, mode === 'native-missing' ? 1 : 0); return;
    }
    const blocked = ['tools-false', 'context-small', 'ollama-loaded', 'model-missing',
      'inventory-unavailable', 'native-rejected', 'ordinary-failed'].includes(mode);
    assert.equal(await run, !blocked);
    const evidence = probe.readiness?.(); assert.ok(evidence);
    assert.equal(evidence.decision, blocked ? 'block' : 'allow');
    assert.equal(ordinaryRuns, 1); assert.equal(ordinaryCloses, 1);
    if (mode.startsWith('native-') && nativeRequests.length) assert.deepEqual(nativeRequests,
      ['GET /config', 'GET /config', 'GET /config', 'GET /provider', 'GET /experimental/tool/ids',
        'POST /session', 'POST /session/ses_TESTreadiness/message'], 'same original native reads and one ordinary input');
    const nonApplicable = ['configured-key', 'stored-key', 'effective-key', 'native-key', 'native-options-key',
      'remote', 'native-builtin-alias', 'native-remote-alias'].includes(mode);
    if (nonApplicable) {
      assert.equal(evidence.coordination, 'not-applicable');
      assert.deepEqual(evidence.reasons, ['not-applicable']);
      assert.equal(requests.length, 0); assert.equal(coordinationRuns, 0);
    } else if (mode === 'native-unavailable') {
      assert.equal(evidence.coordination, 'unavailable'); assert.ok(evidence.reasons.includes('coordination-unavailable'));
      assert.equal(evidence.metadata.contextTokens, null); assert.equal(coordinationRuns, 1);
    } else if (mode === 'native-rejected') {
      assert.equal(evidence.coordination, 'incompatible'); assert.ok(evidence.reasons.includes('request-rejected'));
    } else if (mode === 'ollama-loaded') {
      assert.equal(evidence.metadata.contextTokens, 8192); assert.equal(evidence.metadata.contextSource, 'ollama-loaded');
      assert.equal(evidence.metadata.configuredContextTokens, 64000); assert.equal(evidence.metadata.trainedContextTokens, 128000);
      assert.ok(evidence.reasons.includes('context-too-small'));
      assert.deepEqual(requests, ['/v1/models', '/api/show', '/api/ps']);
    } else if (mode === 'compatible' || mode === 'native-authless') {
      assert.equal(evidence.coordination, 'compatible'); assert.equal(coordinationRuns, 1);
      assert.ok(sequence.indexOf('ordinary-close') < sequence.indexOf('/v1/models'));
    } else assert.equal(coordinationRuns, 0, 'known refusal occurs before coordination allocation');
    assert.equal(JSON.stringify(evidence).includes('TEST-stored-key'), false);
    assert.equal(JSON.stringify(evidence).includes('TEST-effective-key'), false);
    assert.equal(JSON.stringify(evidence).includes('TEST-native-key'), false);
  } finally {
    if (probe) assert.equal(await probe.close(deadline), mode !== 'unclean');
    rmSync(root, { recursive: true, force: true });
  }
}
