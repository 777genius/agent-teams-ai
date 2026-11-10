import { describe, expect, it, vi } from 'vitest';

import {
  buildLaunchFailureArtifactPackInput,
  decideLaunchFailureArtifactPackWrite,
  decideStaleTaskActivityRepair,
  type LaunchFailureArtifactPackRun,
  readTaskActivityRepairLaunchSnapshot,
  repairStaleTaskActivityIntervalsBeforeSnapshot,
  repairStaleTaskActivityIntervalsOnce,
  writeLaunchFailureArtifactPackBestEffort,
} from '../TeamProvisioningTaskActivityRepair';

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
    progress: progress({ pid: 4321 }),
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
    finalizingByTimeout: true,
    cancelRequested: false,
    ...overrides,
  };
}

describe('task activity repair helpers', () => {
  it('uses a pending repair snapshot instead of replacing it with a newer launch snapshot', () => {
    const pending = snapshot('team-a', '2026-01-01T00:00:00.000Z');
    const newer = snapshot('team-a', '2026-01-01T00:01:00.000Z');

    expect(
      decideStaleTaskActivityRepair({
        alreadyRepaired: false,
        hasPendingSnapshot: true,
        pendingSnapshot: pending,
        launchSnapshot: newer,
      })
    ).toEqual({
      action: 'repair',
      repairSnapshot: pending,
      snapshotToRememberOnFailure: newer,
      shouldRememberSnapshotOnFailure: false,
    });
  });

  it('remembers the first failed repair snapshot and clears it after a later success', () => {
    const firstSnapshot = snapshot('team-a', '2026-01-01T00:00:00.000Z');
    const newerSnapshot = snapshot('team-a', '2026-01-01T00:01:00.000Z');
    const repairedTeams = new Set<string>();
    const pendingSnapshots = new Map<string, PersistedTeamLaunchSnapshot | null>();
    const repairStaleIntervalsAfterCrash = vi
      .fn()
      .mockReturnValueOnce({ failed: true })
      .mockReturnValueOnce({ failed: false });

    expect(
      repairStaleTaskActivityIntervalsOnce('team-a', firstSnapshot, {
        taskActivityIntervalService: { repairStaleIntervalsAfterCrash },
        tracking: { repairedTeams, pendingSnapshots },
      })
    ).toBe(false);
    expect(pendingSnapshots.get('team-a')).toBe(firstSnapshot);

    expect(
      repairStaleTaskActivityIntervalsOnce('team-a', newerSnapshot, {
        taskActivityIntervalService: { repairStaleIntervalsAfterCrash },
        tracking: { repairedTeams, pendingSnapshots },
      })
    ).toBe(true);
    expect(repairStaleIntervalsAfterCrash).toHaveBeenLastCalledWith('team-a', firstSnapshot);
    expect(pendingSnapshots.has('team-a')).toBe(false);
    expect(repairedTeams.has('team-a')).toBe(true);
  });

  it('reads bootstrap and persisted launch snapshots through explicit ports', async () => {
    const bootstrap = snapshot('team-a', '2026-01-01T00:00:00.000Z');
    const persisted = snapshot('team-a', '2026-01-01T00:01:00.000Z');
    const choosePreferredLaunchSnapshot = vi.fn(() => persisted);

    await expect(
      readTaskActivityRepairLaunchSnapshot('team-a', {
        readBootstrapLaunchSnapshot: vi.fn(() => Promise.resolve(bootstrap)),
        readLaunchState: vi.fn(() => Promise.resolve(persisted)),
        choosePreferredLaunchSnapshot,
      })
    ).resolves.toBe(persisted);
    expect(choosePreferredLaunchSnapshot).toHaveBeenCalledWith(bootstrap, persisted);
  });

  it('skips before-snapshot repair while the tracked run is still live', async () => {
    const repairOnce = vi.fn(() => true);

    await repairStaleTaskActivityIntervalsBeforeSnapshot('team-a', {
      tracking: {
        repairedTeams: new Set<string>(),
        pendingSnapshots: new Map<string, PersistedTeamLaunchSnapshot | null>(),
      },
      getTrackedRunId: vi.fn(() => 'run-1'),
      hasRun: vi.fn(() => true),
      readRepairLaunchSnapshot: vi.fn(),
      repairOnce,
    });

    expect(repairOnce).not.toHaveBeenCalled();
  });

  it('throws before snapshot when stale task activity repair fails', async () => {
    await expect(
      repairStaleTaskActivityIntervalsBeforeSnapshot('team-a', {
        tracking: {
          repairedTeams: new Set<string>(),
          pendingSnapshots: new Map<string, PersistedTeamLaunchSnapshot | null>(),
        },
        getTrackedRunId: vi.fn(() => null),
        hasRun: vi.fn(() => false),
        readRepairLaunchSnapshot: vi.fn(() => Promise.resolve(null)),
        repairOnce: vi.fn(() => false),
      })
    ).rejects.toThrow('Task activity interval repair failed before snapshot for team team-a');
  });
});

