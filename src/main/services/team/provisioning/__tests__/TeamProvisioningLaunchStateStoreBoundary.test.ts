import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createTeamProvisioningLaunchStateStoreBoundaryFromService,
  TeamProvisioningLaunchStateStoreBoundary,
  type TeamProvisioningLaunchStateStoreBoundaryPorts,
  type TeamProvisioningLaunchStateStoreBoundaryServiceHost,
} from '../TeamProvisioningLaunchStateStoreBoundary';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';
const refreshMs = 1_000;

function member(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<PersistedTeamLaunchSnapshot> = {}
): PersistedTeamLaunchSnapshot {
  return {
    ...createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      members: { Builder: member() },
      updatedAt: at,
    }),
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function createBoundary(overrides: Partial<TeamProvisioningLaunchStateStoreBoundaryPorts> = {}): {
  boundary: TeamProvisioningLaunchStateStoreBoundary;
  ports: TeamProvisioningLaunchStateStoreBoundaryPorts;
  setCurrentSnapshot(snapshot: PersistedTeamLaunchSnapshot | null): void;
  setTrackedRunId(runId: string | null): void;
} {
  let currentSnapshot: PersistedTeamLaunchSnapshot | null = null;
  let trackedRunId: string | null = 'run-1';
  const ports: TeamProvisioningLaunchStateStoreBoundaryPorts = {
    launchStateStore: {
      read: vi.fn(async () => currentSnapshot),
      write: vi.fn(async (_teamName, nextSnapshot) => {
        currentSnapshot = nextSnapshot;
      }),
      clear: vi.fn(async () => {
        currentSnapshot = null;
      }),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => [{ name: 'Builder', joinedAt: 1 }]),
    },
    getTrackedRunId: vi.fn(() => trackedRunId),
    applyOpenCodeSecondaryEvidenceOverlay: vi.fn(
      async ({ snapshot: inputSnapshot }) => inputSnapshot
    ),
    applyBootstrapStallOverlay: vi.fn(() => null),
    areSnapshotsSemanticallyEqual: vi.fn(() => false),
    clearBootstrapState: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(() => undefined),
    logDebug: vi.fn(() => undefined),
    nowMs: vi.fn(() => Date.parse(at)),
    noopRefreshMs: refreshMs,
    ...overrides,
  };
  return {
    boundary: new TeamProvisioningLaunchStateStoreBoundary(ports),
    ports,
    setCurrentSnapshot(nextSnapshot) {
      currentSnapshot = nextSnapshot;
    },
    setTrackedRunId(runId) {
      trackedRunId = runId;
    },
  };
}

