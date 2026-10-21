// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, expect, it } from 'vitest';

import {
  BackendOwnerRouter,
  createCapturedHostClient,
  FileHandleBindingStore,
} from '../../../src/features/agent-backend/main';

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
  await Promise.all(owners.splice(0).map((owner) => owner.client.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function testRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-owner-routing-')));
  roots.push(root);
  return root;
}

async function makeOwner(ownerId: string): Promise<CapturedBackendOwner> {
  const root = await testRoot();
  const hostEntry = join(root, 'host.mts');
  const effectsPath = join(root, 'effects.jsonl');
  const source = `
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { appendFileSync, existsSync, readFileSync } from 'node:fs';
    const effects = ${JSON.stringify(effectsPath)};
    const server = createHostServer({ input: process.stdin, output: process.stdout, buildId: 'TEST-routing-v1',
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
  const client = createCapturedHostClient({
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
  });
  const owner = { ownerId, revision: 'revision-1', storageRoot: root, client };
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
});
