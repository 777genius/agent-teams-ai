import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { describe, expect, it, vi } from 'vitest';

import { getTeamLaunchFreshnessPath } from '../../TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  getTeamLaunchStatePath,
  getTeamLaunchSummaryPath,
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '../../TeamLaunchStateStore';
import { TeamProvisioningLaunchStateStoreBoundary } from '../TeamProvisioningLaunchStateStoreBoundary';
import {
  type ReconcilePersistedLaunchStatePorts,
  reconcilePersistedLaunchStateWithPorts,
} from '../TeamProvisioningPersistedLaunchReconciliation';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

const at = '2026-08-27T18:08:00.000Z';

function member(overrides: Partial<PersistedTeamLaunchMemberState> = {}) {
  return {
    name: 'Builder',
    launchState: 'confirmed_alive' as const,
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    livenessKind: 'confirmed_bootstrap' as const,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function cleanSnapshot(): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: ['Builder'],
    launchPhase: 'finished',
    members: { Builder: member() },
    updatedAt: at,
  });
}

function createBoundary(input: {
  trackedRunId: string | null;
  stored: PersistedTeamLaunchSnapshot | null;
  store?: TeamLaunchStateStore;
}) {
  const state = { snapshot: input.stored };
  const clearBootstrapState = vi.fn(async () => undefined);
  const boundary = new TeamProvisioningLaunchStateStoreBoundary({
    launchStateStore: input.store ?? {
      read: async () => state.snapshot,
      write: async (_teamName, snapshot) => {
        state.snapshot = snapshot;
      },
      clear: async () => {
        state.snapshot = null;
      },
    },
    membersMetaStore: { getMembers: async () => [] },
    getTrackedRunId: () => input.trackedRunId,
    applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => snapshot,
    applyBootstrapStallOverlay: (snapshot) => snapshot,
    areSnapshotsSemanticallyEqual: () => false,
    clearBootstrapState,
    invalidateRuntimeSnapshotCaches: vi.fn(),
    logDebug: vi.fn(),
    nowMs: () => Date.parse(at),
  });
  return { boundary, state, clearBootstrapState };
}

function createReconcilePorts(
  overrides: Partial<ReconcilePersistedLaunchStatePorts> = {}
): ReconcilePersistedLaunchStatePorts {
  return {
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    readLaunchState: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => []),
    recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => null),
    applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async ({ snapshot }) => snapshot),
    applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn((snapshot) => snapshot),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, snapshot) => snapshot),
    clearPersistedLaunchState: vi.fn(async () => undefined),
    applyBootstrapTranscriptEvidenceOverlay: vi.fn(async (snapshot) => snapshot),
    needsBootstrapAcceptanceReconcile: vi.fn(() => false),
    needsConfirmedBootstrapDiagnosticReconcile: vi.fn(() => false),
    cleanConfirmedBootstrapRuntimeDiagnostics: vi.fn((snapshot) => snapshot),
    hasBootstrapTranscriptLaunchReconcileOutcome: vi.fn(async () => false),
    choosePreferredLaunchSnapshot: vi.fn(
      (bootstrapSnapshot, persistedSnapshot) => bootstrapSnapshot ?? persistedSnapshot
    ),
    createDefaultLaunchReconcileConfigMembers: vi.fn(() => ({
      configMembers: new Set<string>(),
      configBootstrapRunIds: new Map<string, string>(),
      leadName: 'team-lead',
    })),
    parseLaunchReconcileConfigMembers: vi.fn(() => ({
      configMembers: new Set<string>(),
      configBootstrapRunIds: new Map<string, string>(),
      leadName: 'team-lead',
    })),
    getTeamsBasePath: vi.fn(() => '/teams'),
    pathJoin: vi.fn((...parts) => parts.join('/')),
    readRegularFileUtf8: vi.fn(async () => null),
    teamJsonReadTimeoutMs: 5_000,
    teamConfigMaxBytes: 10 * 1024 * 1024,
    readLeadInboxMessagesForLaunchReconcile: vi.fn(async () => []),
    hasLeadInboxLaunchReconcileHeartbeat: vi.fn(() => false),
    getLiveTeamAgentRuntimeMetadata: vi.fn(
      async () =>
        new Map([['Builder', { alive: true, livenessKind: 'confirmed_bootstrap' as const }]])
    ),
    getPersistedLaunchMemberNames: vi.fn((snapshot) => [...snapshot.expectedMembers]),
    selectLatestLeadInboxLaunchReconcileMessage: vi.fn(() => null),
    findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
    findBootstrapTranscriptOutcome: vi.fn(async () => null),
    readProcessBootstrapTransportSummary: vi.fn(async () => null),
    applyProcessBootstrapTransportOverlay: vi.fn(({ member: current }) => current),
    nowIso: vi.fn(() => at),
    nowMs: vi.fn(() => Date.parse(at)),
    ...overrides,
  };
}