describe('TeamProvisioningLaunchStateStoreBoundary', () => {
  it('builds service-shaped boundary ports and mirrors launch-state writes', async () => {
    const nextSnapshot = snapshot();
    const launchStateStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const defaultLaunchStateStore = {
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const clearBootstrapState = vi.fn(async () => undefined);
    const invalidateRuntimeSnapshotCaches = vi.fn();
    const service = {
      launchStateStore,
      defaultLaunchStateStore,
      membersMetaStore: {
        getMembers: vi.fn(async () => [{ name: 'Builder', joinedAt: 1 }]),
      },
      getTrackedRunId: vi.fn(() => 'run-1'),
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(
        async ({ snapshot: inputSnapshot }) => inputSnapshot
      ),
      applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn(() => null),
      invalidateRuntimeSnapshotCaches,
      launchStateWrittenRunIdByTeam: new Map<string, string>(),
    } satisfies TeamProvisioningLaunchStateStoreBoundaryServiceHost;
    const boundary = createTeamProvisioningLaunchStateStoreBoundaryFromService(service, {
      areSnapshotsSemanticallyEqual: vi.fn(() => false),
      clearBootstrapState,
      logDebug: vi.fn(),
      nowMs: vi.fn(() => Date.parse(at)),
    });

    await boundary.writeLaunchStateSnapshotNow('demo', nextSnapshot, { runId: 'run-1' });
    await boundary.clearPersistedLaunchStateNow('demo');

    expect(launchStateStore.write).toHaveBeenCalledWith('demo', nextSnapshot);
    expect(defaultLaunchStateStore.write).toHaveBeenCalledWith('demo', nextSnapshot);
    expect(launchStateStore.clear).toHaveBeenCalledWith('demo');
    expect(defaultLaunchStateStore.clear).toHaveBeenCalledWith('demo');
    expect(clearBootstrapState).toHaveBeenCalledWith('demo');
    expect(invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');
  });

  it('skips stale clears when the tracked run id differs', async () => {
    const { boundary, ports, setTrackedRunId } = createBoundary();
    setTrackedRunId('run-current');

    await boundary.clearPersistedLaunchStateNow('demo', { expectedRunId: 'run-stale' });

    expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
    expect(ports.clearBootstrapState).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[demo] Skipping stale launch-state clear for run run-stale'
    );
  });

  it('clears run-scoped persisted state, last-written state, and runtime caches', async () => {
    const { boundary, ports, setTrackedRunId } = createBoundary();

    await boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
    await boundary.clearPersistedLaunchStateNow('demo', { expectedRunId: 'run-1' });

    expect(ports.launchStateStore.clear).toHaveBeenCalledWith('demo');
    expect(ports.clearBootstrapState).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');

    setTrackedRunId('run-2');
    expect(boundary.canClearPersistedLaunchStateForRun('demo', 'run-2')).toBe(true);
  });

  it('preserves successor bootstrap state when a run-scoped clear loses authority', async () => {
    const launchClearStarted = deferred();
    const launchClearGate = deferred();
    let bootstrapRunId: string | null = 'run-1';
    const clearBootstrapState = vi.fn(async () => {
      bootstrapRunId = null;
    });
    const launchStateStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => {
        launchClearStarted.resolve();
        await launchClearGate.promise;
      }),
    };
    const { boundary, ports, setTrackedRunId } = createBoundary({
      clearBootstrapState,
      launchStateStore,
    });

    const clearing = boundary.clearPersistedLaunchStateNow('demo', { expectedRunId: 'run-1' });
    await launchClearStarted.promise;

    setTrackedRunId('run-2');
    bootstrapRunId = 'run-2';
    launchClearGate.resolve();
    await clearing;

    expect(bootstrapRunId).toBe('run-2');
    expect(ports.clearBootstrapState).not.toHaveBeenCalled();
  });

  it('keeps team-scoped bootstrap clearing for compatibility with unscoped clears', async () => {
    const { boundary, ports } = createBoundary();

    await boundary.clearPersistedLaunchStateNow('demo');

    expect(ports.clearBootstrapState).toHaveBeenCalledWith('demo');
  });

  it('applies both write overlays and updates the last-written run id', async () => {
    const base = snapshot();
    const previous = snapshot({ updatedAt: '2025-12-31T00:00:00.000Z' });
    const evidenceOverlay = snapshot({
      members: {
        Builder: member({ diagnostics: ['secondary evidence'] }),
      },
    });
    const stallOverlay = snapshot({
      teamLaunchState: 'partial_failure',
      members: {
        Builder: member({ diagnostics: ['secondary evidence', 'bootstrap stall'] }),
      },
    });
    const { boundary, ports, setCurrentSnapshot, setTrackedRunId } = createBoundary({
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async () => evidenceOverlay),
      applyBootstrapStallOverlay: vi.fn(() => stallOverlay),
    });
    setCurrentSnapshot(previous);

    const result = await boundary.writeLaunchStateSnapshotNow('demo', base, { runId: 'run-1' });

    expect(ports.applyOpenCodeSecondaryEvidenceOverlay).toHaveBeenCalledWith({
      teamName: 'demo',
      snapshot: base,
      previousSnapshot: previous,
      metaMembers: [{ name: 'Builder', joinedAt: 1 }],
    });
    expect(ports.applyBootstrapStallOverlay).toHaveBeenCalledWith(evidenceOverlay);
    expect(ports.launchStateStore.write).toHaveBeenCalledWith('demo', stallOverlay);
    expect(result).toEqual({ snapshot: stallOverlay, wrote: true });

    setTrackedRunId('run-2');
    expect(boundary.canClearPersistedLaunchStateForRun('demo', 'run-2')).toBe(false);
  });

  it('returns the previous snapshot on no-op skip when refresh is not due', async () => {
    const previous = snapshot();
    const { boundary, ports, setCurrentSnapshot } = createBoundary({
      areSnapshotsSemanticallyEqual: vi.fn(() => true),
      nowMs: vi.fn(() => Date.parse(at) + refreshMs - 1),
    });

    setCurrentSnapshot(previous);
    await boundary.writeLaunchStateSnapshotNow('demo', previous, { runId: 'run-1' });
    vi.mocked(ports.launchStateStore.write).mockClear();

    const result = await boundary.writeLaunchStateSnapshotNow('demo', snapshot(), {
      allowNoopSkip: true,
      runId: 'run-1',
    });

    expect(result).toEqual({ snapshot: previous, wrote: false });
    expect(ports.launchStateStore.write).not.toHaveBeenCalled();
  });

  it('forces a write when a no-op refresh is due', async () => {
    const previous = snapshot();
    const next = snapshot({ updatedAt: '2026-01-01T00:00:01.000Z' });
    const { boundary, ports, setCurrentSnapshot } = createBoundary({
      areSnapshotsSemanticallyEqual: vi.fn(() => true),
      nowMs: vi.fn(() => Date.parse(at) + refreshMs),
    });

    setCurrentSnapshot(previous);
    await boundary.writeLaunchStateSnapshotNow('demo', previous, { runId: 'run-1' });
    vi.mocked(ports.launchStateStore.write).mockClear();

    const result = await boundary.writeLaunchStateSnapshotNow('demo', next, {
      allowNoopSkip: true,
      runId: 'run-1',
    });

    expect(result).toEqual({ snapshot: next, wrote: true });
    expect(ports.launchStateStore.write).toHaveBeenCalledWith('demo', next);
  });

  it('does not overwrite a successor snapshot when a stale write starts after authority changed', async () => {
    const successorSnapshot = snapshot({ updatedAt: '2026-01-01T00:00:02.000Z' });
    const writtenRunIdByTeam = new Map([['demo', 'run-2']]);
    const { boundary, ports, setCurrentSnapshot, setTrackedRunId } = createBoundary({
      writtenRunIdByTeam,
    });
    setCurrentSnapshot(successorSnapshot);
    setTrackedRunId('run-2');

    const result = await boundary.writeLaunchStateSnapshotNow('demo', snapshot(), {
      runId: 'run-1',
    });

    expect(result).toEqual({ snapshot: successorSnapshot, wrote: false });
    expect(ports.launchStateStore.write).not.toHaveBeenCalled();
    expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
    expect(writtenRunIdByTeam.get('demo')).toBe('run-2');
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[demo] Skipping stale launch-state write for run run-1'
    );
  });

  it('removes a snapshot whose run loses authority while its write is pending', async () => {
    const writeStarted = deferred();
    const writeGate = deferred();
    let persistedSnapshot: PersistedTeamLaunchSnapshot | null = null;
    const launchStateStore = {
      read: vi.fn(async () => persistedSnapshot),
      write: vi.fn(async (_teamName: string, nextSnapshot: PersistedTeamLaunchSnapshot) => {
        writeStarted.resolve();
        await writeGate.promise;
        persistedSnapshot = nextSnapshot;
      }),
      clear: vi.fn(async () => {
        persistedSnapshot = null;
      }),
    };
    const { boundary, ports, setTrackedRunId } = createBoundary({ launchStateStore });

    const writing = boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
    await writeStarted.promise;
    setTrackedRunId('run-2');
    writeGate.resolve();

    await expect(writing).resolves.toMatchObject({ wrote: false });
    expect(persistedSnapshot).toBeNull();
    expect(ports.launchStateStore.clear).toHaveBeenCalledWith('demo');
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');
    expect(boundary.getWrittenRunIdByTeam().has('demo')).toBe(false);
  });

  it('serializes queued operations and only removes the current queue entry', async () => {
    const { boundary } = createBoundary();
    const events: string[] = [];
    const firstGate = deferred();
    const secondGate = deferred();

    const first = boundary.enqueue('demo', async () => {
      events.push('first-start');
      await firstGate.promise;
      events.push('first-end');
      throw new Error('first failed');
    });
    const firstResult = first.catch((error: unknown) => error);
    const second = boundary.enqueue('demo', async () => {
      events.push('second-start');
      await secondGate.promise;
      events.push('second-end');
      return 'second';
    });

    await flushMicrotasks();
    expect(events).toEqual(['first-start']);

    firstGate.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);

    const third = boundary.enqueue('demo', async () => {
      events.push('third-start');
      return 'third';
    });
    await flushMicrotasks();
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);

    secondGate.resolve();

    await expect(second).resolves.toBe('second');
    await expect(third).resolves.toBe('third');
    await expect(firstResult).resolves.toBeInstanceOf(Error);
    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
      'third-start',
    ]);
  });
});
