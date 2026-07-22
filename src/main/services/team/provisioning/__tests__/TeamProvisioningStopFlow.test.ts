import { describe, expect, it, vi } from 'vitest';

import {
  stopAllTeamsFlow,
  stopTeamFlow,
  type TeamProvisioningStopTeamPorts,
} from '../TeamProvisioningStopFlow';

import type { AnthropicTeamApiKeyHelperMaterial } from '../../../runtime/anthropicTeamApiKeyHelper';
import type { TeamProvisioningProgress } from '@shared/types';

interface StopFlowRun {
  runId: string;
  teamName: string;
  processKilled: boolean;
  cancelRequested: boolean;
  child: { killed?: boolean } | null;
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
  anthropicApiKeyHelperCleanupPromise: Promise<void> | null;
  onProgress(progress: TeamProvisioningProgress): void;
}

function progress(runId: string, teamName: string): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state: 'spawning',
    message: 'Spawning',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

function makeRun(runId: string, teamName = 'team-a'): StopFlowRun {
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

function makeAnthropicHelper(teamName: string, runId: string): AnthropicTeamApiKeyHelperMaterial {
  const directory = `/helpers/${teamName}/${runId}`;
  return {
    teamName,
    directory,
    helperPath: `${directory}/helper.sh`,
    keyPath: `${directory}/key`,
    settingsPath: `${directory}/settings.json`,
    settingsObject: { apiKeyHelper: `${directory}/helper.sh` },
    settingsArgs: ['--settings', `${directory}/settings.json`],
    envPatch: {},
  };
}

async function withTeamLock<T>(_teamName: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

function makePorts(
  teamName: string,
  runs: Map<string, StopFlowRun>,
  provisioningRunByTeam = new Map<string, string>(),
  aliveRunByTeam = new Map<string, string>()
): TeamProvisioningStopTeamPorts<StopFlowRun> & {
  cleanupRun: ReturnType<typeof vi.fn>;
  deleteAliveRunId: ReturnType<typeof vi.fn>;
  killTeamProcess: ReturnType<typeof vi.fn>;
  killTeamProcessAndWait: ReturnType<typeof vi.fn>;
  runtimeAdapterRunByTeam: Map<string, { runId: string; providerId: string }>;
} {
  const ports = {
    invalidateRuntimeSnapshotCaches: vi.fn(),
    pauseActiveIntervalsForTeam: vi.fn(),
    stopPersistentTeamMembers: vi.fn(),
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    getTrackedRunId: vi.fn(
      (candidateTeamName: string) =>
        provisioningRunByTeam.get(candidateTeamName) ??
        aliveRunByTeam.get(candidateTeamName) ??
        null
    ),
    getAliveRunId: vi.fn(
      (candidateTeamName: string) => aliveRunByTeam.get(candidateTeamName) ?? null
    ),
    runs,
    runtimeAdapterProgressByRunId: new Map<string, TeamProvisioningProgress>(),
    isCancellableRuntimeAdapterProgress: vi.fn(() => false),
    cancelRuntimeAdapterProvisioning: vi.fn(),
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn(),
    runtimeAdapterRunByTeam: new Map(),
    withTeamLock,
    stopOpenCodeRuntimeAdapterTeam: vi.fn(),
    hasSecondaryRuntimeRuns: vi.fn(() => false),
    stopMixedSecondaryRuntimeLanes: vi.fn(),
    provisioningRunByTeam,
    deleteAliveRunId: vi.fn((candidateTeamName: string) => {
      aliveRunByTeam.delete(candidateTeamName);
    }),
    killTeamProcess: vi.fn((child: StopFlowRun['child']) => {
      if (child) {
        child.killed = true;
      }
    }),
    killTeamProcessAndWait: vi.fn(async (child: StopFlowRun['child']) => {
      if (child) {
        child.killed = true;
      }
    }),
    updateProgress: vi.fn((run: StopFlowRun, state, message) => {
      const next = { ...progress(run.runId, run.teamName), state, message };
      return next;
    }),
    cleanupRun: vi.fn((run: StopFlowRun) => {
      runs.delete(run.runId);
      if (provisioningRunByTeam.get(run.teamName) === run.runId) {
        provisioningRunByTeam.delete(run.teamName);
      }
      if (aliveRunByTeam.get(run.teamName) === run.runId) {
        aliveRunByTeam.delete(run.teamName);
      }
    }),
    logger: { info: vi.fn() },
  } satisfies TeamProvisioningStopTeamPorts<StopFlowRun>;
  void teamName;
  return ports;
}

describe('team provisioning stop flow', () => {
  it('kills tracked processes before waiting for a slow roster-aware team stop', async () => {
    let releaseInitialStop!: () => void;
    const initialStopGate = new Promise<void>((resolve) => {
      releaseInitialStop = resolve;
    });
    const events: string[] = [];
    let stopPass = 0;

    const stopping = stopAllTeamsFlow({
      incrementStopAllTeamsGeneration: () => events.push('generation'),
      getShutdownTrackedTeamNames: () => ['team-a'],
      pauseActiveIntervalsForTeam: () => events.push('pause'),
      killTrackedCliProcesses: () => events.push('kill-cli'),
      killTransientProbeProcessesForShutdown: () => events.push('kill-probes'),
      stopTrackedTeamsForShutdown: async () => {
        stopPass += 1;
        events.push(`stop-${stopPass}:start`);
        if (stopPass === 1) {
          await initialStopGate;
        }
        events.push(`stop-${stopPass}:end`);
        return ['team-a'];
      },
      cancelPendingRuntimeAdapterLaunchesForShutdown: async () => {
        events.push('cancel-adapter');
      },
      waitForInFlightTeamOperationsForShutdown: async () => {
        events.push('wait-locks');
      },
      listPersistedTeamNames: () => [],
      stopPersistentTeamMembers: () => events.push('stop-persisted'),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: async () => undefined,
      logger: { info: vi.fn() },
    });
    await Promise.resolve();

    expect(events).toEqual(['generation', 'pause', 'kill-cli', 'kill-probes', 'stop-1:start']);

    releaseInitialStop();
    await stopping;
    expect(events).toEqual([
      'generation',
      'pause',
      'kill-cli',
      'kill-probes',
      'stop-1:start',
      'stop-1:end',
      'cancel-adapter',
      'wait-locks',
      'cancel-adapter',
      'stop-2:start',
      'stop-2:end',
    ]);
  });

  it('cancels OpenCode runtime advisory timers even when no tracked run remains', async () => {
    const teamName = 'team-a';
    const ports = makePorts(teamName, new Map());

    await stopTeamFlow(teamName, ports);

    expect(ports.openCodeRuntimeDeliveryAdvisory.cancelTeam).toHaveBeenCalledWith(teamName);
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).toHaveBeenCalledWith(teamName);
  });

  it('propagates the stopped-team helper sweep failure to its production caller', async () => {
    const teamName = 'team-sweep-failure';
    const ports = makePorts(teamName, new Map());
    vi.mocked(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).mockRejectedValue(
      new Error('helper sweep failed')
    );

    await expect(stopTeamFlow(teamName, ports)).rejects.toThrow('helper sweep failed');

    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).toHaveBeenCalledWith(teamName);
  });

  it('retains API-key helper material when stopping secondary lanes fails', async () => {
    const teamName = 'team-a';
    const ports = makePorts(teamName, new Map());
    ports.hasSecondaryRuntimeRuns = vi.fn(() => true);
    ports.stopMixedSecondaryRuntimeLanes = vi.fn(async () => {
      throw new Error('secondary stop failed');
    });

    await expect(stopTeamFlow(teamName, ports)).rejects.toThrow('secondary stop failed');

    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).not.toHaveBeenCalled();
  });

  it('retains exact run ownership when the team process cannot be confirmed stopped', async () => {
    const teamName = 'team-stop-failure';
    const currentRun = makeRun('run-stop-failure', teamName);
    currentRun.anthropicApiKeyHelper = makeAnthropicHelper(teamName, currentRun.runId);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const provisioningRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, provisioningRunByTeam);
    ports.killTeamProcessAndWait.mockRejectedValue(new Error('process still running'));
    const cleanupRunOwnedAnthropicApiKeyHelper = vi.fn(async () => undefined);
    ports.cleanupRunOwnedAnthropicApiKeyHelper = cleanupRunOwnedAnthropicApiKeyHelper;

    await expect(stopTeamFlow(teamName, ports)).rejects.toThrow('process still running');

    expect(cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).not.toHaveBeenCalled();
    expect(runs.get(currentRun.runId)).toBe(currentRun);
    expect(currentRun.anthropicApiKeyHelper).not.toBeNull();
  });

  it('retains the stopped run when helper cleanup fails and releases it on retry', async () => {
    const teamName = 'team-helper-cleanup-retry';
    const currentRun = makeRun('run-helper-cleanup-retry', teamName);
    currentRun.anthropicApiKeyHelper = makeAnthropicHelper(teamName, currentRun.runId);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const provisioningRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, provisioningRunByTeam);
    const cleanupRunOwnedAnthropicApiKeyHelper = vi
      .fn<(run: StopFlowRun) => Promise<void>>()
      .mockRejectedValueOnce(new Error('helper cleanup failed'))
      .mockImplementationOnce(async (run) => {
        run.anthropicApiKeyHelper = null;
      });
    ports.cleanupRunOwnedAnthropicApiKeyHelper = cleanupRunOwnedAnthropicApiKeyHelper;

    await expect(stopTeamFlow(teamName, ports)).rejects.toThrow('helper cleanup failed');

    expect(currentRun.processKilled).toBe(true);
    expect(currentRun.cancelRequested).toBe(true);
    expect(runs.get(currentRun.runId)).toBe(currentRun);
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).not.toHaveBeenCalled();

    await stopTeamFlow(teamName, ports);

    expect(cleanupRunOwnedAnthropicApiKeyHelper).toHaveBeenCalledTimes(2);
    expect(currentRun.anthropicApiKeyHelper).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(currentRun);
    expect(runs.has(currentRun.runId)).toBe(false);
    expect(ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam).toHaveBeenCalledWith(teamName);
  });

  it('stops the newer alive run when a stale provisioning id masks it', async () => {
    const teamName = 'team-a';
    const currentRun = makeRun('current-run', teamName);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const provisioningRunByTeam = new Map([[teamName, 'stale-run']]);
    const aliveRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, provisioningRunByTeam, aliveRunByTeam);

    await stopTeamFlow(teamName, ports);

    expect(provisioningRunByTeam.has(teamName)).toBe(false);
    expect(ports.openCodeRuntimeDeliveryAdvisory.cancelTeam).toHaveBeenCalledWith(teamName);
    expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(currentRun.child);
    expect(currentRun.processKilled).toBe(true);
    expect(currentRun.cancelRequested).toBe(true);
    expect(currentRun.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: currentRun.runId,
        state: 'disconnected',
        message: 'Team stopped by user',
      })
    );
    expect(ports.cleanupRun).toHaveBeenCalledWith(currentRun);
    expect(ports.deleteAliveRunId).not.toHaveBeenCalledWith(teamName);
  });

  it('stops primary and secondary OpenCode lanes owned by an aggregate run', async () => {
    const teamName = 'opencode-team';
    const currentRun = makeRun('aggregate-run', teamName);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const aliveRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, new Map(), aliveRunByTeam);
    ports.runtimeAdapterRunByTeam.set(teamName, {
      runId: currentRun.runId,
      providerId: 'opencode',
    });
    vi.mocked(ports.hasSecondaryRuntimeRuns).mockReturnValue(true);

    await stopTeamFlow(teamName, ports);

    expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(teamName, currentRun.runId);
    expect(ports.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(teamName);
    expect(ports.cleanupRun).toHaveBeenCalledWith(currentRun);
  });

  it('retains secondary lane ownership until asynchronous lane cleanup completes', async () => {
    const teamName = 'opencode-team-owned-stop';
    const currentRun = makeRun('aggregate-run-owned-stop', teamName);
    currentRun.anthropicApiKeyHelper = makeAnthropicHelper(teamName, currentRun.runId);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const aliveRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, new Map(), aliveRunByTeam);
    let releaseTeamProcessStop: (() => void) | undefined;
    const teamProcessStopReleased = new Promise<void>((resolve) => {
      releaseTeamProcessStop = resolve;
    });
    let releaseLaneStop: (() => void) | undefined;
    const laneStopReleased = new Promise<void>((resolve) => {
      releaseLaneStop = resolve;
    });
    ports.hasSecondaryRuntimeRuns = vi.fn(() => true);
    const stopMixedSecondaryRuntimeLanes = vi.fn(async () => {
      await laneStopReleased;
      expect(runs.has(currentRun.runId)).toBe(true);
    });
    ports.stopMixedSecondaryRuntimeLanes = stopMixedSecondaryRuntimeLanes;
    ports.killTeamProcessAndWait.mockImplementation(async () => {
      await teamProcessStopReleased;
    });
    const cleanupRunOwnedAnthropicApiKeyHelper = vi.fn(async (run: StopFlowRun) => {
      run.anthropicApiKeyHelper = null;
    });
    ports.cleanupRunOwnedAnthropicApiKeyHelper = cleanupRunOwnedAnthropicApiKeyHelper;

    const stopping = stopTeamFlow(teamName, ports);
    await vi.waitFor(() => {
      expect(stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(teamName);
    });

    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(currentRun.anthropicApiKeyHelper).not.toBeNull();
    releaseLaneStop?.();
    await laneStopReleased;
    await Promise.resolve();
    expect(cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(currentRun.anthropicApiKeyHelper).not.toBeNull();
    releaseTeamProcessStop?.();
    await stopping;
    expect(cleanupRunOwnedAnthropicApiKeyHelper).toHaveBeenCalledWith(currentRun);
    expect(currentRun.anthropicApiKeyHelper).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(currentRun);
    expect(runs.has(currentRun.runId)).toBe(false);
  });

  it('retries aggregate lane cleanup when the tracked run was already marked stopped', async () => {
    const teamName = 'opencode-team-retry';
    const currentRun = makeRun('aggregate-run-retry', teamName);
    currentRun.processKilled = true;
    currentRun.cancelRequested = true;
    const runs = new Map([[currentRun.runId, currentRun]]);
    const aliveRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, new Map(), aliveRunByTeam);
    ports.runtimeAdapterRunByTeam.set(teamName, {
      runId: currentRun.runId,
      providerId: 'opencode',
    });
    vi.mocked(ports.hasSecondaryRuntimeRuns).mockReturnValue(true);

    await stopTeamFlow(teamName, ports);

    expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(teamName, currentRun.runId);
    expect(ports.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(teamName);
    expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(currentRun.child);
  });
});
