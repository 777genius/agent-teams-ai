import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type HostedExternalWriterInventorySnapshot,
  HostedExternalWriterInventorySupervisor,
  type HostedExternalWriterObserverHandle,
  HostedExternalWriterTaskInventory,
} from '@main/composition/hosted/hostedExternalWriterInventorySupervisor';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ExternalWriterObserverSnapshot,
  ExternalWriterShutdownHandoff,
} from '@features/external-writer-coordination';
import type { TeamIdentityRecord } from '@features/internal-storage/contracts';

const teamId = parseTeamId('team_11111111111111111111111111111111');

function activeIdentity(legacyKey = 'sandbox-team'): TeamIdentityRecord {
  return {
    teamId,
    state: 'active',
    legacyKey: legacyKey as TeamIdentityRecord['legacyKey'],
    directoryFingerprint: 'a'.repeat(64) as TeamIdentityRecord['directoryFingerprint'],
    workspaceBinding: null,
    adoptionIntentId: null,
    identityChecksum: 'b'.repeat(64) as TeamIdentityRecord['identityChecksum'],
    createdAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:00.000Z',
    tombstonedAt: null,
  };
}

async function createActiveIdentity(
  root: string,
  legacyKey = 'sandbox-team'
): Promise<TeamIdentityRecord> {
  const teamRoot = join(root, 'teams', legacyKey);
  await mkdir(teamRoot, { recursive: true });
  const identityFile = `${JSON.stringify(
    { schemaVersion: 1, teamId, createdAt: '2026-01-01T00:00:00.000Z' },
    null,
    2
  )}\n`;
  await writeFile(join(teamRoot, 'team.identity.json'), identityFile);
  const stat = await lstat(teamRoot, { bigint: true });
  return {
    ...activeIdentity(legacyKey),
    directoryFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          canonicalPath: teamRoot,
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
        })
      )
      .digest('hex') as TeamIdentityRecord['directoryFingerprint'],
    identityChecksum: createHash('sha256')
      .update(identityFile)
      .digest('hex') as TeamIdentityRecord['identityChecksum'],
  };
}

function identityGateway(records: readonly TeamIdentityRecord[]) {
  return {
    listTeamIdentities: vi.fn().mockResolvedValue(records),
    listActiveTeamIdentities: vi
      .fn()
      .mockResolvedValue(records.filter((record) => record.state === 'active')),
    captureExternalWriterTeamIdentities: vi.fn(({ retirementCandidates }) =>
      Promise.resolve({
        active: records.filter((record) => record.state === 'active'),
        retiredCandidates: records.flatMap((record) =>
          retirementCandidates.includes(record.teamId) &&
          record.state === 'tombstoned' &&
          record.identityChecksum !== null &&
          record.tombstonedAt !== null
            ? [
                {
                  teamId: record.teamId,
                  identityChecksum: record.identityChecksum,
                  tombstonedAt: record.tombstonedAt,
                },
              ]
            : []
        ),
      })
    ),
    getTeamIdentity: vi.fn((requested) =>
      Promise.resolve(records.find((item) => item.teamId === requested) ?? null)
    ),
  };
}

const cleanObserverSnapshot = (): ExternalWriterObserverSnapshot => ({
  phase: 'running',
  acceptingNotifications: true,
  readiness: 'clean',
  checkpoint: {
    schemaVersion: 2,
    lastObservationSequence: 0,
    observationWatermark: 0,
    fileWriterEpochs: [],
    teamObservationWatermarks: [],
    pendingObservations: [],
    dirtyScopes: [],
    selfWriteIntents: [],
    observedFiles: [],
  },
});

function cleanHandoff(): ExternalWriterShutdownHandoff {
  return {
    status: 'clean',
    capturedSequence: 0,
    persistedWatermark: 0,
    dirtyScopes: [],
    pendingObservationCount: 0,
  };
}

