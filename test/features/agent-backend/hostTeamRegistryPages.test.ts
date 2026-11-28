// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import { createTeamRegistryMethods } from '../../../packages/legacy-agent-host/dist/composition/createTeamCreationMethods.js';
import { teamRegistryRecordSchema } from '../../../packages/legacy-agent-host/dist/team-registry/contracts.js';
import { DesktopBackendFeature } from '../../../src/features/agent-backend/main';
import { CapturedTeamRegistry } from '../../../src/features/agent-backend/main/infrastructure/CapturedTeamRegistry';

import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  TeamRegistryList,
  TeamRegistryRecord,
} from '@agent-teams/legacy-agent-host/team-registry/contracts';

const contextId = 'TEST-context';
const revision = 'a'.repeat(64);
const cursor = (offset: number) => offset + '.' + 'b'.repeat(64);

function record(index: number, description = 'TEST description'): TeamRegistryRecord {
  return teamRegistryRecordSchema.parse({
    contextId,
    teamId: 'test-team-' + index,
    teamName: 'test-team-' + index,
    displayName: 'Team ' + index,
    description,
    color: 'blue',
    projectContextMode: 'per_project',
    projectContext: {
      logicalTeamId: 'test-logical',
      logicalHandleId: 'TEST-logical',
      workContextId: 'TEST-work-' + index,
      projectKey: 'd'.repeat(64),
      projectPath: '/TEST-project-' + index,
    },
    members: [{ memberId: 'test-lead-' + index, label: 'team-lead' }],
    binding: {
      schemaVersion: 1,
      handleId: 'TEST-handle-' + index,
      scope: {
        projectId: contextId,
        workspaceId: contextId,
        teamId: 'test-team-' + index,
        runId: 'TEST-run-' + index,
        memberId: 'user',
        generation: '1',
      },
    },
  });
}

function page(
  teams: TeamRegistryRecord[],
  held: TeamRegistryList['held'],
  totalTeams: number,
  totalHeld: number,
  nextCursor: string | null
) {
  return { kind: 'team-registry-page', teams, held, totalTeams, totalHeld, revision, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(read: (payload: Record<string, JsonValue>) => unknown | Promise<unknown>) {
  const owner = {
    ownerId: 'TEST-owner',
    revision: 'TEST-revision',
    protocolVersion: 1 as const,
    profileId: 'TEST-profile',
    buildId: 'TEST-build',
    nodeSha256: 'a'.repeat(64),
    hostEntrySha256: 'b'.repeat(64),
    storageRoot: '/TEST-host',
  };
  const request = vi.fn(async (_method: string, raw: JsonValue): Promise<JsonValue> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('TEST invalid request');
    expect(raw.owner).toEqual(owner);
    const payload = raw.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('TEST invalid payload');
    return JSON.parse(JSON.stringify({ ok: true, value: await read(payload) })) as JsonValue;
  });
  const options = {
    owner,
    client: { request },
    start: vi.fn(async () => undefined),
    available: () => true,
  };
  const registry = new CapturedTeamRegistry(options);
  return { registry, request, options, owner };
}

it('assembles the actual Host registry pager before returning the complete ordered teams and held receipts', async () => {
  const catalog: TeamRegistryList = {
    teams: Array.from({ length: 18 }, (_, index) => record(index, 'x'.repeat(60_000))),
    held: [
      { commandId: 'TEST-held', phase: 'held', record: record(18, 'y'.repeat(60_000)) },
      { commandId: 'TEST-pending', phase: 'pending', record: record(19, 'z'.repeat(60_000)) },
    ],
  };
  const unexpected = (): never => {
    throw new Error('Unexpected registry mutation');
  };
  let reads = 0;
  const methods = createTeamRegistryMethods({
    select: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('TEST invalid request');
      const input = raw as { commandId: string; payload: unknown };
      return {
        commandId: input.commandId,
        payload: input.payload,
        registry: {
          create: unexpected,
          lookup: unexpected,
          list: (selected) => {
            expect(selected).toBe(contextId);
            reads++;
            return catalog;
          },
        },
      };
    },
  });
  const f = fixture(async (payload) => {
    const result = await methods['team.registry.list']!.handle(
      { commandId: 'TEST-original', payload },
      { requestId: 'TEST-registry-read', signal: new AbortController().signal }
    );
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true)
      throw new Error('TEST Host rejected list');
    return result.value;
  });
  expect(await f.registry.list(contextId)).toEqual(catalog);
  expect(reads).toBeGreaterThan(1);
  expect(f.request.mock.calls.every(([method]) => method === 'team.registry.list')).toBe(true);
  const ids = f.request.mock.calls.map(([, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('TEST invalid request');
    return raw.commandId;
  });
  expect(new Set(ids).size).toBe(1);
});

