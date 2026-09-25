import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import { applyOpenCodeSecondaryEvidenceOverlay } from '../TeamProvisioningLaunchStateReconciliation';
import {
  createTeamProvisioningLaunchStateStoreBoundaryFromService,
  type LaunchStatePublicationOptions,
  TeamProvisioningLaunchStateStoreBoundary,
  type TeamProvisioningLaunchStateStoreBoundaryPorts,
  type TeamProvisioningLaunchStateStoreBoundaryServiceHost,
} from '../TeamProvisioningLaunchStateStoreBoundary';

import type { OpenCodeRuntimeLaneIndexEntry } from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
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
  setTrackedRunId(runId: string | null | undefined): void;
} {
  let currentSnapshot: PersistedTeamLaunchSnapshot | null = null;
  let trackedRunId: string | null | undefined = 'run-1';
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
      getTrackedRunId: vi.fn<() => string | null>(() => 'run-1'),
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

    expect(launchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(nextSnapshot),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
    expect(defaultLaunchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(nextSnapshot),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
    expect(launchStateStore.clear).toHaveBeenCalledWith('demo', expect.any(Function), undefined);
    expect(defaultLaunchStateStore.clear).toHaveBeenCalledWith(
      'demo',
      expect.any(Function),
      undefined
    );
    expect(clearBootstrapState).toHaveBeenCalledWith('demo');
    expect(invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');

    service.getTrackedRunId.mockReturnValue(null);
    clearBootstrapState.mockClear();
    const reopenedBoundary = createTeamProvisioningLaunchStateStoreBoundaryFromService(service, {
      areSnapshotsSemanticallyEqual: () => false,
      clearBootstrapState,
      logDebug: vi.fn(),
      nowMs: Date.now,
    });
    await reopenedBoundary.clearPersistedLaunchStateNow('demo', { expectedRunId: 'persisted-run' });
    expect(launchStateStore.clear).toHaveBeenLastCalledWith(
      'demo',
      expect.any(Function),
      'persisted-run'
    );
    expect(defaultLaunchStateStore.clear).toHaveBeenLastCalledWith(
      'demo',
      expect.any(Function),
      'persisted-run'
    );
    expect(clearBootstrapState).not.toHaveBeenCalled();
  });

  it('notifies readers only after both service stores confirm the publication', async () => {
    const nextSnapshot = snapshot();
    const defaultWriteStarted = deferred();
    const defaultWriteGate = deferred();
    const launchStateStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const defaultLaunchStateStore = {
      write: vi.fn(async () => {
        defaultWriteStarted.resolve();
        await defaultWriteGate.promise;
      }),
      clear: vi.fn(async () => undefined),
    };
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
      clearBootstrapState: vi.fn(async () => undefined),
      logDebug: vi.fn(),
      nowMs: vi.fn(() => Date.parse(at)),
    });

    const publishing = boundary.writeLaunchStateSnapshot('demo', nextSnapshot);
    await defaultWriteStarted.promise;

    // The injected view must wait for durable publication.
    expect(launchStateStore.write).not.toHaveBeenCalled();
    expect(defaultLaunchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(nextSnapshot),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
    expect(invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();

    defaultWriteGate.resolve();
    await expect(publishing).resolves.toEqual(nextSnapshot);
    expect(invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');
  });

  it('clears the default store after an injected store clear fails and preserves the error', async () => {
    const clearError = new Error('injected clear failed');
    const clearOrder: string[] = [];
    const launchStateStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => {
        clearOrder.push('injected');
        throw clearError;
      }),
    };
    const defaultLaunchStateStore = {
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => {
        clearOrder.push('default');
      }),
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

    await expect(boundary.clearPersistedLaunchStateNow('demo')).rejects.toBe(clearError);

    expect(clearOrder).toEqual(['injected', 'default']);
    expect(defaultLaunchStateStore.clear).toHaveBeenCalledWith(
      'demo',
      expect.any(Function),
      undefined
    );
    expect(clearBootstrapState).not.toHaveBeenCalled();
    expect(invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
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

    expect(ports.launchStateStore.clear).toHaveBeenCalledWith(
      'demo',
      expect.any(Function),
      undefined
    );
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
    expect(ports.launchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(stallOverlay),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
    expect(result).toMatchObject({ snapshot: stallOverlay, wrote: true });

    setTrackedRunId('run-2');
    expect(boundary.canClearPersistedLaunchStateForRun('demo', 'run-2')).toBe(false);
  });

  it('does not attach durable evidence from an old lane run to an unbound replacement lane', async () => {
    const replacementSnapshot = snapshot({
      members: {
        Builder: member({
          providerId: 'opencode',
          laneId: 'secondary:opencode:Builder',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        }),
      },
    });
    const { boundary, ports } = createBoundary({
      applyOpenCodeSecondaryEvidenceOverlay: (params) =>
        applyOpenCodeSecondaryEvidenceOverlay(params, {
          readLaneIndex: vi.fn(async () => ({
            lanes: {
              'secondary:opencode:Builder': {
                laneId: 'secondary:opencode:Builder',
                state: 'active' as const,
                updatedAt: at,
              },
            },
          })),
          readCommittedBootstrapSessionEvidence: vi.fn(async () => ({
            committed: true,
            activeRunId: 'old-lane-run',
            sessions: [
              {
                id: 'old-session',
                teamName: 'demo',
                memberName: 'Builder',
                laneId: 'secondary:opencode:Builder',
                runId: 'old-lane-run',
                observedAt: at,
                source: 'runtime_bootstrap_checkin' as const,
              },
            ],
            diagnostics: [],
          })),
          hasBootstrapCheckinTombstone: vi.fn(async () => false),
          nowIso: () => at,
        }),
    });

    const result = await boundary.writeLaunchStateSnapshotNow('demo', replacementSnapshot, {
      runId: 'run-1',
    });

    expect(result.snapshot).toMatchObject(replacementSnapshot);
    expect(result.snapshot.teamLaunchState).toBe('partial_pending');
    expect(result.snapshot.members.Builder).toMatchObject({
      launchState: 'starting',
      runtimeAlive: false,
      bootstrapConfirmed: false,
    });
    expect(result.snapshot.members.Builder.runtimeRunId).toBeUndefined();
    expect(result.snapshot.members.Builder.runtimeSessionId).toBeUndefined();
    expect(ports.launchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(replacementSnapshot),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
  });

  it.each([
    {
      label: 'lane index entry was removed',
      laneIndex: { lanes: {} as Record<string, OpenCodeRuntimeLaneIndexEntry> },
      activeRunId: 'old-lane-run',
    },
    {
      label: 'manifest active run was cleared',
      laneIndex: {
        lanes: {
          'secondary:opencode:Builder': {
            laneId: 'secondary:opencode:Builder',
            state: 'active' as const,
            updatedAt: at,
          },
        },
      },
      activeRunId: null,
    },
  ])(
    'does not resurrect stopped lane evidence when the $label',
    async ({ laneIndex, activeRunId }) => {
      const stoppedSnapshot = snapshot({
        members: {
          Builder: member({
            providerId: 'opencode',
            laneId: 'secondary:opencode:Builder',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            runtimeRunId: 'old-lane-run',
            runtimeSessionId: 'old-session',
          }),
        },
      });

      const overlaid = await applyOpenCodeSecondaryEvidenceOverlay(
        { teamName: 'demo', snapshot: stoppedSnapshot },
        {
          readLaneIndex: vi.fn(async () => laneIndex),
          readCommittedBootstrapSessionEvidence: vi.fn(async () => ({
            committed: true,
            activeRunId,
            sessions: [
              {
                id: 'old-session',
                teamName: 'demo',
                memberName: 'Builder',
                laneId: 'secondary:opencode:Builder',
                runId: 'old-lane-run',
                observedAt: at,
                source: 'runtime_bootstrap_checkin' as const,
              },
            ],
            diagnostics: [],
          })),
          hasBootstrapCheckinTombstone: vi.fn(async () => false),
          nowIso: () => at,
        }
      );

      expect(overlaid).toMatchObject(stoppedSnapshot);
      expect(overlaid.teamLaunchState).toBe('partial_pending');
      expect(overlaid.members.Builder).toMatchObject({
        launchState: 'starting',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        runtimeRunId: 'old-lane-run',
        runtimeSessionId: 'old-session',
      });
    }
  );

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

    expect(result).toEqual({
      snapshot: { ...previous, publicationRunId: 'run-1' },
      wrote: false,
    });
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

    expect(result).toMatchObject({ snapshot: next, wrote: true });
    expect(ports.launchStateStore.write).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining(next),
      expect.objectContaining({ isAuthorized: expect.any(Function) })
    );
  });

  it.each([null, undefined])(
    'writes run-scoped snapshots when the tracked run id is %s',
    async (trackedRunId) => {
      const next = snapshot();
      const { boundary, ports, setTrackedRunId } = createBoundary();
      setTrackedRunId(trackedRunId);

      const result = await boundary.writeLaunchStateSnapshotNow('demo', next, {
        runId: 'run-1',
      });

      expect(result).toMatchObject({ snapshot: next, wrote: true });
      expect(ports.launchStateStore.write).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining(next),
        expect.objectContaining({ isAuthorized: expect.any(Function) })
      );
      expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
      expect(boundary.getWrittenRunIdByTeam().get('demo')).toBe('run-1');
      expect(ports.logDebug).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined])(
    'rejects an unobserved strictly tracked snapshot when the tracked run id is %s',
    async (trackedRunId) => {
      const previousSnapshot = snapshot({ updatedAt: '2026-01-01T00:00:01.000Z' });
      const nextSnapshot = snapshot();
      const { boundary, ports, setCurrentSnapshot, setTrackedRunId } = createBoundary();
      setCurrentSnapshot(previousSnapshot);
      setTrackedRunId(trackedRunId);

      const result = await boundary.writeLaunchStateSnapshotNow('demo', nextSnapshot, {
        requireTrackedRun: true,
        runId: 'run-1',
      });

      expect(result).toEqual({ snapshot: previousSnapshot, wrote: false });
      expect(ports.launchStateStore.write).not.toHaveBeenCalled();
      expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
      expect(boundary.getWrittenRunIdByTeam().has('demo')).toBe(false);
      expect(ports.logDebug).toHaveBeenCalledWith(
        '[demo] Skipping stale launch-state write for run run-1'
      );
    }
  );

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

  it('does not persist a run snapshot after tracking has been cleared', async () => {
    const previousSnapshot = snapshot({ updatedAt: '2026-01-01T00:00:01.000Z' });
    const nextSnapshot = snapshot();
    const { boundary, ports, setTrackedRunId } = createBoundary();
    await boundary.writeLaunchStateSnapshotNow('demo', previousSnapshot, {
      runId: 'run-1',
    });
    vi.mocked(ports.launchStateStore.write).mockClear();
    vi.mocked(ports.logDebug).mockClear();
    setTrackedRunId(undefined);

    const result = await boundary.writeLaunchStateSnapshotNow('demo', nextSnapshot, {
      runId: 'run-1',
    });

    expect(result).toEqual({
      snapshot: { ...previousSnapshot, publicationRunId: 'run-1' },
      wrote: false,
    });
    expect(ports.launchStateStore.write).not.toHaveBeenCalled();
    expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[demo] Skipping stale launch-state write for run run-1'
    );
  });

  it('removes a pending snapshot write after run tracking has been cleared', async () => {
    const writeStarted = deferred();
    const writeGate = deferred();
    let persistedSnapshot: PersistedTeamLaunchSnapshot | null = null;
    const launchStateStore = {
      read: vi.fn(async () => persistedSnapshot),
      write: vi.fn(
        async (
          _teamName: string,
          nextSnapshot: PersistedTeamLaunchSnapshot,
          options?: LaunchStatePublicationOptions
        ) => {
          writeStarted.resolve();
          await writeGate.promise;
          if (options?.isAuthorized?.() === false) return false;
          persistedSnapshot = nextSnapshot;
        }
      ),
      clear: vi.fn(async () => {
        persistedSnapshot = null;
      }),
    };
    const { boundary, ports, setTrackedRunId } = createBoundary({ launchStateStore });

    const writing = boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
    await writeStarted.promise;
    setTrackedRunId(undefined);
    writeGate.resolve();

    await expect(writing).resolves.toMatchObject({ wrote: false });
    expect(persistedSnapshot).toBeNull();
    expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
    expect(boundary.getWrittenRunIdByTeam().has('demo')).toBe(false);
  });

  it('preserves previous truth when the store suppresses a stale publication', async () => {
    const newerSnapshot = snapshot({ updatedAt: '2026-01-01T00:00:05.000Z' });
    const writeStarted = deferred();
    const writeGate = deferred();
    let persistedSnapshot: PersistedTeamLaunchSnapshot | null = newerSnapshot;
    const launchStateStore = {
      read: vi.fn(async () => persistedSnapshot),
      write: vi.fn(
        async (
          _teamName: string,
          nextSnapshot: PersistedTeamLaunchSnapshot,
          options?: LaunchStatePublicationOptions
        ) => {
          if (nextSnapshot === newerSnapshot) {
            if (options?.isAuthorized?.() === false) return false;
            persistedSnapshot = nextSnapshot;
            return;
          }
          writeStarted.resolve();
          await writeGate.promise;
          if (options?.isAuthorized?.() === false) return false;
          persistedSnapshot = nextSnapshot;
        }
      ),
      clear: vi.fn(async () => {
        persistedSnapshot = null;
      }),
    };
    const { boundary, ports, setTrackedRunId } = createBoundary({ launchStateStore });

    const writing = boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
    await writeStarted.promise;
    setTrackedRunId(undefined);
    writeGate.resolve();

    await expect(writing).resolves.toEqual({ snapshot: newerSnapshot, wrote: false });
    expect(persistedSnapshot).toEqual(newerSnapshot);
    expect(ports.launchStateStore.clear).not.toHaveBeenCalled();
    expect(boundary.getWrittenRunIdByTeam().has('demo')).toBe(false);
  });

  it('never queues a compensating write over a later stop or successor', async () => {
    // Store rollback runs within publication serialization; the boundary must not
    // enqueue a second mutation after another owner or Stop may have committed.
    const previousSnapshot = snapshot({ updatedAt: '2026-01-01T00:00:05.000Z' });
    const writeStarted = deferred();
    const writeGate = deferred();
    const launchStateStore = {
      read: vi.fn(async () => previousSnapshot),
      write: vi.fn(async (_teamName: string, nextSnapshot: PersistedTeamLaunchSnapshot) => {
        if (nextSnapshot === previousSnapshot) return;
        writeStarted.resolve();
        await writeGate.promise;
      }),
      clear: vi.fn(async () => undefined),
    };
    const { boundary, setTrackedRunId } = createBoundary({ launchStateStore });

    const writing = boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
    await writeStarted.promise;
    setTrackedRunId(undefined);
    writeGate.resolve();

    await expect(writing).resolves.toMatchObject({ wrote: false });
    expect(launchStateStore.write).toHaveBeenCalledTimes(1);
    expect(launchStateStore.clear).not.toHaveBeenCalled();
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

  describe('enqueue coalescing', () => {
    it('merges a request into a pending, not-yet-started tail with the same coalesce key', async () => {
      const { boundary } = createBoundary();
      const runObj = {};
      const gate = deferred<string>();
      let executions = 0;
      const op = () => {
        executions += 1;
        return gate.promise;
      };
      const blocker = deferred();
      boundary.enqueue('demo', () => blocker.promise);
      const first = boundary.enqueue('demo', op, { coalesce: { subject: runObj, key: 'k' } });
      const second = boundary.enqueue('demo', op, { coalesce: { subject: runObj, key: 'k' } });
      expect(second).toBe(first);
      blocker.resolve();
      await flushMicrotasks();
      expect(executions).toBe(1);
      gate.resolve('result');
      await expect(first).resolves.toBe('result');
      await expect(second).resolves.toBe('result');
    });

    it('does not merge into a tail that has already started executing', async () => {
      const { boundary } = createBoundary();
      const runObj = {};
      const startedGate = deferred<string>();
      let executions = 0;
      const first = boundary.enqueue(
        'demo',
        async () => {
          executions += 1;
          return startedGate.promise;
        },
        { coalesce: { subject: runObj, key: 'k' } }
      );
      await flushMicrotasks();
      const second = boundary.enqueue(
        'demo',
        async () => {
          executions += 1;
          return 'second';
        },
        { coalesce: { subject: runObj, key: 'k' } }
      );
      expect(second).not.toBe(first);
      startedGate.resolve('first');
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
      expect(executions).toBe(2);
    });

    it('only ever compares against the tail — an intervening uncoalesced operation forces separate execution', async () => {
      const { boundary } = createBoundary();
      const runObj = {};
      const blocker = deferred();
      boundary.enqueue('demo', () => blocker.promise);
      const order: string[] = [];
      const a = boundary.enqueue(
        'demo',
        async () => {
          order.push('a');
          return 'a';
        },
        { coalesce: { subject: runObj, key: 'k' } }
      );
      const x = boundary.enqueue('demo', async () => {
        order.push('x');
        return 'x';
      });
      const a2 = boundary.enqueue(
        'demo',
        async () => {
          order.push('a2');
          return 'a2';
        },
        { coalesce: { subject: runObj, key: 'k' } }
      );
      expect(a2).not.toBe(a);
      blocker.resolve();
      await expect(a).resolves.toBe('a');
      await expect(x).resolves.toBe('x');
      await expect(a2).resolves.toBe('a2');
      expect(order).toEqual(['a', 'x', 'a2']);
    });

    it('does not merge across different subjects or different keys', async () => {
      const { boundary } = createBoundary();
      const blocker = deferred();
      boundary.enqueue('demo', () => blocker.promise);
      const runA = {};
      const runB = {};
      let executions = 0;
      const op = () => {
        executions += 1;
        return Promise.resolve('x');
      };
      const p1 = boundary.enqueue('demo', op, { coalesce: { subject: runA, key: 'k' } });
      const p2 = boundary.enqueue('demo', op, { coalesce: { subject: runB, key: 'k' } });
      const p3 = boundary.enqueue('demo', op, { coalesce: { subject: runA, key: 'k2' } });
      blocker.resolve();
      await Promise.all([p1, p2, p3]);
      expect(executions).toBe(3);
    });

    it('propagates a shared rejection to both merged callers without blocking what follows', async () => {
      const { boundary } = createBoundary();
      const runObj = {};
      const blocker = deferred();
      boundary.enqueue('demo', () => blocker.promise);
      const failure = new Error('boom');
      const op = () => Promise.reject(failure);
      const first = boundary.enqueue('demo', op, { coalesce: { subject: runObj, key: 'k' } });
      const second = boundary.enqueue('demo', op, { coalesce: { subject: runObj, key: 'k' } });
      const after = boundary.enqueue('demo', async () => 'after');
      blocker.resolve();
      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
      await expect(after).resolves.toBe('after');
    });
  });

  describe('whenIdle / isIdle', () => {
    it('reports idle and resolves immediately when nothing is queued', async () => {
      const { boundary } = createBoundary();
      expect(boundary.isIdle('demo')).toBe(true);
      await expect(boundary.whenIdle('demo')).resolves.toBeUndefined();
    });

    it('does not resolve while an operation is running, and resolves once it settles', async () => {
      const { boundary } = createBoundary();
      const gate = deferred();
      const op = boundary.enqueue('demo', () => gate.promise);
      expect(boundary.isIdle('demo')).toBe(false);
      let resolved = false;
      void boundary.whenIdle('demo').then(() => {
        resolved = true;
      });
      await flushMicrotasks();
      expect(resolved).toBe(false);
      gate.resolve();
      await op;
      await flushMicrotasks();
      expect(resolved).toBe(true);
      expect(boundary.isIdle('demo')).toBe(true);
    });

    it('stays unresolved when another operation is appended before the current one drains', async () => {
      const { boundary } = createBoundary();
      const gate1 = deferred();
      const op1 = boundary.enqueue('demo', () => gate1.promise);
      let resolved = false;
      void boundary.whenIdle('demo').then(() => {
        resolved = true;
      });
      const gate2 = deferred();
      const op2 = boundary.enqueue('demo', () => gate2.promise);
      gate1.resolve();
      await op1;
      await flushMicrotasks();
      expect(resolved).toBe(false);
      gate2.resolve();
      await op2;
      await flushMicrotasks();
      expect(resolved).toBe(true);
    });

    it('resolves after the last operation settles even when it rejects', async () => {
      const { boundary } = createBoundary();
      await boundary
        .enqueue('demo', () => Promise.reject(new Error('boom')))
        .catch(() => undefined);
      await flushMicrotasks();
      expect(boundary.isIdle('demo')).toBe(true);
      await expect(boundary.whenIdle('demo')).resolves.toBeUndefined();
    });

    it('does not delay whenIdle for a different, unrelated team', async () => {
      const { boundary } = createBoundary();
      const gate = deferred();
      boundary.enqueue('busy-team', () => gate.promise);
      await expect(boundary.whenIdle('demo')).resolves.toBeUndefined();
      gate.resolve();
    });
  });

  describe('metaMembers write option', () => {
    it('skips reading members meta when metaMembers is provided, and forwards it to the overlay', async () => {
      const { boundary, ports } = createBoundary();
      const providedMembers = [{ name: 'Provided', joinedAt: 2 }];
      await boundary.writeLaunchStateSnapshotNow('demo', snapshot(), {
        runId: 'run-1',
        metaMembers: providedMembers,
      });
      expect(ports.membersMetaStore.getMembers).not.toHaveBeenCalled();
      expect(ports.applyOpenCodeSecondaryEvidenceOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ metaMembers: providedMembers })
      );
    });

    it('reads members meta exactly once when metaMembers is not provided', async () => {
      const { boundary, ports } = createBoundary();
      await boundary.writeLaunchStateSnapshotNow('demo', snapshot(), { runId: 'run-1' });
      expect(ports.membersMetaStore.getMembers).toHaveBeenCalledTimes(1);
    });
  });
});
