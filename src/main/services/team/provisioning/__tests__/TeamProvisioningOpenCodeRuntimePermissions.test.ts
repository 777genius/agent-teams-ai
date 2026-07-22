import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimePermissionSyncPortsFromService,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSyncServiceHost,
  type OpenCodeRuntimePermissionTrackedRunLike,
} from '../TeamProvisioningOpenCodeRuntimePermissions';

const trackedRun: OpenCodeRuntimePermissionTrackedRunLike = {
  runId: 'run-1',
  request: { providerId: 'opencode' },
  memberSpawnStatuses: new Map(),
  isLaunch: false,
};

describe('TeamProvisioningOpenCodeRuntimePermissions', () => {
  it('builds permission sync ports from service dependencies', async () => {
    const permissionListingAdapter = {
      listRuntimePermissions: vi.fn(async () => ({
        permissions: [],
        diagnostics: [],
      })),
    };
    const persistencePorts = {} as OpenCodeRuntimePendingPermissionsPersistencePorts;
    const spawnStatusPorts: OpenCodeRuntimePermissionSpawnStatusPorts<OpenCodeRuntimePermissionTrackedRunLike> =
      {
        getTrackedRunId: vi.fn(() => 'run-1'),
        getRun: vi.fn(() => trackedRun),
        nowIso: vi.fn(() => '2026-07-08T00:00:00.000Z'),
        isCurrentTrackedRun: vi.fn(() => true),
        emitMemberSpawnChange: vi.fn(),
        persistLaunchStateSnapshot: vi.fn(),
      };
    const service: OpenCodeRuntimePermissionSyncServiceHost<OpenCodeRuntimePermissionTrackedRunLike> =
      {
        runTracking: {
          getTrackedRunId: vi.fn(() => 'run-1'),
        },
        appShellBoundary: {
          getOpenCodeRuntimePermissionListingAdapter: vi.fn(
            () => permissionListingAdapter as never
          ),
        },
        launchStateStore: {
          read: vi.fn(async () => null),
        },
        runs: {
          get: vi.fn(() => trackedRun),
        },
        runtimeAdapterRunByTeam: {
          get: vi.fn(() => ({ runId: 'run-1', providerId: 'opencode' })),
        },
        openCodeRuntimePermissionPersistencePorts: persistencePorts,
        openCodeRuntimePermissionSpawnStatusPorts: spawnStatusPorts,
        toolApprovalFacade: {
          syncOpenCodeRuntimeToolApprovals: vi.fn(),
        },
      };
    const logWarning = vi.fn();

    const ports = createOpenCodeRuntimePermissionSyncPortsFromService(service, { logWarning });

    expect(ports.getTrackedRunId('team-a')).toBe('run-1');
    expect(ports.getPermissionListingAdapter()).toBe(permissionListingAdapter);
    await expect(ports.readLaunchState('team-a')).resolves.toBeNull();
    expect(ports.getTrackedRun('team-a')).toBe(trackedRun);
    expect(ports.getRuntimeAdapterRun('team-a')).toEqual({
      runId: 'run-1',
      providerId: 'opencode',
    });
    await expect(
      ports.persistPendingPermissions({
        teamName: 'team-a',
        runId: 'run-1',
        laneId: 'lane-1',
        permissionsByMember: new Map(),
        previousLaunchState: null,
      })
    ).resolves.toBeUndefined();
    ports.syncSpawnStatuses({
      teamName: 'team-a',
      runId: 'run-1',
      laneId: 'lane-1',
      permissionsByMember: new Map(),
    });
    ports.syncToolApprovals({
      teamName: 'team-a',
      runId: 'run-1',
      laneId: 'lane-1',
      cwd: path.join('/tmp', 'team-a'),
      members: {},
      expectedMembers: [],
    });
    ports.logWarning('permission sync warning');

    expect(service.runTracking.getTrackedRunId).toHaveBeenCalledWith('team-a');
    expect(service.appShellBoundary.getOpenCodeRuntimePermissionListingAdapter).toHaveBeenCalled();
    expect(service.launchStateStore.read).toHaveBeenCalledWith('team-a');
    expect(service.runs.get).toHaveBeenCalledWith('run-1');
    expect(service.runtimeAdapterRunByTeam.get).toHaveBeenCalledWith('team-a');
    expect(spawnStatusPorts.getTrackedRunId).toHaveBeenCalledWith('team-a');
    expect(service.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'team-a', runId: 'run-1' })
    );
    expect(logWarning).toHaveBeenCalledWith('permission sync warning');
  });
});