it('keeps small and empty legacy lists complete without a second request', async () => {
  for (const catalog of [
    { teams: [], held: [] },
    { teams: [record(0)], held: [] },
  ]) {
    const f = fixture(() => catalog);
    expect(await f.registry.list(contextId)).toEqual(catalog);
    expect(f.request).toHaveBeenCalledOnce();
  }
});

it.each([
  'owner mutation',
  'owner replacement',
  'client replacement',
  'context revocation',
  'availability loss',
])(
  'captures the original owner/client before start and refuses %s before dispatch',
  async (change) => {
    const ready = deferred<undefined>();
    const f = fixture(() => ({ teams: [], held: [] }));
    f.options.start = vi.fn(() => ready.promise);
    let current = true;
    const pending = f.registry.list(contextId, { isCurrent: () => current });
    const rejection = expect(pending).rejects.toThrow();
    if (change === 'owner mutation') f.owner.ownerId = 'TEST-replacement';
    else if (change === 'owner replacement')
      f.options.owner = { ...f.owner, revision: 'replacement' };
    else if (change === 'client replacement') f.options.client = { request: vi.fn(f.request) };
    else if (change === 'context revocation') current = false;
    else f.options.available = () => false;
    ready.resolve(undefined);
    await rejection;
    expect(f.request).not.toHaveBeenCalled();
  }
);

it.each(['owner', 'client', 'context', 'availability'])(
  'discards a complete continuation after original %s becomes stale',
  async (change) => {
    const next = deferred<unknown>();
    const entered = deferred<undefined>();
    const f = fixture((payload) => {
      if (payload.cursor === undefined) return page([record(0)], [], 2, 0, cursor(1));
      entered.resolve(undefined);
      return next.promise;
    });
    let current = true,
      published = false;
    const pending = f.registry.list(contextId, { isCurrent: () => current }).then((value) => {
      published = true;
      return value;
    });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    if (change === 'owner') f.owner.revision = 'changed';
    else if (change === 'client') f.options.client = { request: vi.fn(f.request) };
    else if (change === 'context') current = false;
    else f.options.available = () => false;
    next.resolve(page([record(1)], [], 2, 0, null));
    await rejection;
    expect(published).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(2);
  }
);

const invalidContinuation = [
  ['revision drift', { revision: 'c'.repeat(64) }],
  ['total drift', { totalTeams: 3 }],
  ['kind drift', { kind: 'other-page' }],
  [
    'legacy after page',
    {
      kind: undefined,
      totalTeams: undefined,
      totalHeld: undefined,
      revision: undefined,
      nextCursor: undefined,
    },
  ],
  ['empty page', { teams: [], held: [] }],
  ['duplicate team', { teams: [record(0)] }],
  [
    'duplicate handle',
    {
      teams: [
        { ...record(1), binding: { ...record(1).binding, handleId: record(0).binding.handleId } },
      ],
    },
  ],
  [
    'duplicate case-folded name',
    { teams: [{ ...record(1), teamName: record(0).teamName.toUpperCase() }] },
  ],
  ['foreign context', { teams: [{ ...record(1), contextId: 'foreign' }] }],
  ['premature end', { held: [] }],
  ['wrong cursor offset', { held: [], nextCursor: cursor(1) }],
  ['continued after total', { nextCursor: cursor(3) }],
  ['malformed cursor', { held: [], nextCursor: 'invalid' }],
  ['extra field', { extra: true }],
] as const;
it.each(invalidContinuation)(
  'rejects %s without publishing any assembled prefix',
  async (_name, patch) => {
    const first = page([record(0)], [], 2, 1, cursor(1));
    const second = {
      ...page(
        [record(1)],
        [{ commandId: 'TEST-held', phase: 'held', record: record(2) }],
        2,
        1,
        null
      ),
      ...patch,
    };
    const f = fixture((payload) => (payload.cursor === undefined ? first : second));
    let published = false;
    await expect(
      f.registry.list(contextId).then((value) => {
        published = true;
        return value;
      })
    ).rejects.toThrow();
    expect(published).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(2);
  }
);

