import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningConfigTaskActivityBoundaryFromService,
  TeamProvisioningConfigTaskActivityBoundary,
  type TeamProvisioningConfigTaskActivityBoundaryPorts,
  type TeamProvisioningConfigTaskActivityBoundaryServiceHost,
} from '../TeamProvisioningConfigTaskActivityBoundary';

import type { LaunchFailureArtifactPackRun } from '../TeamProvisioningTaskActivityRepair';
import type { PersistedTeamLaunchSnapshot, TeamConfig } from '@shared/types';

function snapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'alpha',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function createBoundary(): {
  boundary: TeamProvisioningConfigTaskActivityBoundary<LaunchFailureArtifactPackRun>;
  ports: TeamProvisioningConfigTaskActivityBoundaryPorts<LaunchFailureArtifactPackRun>;
} {
  const configSnapshot = { teamName: 'snapshot', members: [] } as unknown as TeamConfig;
  const strictConfig = { teamName: 'strict', members: [] } as unknown as TeamConfig;
  const launchSnapshot = snapshot();
  const ports: TeamProvisioningConfigTaskActivityBoundaryPorts<LaunchFailureArtifactPackRun> = {
    config: {
      readConfigSnapshot: vi.fn(async () => configSnapshot),
      readConfigForStrictDecision: vi.fn(async () => strictConfig),
      updateConfigProjectPath: vi.fn(async () => undefined),
      restorePrelaunchConfig: vi.fn(async () => undefined),
      cleanupPrelaunchBackup: vi.fn(async () => undefined),
    },
    taskActivityRepair: {
      repairStaleTaskActivityIntervalsOnce: vi.fn(() => true),
      readTaskActivityRepairLaunchSnapshot: vi.fn(async () => launchSnapshot),
      writeLaunchFailureArtifactPackBestEffort: vi.fn(() => undefined),
      repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(async () => undefined),
    },
  };
  return {
    boundary: new TeamProvisioningConfigTaskActivityBoundary(ports),
    ports,
  };
}

describe('TeamProvisioningConfigTaskActivityBoundary', () => {
  it('builds the boundary from service-shaped dependencies', async () => {
    const configFacade = {
      readConfigSnapshot: vi.fn(async () => ({ teamName: 'snapshot' }) as unknown as TeamConfig),
      readConfigForStrictDecision: vi.fn(
        async () => ({ teamName: 'strict' }) as unknown as TeamConfig
      ),
      updateConfigProjectPath: vi.fn(async () => undefined),
      restorePrelaunchConfig: vi.fn(async () => undefined),
      cleanupPrelaunchBackup: vi.fn(async () => undefined),
    };
    const runId = 'run-1';
    const service = {
      configFacade,
      taskActivityIntervalService: {
        repairStaleIntervalsAfterCrash: vi.fn(() => ({})),
      },
      runTracking: {
        getTrackedRunId: vi.fn(() => runId),
      },
      runs: {
        has: vi.fn(() => false),
      },
      launchStateStore: {
        read: vi.fn(async () => null),
      },
      runtimeAdapterTraceLinesByRunId: {
        get: vi.fn(() => undefined),
      },
    } satisfies TeamProvisioningConfigTaskActivityBoundaryServiceHost;
    const logger = {
      warn: vi.fn(),
    };
    const boundary =
      createTeamProvisioningConfigTaskActivityBoundaryFromService<LaunchFailureArtifactPackRun>(
        service,
        { logger }
      );

    await expect(boundary.readConfigSnapshot('alpha')).resolves.toMatchObject({
      teamName: 'snapshot',
    });
    await boundary.repairStaleTaskActivityIntervalsBeforeSnapshot('alpha');

    expect(configFacade.readConfigSnapshot).toHaveBeenCalledWith('alpha');
    expect(service.runTracking.getTrackedRunId).toHaveBeenCalledWith('alpha');
    expect(service.launchStateStore.read).toHaveBeenCalledWith('alpha');
  });

  it('keeps config reads and prelaunch mutations behind the config port', async () => {
    const { boundary, ports } = createBoundary();

    await expect(boundary.readConfigSnapshot('alpha')).resolves.toMatchObject({
      teamName: 'snapshot',
    });
    await expect(boundary.readConfigForStrictDecision('alpha')).resolves.toMatchObject({
      teamName: 'strict',
    });
    await boundary.updateConfigProjectPath('alpha', '/repo');
    await boundary.restorePrelaunchConfig('alpha');
    await boundary.cleanupPrelaunchBackup('alpha');

    expect(ports.config.readConfigSnapshot).toHaveBeenCalledWith('alpha');
    expect(ports.config.readConfigForStrictDecision).toHaveBeenCalledWith('alpha');
    expect(ports.config.updateConfigProjectPath).toHaveBeenCalledWith('alpha', '/repo');
    expect(ports.config.restorePrelaunchConfig).toHaveBeenCalledWith('alpha');
    expect(ports.config.cleanupPrelaunchBackup).toHaveBeenCalledWith('alpha');
  });

  it('keeps task-activity repair behind the repair port', async () => {
    const { boundary, ports } = createBoundary();
    const launchSnapshot = snapshot();
    const run = { teamName: 'alpha', runId: 'run-1' } as LaunchFailureArtifactPackRun;

    expect(boundary.repairStaleTaskActivityIntervalsOnce('alpha', launchSnapshot)).toBe(true);
    await expect(boundary.readTaskActivityRepairLaunchSnapshot('alpha')).resolves.toMatchObject({
      teamName: 'alpha',
    });
    boundary.writeLaunchFailureArtifactPackBestEffort(run, { reason: 'failed' });
    await boundary.repairStaleTaskActivityIntervalsBeforeSnapshot('alpha');

    expect(ports.taskActivityRepair.repairStaleTaskActivityIntervalsOnce).toHaveBeenCalledWith(
      'alpha',
      launchSnapshot
    );
    expect(ports.taskActivityRepair.readTaskActivityRepairLaunchSnapshot).toHaveBeenCalledWith(
      'alpha'
    );
    expect(ports.taskActivityRepair.writeLaunchFailureArtifactPackBestEffort).toHaveBeenCalledWith(
      run,
      { reason: 'failed' }
    );
    expect(
      ports.taskActivityRepair.repairStaleTaskActivityIntervalsBeforeSnapshot
    ).toHaveBeenCalledWith('alpha');
  });
});
