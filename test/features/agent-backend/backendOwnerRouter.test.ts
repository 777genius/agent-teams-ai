// @vitest-environment node
import { ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import {
  BackendOwnerRouter,
  CapturedHostClient,
  createCapturedHostClient,
  FileHandleBindingStore,
} from '../../../src/features/agent-backend/main';
import { capturedHostProfileDigest } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

import type {
  BackendScope,
  CapturedBackendOwner,
  HandleBindingStore,
} from '../../../src/features/agent-backend/main';

let nodeExecutable: string;
let nodeVersion: string;
let nodeSha256: string;
let serverUrl: string;
const roots: string[] = [];
const owners: CapturedBackendOwner[] = [];
const recoveryRouters: BackendOwnerRouter[] = [];
const retainedOwners: RetainedWindowsCustody[] = [];
const scope: BackendScope = {
  projectId: 'TEST-project',
  workspaceId: 'TEST-workspace',
  teamId: 'team-1',
  runId: 'run-1',
  memberId: 'member-1',
  generation: 1,
};

beforeAll(async () => {
  nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  nodeVersion = execFileSync(nodeExecutable, ['--version'], { env: {}, encoding: 'utf8' }).trim();
  nodeSha256 = createHash('sha256')
    .update(await readFile(nodeExecutable))
    .digest('hex');
  serverUrl = execFileSync(
    nodeExecutable,
    [
      '--input-type=module',
      '-e',
      'process.stdout.write(import.meta.resolve("@agent-teams/legacy-agent-host"))',
    ],
    { cwd: process.cwd(), env: {}, encoding: 'utf8' }
  );
});

afterEach(async () => {
  const recovered = await Promise.all(recoveryRouters.splice(0).map((router) => router.shutdown()));
  await Promise.all(owners.splice(0).map((owner) => owner.client.shutdown()));
  for (const owner of retainedOwners.splice(0)) expect(await owner.close()).toBe(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const results of recovered) expect(results).toEqual([
    { status: 'fulfilled', value: { childExit: 'confirmed', providerCustody: 'unresolved' } },
  ]);
});

async function testRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-owner-routing-')));
  roots.push(root);
  return root;
}

async function makeOwner(ownerId: string, native = false): Promise<CapturedBackendOwner> {
  const root = await testRoot();
  const hostEntry = join(root, 'host.mts');
  const effectsPath = join(root, 'effects.jsonl');
  const source = `
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { appendFileSync, existsSync, readFileSync } from 'node:fs';
    const effects = ${JSON.stringify(effectsPath)};
    const server = createHostServer({ input: process.stdin, output: process.stdout, buildId: 'TEST-routing-v1',${native ? ' nativeCustody: { timeoutMs: 2000 },' : ''}
      methods: {
        'test.mutate': { lane: 'work', handle: (params) => {
          appendFileSync(effects, JSON.stringify(params) + '\\n');
          return { owner: ${JSON.stringify(ownerId)}, commandId: params.commandId, scope: params.binding.scope };
        } },
        'test.lookup': { lane: 'control', handle: (params) => {
          const records = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
          return records.find((entry) => entry.commandId === params.commandId) ?? null;
        } },
        'test.disconnect': { lane: 'control', handle: () => process.exit(0) }
      }
    });
    void server.closed.then(() => process.exit(0));
  `;
  await writeFile(hostEntry, source);
  const profile = {
    profileId: `TEST-${ownerId}`,
    nodeExecutable,
    nodeVersion,
    nodeSha256,
    hostEntry,
    hostEntrySha256: createHash('sha256').update(source).digest('hex'),
    expectedBuildId: 'TEST-routing-v1',
    cwd: root,
    env: { HOME: root, TMPDIR: root },
    startupTimeoutMs: 3000,
    requestTimeoutMs: 1000,
    writeTimeoutMs: 500,
    shutdownTimeoutMs: 300,
  };
  const nativeCustody = native ? new RetainedWindowsCustody({
    profileId: profile.profileId, profileDigest: capturedHostProfileDigest(profile),
    selectBroker() { throw new Error('TEST recovery must not allocate a provider'); },
    async verifyLaunch() { throw new Error('TEST recovery must not launch a provider'); },
  }) : undefined;
  if (nativeCustody) retainedOwners.push(nativeCustody);
  const client = nativeCustody
    ? new CapturedHostClient(profile, nativeCustody) : createCapturedHostClient(profile);
  const owner = { ownerId, revision: 'revision-1', storageRoot: root, client,
    ...(nativeCustody ? { nativeCustody } : {}) };
  owners.push(owner);
  return owner;
}