it('rejects held rows before all declared teams and repeated opaque cursors', async () => {
  const early = fixture(() =>
    page([], [{ commandId: 'held', phase: 'held', record: record(2) }], 2, 1, cursor(1))
  );
  await expect(early.registry.list(contextId)).rejects.toThrow();
  expect(early.request).toHaveBeenCalledOnce();
  const repeated = fixture((payload) =>
    payload.cursor === undefined
      ? page([record(0)], [], 3, 0, cursor(1))
      : page([record(1)], [], 3, 0, cursor(1))
  );
  await expect(repeated.registry.list(contextId)).rejects.toThrow();
  expect(repeated.request).toHaveBeenCalledTimes(2);
});

it('validates combined counts, original context and unique identities on the first legacy response too', async () => {
  const original = record(0);
  const invalid: TeamRegistryList[] = [
    {
      teams: Array.from({ length: 256 }, (_, index) => record(index)),
      held: [{ commandId: 'held', phase: 'held', record: record(256) }],
    },
    { teams: [{ ...original, contextId: 'foreign' }], held: [] },
    { teams: [original], held: [{ commandId: 'held', phase: 'held', record: original }] },
    { teams: [original, { ...record(1), binding: original.binding }], held: [] },
    { teams: [original, { ...record(1), teamName: original.teamName.toUpperCase() }], held: [] },
  ];
  for (const catalog of invalid) {
    const f = fixture(() => catalog);
    await expect(f.registry.list(contextId)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
  }
});

it('accepts exactly 256 one-record pages and rejects an attempted continuation after the complete catalog', async () => {
  const rows = Array.from({ length: 256 }, (_, index) => record(index));
  for (const extra of [false, true]) {
    let index = 0;
    const f = fixture(() => {
      const position = index++;
      return page(
        [rows[position]!],
        [],
        rows.length,
        0,
        position < rows.length - 1 || extra ? cursor(position + 1) : null
      );
    });
    if (extra) await expect(f.registry.list(contextId)).rejects.toThrow();
    else expect(await f.registry.list(contextId)).toEqual({ teams: rows, held: [] });
    expect(f.request).toHaveBeenCalledTimes(256);
  }
  const invalid = fixture(() => page([record(0)], [], 257, 0, cursor(1)));
  await expect(invalid.registry.list(contextId)).rejects.toThrow();
  expect(invalid.request).toHaveBeenCalledOnce();
});

const roots: string[] = [],
  features: DesktopBackendFeature[] = [];
afterEach(async () => {
  await Promise.all(features.splice(0).map((feature) => feature.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function desktopFixture(mutate: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-registry-discovery-')));
  roots.push(root);
  const catalog: TeamRegistryList = {
    teams: Array.from({ length: 18 }, (_, index) => record(index, 'x'.repeat(60_000))),
    held: [{ commandId: 'TEST-held', phase: 'held', record: record(18, 'y'.repeat(60_000)) }],
  };
  const registryPath = join(root, 'registry.json'),
    markerPath = join(root, 'reads.ndjson');
  await writeFile(registryPath, JSON.stringify(catalog));
  const dist = pathToFileURL(join(process.cwd(), 'packages/legacy-agent-host/dist/')).href;
  const source = `import { readFileSync, appendFileSync } from 'node:fs';
    import { createHostServer } from ${JSON.stringify(new URL('index.js', dist).href)};
    import { createTeamRegistryMethods } from ${JSON.stringify(new URL('composition/createTeamCreationMethods.js', dist).href)};
    import { TeamRegistry } from ${JSON.stringify(new URL('team-registry/TeamRegistry.js', dist).href)};
    import { FileTeamRegistryStore } from ${JSON.stringify(new URL('adapters/team-registry/FileTeamRegistryStore.js', dist).href)};
    const catalog = JSON.parse(readFileSync(${JSON.stringify(registryPath)}, 'utf8'));
    const registry = new TeamRegistry({ ownerId:'TEST-owner',profileId:'TEST-profile',principalId:'TEST-principal',
      contextIds:[${JSON.stringify(contextId)}],staticTeams:[],store:new FileTeamRegistryStore(${JSON.stringify(root)},()=>{}),
      assertWriter(){},admit(){throw new Error('TEST unexpected admission')},attach(){throw new Error('TEST unexpected attach')},
      additionalCatalog(){return catalog} });
    const methods = createTeamRegistryMethods({select(raw){
      if(raw.owner.ownerId!=='TEST-owner'||raw.owner.revision!=='v1'||raw.owner.storageRoot!==${JSON.stringify(root)})
        throw new Error('TEST foreign owner');
      appendFileSync(${JSON.stringify(markerPath)},JSON.stringify(raw.payload)+'\\n');
      if(${mutate}&&raw.payload.cursor)catalog.teams[17].description+='changed';
      return{registry,commandId:raw.commandId,payload:raw.payload};
    }});
    methods['team.lifecycle.retired.read']={lane:'control',handle:()=>({ok:true,value:{teamIds:[]}})};
    const host=createHostServer({input:process.stdin,output:process.stdout,buildId:'TEST-registry-build',methods});
    void host.closed.then(()=>process.exit(0));`;
  const hostEntry = join(root, 'host.mjs');
  await writeFile(hostEntry, source);
  const nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const owner = { ownerId: 'TEST-owner', revision: 'v1' };
  const descriptor = {
    schemaVersion: 1,
    defaultOwner: owner,
    owners: [
      {
        ...owner,
        storageRoot: root,
        profile: {
          profileId: 'TEST-profile',
          nodeExecutable,
          nodeVersion: execFileSync(nodeExecutable, ['--version'], {
            encoding: 'utf8',
            env: {},
          }).trim(),
          nodeSha256: createHash('sha256')
            .update(await readFile(nodeExecutable))
            .digest('hex'),
          hostEntry,
          hostEntrySha256: createHash('sha256').update(source).digest('hex'),
          expectedBuildId: 'TEST-registry-build',
          cwd: root,
          env: { HOME: root, TMPDIR: root },
          startupTimeoutMs: 3000,
          requestTimeoutMs: 3000,
          writeTimeoutMs: 1000,
          shutdownTimeoutMs: 300,
        },
      },
    ],
    handles: [],
    creation: { owner, contextIds: [contextId] },
  };
  const descriptorPath = join(root, 'descriptor.json'),
    bytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, bytes, { mode: 0o600 });
  const feature = new DesktopBackendFeature({
    descriptor: { path: descriptorPath, sha256: createHash('sha256').update(bytes).digest('hex') },
    bindingDirectory: join(root, 'bindings'),
  });
  features.push(feature);
  return { feature, catalog, markerPath };
}

it('actual captured Host discovery registers every complete published row and no held row', async () => {
  const f = await desktopFixture(false);
  await f.feature.initialize();
  expect(f.feature.listBindings(contextId)).toMatchObject({ state: 'ready', bindings: [] });
  const result = await f.feature.discoverBindings(contextId, { isCurrent: () => true });
  expect(result.state).toBe('ready');
  expect(result.bindings.map((binding) => binding.handle.handleId)).toEqual(
    f.catalog.teams.map((row) => row.binding.handleId)
  );
  expect(new Set(result.bindings.map((binding) => binding.handle.handleId)).size).toBe(18);
  expect(
    result.bindings.some(
      (binding) => binding.handle.handleId === f.catalog.held[0]!.record.binding.handleId
    )
  ).toBe(false);
  const reads = (await readFile(f.markerPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(reads.length).toBeGreaterThan(1);
  expect(reads[0]).toEqual({ contextId });
  expect(
    reads.slice(1).every((row) => row.contextId === contextId && typeof row.cursor === 'string')
  ).toBe(true);
});

it('actual captured Host discovery publishes no prefix when the original catalog changes between pages', async () => {
  const f = await desktopFixture(true);
  await f.feature.initialize();
  expect(f.feature.listBindings(contextId)).toMatchObject({ state: 'ready', bindings: [] });
  await expect(f.feature.discoverBindings(contextId, { isCurrent: () => true })).rejects.toThrow();
  expect(f.feature.listBindings(contextId).bindings).toEqual([]);
  expect((await readFile(f.markerPath, 'utf8')).trim().split('\n')).toHaveLength(2);
});
