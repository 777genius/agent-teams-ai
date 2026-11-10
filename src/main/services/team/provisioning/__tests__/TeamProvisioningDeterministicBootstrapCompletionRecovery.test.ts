import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createDeterministicBootstrapCompletionRecoveryPortsFromService,
  type DeterministicBootstrapCompletionRecoveryPorts,
  type DeterministicBootstrapCompletionRecoveryRun,
  type DeterministicBootstrapCompletionRecoveryServiceHost,
  recoverDeterministicBootstrapCompletion,
} from '../TeamProvisioningDeterministicBootstrapCompletionRecovery';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

const startedAt = '2026-01-01T00:00:00.000Z';
const snapshotUpdatedAt = '2026-01-01T00:00:05.000Z';
const now = '2026-01-01T00:00:09.000Z';

interface TestRun extends DeterministicBootstrapCompletionRecoveryRun {
  recoveredSnapshots: PersistedTeamLaunchSnapshot[];
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'demo',
    state: 'finalizing',
    message: 'Finalizing team launch',
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  const createdRun: TestRun = {
    runId: 'run-1',
    teamName: 'demo',
    startedAt,
    provisioningComplete: true,
    cancelRequested: false,
    processKilled: false,
    deterministicBootstrap: true,
    requiresFirstRealTurnSuccess: false,
    firstRealTurnSucceeded: false,
    mixedSecondaryLanes: [],
    isLaunch: true,
    progress: progress(),
    onProgress: vi.fn(),
    recoveredSnapshots: [],
    ...overrides,
  };
  createdRun.onProgress =
    overrides.onProgress ??
    vi.fn((nextProgress: TeamProvisioningProgress) => {
      createdRun.progress = nextProgress;
    });
  return createdRun;
}

function member(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastEvaluatedAt: snapshotUpdatedAt,
    ...overrides,
  };
}

function snapshot(input: {
  launchPhase?: PersistedTeamLaunchSnapshot['launchPhase'];
  updatedAt?: string;
  expectedMembers?: readonly string[];
  members?: Record<string, PersistedTeamLaunchMemberState>;
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: input.expectedMembers ?? ['Builder'],
    launchPhase: input.launchPhase ?? 'finished',
    members: input.members ?? { Builder: member('Builder') },
    updatedAt: input.updatedAt ?? snapshotUpdatedAt,
  });
}

function ports(
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
  options: {
    currentRunId?: string | null;
    writeFails?: boolean;
    pendingBootstrap?: boolean;
    promotedToAlive?: boolean;
    promotable?: boolean;
  } = {}
): DeterministicBootstrapCompletionRecoveryPorts<TestRun> {
  let currentRunId = options.currentRunId === undefined ? 'run-1' : options.currentRunId;
  let promotable = options.promotable ?? true;

  return {
    isProvisioningRunPromotedToAlive: vi.fn(() => options.promotedToAlive ?? false),
    hasPendingDeterministicFirstRealTurn: vi.fn(
      (target) => target.deterministicBootstrap === true && target.requiresFirstRealTurnSuccess
    ),
    isProvisioningRunStillPromotable: vi.fn(
      (target) => promotable && currentRunId === target.runId
    ),
    isCurrentProvisioningRun: vi.fn((target) => currentRunId === target.runId),
    readBootstrapLaunchSnapshot: vi.fn(async () => bootstrapSnapshot),
    syncRunMemberSpawnStatusesFromSnapshot: vi.fn((target, recoveredSnapshot) => {
      target.recoveredSnapshots.push(recoveredSnapshot);
    }),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, recoveredSnapshot) => {
      if (options.writeFails) {
        throw new Error('write failed');
      }
      return recoveredSnapshot;
    }),
    nowIso: vi.fn(() => now),
    getMemberLaunchSummary: vi.fn(() => ({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    })),
    hasPendingLaunchMembers: vi.fn(() => options.pendingBootstrap ?? false),
    buildAggregatePendingLaunchMessage: vi.fn(() => 'Launch completed with pending bootstrap'),
    updateProgress: vi.fn((target, state, message, extras) => {
      const next = {
        ...target.progress,
        state,
        message,
        updatedAt: now,
        cliLogsTail: extras?.cliLogsTail ?? target.progress.cliLogsTail,
        messageSeverity: extras?.messageSeverity,
      };
      target.progress = next;
      return next;
    }),
    extractCliLogsFromRun: vi.fn(() => 'logs tail'),
    deleteProvisioningRun: vi.fn(() => {
      currentRunId = null;
      promotable = false;
    }),
    setAliveRunId: vi.fn(),
    emitTeamChange: vi.fn(),
    fireTeamLaunchedNotification: vi.fn(async () => undefined),
    fireTeamLaunchIncompleteNotification: vi.fn(async () => undefined),
    warn: vi.fn(),
  };
}

