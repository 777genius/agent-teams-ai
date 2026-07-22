import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import { type TeamProvisioningPersistedLaunchReconcilePortsInput } from '../TeamProvisioningPersistedLaunchReconcilePorts';
import {
  TeamProvisioningPersistenceReconcileFacade,
  type TeamProvisioningPersistenceReconcileFacadePorts,
  type TeamProvisioningPersistenceReconcileRun,
} from '../TeamProvisioningPersistenceReconcileFacade';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';

interface TestRun extends TeamProvisioningPersistenceReconcileRun {
  startedAt: string;
}

function member(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function snapshot(input: {
  members: Record<string, PersistedTeamLaunchMemberState>;
  expectedMembers?: readonly string[];
  updatedAt?: string;
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: input.expectedMembers ?? Object.keys(input.members),
    launchPhase: 'active',
    members: input.members,
    updatedAt: input.updatedAt ?? at,
  });
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    teamName: 'demo',
    runId: 'run-1',
    isLaunch: true,
    provisioningComplete: false,
    startedAt: at,
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningPersistenceReconcileFacadePorts<TestRun>> = {}
): TeamProvisioningPersistenceReconcileFacadePorts<TestRun> {
  const launchStateStoreBoundary: TeamProvisioningPersistenceReconcileFacadePorts<TestRun>['launchStateStoreBoundary'] =
    {
      clearPersistedLaunchState: vi.fn(async () => undefined),
      canClearPersistedLaunchStateForRun: vi.fn(() => true),
      clearPersistedLaunchStateNow: vi.fn(async () => undefined),
      writeLaunchStateSnapshot: vi.fn(
        async (_teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot) => launchSnapshot
      ),
      writeLaunchStateSnapshotNow: vi.fn(
        async (_teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot) => ({
          snapshot: launchSnapshot,
          wrote: true,
        })
      ),
      isLaunchStateNoopRefreshDue: vi.fn(() => false),
      enqueue: vi.fn(<T>(_teamName: string, operation: () => Promise<T>) =>
        operation()
      ) as TeamProvisioningPersistenceReconcileFacadePorts<TestRun>['launchStateStoreBoundary']['enqueue'],
    };
  return {
    launchStateStoreBoundary,
    readLaunchState: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => []),
    overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: vi.fn(async () => undefined),
    buildLiveLaunchSnapshotForRun: vi.fn(() => null),
    invalidateRuntimeSnapshotCaches: vi.fn(() => undefined),
    reconcile: {
      recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => null),
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(
        async (input: { snapshot: PersistedTeamLaunchSnapshot }) => input.snapshot
      ),
      applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn(
        (launchSnapshot: PersistedTeamLaunchSnapshot | null) => launchSnapshot
      ),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      readPersistedRuntimeMembers: vi.fn(() => []),
      resolveExpectedLaunchMemberName: vi.fn(
        (expectedMembers: readonly string[] | undefined, candidateName: string) =>
          expectedMembers?.find((memberName) => memberName === candidateName) ?? null
      ),
      findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
      findBootstrapTranscriptOutcome: vi.fn(async () => null),
    },
    ...overrides,
  };
}

describe('TeamProvisioningPersistenceReconcileFacade', () => {
  it('persists run launch snapshots through the queued boundary and filters removed members', async () => {
    const rawSnapshot = snapshot({
      expectedMembers: ['Builder', 'Removed'],
      members: {
        Builder: member('Builder'),
        Removed: member('Removed'),
      },
    });
    const metaMembers: TeamMember[] = [
      { name: 'Builder', joinedAt: 1 },
      { name: 'Removed', joinedAt: 1, removedAt: 2 },
    ];
    const ports = createPorts({
      readMembersMeta: vi.fn(async () => metaMembers),
      buildLiveLaunchSnapshotForRun: vi.fn(() => rawSnapshot),
    });
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);
    const targetRun = run();

    const result = await facade.persistLaunchStateSnapshot(targetRun, 'finished');

    expect(ports.launchStateStoreBoundary.enqueue).toHaveBeenCalledWith(
      'demo',
      expect.any(Function)
    );
    expect(
      ports.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState
    ).toHaveBeenCalledWith(targetRun);
    expect(ports.buildLiveLaunchSnapshotForRun).toHaveBeenCalledWith(targetRun, 'finished');
    const [writeCall] = vi.mocked(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).mock
      .calls as [[string, PersistedTeamLaunchSnapshot, { allowNoopSkip: true; runId: string }]];
    const writtenSnapshot = writeCall[1];
    expect(writtenSnapshot.expectedMembers).toEqual(['Builder']);
    expect(Object.keys(writtenSnapshot.members)).toEqual(['Builder']);
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).toHaveBeenCalledWith(
      'demo',
      writtenSnapshot,
      { allowNoopSkip: true, runId: 'run-1' }
    );
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');
    expect(result).toBe(writtenSnapshot);
  });

  it('clears persisted launch state instead of writing absent or finished clean snapshots', async () => {
    const cleanSnapshot = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
      },
    });
    const ports = createPorts();
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);

    await expect(facade.persistLaunchStateSnapshot(run(), 'active')).resolves.toBeNull();
    expect(ports.launchStateStoreBoundary.clearPersistedLaunchStateNow).toHaveBeenCalledWith(
      'demo',
      { expectedRunId: 'run-1' }
    );
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).not.toHaveBeenCalled();

    vi.mocked(ports.buildLiveLaunchSnapshotForRun).mockReturnValue(cleanSnapshot);
    await expect(facade.persistLaunchStateSnapshot(run(), 'finished')).resolves.toBeNull();

    expect(ports.launchStateStoreBoundary.clearPersistedLaunchStateNow).toHaveBeenCalledTimes(2);
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).not.toHaveBeenCalled();
  });

  it('passes facade-owned persistence ports into the reconcile runner', async () => {
    const persistedSnapshot = snapshot({
      members: {
        Builder: member('Builder'),
      },
    });
    const runPersistedLaunchReconcile = vi.fn(
      async (_teamName: string, input: TeamProvisioningPersistedLaunchReconcilePortsInput) => {
        await expect(input.readLaunchState('demo')).resolves.toBe(persistedSnapshot);
        await expect(input.readMembersMeta('demo')).resolves.toEqual([]);
        await input.writeLaunchStateSnapshot('demo', persistedSnapshot);
        await input.clearPersistedLaunchState('demo');
        return { snapshot: persistedSnapshot, statuses: {} };
      }
    );
    const ports = createPorts({
      readLaunchState: vi.fn(async () => persistedSnapshot),
      runPersistedLaunchReconcile,
    });
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);

    await expect(facade.reconcilePersistedLaunchState('demo')).resolves.toEqual({
      snapshot: persistedSnapshot,
      statuses: {},
    });

    expect(runPersistedLaunchReconcile).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        readLaunchState: expect.any(Function),
        readMembersMeta: expect.any(Function),
        writeLaunchStateSnapshot: expect.any(Function),
        clearPersistedLaunchState: expect.any(Function),
      })
    );
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshot).toHaveBeenCalledWith(
      'demo',
      persistedSnapshot
    );
    expect(ports.launchStateStoreBoundary.clearPersistedLaunchState).toHaveBeenCalledWith(
      'demo',
      undefined
    );
  });
});
