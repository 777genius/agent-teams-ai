import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeStopFlowPortsFromDeps,
  createTeamProvisioningStopFlowBoundary,
  createTeamProvisioningStopFlowDepsFromService,
  type TeamProvisioningStopFlowFactoryDeps,
  type TeamProvisioningStopFlowServiceHost,
} from '../TeamProvisioningStopFlowPortsFactory';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { SecondaryRuntimeRunEntry } from '../TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamProvisioningProgress,
} from '@shared/types';

interface StopFactoryRun {
  runId: string;
  teamName: string;
  processKilled: boolean;
  cancelRequested: boolean;
  child: { killed?: boolean } | null;
  anthropicApiKeyHelper: null;
  anthropicApiKeyHelperCleanupPromise: Promise<void> | null;
  onProgress(progress: TeamProvisioningProgress): void;
}

function makeRun(runId = 'run-1', teamName = 'team-a'): StopFactoryRun {
  return {
    runId,
    teamName,
    processKilled: false,
    cancelRequested: false,
    child: {},
    anthropicApiKeyHelper: null,
    anthropicApiKeyHelperCleanupPromise: null,
    onProgress: vi.fn(),
  };
}

function makeProgress(
  runId = 'run-1',
  teamName = 'team-a',
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state: 'spawning',
    message: 'Spawning',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeAdapter(
  stop: TeamLaunchRuntimeAdapter['stop'] = vi.fn(async (input) => ({
    runId: input.runId,
    teamName: input.teamName,
    stopped: true,
    members: {},
    warnings: [],
    diagnostics: [],
  }))
): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop,
  } as unknown as TeamLaunchRuntimeAdapter;
}

function createDeps(
  overrides: Partial<TeamProvisioningStopFlowFactoryDeps<StopFactoryRun>> = {}
): TeamProvisioningStopFlowFactoryDeps<StopFactoryRun> & {
  mutableRuns: Map<string, StopFactoryRun>;
  aliveRunByTeam: Map<string, string>;
  emittedEvents: TeamChangeEvent[];
  progressUpdates: TeamProvisioningProgress[];
} {
  const runs = new Map<string, StopFactoryRun>();
  const provisioningRunByTeam = new Map<string, string>();
  const aliveRunByTeam = new Map<string, string>();
  const runtimeAdapterRunByTeam = new Map([
    [
      'team-a',
      {
        runId: 'runtime-run',
        providerId: 'opencode' as const,
        cwd: '/runtime-cwd',
      },
    ],
  ]);
  const runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  const emittedEvents: TeamChangeEvent[] = [];
  const progressUpdates: TeamProvisioningProgress[] = [];

  return {
    getTeamsBasePath: vi.fn(() => '/teams'),
    getSecondaryRuntimeRuns: vi.fn((): SecondaryRuntimeRunEntry[] => []),
    stoppingSecondaryRuntimeTeams: new Set<string>(),
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    readLaunchState: vi.fn(async () => null),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, snapshot) => snapshot),
    readPersistedTeamProjectPath: vi.fn(() => '/persisted-cwd'),
    clearOpenCodeRuntimeLaneStorage: vi.fn(async () => true),
    deleteSecondaryRuntimeRun: vi.fn(),
    clearSecondaryRuntimeRuns: vi.fn(),
    runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId,
    setRuntimeAdapterProgress: vi.fn((progress) => {
      runtimeAdapterProgressByRunId.set(progress.runId, progress);
      progressUpdates.push(progress);
      return progress;
    }),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    getTrackedRunId: vi.fn(
      (teamName) => provisioningRunByTeam.get(teamName) ?? aliveRunByTeam.get(teamName) ?? null
    ),
    getAliveRunId: vi.fn((teamName) => aliveRunByTeam.get(teamName) ?? null),
    deleteAliveRunId: vi.fn((teamName) => {
      aliveRunByTeam.delete(teamName);
    }),
    runs,
    mutableRuns: runs,
    provisioningRunByTeam,
    invalidateRuntimeSnapshotCaches: vi.fn(),
    pauseActiveIntervalsForTeam: vi.fn(),
    persistentRuntimeCleanup: {
      stopPersistentTeamMembers: vi.fn(),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn(),
    },
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    isCancellableRuntimeAdapterProgress: vi.fn(() => false),
    cancelRuntimeAdapterProvisioning: vi.fn(),
    withTeamLock: vi.fn(async (_teamName, fn) => fn()),
    hasSecondaryRuntimeRuns: vi.fn(() => false),
    killTeamProcess: vi.fn((child) => {
      if (child) {
        child.killed = true;
      }
    }),
    killTeamProcessAndWait: vi.fn(async (child) => {
      if (child) {
        child.killed = true;
      }
    }),
    updateProgress: vi.fn((run, state, message) =>
      makeProgress(run.runId, run.teamName, { state, message })
    ),
    cleanupRun: vi.fn((run) => {
      runs.delete(run.runId);
      provisioningRunByTeam.delete(run.teamName);
      aliveRunByTeam.delete(run.teamName);
    }),
    emitTeamChange: vi.fn((event) => {
      emittedEvents.push(event);
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    nowIso: vi.fn(() => '2026-01-01T00:00:02.000Z'),
    aliveRunByTeam,
    emittedEvents,
    progressUpdates,
    ...overrides,
  };
}