/** Records what the reconcile asked the persistence layer to do, in order. */
function createPersistedWriteLog(boundary: TeamProvisioningLaunchStateStoreBoundary): {
  persistedWrites: string[];
  ports: Pick<
    ReconcilePersistedLaunchStatePorts,
    'writeLaunchStateSnapshot' | 'clearPersistedLaunchState'
  >;
} {
  const persistedWrites: string[] = [];
  return {
    persistedWrites,
    ports: {
      writeLaunchStateSnapshot: async (teamName, snapshot, options) => {
        persistedWrites.push(`write:${options?.runId ?? 'unscoped'}`);
        return boundary.writeLaunchStateSnapshot(teamName, snapshot, options);
      },
      clearPersistedLaunchState: async (teamName, options) => {
        persistedWrites.push(`clear:${options?.expectedRunId ?? 'unscoped'}`);
        await boundary.clearPersistedLaunchState(teamName, options);
      },
    },
  };
}

describe('persisted launch reconcile run scope', () => {
  it('passes its run id to every write and clear', async () => {
    const ports = createReconcilePorts({ readLaunchState: vi.fn(async () => cleanSnapshot()) });

    await reconcilePersistedLaunchStateWithPorts('demo', ports, { expectedRunId: 'run-2' });

    expect(ports.clearPersistedLaunchState).toHaveBeenCalledWith('demo', {
      expectedRunId: 'run-2',
    });
  });

  it('takes the run id from the tracked-run port when the caller does not supply one', async () => {
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanSnapshot()),
      getTrackedRunId: vi.fn(() => 'run-3'),
    });

    await reconcilePersistedLaunchStateWithPorts('demo', ports);

    expect(ports.clearPersistedLaunchState).toHaveBeenCalledWith('demo', {
      expectedRunId: 'run-3',
    });
  });

  it('does not clear a successor run state, and leaves bootstrap state alone', async () => {
    const stored = cleanSnapshot();
    const { boundary, state, clearBootstrapState } = createBoundary({
      trackedRunId: 'run-successor',
      stored,
    });
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanSnapshot()),
      clearPersistedLaunchState: (teamName, options) =>
        boundary.clearPersistedLaunchState(teamName, options),
    });

    await reconcilePersistedLaunchStateWithPorts('demo', ports, { expectedRunId: 'run-stale' });

    expect(state.snapshot).toBe(stored);
    expect(clearBootstrapState).not.toHaveBeenCalled();
  });

  it('still wipes bootstrap state on an unscoped clear, which is why the scope matters', async () => {
    const { boundary, state, clearBootstrapState } = createBoundary({
      trackedRunId: 'run-successor',
      stored: cleanSnapshot(),
    });
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanSnapshot()),
      clearPersistedLaunchState: (teamName, options) =>
        boundary.clearPersistedLaunchState(teamName, options),
    });

    await reconcilePersistedLaunchStateWithPorts('demo', ports);

    expect(state.snapshot).toBeNull();
    expect(clearBootstrapState).toHaveBeenCalledTimes(1);
  });

  it('records no clear at all once the run that asked for it has been superseded', async () => {
    const stored = cleanSnapshot();
    const { boundary } = createBoundary({ trackedRunId: 'run-successor', stored });
    const { persistedWrites, ports: writeLogPorts } = createPersistedWriteLog(boundary);
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanSnapshot()),
      ...writeLogPorts,
    });

    await reconcilePersistedLaunchStateWithPorts('demo', ports, { expectedRunId: 'run-stale' });

    expect(persistedWrites).toEqual(['clear:run-stale']);
    expect(boundary.canClearPersistedLaunchStateForRun('demo', 'run-stale')).toBe(false);
  });

  it('behaves exactly as an unscoped reconcile when the tracked-run port answers null', async () => {
    const { boundary, state, clearBootstrapState } = createBoundary({
      trackedRunId: null,
      stored: cleanSnapshot(),
    });
    const { persistedWrites, ports: writeLogPorts } = createPersistedWriteLog(boundary);
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanSnapshot()),
      getTrackedRunId: vi.fn(() => null),
      ...writeLogPorts,
    });

    await reconcilePersistedLaunchStateWithPorts('demo', ports);

    expect(persistedWrites).toEqual(['clear:unscoped']);
    expect(state.snapshot).toBeNull();
    expect(clearBootstrapState).toHaveBeenCalledTimes(1);
  });

  it('lets the launch-state boundary reject a stale scoped write', async () => {
    const stored = cleanSnapshot();
    const { boundary, state } = createBoundary({ trackedRunId: 'run-successor', stored });
    const written = await boundary.writeLaunchStateSnapshot(
      'demo',
      { ...stored, updatedAt: '2026-08-27T18:09:00.000Z' },
      { runId: 'run-stale' }
    );

    expect(written).toBe(stored);
    expect(state.snapshot).toBe(stored);
  });
});