describe('recoverDeterministicBootstrapCompletion', () => {
  it('builds recovery ports from service dependencies', async () => {
    const targetRun = run();
    const recoveredSnapshot = snapshot({});
    const provisioningRunByTeam = new Map([['demo', 'run-1']]);
    const service: DeterministicBootstrapCompletionRecoveryServiceHost<TestRun> = {
      isProvisioningRunPromotedToAlive: vi.fn(() => false),
      hasPendingDeterministicFirstRealTurn: vi.fn(() => false),
      isProvisioningRunStillPromotable: vi.fn(() => true),
      provisioningRunByTeam,
      syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
      writeLaunchStateSnapshot: vi.fn(async (_teamName, nextSnapshot) => nextSnapshot),
      hasPendingLaunchMembers: vi.fn(() => false),
      runTracking: {
        setAliveRunId: vi.fn(),
      },
      teamChangeEmitter: vi.fn(),
      fireTeamLaunchedNotification: vi.fn(async () => undefined),
      fireTeamLaunchIncompleteNotification: vi.fn(async () => undefined),
    };

    const recoveryPorts = createDeterministicBootstrapCompletionRecoveryPortsFromService(service, {
      readBootstrapLaunchSnapshot: vi.fn(async () => recoveredSnapshot),
      nowIso: vi.fn(() => now),
      getMemberLaunchSummary: vi.fn(() => ({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      })),
      buildAggregatePendingLaunchMessage: vi.fn(() => 'pending launch'),
      updateProgress: vi.fn((run, state, message) => ({ ...run.progress, state, message })),
      extractCliLogsFromRun: vi.fn(() => 'logs tail'),
      warn: vi.fn(),
    });

    expect(recoveryPorts.isCurrentProvisioningRun(targetRun)).toBe(true);
    recoveryPorts.syncRunMemberSpawnStatusesFromSnapshot(targetRun, recoveredSnapshot);
    await expect(recoveryPorts.writeLaunchStateSnapshot('demo', recoveredSnapshot)).resolves.toBe(
      recoveredSnapshot
    );
    recoveryPorts.deleteProvisioningRun('demo');
    recoveryPorts.setAliveRunId('demo', 'run-1');
    recoveryPorts.emitTeamChange({
      type: 'lead-message',
      teamName: 'demo',
      runId: 'run-1',
      detail: 'lead-session-sync',
    });

    expect(service.syncRunMemberSpawnStatusesFromSnapshot).toHaveBeenCalledWith(
      targetRun,
      recoveredSnapshot
    );
    expect(service.writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', recoveredSnapshot);
    expect(provisioningRunByTeam.has('demo')).toBe(false);
    expect(service.runTracking.setAliveRunId).toHaveBeenCalledWith('demo', 'run-1');
    expect(service.teamChangeEmitter).toHaveBeenCalledWith({
      type: 'lead-message',
      teamName: 'demo',
      runId: 'run-1',
      detail: 'lead-session-sync',
    });
  });

  it('does nothing when the run is not current or the bootstrap snapshot is not a completed launch', async () => {
    let targetRun = run();
    const stalePorts = ports(snapshot({}), { currentRunId: 'other-run' });

    await recoverDeterministicBootstrapCompletion(targetRun, stalePorts);

    expect(stalePorts.readBootstrapLaunchSnapshot).not.toHaveBeenCalled();
    expect(stalePorts.updateProgress).not.toHaveBeenCalled();

    targetRun = run();
    const activePorts = ports(snapshot({ launchPhase: 'active' }));

    await recoverDeterministicBootstrapCompletion(targetRun, activePorts);

    expect(activePorts.readBootstrapLaunchSnapshot).toHaveBeenCalledWith('demo');
    expect(activePorts.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(activePorts.updateProgress).not.toHaveBeenCalled();
  });

  it('does nothing when the completed bootstrap snapshot is missing or empty', async () => {
    let targetRun = run();
    const missingPorts = ports(null);

    await recoverDeterministicBootstrapCompletion(targetRun, missingPorts);

    expect(missingPorts.syncRunMemberSpawnStatusesFromSnapshot).not.toHaveBeenCalled();
    expect(missingPorts.updateProgress).not.toHaveBeenCalled();

    targetRun = run();
    const emptyPorts = ports(snapshot({ expectedMembers: [], members: {} }));

    await recoverDeterministicBootstrapCompletion(targetRun, emptyPorts);

    expect(emptyPorts.syncRunMemberSpawnStatusesFromSnapshot).not.toHaveBeenCalled();
    expect(emptyPorts.updateProgress).not.toHaveBeenCalled();
  });

  it('recovers a ready launch from a completed deterministic bootstrap snapshot', async () => {
    const recoveredSnapshot = snapshot({});
    const targetRun = run();
    const helperPorts = ports(recoveredSnapshot);

    await recoverDeterministicBootstrapCompletion(targetRun, helperPorts);

    expect(helperPorts.syncRunMemberSpawnStatusesFromSnapshot).toHaveBeenCalledWith(
      targetRun,
      recoveredSnapshot
    );
    expect(helperPorts.writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', recoveredSnapshot);
    expect(targetRun.progress).toMatchObject({
      state: 'ready',
      message: 'Team launched - process alive and ready',
      cliLogsTail: 'logs tail',
      messageSeverity: undefined,
    });
    expect(helperPorts.deleteProvisioningRun).toHaveBeenCalledWith('demo');
    expect(helperPorts.setAliveRunId).toHaveBeenCalledWith('demo', 'run-1');
    expect(helperPorts.emitTeamChange).toHaveBeenCalledWith({
      type: 'lead-message',
      teamName: 'demo',
      runId: 'run-1',
      detail: 'lead-session-sync',
    });
    expect(helperPorts.fireTeamLaunchedNotification).toHaveBeenCalledWith(targetRun);
    expect(helperPorts.fireTeamLaunchIncompleteNotification).not.toHaveBeenCalled();
  });

  it('warns but still recovers when the recovered snapshot write fails', async () => {
    const targetRun = run();
    const helperPorts = ports(snapshot({}), { writeFails: true });

    await recoverDeterministicBootstrapCompletion(targetRun, helperPorts);

    expect(helperPorts.warn).toHaveBeenCalledWith(
      '[demo] Failed to persist recovered deterministic bootstrap snapshot: write failed'
    );
    expect(targetRun.progress.state).toBe('ready');
    expect(helperPorts.setAliveRunId).toHaveBeenCalledWith('demo', 'run-1');
  });

  it('reports failed teammates through the warning and incomplete-notification path', async () => {
    const failedSnapshot = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'spawn failed',
          lastEvaluatedAt: snapshotUpdatedAt,
        }),
      },
    });
    const targetRun = run();
    const helperPorts = ports(failedSnapshot);

    await recoverDeterministicBootstrapCompletion(targetRun, helperPorts);

    expect(targetRun.progress).toMatchObject({
      state: 'ready',
      message: 'Launch completed with teammate errors - Builder failed to start',
      messageSeverity: 'warning',
    });
    expect(helperPorts.fireTeamLaunchedNotification).not.toHaveBeenCalled();
    expect(helperPorts.fireTeamLaunchIncompleteNotification).toHaveBeenCalledWith(
      targetRun,
      [{ name: 'Builder', error: 'spawn failed', updatedAt: snapshotUpdatedAt }],
      failedSnapshot.summary,
      failedSnapshot
    );
  });

  it('is idempotent after the first recovery promotes the run out of provisioning', async () => {
    const targetRun = run();
    const helperPorts = ports(snapshot({}));

    await recoverDeterministicBootstrapCompletion(targetRun, helperPorts);
    await recoverDeterministicBootstrapCompletion(targetRun, helperPorts);

    expect(helperPorts.writeLaunchStateSnapshot).toHaveBeenCalledTimes(1);
    expect(helperPorts.updateProgress).toHaveBeenCalledTimes(1);
    expect(helperPorts.fireTeamLaunchedNotification).toHaveBeenCalledTimes(1);
  });
});
