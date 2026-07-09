import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningRequestAdmissionBoundary,
  getTeamProvisioningRequestLockKey,
  type TeamProvisioningRequestAdmissionServiceHost,
} from '../TeamProvisioningRequestAdmission';

import type { TeamCreateRequest, TeamLaunchRequest, TeamProvisioningProgress } from '@shared/types';

const createRequest: TeamCreateRequest = {
  teamName: 'alpha',
  cwd: '/repo',
  providerId: 'opencode',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  members: [{ name: 'Lead', role: 'Lead', providerId: 'opencode' }],
  prompt: 'start',
};

const launchRequest: TeamLaunchRequest = {
  teamName: 'alpha',
  cwd: '/repo',
  providerId: 'opencode',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

function unexpected(): never {
  throw new Error('unexpected provisioning flow call');
}

function createHost(
  overrides: Partial<TeamProvisioningRequestAdmissionServiceHost> = {}
): TeamProvisioningRequestAdmissionServiceHost & { lockCalls: string[] } {
  const lockCalls: string[] = [];
  return {
    lockCalls,
    withTeamLock: (teamName, fn) => {
      lockCalls.push(teamName);
      return fn();
    },
    cleanedStoppedTeamOpenCodeRuntimeLanes: new Set(['alpha']),
    runTracking: {
      getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
    },
    configTaskActivityBoundary: {
      readTaskActivityRepairLaunchSnapshot: vi.fn(unexpected),
      repairStaleTaskActivityIntervalsOnce: vi.fn(unexpected),
    },
    stopAllTeamsGeneration: 7,
    provisioningRunByTeam: new Map(),
    shouldRouteOpenCodeToRuntimeAdapter: vi.fn(unexpected),
    createOpenCodeTeamThroughRuntimeAdapter: vi.fn(unexpected),
    launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(unexpected),
    createDeterministicCreateSetupFlowPorts: vi.fn(unexpected),
    createDeterministicCreateRunFlowPorts: vi.fn(unexpected),
    createDeterministicCreateSpawnFlowPorts: vi.fn(unexpected),
    deterministicLaunchFlowBoundary: {
      createSetupPorts: vi.fn(unexpected),
      createRunFlowPorts: vi.fn(unexpected),
    },
    ...overrides,
  };
}

describe('TeamProvisioningRequestAdmission', () => {
  it('rejects missing or blank team names before admission', () => {
    expect(() => getTeamProvisioningRequestLockKey({})).toThrow('Team name is required');
    expect(() => getTeamProvisioningRequestLockKey({ teamName: '   ' })).toThrow(
      'Team name is required'
    );
  });

  it('preserves the request team name as the lock key', () => {
    expect(getTeamProvisioningRequestLockKey({ teamName: ' alpha ' })).toBe(' alpha ');
  });

  it('does not enter the create lock or provisioning flow for an invalid request', async () => {
    const host = createHost();
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(
      boundary.createTeam({ ...createRequest, teamName: '  ' }, onProgress)
    ).rejects.toThrow('Team name is required');

    expect(host.lockCalls).toEqual([]);
    expect(host.runTracking.getResolvableProvisioningRunId).not.toHaveBeenCalled();
  });

  it('serializes launch admission by team and delegates to launch orchestration', async () => {
    const host = createHost();
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(
      boundary.launchTeam({ ...launchRequest, teamName: ' alpha ' }, onProgress)
    ).resolves.toEqual({
      runId: 'run-active',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.lockCalls).toEqual([' alpha ']);
    expect(host.runTracking.getResolvableProvisioningRunId).toHaveBeenCalledWith(' alpha ');
  });
});
