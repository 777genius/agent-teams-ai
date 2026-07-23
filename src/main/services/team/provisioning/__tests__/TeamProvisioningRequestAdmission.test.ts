import { describe, expect, it, vi } from 'vitest';

import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
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
    anthropicApiKeyHelperCleanupRetryOwner:
      overrides.anthropicApiKeyHelperCleanupRetryOwner ??
      createAnthropicApiKeyHelperCleanupRetryOwner(),
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
    const getResolvableProvisioningRunId = vi.fn(() => 'run-active');
    const host = createHost({ runTracking: { getResolvableProvisioningRunId } });
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);
    const onProgress = vi.fn<(progress: TeamProvisioningProgress) => void>();

    await expect(
      boundary.createTeam({ ...createRequest, teamName: '  ' }, onProgress)
    ).rejects.toThrow('Team name is required');

    expect(host.lockCalls).toEqual([]);
    expect(getResolvableProvisioningRunId).not.toHaveBeenCalled();
  });

  it('serializes launch admission by team and delegates to launch orchestration', async () => {
    const getResolvableProvisioningRunId = vi.fn(() => 'run-active');
    const host = createHost({ runTracking: { getResolvableProvisioningRunId } });
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
    expect(getResolvableProvisioningRunId).toHaveBeenCalledWith(' alpha ');
  });

  it('rejects a reentrant request for the admitted team instead of deadlocking', async () => {
    let occupied = false;
    const withTeamLock = async <T>(_teamName: string, fn: () => Promise<T>): Promise<T> => {
      if (occupied) {
        return new Promise<T>(() => undefined);
      }
      occupied = true;
      try {
        return await fn();
      } finally {
        occupied = false;
      }
    };
    const host = createHost({
      withTeamLock,
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => null),
      },
      shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
      launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(
        (request: TeamLaunchRequest, onProgress: (progress: TeamProvisioningProgress) => void) =>
          boundary.launchTeam(request, onProgress)
      ),
    });
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);

    const outcome = await Promise.race([
      boundary.launchTeam(launchRequest, vi.fn()).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      ),
      new Promise<{ status: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timed_out' }), 25);
      }),
    ]);

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: new Error('Reentrant team provisioning request for "alpha"'),
    });
  });

  it('allows a nested request for a different team', async () => {
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn((teamName) =>
          teamName === 'beta' ? 'run-beta' : null
        ),
      },
      shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
      launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(
        (_request: TeamLaunchRequest, onProgress: (progress: TeamProvisioningProgress) => void) =>
          boundary.launchTeam({ ...launchRequest, teamName: 'beta' }, onProgress)
      ),
    });
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);

    await expect(boundary.launchTeam(launchRequest, vi.fn())).resolves.toEqual({
      runId: 'run-beta',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });

    expect(host.lockCalls).toEqual(['alpha', 'beta']);
  });

  it('releases reentrancy state when a progress callback throws', async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let deferredRetry!: Promise<unknown>;
    let adapterCalls = 0;
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => null),
      },
      shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
      launchOpenCodeTeamThroughRuntimeAdapter: vi.fn(
        async (
          request: TeamLaunchRequest,
          onProgress: (progress: TeamProvisioningProgress) => void
        ) => {
          adapterCalls += 1;
          if (adapterCalls === 1) {
            deferredRetry = (async () => {
              await retryGate;
              return boundary.launchTeam(request, vi.fn());
            })();
            onProgress({
              runId: 'run-alpha',
              teamName: request.teamName,
              state: 'validating',
              message: 'Validating',
              startedAt: '2026-07-13T00:00:00.000Z',
              updatedAt: '2026-07-13T00:00:00.000Z',
            });
          }
          return { runId: 'run-alpha', launchStatus: 'started' as const };
        }
      ),
    });
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);
    const throwingProgress = vi.fn(() => {
      throw new Error('progress observer failed');
    });

    await expect(boundary.launchTeam(launchRequest, throwingProgress)).rejects.toThrow(
      'progress observer failed'
    );
    releaseRetry();
    await expect(deferredRetry).resolves.toEqual({
      runId: 'run-alpha',
      launchStatus: 'started',
    });

    expect(host.lockCalls).toEqual(['alpha', 'alpha']);
  });

  it('releases reentrancy state when app shutdown cancels creation', async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let deferredRetry!: Promise<unknown>;
    let snapshotReads = 0;
    const host = createHost({
      runTracking: {
        getResolvableProvisioningRunId: vi.fn(() => null),
      },
      configTaskActivityBoundary: {
        readTaskActivityRepairLaunchSnapshot: vi.fn(async () => {
          snapshotReads += 1;
          if (snapshotReads === 1) {
            deferredRetry = (async () => {
              await retryGate;
              return boundary.createTeam(createRequest, vi.fn());
            })();
            host.stopAllTeamsGeneration += 1;
          }
          return null;
        }),
        repairStaleTaskActivityIntervalsOnce: vi.fn(),
      },
      shouldRouteOpenCodeToRuntimeAdapter: vi.fn(() => true),
      createOpenCodeTeamThroughRuntimeAdapter: vi.fn(async () => ({
        runId: 'run-alpha',
        launchStatus: 'started' as const,
      })),
    });
    const boundary = createTeamProvisioningRequestAdmissionBoundary(host);

    await expect(boundary.createTeam(createRequest, vi.fn())).rejects.toThrow(
      'Team launch cancelled by app shutdown'
    );
    releaseRetry();
    await expect(deferredRetry).resolves.toEqual({
      runId: 'run-alpha',
      launchStatus: 'started',
    });

    expect(host.lockCalls).toEqual(['alpha', 'alpha']);
  });
});