describe('HostedExternalWriterTaskInventory', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('maps active durable identities to sorted exact direct-child task registrations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'sandbox-team');
    await mkdir(join(tasks, 'nested'), { recursive: true });
    await writeFile(join(tasks, 'z-task.json'), '{}');
    await writeFile(join(tasks, 'a-task.json'), '{}');
    await writeFile(join(tasks, 'notes.txt'), 'ignored');
    await writeFile(join(tasks, 'nested', 'not-admitted.json'), '{}');
    const active = await createActiveIdentity(root);
    const inactiveTasks = join(root, 'tasks', 'inactive-team');
    await mkdir(inactiveTasks, { recursive: true });
    await writeFile(join(inactiveTasks, 'must-not-register.json'), '{}');
    const inactive = {
      ...activeIdentity('inactive-team'),
      teamId: parseTeamId('team_22222222222222222222222222222222'),
      state: 'tombstoned' as const,
      tombstonedAt: '2026-01-02T00:00:00.000Z',
    };
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active, inactive]),
    });

    const snapshot = await inventory.capture();

    expect(snapshot.definitions.map((item) => item.registration.fileKey)).toEqual([
      'a-task',
      'z-task',
    ]);
    expect(snapshot.definitions[0]).toMatchObject({
      rootPath: root,
      filePath: join(tasks, 'a-task.json'),
      registration: {
        scope: { teamId, featureKey: 'tasks' },
        attributionPolicy: 'external_file_only',
      },
    });
  });

  it('independently discovers a new provider file on the next inventory capture', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'sandbox-team');
    await mkdir(tasks, { recursive: true });
    const active = await createActiveIdentity(root);
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active]),
    });
    const before = await inventory.capture();

    await writeFile(join(tasks, 'provider-external-write.json'), '{}');
    const after = await inventory.capture();

    expect(before.definitions).toHaveLength(0);
    expect(after.definitions.map((item) => item.registration.fileKey)).toEqual([
      'provider-external-write',
    ]);
    expect(after.catalogToken).not.toBe(before.catalogToken);
  });

  it('catalogues provider inboxes beside task files under the same durable team identity', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'sandbox-team');
    const inboxes = join(root, 'teams', 'sandbox-team', 'inboxes');
    await mkdir(tasks, { recursive: true });
    const active = await createActiveIdentity(root);
    await mkdir(inboxes, { recursive: true });
    await writeFile(join(tasks, 'task-1.json'), '{}');
    await writeFile(join(inboxes, 'user.json'), '[]');
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active]),
    });

    const snapshot = await inventory.capture();

    expect(
      snapshot.definitions.map((item) => [
        item.registration.scope.featureKey,
        item.registration.fileKey,
        item.filePath,
      ])
    ).toEqual([
      ['tasks', 'task-1', join(tasks, 'task-1.json')],
      ['inboxes', 'user', join(inboxes, 'user.json')],
    ]);
  });

  it('fails closed for a JSON symlink instead of registering an alias', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'sandbox-team');
    await mkdir(tasks, { recursive: true });
    await writeFile(join(root, 'outside.json'), '{}');
    await symlink(join(root, 'outside.json'), join(tasks, 'alias.json'));
    const active = await createActiveIdentity(root);
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active]),
    });

    await expect(inventory.capture()).rejects.toThrow('hosted-external-writer-task-entry-invalid');
  });

  it('fails closed when the admitted root inode is replaced after construction', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    const active = await createActiveIdentity(root);
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active]),
    });
    await rename(root, displaced);
    await mkdir(root);

    await expect(inventory.capture()).rejects.toThrow('hosted-external-writer-root-replaced');
  });

  it('fails closed when an active identity is bound to another team-directory inode', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    await mkdir(join(root, 'tasks', 'sandbox-team'), { recursive: true });
    const active = await createActiveIdentity(root);
    const substituted = {
      ...active,
      directoryFingerprint: 'a'.repeat(64) as TeamIdentityRecord['directoryFingerprint'],
    };
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([substituted]),
    });

    await expect(inventory.capture()).rejects.toThrow(
      'hosted-external-writer-team-directory-fingerprint-mismatch'
    );
  });

  it('bounds every inspected directory entry, including ignored non-JSON files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-external-inventory-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'sandbox-team');
    await mkdir(tasks, { recursive: true });
    await Promise.all(
      ['one.txt', 'two.txt', 'three.txt'].map((name) => writeFile(join(tasks, name), 'ignored'))
    );
    const active = await createActiveIdentity(root);
    const inventory = new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: root,
      teamIdentities: identityGateway([active]),
      maxDirectoryEntriesPerTeam: 2,
    });

    await expect(inventory.capture()).rejects.toThrow(
      'hosted-external-writer-directory-inventory-overflow'
    );
  });
});