async function setup(): Promise<{
  router: BackendOwnerRouter;
  store: FileHandleBindingStore;
  directory: string;
  a: CapturedBackendOwner;
  b: CapturedBackendOwner;
}> {
  const directory = await testRoot();
  const store = new FileHandleBindingStore(directory);
  const router = new BackendOwnerRouter(store);
  const a = await makeOwner('A');
  const b = await makeOwner('B');
  router.registerOwner(a);
  router.registerOwner(b);
  router.setDefault(a);
  await Promise.all([router.startOwner(a), router.startOwner(b)]);
  return { router, store, directory, a, b };
}

async function effects(owner: CapturedBackendOwner): Promise<unknown[]> {
  try {
    return (await readFile(join(owner.storageRoot, 'effects.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Real Node Hosts and a concrete retained owner; no provider or OS-Job proof is synthesized. */
async function recoveryFixture() {
  const directory = await testRoot();
  const store = new FileHandleBindingStore(directory);
  const router = new BackendOwnerRouter(store);
  recoveryRouters.push(router);
  const original = await makeOwner('retained-A', true);
  const custody = original.nativeCustody;
  if (!custody) throw new Error('TEST original physical owner missing');
  router.registerOwner(original);
  router.setDefault(original);
  const handle = await router.createHandle('TEST-retained-handle', scope, original);
  const clients = new Map([[original.ownerId, original]]);
  let selected = original;
  const counts = { verifies: 0, created: 0, installed: 0, starts: 0 };
  let current = true;
  const source: Parameters<BackendOwnerRouter['recover']>[1] = {
    owner: { ownerId: original.ownerId, revision: original.revision }, scope,
    nativeCustody: custody,
    isCurrent: client => current && clients.get(original.ownerId) === selected &&
      selected.client === client && selected.nativeCustody === custody,
    async verify(assertCurrent) {
      counts.verifies++;
      assertCurrent();
      const bytes = await readFile(original.client.profile.hostEntry);
      assertCurrent();
      if (createHash('sha256').update(bytes).digest('hex') !== original.client.profile.hostEntrySha256)
        throw new Error('TEST original selected source changed');
    },
    create(remaining) {
      counts.created++;
      const candidate = new CapturedHostClient(original.client.profile, custody, remaining);
      owners.push({ ...original, client: candidate });
      const start = candidate.start.bind(candidate);
      vi.spyOn(candidate, 'start').mockImplementation(() => {
        expect(clients.get(original.ownerId)?.client).toBe(candidate);
        counts.starts++;
        return start();
      });
      return candidate;
    },
    install(previous, candidate) {
      expect(clients.get(original.ownerId)).toBe(selected);
      expect(selected.client).toBe(previous);
      expect(candidate.profile).toEqual(original.client.profile);
      counts.installed++;
      selected = { ...selected, client: candidate };
      clients.set(original.ownerId, selected);
    },
  };
  const currentClient = () => {
    const candidate = clients.get(original.ownerId);
    if (!candidate) throw new Error('TEST current client missing');
    return candidate.client;
  };
  const bindingBytes = () => readFile(join(directory,
    createHash('sha256').update(handle.handleId).digest('hex') + '.json'));
  return { router, original, custody, handle, store, clients, source, counts, currentClient,
    bindingBytes, setCurrent: (value: boolean) => { current = value; } };
}

async function closeOriginal(recovery: Awaited<ReturnType<typeof recoveryFixture>>) {
  const child: unknown = Object.getOwnPropertyDescriptor(recovery.original.client, 'child')?.value;
  if (!(child instanceof ChildProcess) || !child.pid) throw new Error('TEST actual original child missing');
  const closed = once(child, 'close');
  await expect(recovery.router.request(recovery.handle, {
    commandId: 'TEST-retained-loss', method: 'test.disconnect', payload: null, control: true,
  })).rejects.toMatchObject({ outcome: 'unknown' });
  await closed;
  expect(recovery.original.client.recoveryState(recovery.custody)).toBe('closed');
  return child;
}

it('captures both original same-owner bindings before a paired dispatch and refuses foreign owners', async () => {
  const { router, a, b } = await setup();
  const source = await router.createHandle('TEST-pair-source', scope, a);
  const target = await router.createHandle(
    'TEST-pair-target',
    { ...scope, teamId: 'team-target' },
    a
  );
  const foreign = await router.createHandle(
    'TEST-pair-foreign',
    { ...scope, teamId: 'team-foreign' },
    b
  );
  router.setDefault(b);
  await router.requestPair(source, target, {
    commandId: 'TEST-pair-command',
    method: 'test.mutate',
    payload: { text: 'TEST immutable' },
  });
  expect(await effects(a)).toMatchObject([
    {
      commandId: 'TEST-pair-command',
      binding: { handleId: source.handleId },
      payload: {
        request: { text: 'TEST immutable' },
        targetBinding: { handleId: target.handleId, scope: { teamId: 'team-target' } },
      },
    },
  ]);
  await expect(
    router.requestPair(source, foreign, {
      commandId: 'TEST-pair-refused',
      method: 'test.mutate',
      payload: { text: 'TEST foreign' },
    })
  ).rejects.toMatchObject({ code: 'invalid-binding' });
  await expect(
    router.requestPair(source, source, {
      commandId: 'TEST-pair-self',
      method: 'test.mutate',
      payload: {},
    })
  ).rejects.toMatchObject({ code: 'invalid-binding' });
  expect(await effects(a)).toHaveLength(1);
  expect(await effects(b)).toEqual([]);
});

it('does not dispatch a paired command after its original context guard is revoked', async () => {
  const { router, a } = await setup();
  const source = await router.createHandle('TEST-pair-source', scope, a);
  const target = await router.createHandle(
    'TEST-pair-target',
    { ...scope, teamId: 'team-target' },
    a
  );
  await expect(
    router.requestPair(source, target, {
      commandId: 'TEST-pair-revoked',
      method: 'test.mutate',
      payload: {},
      guard: { isCurrent: () => false },
    })
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(await effects(a)).toEqual([]);
});

it('refuses an explicit new owner for a retained handle with the same product scope', async () => {
  const { router, a, b } = await setup();
  await router.createHandle('TEST-registry-original', scope, a);
  await expect(router.createHandle('TEST-registry-original', scope, b)).rejects.toMatchObject({
    code: 'binding-conflict',
  });
  router.setDefault(b);
  expect(await router.createHandle('TEST-registry-original', scope)).toEqual({
    handleId: 'TEST-registry-original',
  });
  expect(
    await router.request(
      { handleId: 'TEST-registry-original' },
      { commandId: 'TEST-original-read', method: 'test.lookup', payload: null, control: true }
    )
  ).toBeNull();
  expect(await effects(a)).toEqual([]);
  expect(await effects(b)).toEqual([]);
});

it('routes fresh commands by retained A/B binding across default switch and rollback', async () => {
  const { router, a, b } = await setup();
  const handleA = await router.createHandle('opaque-A', scope);
  expect(handleA).toEqual({ handleId: 'opaque-A' });
  router.setDefault(b);
  expect(
    await router.request(handleA, {
      commandId: 'fresh-A',
      method: 'test.mutate',
      payload: 'A-input',
    })
  ).toMatchObject({ owner: 'A', commandId: 'fresh-A', scope });
  const handleB = await router.createHandle('opaque-B', {
    ...scope,
    teamId: 'team-2',
    runId: 'run-2',
  });
  expect(
    await router.request(handleB, {
      commandId: 'fresh-B',
      method: 'test.mutate',
      payload: 'B-input',
    })
  ).toMatchObject({ owner: 'B' });
  router.setDefault(a);
  expect(
    await router.request(handleB, {
      commandId: 'after-rollback-B',
      method: 'test.mutate',
      payload: null,
    })
  ).toMatchObject({ owner: 'B' });
  expect(await router.lookup(handleA, 'fresh-A', 'test.lookup')).toMatchObject({
    commandId: 'fresh-A',
    payload: 'A-input',
  });
  expect(await effects(a)).toHaveLength(1);
  expect(await effects(b)).toHaveLength(2);
  router.setDefault(b);
  await router.shutdownOwner(a);
  await expect(
    router.request(handleA, { commandId: 'unavailable-A', method: 'test.mutate', payload: null })
  ).rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });
  expect(await effects(b)).toHaveLength(2);
});

it('rehydrates durable bindings without selecting current default or changing caller command identity', async () => {
  const { router, directory, a, b } = await setup();
  await router.createHandle('retained', scope);
  const restored = new BackendOwnerRouter(new FileHandleBindingStore(directory));
  restored.registerOwner(a);
  restored.registerOwner(b);
  restored.setDefault(b);
  const handle = await restored.readHandle('retained');
  expect(await restored.createHandle('retained', scope)).toEqual(handle);
  expect(
    await restored.request(handle, {
      commandId: 'original-command',
      method: 'test.mutate',
      payload: null,
    })
  ).toMatchObject({ owner: 'A', commandId: 'original-command' });
  expect(await effects(b)).toHaveLength(0);
  await expect(
    restored.createHandle('retained', { ...scope, generation: 2 })
  ).rejects.toMatchObject({ code: 'binding-conflict' });
});

it('holds missing/corrupt binding and mismatched selected owner revision without default fallback', async () => {
  const { router, directory, a, b } = await setup();
  await router.createHandle('corrupt', scope);
  router.setDefault(b);
  const path = join(directory, `${createHash('sha256').update('corrupt').digest('hex')}.json`);
  await writeFile(path, '{corrupt');
  await expect(
    router.request(
      { handleId: 'corrupt' },
      { commandId: 'must-not-run', method: 'test.mutate', payload: null }
    )
  ).rejects.toMatchObject({ code: 'hold' });
  await expect(
    router.request(
      { handleId: 'missing' },
      { commandId: 'must-not-run', method: 'test.mutate', payload: null }
    )
  ).rejects.toMatchObject({ code: 'hold' });
  await router.createHandle('owner-B', { ...scope, teamId: 'team-B' });
  const restored = new BackendOwnerRouter(new FileHandleBindingStore(directory));
  restored.registerOwner(a);
  restored.registerOwner({ ...b, revision: 'another-revision' });
  restored.setDefault(a);
  await expect(
    restored.request(
      { handleId: 'owner-B' },
      { commandId: 'wrong-revision', method: 'test.mutate', payload: null }
    )
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(await effects(a)).toHaveLength(0);
  expect(await effects(b)).toHaveLength(0);
});

it('no-clobber publication preserves one immutable owner for a concurrently created handle', async () => {
  const { router, store, a, b } = await setup();
  const alternate = new BackendOwnerRouter(store);
  alternate.registerOwner(a);
  alternate.registerOwner(b);
  alternate.setDefault(b);
  await Promise.all([router.createHandle('raced', scope), alternate.createHandle('raced', scope)]);
  const saved = await store.read('raced');
  expect(['A', 'B']).toContain(saved?.owner.ownerId);
  const left = await router.request(
    { handleId: 'raced' },
    { commandId: 'one', method: 'test.mutate', payload: null }
  );
  const right = await alternate.request(
    { handleId: 'raced' },
    { commandId: 'two', method: 'test.mutate', payload: null }
  );
  expect(left).toMatchObject({ owner: saved?.owner.ownerId });
  expect(right).toMatchObject({ owner: saved?.owner.ownerId });
});

it('keeps response loss UNKNOWN and subsequent owner outage unavailable without routing to default', async () => {
  const { router, a, b } = await setup();
  const handle = await router.createHandle('original-owner', scope);
  router.setDefault(b);
  await expect(
    router.request(handle, {
      commandId: 'lost-response',
      method: 'test.disconnect',
      payload: null,
      control: true,
    })
  ).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(
    router.request(handle, {
      commandId: 'fresh-after-outage',
      method: 'test.mutate',
      payload: null,
    })
  ).rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });
  expect(await effects(a)).toHaveLength(0);
  expect(await effects(b)).toHaveLength(0);

  const recovery = await recoveryFixture();
  const guard = { isCurrent: () => true };
  const capture = { handle: recovery.handle, commandId: 'TEST-original-recovery',
    operation: 'host.recovery.capture' as const, payload: {} };
  const originalBytes = await recovery.bindingBytes();
  const originalBinding = await recovery.store.read(recovery.handle.handleId);
  await expect(recovery.router.recover(capture, recovery.source, guard))
    .rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
  expect(recovery.counts.created).toBe(0);
  await recovery.router.startOwner(recovery.original);
  expect(await recovery.router.recover(capture, recovery.source, guard)).toEqual({ phase: 'ready' });
  expect(recovery.counts.created).toBe(0);
  const mainEpoch = recovery.custody.mainEpoch;
  const predecessor = await closeOriginal(recovery);
  let reachedOld!: () => void, releaseOld!: () => void, releaseFinal!: () => void;
  const oldReached = new Promise<void>(resolve => { reachedOld = resolve; });
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const oldRequest = recovery.original.client.request.bind(recovery.original.client);
  const late = vi.spyOn(recovery.original.client, 'request').mockImplementation(async (...args) => {
    try { return await oldRequest(...args); }
    catch (error) {
      if (args[0] === 'test.lookup') { reachedOld(); await oldGate; }
      throw error;
    }
  });
  const oldRead = Promise.allSettled([
    recovery.router.lookup(recovery.handle, 'TEST-old-read', 'test.lookup'),
  ]);
  let replacement: Promise<unknown> | undefined, restoreRead: (() => void) | undefined;
  try {
    await Promise.race([oldReached, oldRead.then(() => {
      throw new Error('TEST original read did not reach the closed client');
    })]);
    expect(recovery.counts.created).toBe(0);
    const captured = await recovery.router.recover(capture, recovery.source, guard);
    if (captured.phase !== 'captured') throw new Error('TEST original recovery capability missing');
    const capability = captured.capability;
    expect(await recovery.router.recover(capture, recovery.source, guard)).toEqual(captured);
    const continuation = { ...capture, operation: 'host.recovery.start' as const, payload: { capability } };
    const foreignCapability = capability.slice(0, -1) + (capability.endsWith('0') ? '1' : '0');
    await expect(recovery.router.recover({
      ...continuation, payload: { capability: foreignCapability },
    }, recovery.source, guard)).rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
    await expect(recovery.router.recover({
      ...continuation, handle: { handleId: 'TEST-foreign-handle' },
    }, recovery.source, guard)).rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
    let reachedFinal!: () => void, observedFinal = false;
    const finalReached = new Promise<void>(resolve => { reachedFinal = resolve; });
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    const read = recovery.store.read.bind(recovery.store);
    const observation = vi.spyOn(recovery.store, 'read').mockImplementation(async id => {
      const binding = await read(id), current = recovery.currentClient();
      if (!observedFinal && current !== recovery.original.client &&
        current.recoveryState(recovery.custody) === 'ready') {
        observedFinal = true; reachedFinal(); await finalGate;
      }
      return binding;
    });
    restoreRead = () => observation.mockRestore();
    const results = Promise.allSettled([
      recovery.router.recover(continuation, recovery.source, guard),
      recovery.router.recover(continuation, recovery.source, guard),
    ]);
    replacement = results;
    await Promise.race([finalReached, results.then(() => {
      throw new Error('TEST final original binding check was not retained');
    })]);
    const candidate = recovery.currentClient();
    expect(candidate.recoveryState(recovery.custody)).toBe('ready');
    await expect(recovery.router.request(recovery.handle, {
      commandId: 'TEST-before-recovery-accepted', method: 'test.mutate', payload: null,
    })).rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });
    expect(() => recovery.router.startOwner(recovery.original)).toThrow();
    expect(await effects(recovery.original)).toHaveLength(0);
    releaseFinal();
    expect(await results).toEqual([
      { status: 'fulfilled', value: { phase: 'ready' } },
      { status: 'fulfilled', value: { phase: 'ready' } },
    ]);
    releaseOld();
    expect(await oldRead).toMatchObject([
      { status: 'rejected', reason: { code: 'unavailable', outcome: 'not-dispatched' } },
    ]);
    expect(candidate).not.toBe(recovery.original.client);
    const child: unknown = Object.getOwnPropertyDescriptor(candidate, 'child')?.value;
    if (!(child instanceof ChildProcess)) throw new Error('TEST replacement child missing');
    expect(child).not.toBe(predecessor);
    expect(child.pid).toBeGreaterThan(0);
    expect(recovery.clients.get(recovery.original.ownerId))
      .toEqual({ ...recovery.original, client: candidate });
    expect(recovery.custody.mainEpoch).toBe(mainEpoch);
    expect(await recovery.router.recover(continuation, recovery.source, guard)).toEqual({ phase: 'ready' });
    expect(recovery.counts).toMatchObject({ created: 1, installed: 1, starts: 1 });
    expect(await recovery.router.readHandle(recovery.handle.handleId)).toEqual(recovery.handle);
    expect(await recovery.router.startOwner(recovery.original))
      .toMatchObject({ buildId: candidate.profile.expectedBuildId });
    expect(Object.getOwnPropertyDescriptor(candidate, 'child')?.value).toBe(child);
    expect(await recovery.bindingBytes()).toEqual(originalBytes);
    expect(await recovery.store.read(recovery.handle.handleId)).toEqual(originalBinding);
    expect(await recovery.router.request(recovery.handle, {
      commandId: 'TEST-after-explicit-recovery', method: 'test.mutate', payload: null,
    })).toEqual({ owner: recovery.original.ownerId, commandId: 'TEST-after-explicit-recovery', scope });
    expect(await effects(recovery.original)).toHaveLength(1);
  } finally {
    releaseOld(); releaseFinal?.();
    await oldRead; await replacement;
    late.mockRestore(); restoreRead?.();
  }

});

it('shutdown seals requests waiting on storage before any awaited cleanup can allow dispatch', async () => {
  const { router, store, a, b } = await setup();
  const handle = await router.createHandle('pending-read', scope);
  let release!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed: HandleBindingStore = {
    create: (binding) => store.create(binding),
    read: async (id) => {
      observed();
      await gate;
      return store.read(id);
    },
  };
  const pendingRouter = new BackendOwnerRouter(delayed);
  pendingRouter.registerOwner(a);
  pendingRouter.registerOwner(b);
  pendingRouter.setDefault(a);
  const pending = pendingRouter.request(handle, {
    commandId: 'late-read',
    method: 'test.mutate',
    payload: null,
  });
  await started;
  const closing = pendingRouter.shutdown();
  release();
  await expect(pending).rejects.toMatchObject({ code: 'shutting-down' });
  expect((await closing).every((result) => result.status === 'fulfilled')).toBe(true);
  expect(await effects(a)).toHaveLength(0);
  expect(await effects(b)).toHaveLength(0);

  const reading = await recoveryFixture();
  await reading.router.startOwner(reading.original);
  await closeOriginal(reading);
  let readEntered!: () => void, releaseRead!: () => void;
  const readingSource = new Promise<void>(resolve => { readEntered = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const verify = reading.source.verify;
  reading.source.verify = async current => {
    await verify(current); readEntered(); await readGate; current();
  };
  const capture = reading.router.recover({
    handle: reading.handle, commandId: 'TEST-shutdown-during-source',
    operation: 'host.recovery.capture', payload: {},
  }, reading.source, { isCurrent: () => true });
  const captured = Promise.allSettled([capture]);
  try {
    await Promise.race([readingSource, captured.then(() => {
      throw new Error('TEST captured source read was not retained');
    })]);
    let finished = false;
    const closing = reading.router.shutdown().then(result => { finished = true; return result; });
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseRead();
    expect(await captured).toMatchObject([
      { status: 'rejected', reason: { code: 'shutting-down', outcome: 'not-dispatched' } },
    ]);
    expect((await closing).every(result => result.status === 'fulfilled')).toBe(true);
    expect(reading.counts.created).toBe(0);
  } finally { releaseRead(); await captured; }

  const starting = await recoveryFixture();
  await starting.router.startOwner(starting.original);
  await closeOriginal(starting);
  const request = { handle: starting.handle, commandId: 'TEST-shutdown-during-start',
    operation: 'host.recovery.capture' as const, payload: {} };
  const ready = await starting.router.recover(request, starting.source, { isCurrent: () => true });
  if (ready.phase !== 'captured') throw new Error('TEST original start capability missing');
  let reached!: () => void, releaseStart!: () => void;
  const bound = new Promise<void>(resolve => { reached = resolve; });
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  const create = starting.source.create;
  starting.source.create = remaining => {
    const candidate = create(remaining), start = candidate.start.bind(candidate);
    candidate.start = async () => {
      const handshake = await start();
      reached(); await startGate; return handshake;
    };
    return candidate;
  };
  const replacement = starting.router.recover({
    ...request, operation: 'host.recovery.start', payload: { capability: ready.capability },
  }, starting.source, { isCurrent: () => true });
  const replaced = Promise.allSettled([replacement]);
  try {
    await Promise.race([bound, replaced.then(() => {
      throw new Error('TEST actual candidate did not reach its original native bind');
    })]);
    const candidate = starting.currentClient();
    const child: unknown = Object.getOwnPropertyDescriptor(candidate, 'child')?.value;
    if (!(child instanceof ChildProcess) || !child.pid) throw new Error('TEST admitted candidate missing');
    expect(candidate.recoveryState(starting.custody)).toBe('ready');
    const physicallyClosed = once(child, 'close');
    let finished = false;
    const closing = starting.router.shutdown().then(result => { finished = true; return result; });
    await physicallyClosed;
    expect(finished).toBe(false);
    expect(candidate.recoveryState(starting.custody)).toBe('closed');
    releaseStart();
    expect(await replaced).toMatchObject([
      { status: 'rejected', reason: { code: 'hold', outcome: 'unknown' } },
    ]);
    expect(await closing).toMatchObject([
      { status: 'fulfilled', value: { childExit: 'confirmed', providerCustody: 'unresolved' } },
    ]);
    expect(starting.counts).toMatchObject({ created: 1, installed: 1, starts: 1 });
    expect(await starting.custody.close()).toBe(true);
    expect(await effects(starting.original)).toHaveLength(0);
  } finally { releaseStart(); await replaced; }

});

it('rechecks captured context after a delayed binding read immediately before any wire effect', async () => {
  const { router, store, a, b } = await setup();
  const handle = await router.createHandle('guarded-read', scope);
  let release!: () => void;
  let signal!: () => void;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const guarded = new BackendOwnerRouter({
    create: (binding) => store.create(binding),
    read: async (id) => {
      signal();
      await gate;
      return store.read(id);
    },
  });
  guarded.registerOwner(a);
  guarded.registerOwner(b);
  guarded.setDefault(b);
  let current = true;
  const pending = guarded.request(handle, {
    commandId: 'must-not-send',
    method: 'test.mutate',
    payload: null,
    guard: { isCurrent: () => current },
  });
  await started;
  current = false;
  release();
  await expect(pending).rejects.toMatchObject({ code: 'forbidden', outcome: 'not-dispatched' });
  expect(await effects(a)).toHaveLength(0);
  expect(await effects(b)).toHaveLength(0);

  const recovery = await recoveryFixture();
  await recovery.router.startOwner(recovery.original);
  await closeOriginal(recovery);
  const request = { handle: recovery.handle, commandId: 'TEST-original-captured-guard',
    operation: 'host.recovery.capture' as const, payload: {} };
  let admitted = true;
  const originalGuard = { isCurrent: () => admitted };
  recovery.setCurrent(false);
  await expect(recovery.router.recover(request, recovery.source, originalGuard))
    .rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
  recovery.setCurrent(true);
  const captured = await recovery.router.recover(request, recovery.source, originalGuard);
  if (captured.phase !== 'captured') throw new Error('TEST captured guard capability missing');
  const continuation = { ...request, operation: 'host.recovery.start' as const,
    payload: { capability: captured.capability } };
  let entered!: () => void, releaseSource!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
  const verify = recovery.source.verify;
  recovery.source.verify = async assertCurrent => {
    await verify(assertCurrent); entered(); await sourceGate; assertCurrent();
  };
  const starting = recovery.router.recover(continuation, recovery.source, originalGuard);
  const result = Promise.allSettled([starting]);
  try {
    await Promise.race([checking, result.then(() => {
      throw new Error('TEST original guard check was not retained');
    })]);
    admitted = false;
    releaseSource();
    expect(await result).toMatchObject([
      { status: 'rejected', reason: { code: 'forbidden', outcome: 'not-dispatched' } },
    ]);
    await expect(recovery.router.recover(continuation, recovery.source, { isCurrent: () => true }))
      .rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
    expect(recovery.counts.created).toBe(0);
    expect(recovery.currentClient()).toBe(recovery.original.client);
  } finally { releaseSource(); await result; }

  const changed = await recoveryFixture();
  await changed.router.startOwner(changed.original);
  await closeOriginal(changed);
  const changedRequest = { handle: changed.handle, commandId: 'TEST-original-selected-source',
    operation: 'host.recovery.capture' as const, payload: {} };
  const selected = await changed.router.recover(changedRequest, changed.source, { isCurrent: () => true });
  if (selected.phase !== 'captured') throw new Error('TEST selected source capability missing');
  const before = await changed.bindingBytes();
  await writeFile(changed.original.client.profile.hostEntry, '// TEST changed original source\n');
  await expect(changed.router.recover({
    ...changedRequest, operation: 'host.recovery.start', payload: { capability: selected.capability },
  }, changed.source, { isCurrent: () => true })).rejects.toThrow('TEST original selected source changed');
  expect(changed.counts.created).toBe(0);
  expect(await changed.bindingBytes()).toEqual(before);

  const expired = await recoveryFixture();
  await expired.router.startOwner(expired.original);
  await closeOriginal(expired);
  const timed = { handle: expired.handle, commandId: 'TEST-original-recovery-cutoff',
    operation: 'host.recovery.capture' as const, payload: {} };
  const original = await expired.router.recover(timed, expired.source, { isCurrent: () => true });
  if (original.phase !== 'captured') throw new Error('TEST original cutoff capability missing');
  const verified = expired.counts.verifies;
  const afterOriginalCutoff = performance.now() + expired.original.client.profile.startupTimeoutMs + 1;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(afterOriginalCutoff);
  try {
    await expect(expired.router.recover(timed, expired.source, { isCurrent: () => true }))
      .rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
    await expect(expired.router.recover({
      ...timed, operation: 'host.recovery.start', payload: { capability: original.capability },
    }, expired.source, { isCurrent: () => true }))
      .rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
    expect(expired.counts.verifies).toBe(verified);
    expect(expired.counts.created).toBe(0);
  } finally { clock.mockRestore(); }

});