describe('launch failure artifact pack helpers', () => {
  it('keeps duplicate artifact pack writes out of the side-effect path', () => {
    expect(decideLaunchFailureArtifactPackWrite({ alreadyWritten: false })).toEqual({
      action: 'write',
    });
    expect(decideLaunchFailureArtifactPackWrite({ alreadyWritten: true })).toEqual({
      action: 'skip',
    });
  });

  it('builds artifact pack input from a run and injected diagnostic ports', () => {
    const run = launchFailureRun();
    const input = buildLaunchFailureArtifactPackInput(
      run,
      { reason: 'launch_progress_failed', launchSnapshot: null },
      {
        buildLaunchDiagnosticsFromRun: vi.fn((): TeamLaunchDiagnosticItem[] => [
          {
            id: 'diag-1',
            severity: 'error',
            code: 'runtime_not_found',
            label: 'missing',
            observedAt: '2026-01-01T00:00:01.000Z',
          },
        ]),
        extractCliLogsFromRun: vi.fn(() => 'cli log'),
        getRuntimeAdapterTraceLines: vi.fn(() => ['adapter trace']),
      }
    );

    expect(input).toMatchObject({
      teamName: 'team-a',
      runId: 'run-1',
      reason: 'launch_progress_failed',
      cwd: '/workspace/team-a',
      pid: 1234,
      providerId: 'anthropic',
      model: 'claude-sonnet-4',
      expectedMembers: ['lead'],
      cliLogs: 'cli log',
      progressTraceLines: ['trace line'],
      runtimeAdapterTraceLines: ['adapter trace'],
      flags: {
        isLaunch: true,
        provisioningComplete: false,
        deterministicBootstrap: true,
        workspaceTrustPreflight: { required: false },
        processKilled: false,
        finalizingByTimeout: true,
        cancelRequested: false,
      },
    });
    expect(input.memberSpawnStatuses).toEqual({
      lead: {
        status: 'waiting',
        launchState: 'starting',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    });
  });

  it('writes each run artifact pack once and releases the claim after writer failure', async () => {
    const writtenRunIds = new Set<string>();
    const write = vi.fn(() => Promise.reject(new Error('disk full')));
    const onWriteError = vi.fn();
    const run = launchFailureRun();
    const ports = {
      writtenRunIds,
      artifactWriter: { write },
      buildLaunchDiagnosticsFromRun: vi.fn((): TeamLaunchDiagnosticItem[] => []),
      extractCliLogsFromRun: vi.fn(() => undefined),
      getRuntimeAdapterTraceLines: vi.fn(() => undefined),
      onWriteError,
    };

    writeLaunchFailureArtifactPackBestEffort(run, { reason: 'launch_progress_failed' }, ports);
    writeLaunchFailureArtifactPackBestEffort(run, { reason: 'launch_progress_failed' }, ports);

    expect(write).toHaveBeenCalledTimes(1);
    expect(writtenRunIds.has('team-a:run-1')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writtenRunIds.has('team-a:run-1')).toBe(false);
    expect(onWriteError).toHaveBeenCalledWith(expect.any(Error));
  });
});