describe('HostedExternalWriterInventorySupervisor', () => {
  const definition = (fileKey: string) => ({
    rootPath: '/admitted/root',
    filePath: `/admitted/root/tasks/sandbox-team/${fileKey}.json`,
    registration: {
      scope: { teamId, featureKey: 'tasks' },
      fileKey,
      maxBytes: 1_024,
      attributionPolicy: 'external_file_only' as const,
    },
  });
  const inventorySnapshot = (
    fileKeys: readonly string[]
  ): HostedExternalWriterInventorySnapshot => ({
    catalogToken: fileKeys.join(','),
    definitions: fileKeys.map(definition),
    retiredTeams: [],
  });

  function observer(
    name: string,
    events: string[],
    handoff: ExternalWriterShutdownHandoff = cleanHandoff()
  ): HostedExternalWriterObserverHandle {
    return {
      start() {
        events.push(`${name}:start`);
        return Promise.resolve(cleanObserverSnapshot());
      },
      rescanScope() {
        events.push(`${name}:rescan`);
        return Promise.resolve(cleanObserverSnapshot());
      },
      shutdown() {
        events.push(`${name}:shutdown`);
        return Promise.resolve(handoff);
      },
      retryCleanHandoffEligibility() {
        events.push(`${name}:retry-handoff`);
        return Promise.resolve(handoff);
      },
      getSnapshot: cleanObserverSnapshot,
    };
  }

  function dependencies(
    captures: HostedExternalWriterInventorySnapshot[],
    observerFactory: (
      definitions: readonly ReturnType<typeof definition>[]
    ) => HostedExternalWriterObserverHandle
  ) {
    let now = 1_000;
    let consumeAttempt = 0;
    return {
      inventory: {
        capture: vi.fn(() => Promise.resolve(captures.shift() ?? captures.at(-1)!)),
      },
      reconciliation: {
        getResult: vi.fn().mockResolvedValue(null),
        reconcile: vi.fn(),
      },
      stateStore: {
        load: vi.fn().mockResolvedValue(null),
        consumeCleanHandoffEligibility: vi.fn(async () =>
          consumeAttempt++ === 0 ? null : cleanObserverSnapshot().checkpoint
        ),
        listHotTeamIds: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue(undefined),
        saveCleanHandoffEligibility: vi.fn().mockResolvedValue(undefined),
      },
      clock: {
        nowMs: () => now++,
        sleep: vi.fn().mockResolvedValue(undefined),
      },
      convergenceIntervalMs: 60_000,
      observerFactory: observerFactory as never,
    };
  }

  it('starts the first long-lived observer before reporting running and rescans unchanged scope', async () => {
    const events: string[] = [];
    const snapshot = inventorySnapshot(['task-a']);
    const supervisor = new HostedExternalWriterInventorySupervisor(
      dependencies([snapshot, snapshot], () => observer('one', events))
    );

    await supervisor.start();
    await supervisor.convergeNow();

    expect(events).toEqual(['one:start', 'one:rescan']);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'running',
      catalogRevision: 1,
      registeredFileCount: 1,
      diagnosticCode: null,
    });
    await supervisor.shutdown();
  });

  it('keeps inventory convergence fast while throttling unchanged-catalog safety rescans', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const events: string[] = [];
      const snapshot = inventorySnapshot(['task-a']);
      const deps = dependencies([snapshot, snapshot, snapshot, snapshot], () =>
        observer('one', events)
      );
      deps.clock.nowMs = Date.now;
      const supervisor = new HostedExternalWriterInventorySupervisor({
        ...deps,
        convergenceIntervalMs: 10,
        stableCatalogRescanIntervalMs: 30,
      });

      await supervisor.start();
      await vi.advanceTimersByTimeAsync(29);

      expect(deps.inventory.capture).toHaveBeenCalledTimes(3);
      expect(events).toEqual(['one:start']);

      await vi.advanceTimersByTimeAsync(1);

      expect(deps.inventory.capture).toHaveBeenCalledTimes(4);
      expect(events).toEqual(['one:start', 'one:rescan']);
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanly checkpoints the old observer before starting a rebuilt exact catalog', async () => {
    const events: string[] = [];
    let generation = 0;
    const supervisor = new HostedExternalWriterInventorySupervisor(
      dependencies(
        [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
        () => observer(`observer-${++generation}`, events)
      )
    );

    await supervisor.start();
    await supervisor.convergeNow();

    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown',
      'observer-2:start',
    ]);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'running',
      catalogRevision: 2,
      registeredFileCount: 2,
    });
    await supervisor.shutdown();
  });

  it('consumes a sealed restart handoff before inventory capture or watcher construction', async () => {
    const events: string[] = [];
    const deps = dependencies([inventorySnapshot(['task-a'])], () => observer('one', events));
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility).mockImplementationOnce(async () => {
      events.push('handoff:consume');
      return cleanObserverSnapshot().checkpoint;
    });
    vi.mocked(deps.stateStore.listHotTeamIds).mockImplementationOnce(async () => {
      events.push('checkpoint:hot-identities');
      return [];
    });
    vi.mocked(deps.inventory.capture).mockImplementationOnce(async () => {
      events.push('inventory:capture');
      return inventorySnapshot(['task-a']);
    });
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);

    await supervisor.start();

    expect(events).toEqual([
      'handoff:consume',
      'checkpoint:hot-identities',
      'inventory:capture',
      'one:start',
    ]);
    await supervisor.shutdown();
  });

  it('fails closed before watcher start when a retired hot identity has no sealed handoff', async () => {
    const events: string[] = [];
    const retired = {
      teamId,
      identityChecksum: 'b'.repeat(64) as NonNullable<TeamIdentityRecord['identityChecksum']>,
      tombstonedAt: '2026-01-02T00:00:00.000Z',
    };
    const snapshot = { ...inventorySnapshot([]), retiredTeams: [retired] };
    const deps = dependencies([snapshot], () => observer('never', events));
    vi.mocked(deps.stateStore.listHotTeamIds).mockResolvedValueOnce([teamId]);
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);

    await expect(supervisor.start()).rejects.toThrow(
      'hosted-external-writer-retirement-handoff-unproven'
    );

    expect(deps.inventory.capture).toHaveBeenCalledWith([teamId]);
    expect(events).toEqual([]);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'dirty',
      diagnosticCode: 'startup_failed',
    });
  });

  it('does not start a replacement watcher when the sealed handoff cannot be consumed', async () => {
    const events: string[] = [];
    let generation = 0;
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer(`observer-${++generation}`, events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();

    await expect(supervisor.convergeNow()).rejects.toThrow(
      'hosted-external-writer-clean-handoff-marker-missing'
    );

    expect(events).toEqual(['observer-1:start', 'observer-1:rescan', 'observer-1:shutdown']);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'dirty',
      catalogRevision: 1,
      diagnosticCode: 'catalog_rebuild_handoff_persist_failed',
    });
    await supervisor.shutdown();
  });

  it('recovers in-process when marker commit succeeds but the shutdown response is lost', async () => {
    const events: string[] = [];
    let generation = 0;
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer(`observer-${++generation}`, events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cleanObserverSnapshot().checkpoint);
    const first = observer('observer-1', events);
    first.shutdown = vi.fn(async () => {
      events.push('observer-1:shutdown-commit-response-lost');
      throw new Error('response-lost-after-marker-commit');
    });
    deps.observerFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => observer('observer-2', events)) as never;
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();

    await expect(supervisor.convergeNow()).resolves.toMatchObject({
      phase: 'running',
      catalogRevision: 2,
    });

    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown-commit-response-lost',
      'observer-2:start',
    ]);
    await supervisor.shutdown();
  });

  it('retries a transient marker consume in-process without rebuilding from a new inventory', async () => {
    const events: string[] = [];
    let generation = 0;
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer(`observer-${++generation}`, events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('temporary-storage-failure'))
      .mockResolvedValueOnce(cleanObserverSnapshot().checkpoint);
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();

    await expect(supervisor.convergeNow()).rejects.toThrow('temporary-storage-failure');
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'dirty',
      catalogRevision: 1,
      observer: null,
      diagnosticCode: 'catalog_rebuild_handoff_persist_failed',
    });

    await expect(supervisor.convergeNow()).resolves.toMatchObject({
      phase: 'running',
      catalogRevision: 2,
      registeredFileCount: 2,
    });
    expect(deps.inventory.capture).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown',
      'observer-2:start',
    ]);
    await supervisor.shutdown();
  });

  it('backs off periodic marker recovery and cancels it on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let generation = 0;
      const deps = dependencies(
        [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
        () => observer(`observer-${++generation}`, events)
      );
      vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('temporary-storage-failure'))
        .mockResolvedValueOnce(cleanObserverSnapshot().checkpoint);
      const supervisor = new HostedExternalWriterInventorySupervisor({
        ...deps,
        convergenceIntervalMs: 10,
      });
      await supervisor.start();

      await vi.advanceTimersByTimeAsync(10);
      expect(supervisor.getSnapshot()).toMatchObject({
        phase: 'dirty',
        catalogRevision: 1,
        observer: null,
      });
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(19);
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(3);
      expect(supervisor.getSnapshot()).toMatchObject({ phase: 'running', catalogRevision: 2 });

      await supervisor.shutdown();
      await vi.advanceTimersByTimeAsync(100);
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts a replacement when shutdown is requested during lost-response consume', async () => {
    const events: string[] = [];
    let releaseConsume:
      | ((checkpoint: ExternalWriterObserverSnapshot['checkpoint']) => void)
      | null = null;
    const blockedConsume = new Promise<ExternalWriterObserverSnapshot['checkpoint']>((resolve) => {
      releaseConsume = resolve;
    });
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer('observer-2', events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => blockedConsume);
    const first = observer('observer-1', events);
    first.shutdown = vi.fn(async () => {
      events.push('observer-1:shutdown-response-lost');
      throw new Error('response-lost-after-marker-commit');
    });
    deps.observerFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => observer('observer-2', events)) as never;
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();
    const convergence = supervisor.convergeNow();
    await vi.waitFor(() =>
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(2)
    );

    const shutdown = supervisor.shutdown();
    const repeatedShutdown = supervisor.shutdown();
    expect(repeatedShutdown).toBe(shutdown);
    releaseConsume!(cleanObserverSnapshot().checkpoint);

    await expect(convergence).resolves.toMatchObject({ phase: 'stopping' });
    await expect(shutdown).resolves.toMatchObject({ status: 'clean' });
    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown-response-lost',
    ]);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'stopped', catalogRevision: 1 });
    await expect(supervisor.shutdown()).resolves.toMatchObject({ status: 'clean' });
  });

  it('retries the exact seal on shutdown after a pre-commit failure', async () => {
    const events: string[] = [];
    let releaseConsume: (() => void) | null = null;
    const blockedConsume = new Promise<null>((resolve) => {
      releaseConsume = () => resolve(null);
    });
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer('observer-2', events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => blockedConsume);
    const first = observer('observer-1', events);
    first.shutdown = vi.fn(async () => {
      events.push('observer-1:shutdown-pre-commit-failure');
      throw new Error('storage-unavailable-before-marker-commit');
    });
    deps.observerFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => observer('observer-2', events)) as never;
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();
    const convergence = supervisor.convergeNow();
    await vi.waitFor(() =>
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(2)
    );

    const shutdown = supervisor.shutdown();
    releaseConsume!();

    await expect(convergence).resolves.toMatchObject({ phase: 'stopping' });
    await expect(shutdown).resolves.toMatchObject({ status: 'clean' });
    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown-pre-commit-failure',
      'observer-1:retry-handoff',
    ]);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'stopped', catalogRevision: 1 });
  });

  it('preserves the pending generation when shutdown fails and retries the exact seal later', async () => {
    const events: string[] = [];
    let releaseConsume: (() => void) | null = null;
    const blockedConsume = new Promise<null>((resolve) => {
      releaseConsume = () => resolve(null);
    });
    const deps = dependencies(
      [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
      () => observer('observer-2', events)
    );
    vi.mocked(deps.stateStore.consumeCleanHandoffEligibility)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => blockedConsume)
      .mockResolvedValueOnce(null);
    vi.mocked(deps.stateStore.save).mockRejectedValueOnce(
      new Error('ordinary-checkpoint-save-failed')
    );
    const first = observer('observer-1', events);
    first.shutdown = vi.fn(async () => {
      events.push('observer-1:shutdown-pre-commit-failure');
      throw new Error('seal-pre-commit-failure');
    });
    first.retryCleanHandoffEligibility = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push('observer-1:retry-handoff-failed');
        throw new Error('retry-seal-pre-commit-failure');
      })
      .mockImplementationOnce(async () => {
        events.push('observer-1:retry-handoff-succeeded');
        return cleanHandoff();
      });
    deps.observerFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => observer('observer-2', events)) as never;
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();
    const convergence = supervisor.convergeNow();
    await vi.waitFor(() =>
      expect(deps.stateStore.consumeCleanHandoffEligibility).toHaveBeenCalledTimes(2)
    );

    const firstShutdown = supervisor.shutdown();
    releaseConsume!();
    await expect(convergence).resolves.toMatchObject({ phase: 'stopping' });
    await expect(firstShutdown).rejects.toThrow('ordinary-checkpoint-save-failed');
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'dirty',
      catalogRevision: 1,
      diagnosticCode: 'shutdown_failed',
    });

    await expect(supervisor.shutdown()).resolves.toMatchObject({ status: 'clean' });
    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown-pre-commit-failure',
      'observer-1:retry-handoff-failed',
      'observer-1:retry-handoff-succeeded',
    ]);
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'stopped', catalogRevision: 1 });
  });

  it('refuses catalog replacement after a dirty shutdown handoff and surfaces diagnostics', async () => {
    const events: string[] = [];
    const dirty: ExternalWriterShutdownHandoff = {
      ...cleanHandoff(),
      status: 'dirty',
      dirtyScopes: [
        {
          scope: { teamId, featureKey: 'tasks' },
          reasons: ['shutdown_handoff'],
          earliestSequence: 1,
          latestSequence: 1,
        },
      ],
    };
    let generation = 0;
    const supervisor = new HostedExternalWriterInventorySupervisor(
      dependencies(
        [inventorySnapshot(['task-a']), inventorySnapshot(['task-a', 'provider-new'])],
        () => observer(`observer-${++generation}`, events, dirty)
      )
    );

    await supervisor.start();
    await supervisor.convergeNow();

    expect(events).toEqual(['observer-1:start', 'observer-1:rescan', 'observer-1:shutdown']);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'dirty',
      catalogRevision: 1,
      registeredFileCount: 1,
      diagnosticCode: 'catalog_rebuild_handoff_dirty',
      dirtyHandoff: { status: 'dirty' },
    });
  });

  it('does not run another periodic capture after shutdown', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const snapshot = inventorySnapshot(['task-a']);
      const deps = dependencies([snapshot, snapshot], () => observer('one', events));
      const supervisor = new HostedExternalWriterInventorySupervisor({
        ...deps,
        convergenceIntervalMs: 10,
      });
      await supervisor.start();
      await supervisor.shutdown();
      await vi.advanceTimersByTimeAsync(100);

      expect(deps.inventory.capture).toHaveBeenCalledTimes(1);
      expect(supervisor.getSnapshot().phase).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescans the old exact scope before rebuilding when the last file disappears', async () => {
    const events: string[] = [];
    let generation = 0;
    const supervisor = new HostedExternalWriterInventorySupervisor(
      dependencies([inventorySnapshot(['task-a']), inventorySnapshot([])], () =>
        observer(`observer-${++generation}`, events)
      )
    );

    await supervisor.start();
    await supervisor.convergeNow();

    expect(events).toEqual([
      'observer-1:start',
      'observer-1:rescan',
      'observer-1:shutdown',
      'observer-2:start',
    ]);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'running',
      catalogRevision: 2,
      registeredFileCount: 0,
    });
    await supervisor.shutdown();
  });

  it('discovers the first file from an empty catalog on the periodic timer', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let generation = 0;
      const deps = dependencies(
        [inventorySnapshot([]), inventorySnapshot(['provider-first'])],
        () => observer(`observer-${++generation}`, events)
      );
      const supervisor = new HostedExternalWriterInventorySupervisor({
        ...deps,
        convergenceIntervalMs: 10,
      });
      await supervisor.start();

      await vi.advanceTimersByTimeAsync(10);

      expect(deps.inventory.capture).toHaveBeenCalledTimes(2);
      expect(events).toEqual(['observer-1:start', 'observer-1:shutdown', 'observer-2:start']);
      expect(supervisor.getSnapshot()).toMatchObject({
        phase: 'running',
        catalogRevision: 2,
        registeredFileCount: 1,
      });
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries and recovers after one transient periodic inventory failure', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const snapshot = inventorySnapshot(['task-a']);
      const deps = dependencies([snapshot, snapshot], () => observer('one', events));
      vi.mocked(deps.inventory.capture)
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValueOnce(new Error('temporary-read-failure'))
        .mockResolvedValueOnce(snapshot);
      const supervisor = new HostedExternalWriterInventorySupervisor({
        ...deps,
        convergenceIntervalMs: 10,
      });
      await supervisor.start();

      await vi.advanceTimersByTimeAsync(10);
      expect(supervisor.getSnapshot()).toMatchObject({
        phase: 'dirty',
        diagnosticCode: 'periodic_convergence_failed',
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(deps.inventory.capture).toHaveBeenCalledTimes(3);
      expect(events).toEqual(['one:start', 'one:rescan']);
      expect(supervisor.getSnapshot()).toMatchObject({
        phase: 'running',
        diagnosticCode: null,
      });
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes shutdown behind an in-flight periodic capture and never starts a new generation', async () => {
    const events: string[] = [];
    const first = inventorySnapshot(['task-a']);
    const changed = inventorySnapshot(['task-a', 'provider-new']);
    let releaseCapture: (() => void) | null = null;
    const blockedCapture = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const deps = dependencies([first], () => observer('one', events));
    vi.mocked(deps.inventory.capture)
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(async () => {
        await blockedCapture;
        return changed;
      });
    const supervisor = new HostedExternalWriterInventorySupervisor(deps);
    await supervisor.start();
    const convergence = supervisor.convergeNow();
    await vi.waitFor(() => expect(deps.inventory.capture).toHaveBeenCalledTimes(2));

    const shutdown = supervisor.shutdown();
    releaseCapture!();
    await convergence;
    await shutdown;

    expect(events).toEqual(['one:start', 'one:shutdown']);
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'stopped',
      catalogRevision: 1,
      registeredFileCount: 1,
    });
  });

  it('accepts shutdown during blocked startup capture and never constructs an observer', async () => {
    let releaseCapture: (() => void) | null = null;
    const blockedCapture = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const capture = vi.fn(async () => {
      await blockedCapture;
      return inventorySnapshot(['task-a']);
    });
    const factory = vi.fn(() => observer('never', []));
    const deps = dependencies([], factory);
    const supervisor = new HostedExternalWriterInventorySupervisor({
      ...deps,
      inventory: { capture },
    });
    const started = supervisor.start();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    const stopped = supervisor.shutdown();
    releaseCapture!();

    await expect(started).resolves.toMatchObject({ phase: 'stopped' });
    await expect(stopped).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(supervisor.getSnapshot().phase).toBe('stopped');
  });

  it('shuts down an observer whose start completes after shutdown was requested', async () => {
    const events: string[] = [];
    let releaseStart: (() => void) | null = null;
    const blockedStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const delayed: HostedExternalWriterObserverHandle = {
      ...observer('delayed', events),
      async start() {
        events.push('delayed:start');
        await blockedStart;
        return cleanObserverSnapshot();
      },
    };
    const supervisor = new HostedExternalWriterInventorySupervisor(
      dependencies([inventorySnapshot(['task-a'])], () => delayed)
    );
    const started = supervisor.start();
    await vi.waitFor(() => expect(events).toEqual(['delayed:start']));

    const stopped = supervisor.shutdown();
    releaseStart!();

    await expect(started).resolves.toMatchObject({ phase: 'stopped' });
    await expect(stopped).resolves.toMatchObject({ status: 'clean' });
    expect(events).toEqual(['delayed:start', 'delayed:shutdown']);
    expect(supervisor.getSnapshot().phase).toBe('stopped');
  });
});
