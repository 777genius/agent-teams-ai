import { describe, expect, it, vi } from 'vitest';

import { stopTeamFlow, type TeamProvisioningStopTeamPorts } from '../TeamProvisioningStopFlow';

import type { TeamProvisioningProgress } from '@shared/types';

interface StopFlowRun {
  runId: string;
  teamName: string;
  processKilled: boolean;
  cancelRequested: boolean;
  child: { killed?: boolean } | null;
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
    onProgress: vi.fn(),
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
  runtimeAdapterRunByTeam: Map<string, { runId: string; providerId: string }>;
} {
  const ports = {
    invalidateRuntimeSnapshotCaches: vi.fn(),
    pauseActiveIntervalsForTeam: vi.fn(),
    stopPersistentTeamMembers: vi.fn(),
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
  it('stops the newer alive run when a stale provisioning id masks it', async () => {
    const teamName = 'team-a';
    const currentRun = makeRun('current-run', teamName);
    const runs = new Map([[currentRun.runId, currentRun]]);
    const provisioningRunByTeam = new Map([[teamName, 'stale-run']]);
    const aliveRunByTeam = new Map([[teamName, currentRun.runId]]);
    const ports = makePorts(teamName, runs, provisioningRunByTeam, aliveRunByTeam);

    await stopTeamFlow(teamName, ports);

    expect(provisioningRunByTeam.has(teamName)).toBe(false);
    expect(ports.killTeamProcess).toHaveBeenCalledWith(currentRun.child);
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
    expect(ports.killTeamProcess).not.toHaveBeenCalled();
  });
});
