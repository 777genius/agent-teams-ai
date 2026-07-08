import { describe, expect, it, vi } from 'vitest';

import {
  createTeamInnerWithService,
  launchTeamInnerWithService,
  type TeamProvisioningCreateLaunchOrchestrationServiceHost,
} from '../TeamProvisioningCreateLaunchOrchestration';

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
  throw new Error('unexpected deterministic flow call');
}

function createHost(
  overrides: Partial<TeamProvisioningCreateLaunchOrchestrationServiceHost> = {}
): TeamProvisioningCreateLaunchOrchestrationServiceHost {
  return {
    cleanedStoppedTeamOpenCodeRuntimeLanes: new Set(['alpha']),
    runTracking: {
      getResolvableProvisioningRunId: vi.fn(() => null),
    },
    configTaskActivityBoundary: {
      readTaskActivityRepairLaunchSnapshot: vi.fn(async () => null),
      repairStaleTaskActivityIntervalsOnce: vi.fn(),
    },
    stopAllTeamsGeneration: 7,
    provisioningRunByTeam: new Map(),
    shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
    createOpenCodeTeamThroughRuntimeAdapter: vi.fn(async () => ({
      runId: 'opencode-create-run',
    })),
    launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(async () => ({
      runId: 'opencode-launch-run',
    })),
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

describe('TeamProvisioningCreateLaunchOrchestration', () => {
  it('returns an in-flight create run before preparing launch state', async () => {
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
      },
    });
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(createTeamInnerWithService(host, createRequest, onProgress)).resolves.toEqual({
      runId: 'run-active',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.cleanedStoppedTeamOpenCodeRuntimeLanes.has('alpha')).toBe(false);
    expect(
      host.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot
    ).not.toHaveBeenCalled();
    expect(host.shouldRouteOpenCodeToRuntimeAdapter).not.toHaveBeenCalled();
  });

  it('routes create requests to the OpenCode runtime adapter after stale activity repair', async () => {
    const host = createHost();
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(createTeamInnerWithService(host, createRequest, onProgress)).resolves.toEqual({
      runId: 'opencode-create-run',
    });

    expect(
      host.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot
    ).toHaveBeenCalledWith('alpha');
    expect(
      host.configTaskActivityBoundary.repairStaleTaskActivityIntervalsOnce
    ).toHaveBeenCalledWith('alpha', null);
    expect(host.shouldRouteOpenCodeToRuntimeAdapter).toHaveBeenCalledWith(createRequest);
    expect(host.createOpenCodeTeamThroughRuntimeAdapter).toHaveBeenCalledWith(
      createRequest,
      onProgress
    );
    expect(host.provisioningRunByTeam.has('alpha')).toBe(false);
  });

  it('returns an in-flight launch run before selecting a runtime path', async () => {
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => 'run-active'),
      },
    });
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(launchTeamInnerWithService(host, launchRequest, onProgress)).resolves.toEqual({
      runId: 'run-active',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.shouldRouteOpenCodeToRuntimeAdapter).not.toHaveBeenCalled();
    expect(host.launchOpenCodeTeamThroughRuntimeAdapter).not.toHaveBeenCalled();
  });

  it('routes launch requests to the OpenCode runtime adapter without creating a pending legacy run', async () => {
    const host = createHost();
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(launchTeamInnerWithService(host, launchRequest, onProgress)).resolves.toEqual({
      runId: 'opencode-launch-run',
    });

    expect(host.shouldRouteOpenCodeToRuntimeAdapter).toHaveBeenCalledWith(launchRequest);
    expect(host.launchOpenCodeTeamThroughRuntimeAdapter).toHaveBeenCalledWith(
      launchRequest,
      onProgress
    );
    expect(host.provisioningRunByTeam.has('alpha')).toBe(false);
  });
});