describe('TeamProvisioningStopFlowPortsFactory', () => {
  it('builds stop flow deps from service-shaped dependencies', async () => {
    const deps = createDeps();
    const service = {
      getSecondaryRuntimeRuns: deps.getSecondaryRuntimeRuns,
      stoppingSecondaryRuntimeTeams: deps.stoppingSecondaryRuntimeTeams,
      appShellBoundary: {
        getOpenCodeRuntimeAdapter: deps.getOpenCodeRuntimeAdapter,
      },
      launchStateStore: {
        read: deps.readLaunchState,
      },
      writeLaunchStateSnapshot: deps.writeLaunchStateSnapshot,
      readPersistedTeamProjectPath: deps.readPersistedTeamProjectPath,
      deleteSecondaryRuntimeRun: deps.deleteSecondaryRuntimeRun,
      clearSecondaryRuntimeRuns: deps.clearSecondaryRuntimeRuns,
      runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
      runtimeAdapterProgressByRunId: deps.runtimeAdapterProgressByRunId,
      runtimeAdapterProgressState: {
        setRuntimeAdapterProgress: deps.setRuntimeAdapterProgress,
      },
      toolApprovalFacade: {
        clearOpenCodeRuntimeToolApprovals: deps.clearOpenCodeRuntimeToolApprovals,
      },
      runTracking: {
        getTrackedRunId: deps.getTrackedRunId,
        getAliveRunId: deps.getAliveRunId,
        deleteAliveRunId: deps.deleteAliveRunId,
      },
      runs: deps.runs,
      provisioningRunByTeam: deps.provisioningRunByTeam,
      invalidateRuntimeSnapshotCaches: deps.invalidateRuntimeSnapshotCaches,
      taskActivityIntervalService: {
        pauseActiveIntervalsForTeam: deps.pauseActiveIntervalsForTeam,
      },
      persistentRuntimeCleanup: {
        stopPersistentTeamMembers: deps.persistentRuntimeCleanup.stopPersistentTeamMembers,
        cleanupAnthropicApiKeyHelperMaterialForStoppedTeam:
          deps.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam,
      },
      openCodeRuntimeDeliveryAdvisory: deps.openCodeRuntimeDeliveryAdvisory,
      cancellationBoundary: {
        isCancellableRuntimeAdapterProgress: deps.isCancellableRuntimeAdapterProgress,
        cancelRuntimeAdapterProvisioning: deps.cancelRuntimeAdapterProvisioning,
      },
      withTeamLock: deps.withTeamLock,
      hasSecondaryRuntimeRuns: deps.hasSecondaryRuntimeRuns,
      cleanupRun: deps.cleanupRun,
      teamChangeEmitter: deps.emitTeamChange,
    } satisfies TeamProvisioningStopFlowServiceHost<StopFactoryRun>;

    const built = createTeamProvisioningStopFlowDepsFromService(service, {
      getTeamsBasePath: deps.getTeamsBasePath,
      clearOpenCodeRuntimeLaneStorage: deps.clearOpenCodeRuntimeLaneStorage,
      killTeamProcess: deps.killTeamProcess,
      killTeamProcessAndWait: deps.killTeamProcessAndWait,
      updateProgress: deps.updateProgress,
      logger: deps.logger,
      nowIso: deps.nowIso,
    });
    const ports = createOpenCodeRuntimeStopFlowPortsFromDeps(built);

    expect(ports.teamsBasePath).toBe('/teams');
    expect(ports.runtimeAdapterRunByTeam).toBe(deps.runtimeAdapterRunByTeam);
    expect(ports.getAliveRunId('team-a')).toBe(deps.getAliveRunId('team-a'));
    await ports.clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName: 'team-a',
      laneId: 'primary',
    });
    ports.clearOpenCodeRuntimeToolApprovals('team-a', { emitDismiss: true });
    ports.deleteAliveRunId('team-a');

    expect(deps.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'primary',
    });
    expect(deps.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('team-a', {
      emitDismiss: true,
    });
    expect(deps.deleteAliveRunId).toHaveBeenCalledWith('team-a');
  });

  it('creates OpenCode runtime stop ports from explicit service dependencies', async () => {
    const deps = createDeps();
    const ports = createOpenCodeRuntimeStopFlowPortsFromDeps(deps);

    expect(ports.teamsBasePath).toBe('/teams');
    expect(ports.runtimeAdapterRunByTeam).toBe(deps.runtimeAdapterRunByTeam);
    expect(ports.runtimeAdapterProgressByRunId).toBe(deps.runtimeAdapterProgressByRunId);

    await ports.clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName: 'team-a',
      laneId: 'primary',
    });
    ports.clearOpenCodeRuntimeToolApprovals('team-a', {
      runId: 'run-1',
      laneId: 'primary',
      emitDismiss: true,
    });
    ports.emitTeamChange({ type: 'process', teamName: 'team-a', detail: 'stopped' });

    expect(deps.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'primary',
    });
    expect(deps.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('team-a', {
      runId: 'run-1',
      laneId: 'primary',
      emitDismiss: true,
    });
    expect(deps.emitTeamChange).toHaveBeenCalledWith({
      type: 'process',
      teamName: 'team-a',
      detail: 'stopped',
    });
  });

  it('stops tracked process runs through the extracted stop boundary', async () => {
    const teamName = 'team-a';
    const run = makeRun('run-1', teamName);
    const deps = createDeps();
    deps.mutableRuns.set(run.runId, run);
    deps.provisioningRunByTeam.set(teamName, run.runId);
    deps.aliveRunByTeam.set(teamName, run.runId);

    await createTeamProvisioningStopFlowBoundary(deps).stopTeam(teamName);

    expect(deps.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith(teamName);
    expect(deps.pauseActiveIntervalsForTeam).toHaveBeenCalledWith(teamName);
    expect(deps.persistentRuntimeCleanup.stopPersistentTeamMembers).toHaveBeenCalledWith(teamName);
    expect(deps.openCodeRuntimeDeliveryAdvisory.cancelTeam).toHaveBeenCalledWith(teamName);
    expect(deps.killTeamProcessAndWait).toHaveBeenCalledWith(run.child);
    expect(run.processKilled).toBe(true);
    expect(run.cancelRequested).toBe(true);
    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        state: 'disconnected',
        message: 'Team stopped by user',
      })
    );
    expect(deps.cleanupRun).toHaveBeenCalledWith(run);
    expect(
      deps.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam
    ).toHaveBeenCalledWith(teamName);
  });

  it('routes missing tracked OpenCode runtime runs to adapter stop ports', async () => {
    const teamName = 'team-a';
    const runId = 'runtime-run';
    const stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['stopped'],
    }));
    const previousLaunchState = {
      teamName,
      expectedMembers: [],
      members: {},
    } as unknown as PersistedTeamLaunchSnapshot;
    const deps = createDeps({
      getOpenCodeRuntimeAdapter: vi.fn(() => makeAdapter(stop)),
      readLaunchState: vi.fn(async () => previousLaunchState),
    });
    deps.provisioningRunByTeam.set(teamName, runId);
    deps.aliveRunByTeam.set(teamName, runId);

    await createTeamProvisioningStopFlowBoundary(deps).stopTeam(teamName);

    expect(deps.openCodeRuntimeDeliveryAdvisory.cancelTeam).toHaveBeenCalledWith(teamName);
    expect(deps.withTeamLock).toHaveBeenCalledWith(teamName, expect.any(Function));
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        laneId: 'primary',
        teamName,
        cwd: '/runtime-cwd',
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState,
        force: true,
      })
    );
    expect(deps.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    expect(deps.deleteAliveRunId).toHaveBeenCalledWith(teamName);
    expect(deps.emittedEvents).toContainEqual({
      type: 'process',
      teamName,
      runId,
      detail: 'stopped',
    });
    expect(
      deps.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam
    ).toHaveBeenCalledWith(teamName);
  });
});
