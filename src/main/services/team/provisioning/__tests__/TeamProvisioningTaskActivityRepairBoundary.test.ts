import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningTaskActivityRepairBoundary,
  type TeamProvisioningTaskActivityRepairBoundaryPorts,
} from '../TeamProvisioningTaskActivityRepairBoundary';

import type { LaunchFailureArtifactPackRun } from '../TeamProvisioningTaskActivityRepair';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamLaunchDiagnosticItem,
  TeamProvisioningProgress,
} from '@shared/types';

function snapshot(teamName: string, updatedAt: string): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName,
    updatedAt,
    launchPhase: 'active',
    expectedMembers: ['lead'],
    members: {},
    summary: {
      confirmedCount: 0,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: 'partial_pending',
  };
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Launching team',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function launchFailureRun(
  overrides: Partial<LaunchFailureArtifactPackRun> = {}
): LaunchFailureArtifactPackRun {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    request: {
      teamName: 'team-a',
      displayName: 'Team A',
      cwd: '/workspace/team-a',
      members: [],
      providerId: 'anthropic',
      model: 'claude-sonnet-4',
    },
    child: { pid: 1234 },
    progress: progress(),
    expectedMembers: ['lead'],
    allEffectiveMembers: [],
    memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>([
      [
        'lead',
        {
          status: 'waiting',
          launchState: 'starting',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    ]),
    provisioningTraceLines: ['trace line'],
    isLaunch: true,
    provisioningComplete: false,
    deterministicBootstrap: true,
    workspaceTrustDiagnostics: { required: false },
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    ...overrides,
  };
}

function createBoundary(
  overrides: Partial<
    TeamProvisioningTaskActivityRepairBoundaryPorts<LaunchFailureArtifactPackRun>
  > = {}
): {
  boundary: TeamProvisioningTaskActivityRepairBoundary<LaunchFailureArtifactPackRun>;
  ports: TeamProvisioningTaskActivityRepairBoundaryPorts<LaunchFailureArtifactPackRun>;
} {
  const ports: TeamProvisioningTaskActivityRepairBoundaryPorts<LaunchFailureArtifactPackRun> = {
    taskActivityIntervalService: {
      repairStaleIntervalsAfterCrash: vi.fn(() => ({ failed: false })),
    },
    runTracking: {
      getTrackedRunId: vi.fn(() => null),
    },
    runs: {
      has: vi.fn(() => false),
    },
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    readLaunchState: vi.fn(async () => null),
    choosePreferredLaunchSnapshot: vi.fn((_bootstrapSnapshot, launchSnapshot) => launchSnapshot),
    artifactWriter: {
      write: vi.fn(async () => undefined),
    },
    buildLaunchDiagnosticsFromRun: vi.fn((): TeamLaunchDiagnosticItem[] => []),
    extractCliLogsFromRun: vi.fn(() => undefined),
    getRuntimeAdapterTraceLines: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    ...overrides,
  };
  return {
    boundary: new TeamProvisioningTaskActivityRepairBoundary(ports),
    ports,
  };
}

describe('TeamProvisioningTaskActivityRepairBoundary', () => {
  it('keeps a failed repair snapshot for the next before-snapshot repair', async () => {
    const firstSnapshot = snapshot('team-a', '2026-01-01T00:00:00.000Z');
    const newerSnapshot = snapshot('team-a', '2026-01-01T00:01:00.000Z');
    const repairStaleIntervalsAfterCrash = vi
      .fn()
      .mockReturnValueOnce({ failed: true })
      .mockReturnValueOnce({ failed: false });
    const { boundary, ports } = createBoundary({
      taskActivityIntervalService: { repairStaleIntervalsAfterCrash },
      readLaunchState: vi.fn(async () => newerSnapshot),
    });

    expect(boundary.repairStaleTaskActivityIntervalsOnce('team-a', firstSnapshot)).toBe(false);
    await boundary.repairStaleTaskActivityIntervalsBeforeSnapshot('team-a');

    expect(ports.readLaunchState).toHaveBeenCalledWith('team-a');
    expect(repairStaleIntervalsAfterCrash).toHaveBeenNthCalledWith(2, 'team-a', firstSnapshot);
  });

  it('skips before-snapshot repair while the tracked run is still live', async () => {
    const repairStaleIntervalsAfterCrash = vi.fn(() => ({ failed: false }));
    const readLaunchState = vi.fn(async () => snapshot('team-a', '2026-01-01T00:00:00.000Z'));
    const { boundary } = createBoundary({
      taskActivityIntervalService: { repairStaleIntervalsAfterCrash },
      runTracking: { getTrackedRunId: vi.fn(() => 'run-1') },
      runs: { has: vi.fn(() => true) },
      readLaunchState,
    });

    await boundary.repairStaleTaskActivityIntervalsBeforeSnapshot('team-a');

    expect(readLaunchState).not.toHaveBeenCalled();
    expect(repairStaleIntervalsAfterCrash).not.toHaveBeenCalled();
  });

  it('dedupes launch failure artifact writes and logs a retryable write failure', async () => {
    const write = vi.fn<(input: unknown) => Promise<unknown>>(() =>
      Promise.reject(new Error('disk full'))
    );
    const warn = vi.fn();
    const { boundary } = createBoundary({
      artifactWriter: { write },
      getRuntimeAdapterTraceLines: vi.fn(() => ['adapter trace']),
      warn,
    });
    const run = launchFailureRun();

    boundary.writeLaunchFailureArtifactPackBestEffort(run, {
      reason: 'launch_progress_failed',
    });
    boundary.writeLaunchFailureArtifactPackBestEffort(run, {
      reason: 'launch_progress_failed',
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        runId: 'run-1',
        reason: 'launch_progress_failed',
        runtimeAdapterTraceLines: ['adapter trace'],
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(
      '[team-a] Failed to write launch failure artifact pack: disk full'
    );

    write.mockResolvedValueOnce(undefined);
    boundary.writeLaunchFailureArtifactPackBestEffort(run, {
      reason: 'launch_progress_failed',
    });

    expect(write).toHaveBeenCalledTimes(2);
  });
});