describe('untracked persisted launch cleanup with the real publication store', () => {
  it.each([
    'unchanged',
    'successor',
    'admitted-successor',
    'queued-successor',
    'freshness-successor',
    'unreadable-freshness',
  ])('clears only the observed publication: %s', async (transition) => {
    const temp = await mkdtemp('/tmp/untracked-launch-clear-');
    setClaudeBasePathOverride(temp);
    let release: (() => void) | undefined;
    let publication: Promise<unknown> | undefined;
    try {
      await mkdir(path.join(getTeamsBasePath(), 'demo'), { recursive: true });
      const original = {
        ...cleanSnapshot(),
        publicationRunId: 'persisted-run',
      };
      let store = new TeamLaunchStateStore();
      await store.beginLaunch('demo', 'persisted-run', ['Builder'], () => true);
      await store.write('demo', original, { runId: 'persisted-run' });
      store = new TeamLaunchStateStore(); // Simulate restart with no in-memory run tracking.
      const { boundary, clearBootstrapState } = createBoundary({
        trackedRunId: null,
        stored: null,
        store,
      });
      const successor = { ...original, publicationRunId: 'successor-run' };
      const ports = createReconcilePorts({
        getTrackedRunId: () => null,
        readLaunchState: () => store.read('demo'),
        clearPersistedLaunchState: async (teamName, options) => {
          if (transition === 'successor' || transition === 'admitted-successor') {
            await store.beginLaunch('demo', 'successor-run', ['Builder'], () => true);
            if (transition === 'successor')
              await store.write('demo', successor, { runId: 'successor-run' });
          }
          if (transition === 'freshness-successor')
            await writeFile(
              getTeamLaunchFreshnessPath('demo'),
              JSON.stringify({
                version: 1,
                teamName: 'demo',
                kind: 'launch',
                runId: 'successor-run',
              })
            );
          if (transition === 'unreadable-freshness')
            await writeFile(getTeamLaunchFreshnessPath('demo'), '{broken');
          if (transition === 'queued-successor') {
            let entered!: () => void;
            const started = new Promise<void>((resolve) => {
              entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            publication = withTeamLaunchStatePublicationLock('demo', async () => {
              entered();
              await gate;
              // Simulate a publication already ahead of the cleanup in the shared queue.
              await writeFile(getTeamLaunchStatePath('demo'), JSON.stringify(successor));
              await writeFile(getTeamLaunchSummaryPath('demo'), JSON.stringify(successor.summary));
              await writeFile(
                getTeamLaunchFreshnessPath('demo'),
                JSON.stringify({
                  version: 1,
                  teamName: 'demo',
                  kind: 'launch',
                  runId: 'successor-run',
                })
              );
            });
            await started;
          }
          const clearing = boundary.clearPersistedLaunchState(teamName, options);
          // Let the boundary admit the clear before the queued publication completes.
          await Promise.resolve();
          await Promise.resolve();
          release?.();
          await clearing;
        },
      });
      const reconcile = reconcilePersistedLaunchStateWithPorts('demo', ports);
      if (transition === 'unreadable-freshness') await expect(reconcile).rejects.toThrow();
      else await reconcile;
      if (transition === 'unchanged') {
        expect(await store.read('demo')).toBeNull();
        await expect(readFile(getTeamLaunchSummaryPath('demo'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(await store.read('demo')).toMatchObject({
          publicationRunId:
            transition.includes('successor') && transition !== 'freshness-successor'
              ? 'successor-run'
              : 'persisted-run',
        });
        await expect(readFile(getTeamLaunchSummaryPath('demo'))).resolves.toBeDefined();
      }
      expect(clearBootstrapState).not.toHaveBeenCalled();
    } finally {
      release?.();
      await publication;
      setClaudeBasePathOverride(null);
      await rm(temp, { recursive: true, force: true });
    }
  });
});
