import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeRuntimeAdapterFinalProgress,
  buildOpenCodeRuntimeAdapterLaunchInput,
  type OpenCodeRuntimeAdapterLaunchPorts,
  prepareOpenCodeRuntimeAdapterLaunchPreflight,
  runOpenCodeTeamRuntimeAdapterLaunch,
} from '../TeamProvisioningOpenCodeRuntimeAdapterLaunch';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../../runtime';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Starting OpenCode sessions through runtime adapter',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    warnings: ['source warning'],
    ...overrides,
  };
}

function runtimeResult(overrides: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {},
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeRuntimeAdapterLaunch', () => {
  it('builds primary OpenCode runtime launch input without changing member defaults', () => {
    const previousLaunchState = {
      teamName: 'team-a',
    } as TeamRuntimeLaunchInput['previousLaunchState'];
    const { launchCwd, launchInput } = buildOpenCodeRuntimeAdapterLaunchInput({
      runId: 'run-1',
      teamName: 'team-a',
      cwd: '/repo',
      prompt: 'launch prompt',
      request: {
        model: 'gpt-5',
        effort: 'high',
        skipPermissions: undefined,
      },
      members: [
        {
          name: 'alice',
          role: 'Engineer',
          workflow: 'build',
          isolation: 'worktree',
          model: 'member-model',
          effort: 'medium',
          cwd: ' /repo/alice ',
        },
        {
          name: 'bob',
          role: 'Reviewer',
        },
      ] as TeamCreateRequest['members'],
      previousLaunchState,
      getOpenCodeRuntimeLaunchCwd: (baseCwd, members) => {
        expect(baseCwd).toBe('/repo');
        expect(members).toHaveLength(2);
        return '/repo/runtime';
      },
    });

    expect(launchCwd).toBe('/repo/runtime');
    expect(launchInput).toEqual({
      runId: 'run-1',
      laneId: 'primary',
      teamName: 'team-a',
      cwd: '/repo/runtime',
      prompt: 'launch prompt',
      providerId: 'opencode',
      model: 'gpt-5',
      effort: 'high',
      skipPermissions: true,
      expectedMembers: [
        {
          name: 'alice',
          role: 'Engineer',
          workflow: 'build',
          isolation: 'worktree',
          providerId: 'opencode',
          model: 'member-model',
          effort: 'medium',
          cwd: '/repo/alice',
        },
        {
          name: 'bob',
          role: 'Reviewer',
          workflow: undefined,
          isolation: undefined,
          providerId: 'opencode',
          model: 'gpt-5',
          effort: 'high',
          cwd: '/repo/runtime',
        },
      ],
      previousLaunchState,
    });
  });

  it('projects final progress for ready, pending, and failed adapter results', () => {
    expect(
      buildOpenCodeRuntimeAdapterFinalProgress({
        launching: progress(),
        result: runtimeResult({ teamLaunchState: 'clean_success' }),
        updatedAt: '2026-01-01T00:00:02.000Z',
      })
    ).toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is ready',
      warnings: ['source warning'],
      updatedAt: '2026-01-01T00:00:02.000Z',
      configReady: true,
    });

    expect(
      buildOpenCodeRuntimeAdapterFinalProgress({
        launching: progress(),
        result: runtimeResult({
          teamLaunchState: 'partial_pending',
          warnings: ['runtime warning'],
          diagnostics: ['waiting'],
        }),
        updatedAt: '2026-01-01T00:00:03.000Z',
      })
    ).toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is waiting for runtime evidence or permissions',
      messageSeverity: 'warning',
      warnings: ['runtime warning'],
      cliLogsTail: 'waiting',
      error: undefined,
    });

    expect(
      buildOpenCodeRuntimeAdapterFinalProgress({
        launching: progress(),
        result: runtimeResult({
          teamLaunchState: 'partial_failure',
          diagnostics: ['missing bootstrap', 'permission denied'],
        }),
        updatedAt: '2026-01-01T00:00:04.000Z',
      })
    ).toMatchObject({
      state: 'failed',
      message: 'OpenCode team launch failed readiness gate',
      messageSeverity: 'error',
      error: 'missing bootstrap\npermission denied',
      cliLogsTail: 'missing bootstrap\npermission denied',
      configReady: true,
    });
  });

  it('runs previous OpenCode cleanup and pending cancellation before recording stop-all cancellation', async () => {
    const calls: string[] = [];
    let stopAllGeneration = 0;
    const previousProgress = progress({ runId: 'pending-run', state: 'spawning' });

    const result = await prepareOpenCodeRuntimeAdapterLaunchPreflight(
      {
        teamName: 'team-a',
        sourceWarning: 'source warning',
        onProgress: vi.fn(),
      },
      {
        getStopAllTeamsGeneration: () => stopAllGeneration,
        getRuntimeAdapterRun: () => ({ runId: 'old-run', providerId: 'opencode' }),
        stopOpenCodeRuntimeAdapterTeam: async () => {
          calls.push('stopPreviousRuntimeRun');
        },
        getProvisioningRun: () => 'pending-run',
        getRuntimeAdapterProgress: () => previousProgress,
        isCancellableRuntimeAdapterProgress: () => true,
        cancelRuntimeAdapterProvisioning: async () => {
          calls.push('cancelPreviousPendingRun');
          stopAllGeneration += 1;
        },
        recordCancelledOpenCodeRuntimeAdapterLaunch: (teamName, sourceWarning) => {
          calls.push('recordCancelledLaunch');
          expect(teamName).toBe('team-a');
          expect(sourceWarning).toBe('source warning');
          return { runId: 'cancelled-run' };
        },
      }
    );

    expect(result).toEqual({ runId: 'cancelled-run' });
    expect(calls).toEqual([
      'stopPreviousRuntimeRun',
      'cancelPreviousPendingRun',
      'recordCancelledLaunch',
    ]);
  });

  it('coordinates successful launch side effects in the original order', async () => {
    const calls: string[] = [];
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      color: 'blue',
      displayName: 'Team A',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const launchResult = runtimeResult({
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          diagnostics: [],
        },
      },
    });
    const adapter = {
      launch: vi.fn(async () => {
        calls.push('adapter.launch');
        return launchResult;
      }),
    } as unknown as TeamLaunchRuntimeAdapter;
    const provisioningRuns = new Map<string, string>();
    const runtimeRuns = new Map<string, unknown>();
    const aliveRuns = new Map<string, string>();

    const result = await runOpenCodeTeamRuntimeAdapterLaunch(
      {
        adapter,
        request,
        members: request.members,
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...basePorts(calls),
        setProvisioningRun: (teamName, runId) => {
          calls.push('setProvisioningRun');
          provisioningRuns.set(teamName, runId);
        },
        getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
        persistOpenCodeRuntimeAdapterLaunchResult: async (resultToPersist, launchInput) => {
          calls.push('persistLaunchResult');
          expect(launchInput.expectedMembers).toMatchObject([
            { name: 'alice', providerId: 'opencode', cwd: '/repo/runtime' },
          ]);
          return { result: resultToPersist };
        },
        syncOpenCodeRuntimeToolApprovals: (input) => {
          calls.push('syncApprovals');
          expect(input.teamColor).toBe('blue');
          expect(input.teamDisplayName).toBe('Team A');
        },
        setRuntimeAdapterRun: (teamName, runtimeRun) => {
          calls.push('setRuntimeRun');
          runtimeRuns.set(teamName, runtimeRun);
        },
        setAliveRunId: (teamName, runId) => {
          calls.push('setAliveRun');
          aliveRuns.set(teamName, runId);
        },
        deleteProvisioningRunIfCurrent: (teamName, runId) => {
          calls.push('deleteProvisioningRunIfCurrent');
          if (provisioningRuns.get(teamName) === runId) {
            provisioningRuns.delete(teamName);
          }
        },
      }
    );

    expect(result).toEqual({ runId: 'run-1' });
    expect(calls).toEqual([
      'setProvisioningRun',
      'setProgress:validating',
      'resetTransientState',
      'readLaunchState',
      'clearPersistedLaunchState',
      'getTeamsBasePath',
      'migrateLegacyState',
      'getTeamsBasePath',
      'upsertLaneIndex',
      'getLaunchCwd',
      'setProgress:spawning',
      'getTeamsBasePath',
      'setActiveRunManifest',
      'adapter.launch',
      'persistLaunchResult',
      'syncApprovals',
      'setProgress:ready',
      'setRuntimeRun',
      'setAliveRun',
      'invalidateRuntimeSnapshotCaches',
      'deleteProvisioningRunIfCurrent',
      'emitTeamProcessChange:ready',
    ]);
    expect(runtimeRuns.get('team-a')).toMatchObject({
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/repo/runtime',
    });
    expect(aliveRuns.get('team-a')).toBe('run-1');
  });

  it('retains a partial-failure adapter run when another member has usable runtime evidence', async () => {
    const calls: string[] = [];
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [
        { name: 'alice', role: 'Engineer', providerId: 'opencode' },
        { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
      ],
    } as TeamCreateRequest;
    const partialResult = runtimeResult({
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimePid: 1001,
          sessionId: 'session-alice',
          diagnostics: [],
        },
        bob: {
          memberName: 'bob',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          diagnostics: ['failed'],
        },
      },
      diagnostics: ['bob failed'],
    });
    const provisioningRuns = new Map<string, string>();

    await runOpenCodeTeamRuntimeAdapterLaunch(
      {
        adapter: {
          launch: vi.fn(async () => partialResult),
        } as unknown as TeamLaunchRuntimeAdapter,
        request,
        members: request.members,
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...basePorts(calls),
        setProvisioningRun: (teamName, runId) => {
          calls.push('setProvisioningRun');
          provisioningRuns.set(teamName, runId);
        },
        getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
        deleteProvisioningRunIfCurrent: (teamName, runId) => {
          calls.push('deleteProvisioningRunIfCurrent');
          if (provisioningRuns.get(teamName) === runId) provisioningRuns.delete(teamName);
        },
      }
    );

    expect(calls).toContain('setProgress:failed');
    expect(calls).toContain('setRuntimeRun');
    expect(calls).toContain('setAliveRun');
    expect(calls).not.toContain('clearLaneStorage');
    expect(calls).not.toContain('deleteRuntimeRun');
    expect(calls).not.toContain('deleteAliveRun');
  });
});

function basePorts(calls: string[]): OpenCodeRuntimeAdapterLaunchPorts {
  return {
    randomUUID: () => 'run-1',
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getStopAllTeamsGeneration: () => 0,
    getRuntimeAdapterRun: () => undefined,
    stopOpenCodeRuntimeAdapterTeam: async () => {
      calls.push('stopPreviousRuntimeRun');
    },
    getProvisioningRun: () => undefined,
    getRuntimeAdapterProgress: () => undefined,
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => {
      calls.push('cancelPreviousPendingRun');
    },
    recordCancelledOpenCodeRuntimeAdapterLaunch: () => {
      calls.push('recordCancelledLaunch');
      return { runId: 'cancelled-run' };
    },
    setProvisioningRun: () => {
      calls.push('setProvisioningRun');
    },
    setRuntimeAdapterProgress: (nextProgress) => {
      calls.push(`setProgress:${nextProgress.state}`);
      return nextProgress;
    },
    resetTeamScopedTransientStateForNewRun: () => {
      calls.push('resetTransientState');
    },
    readLaunchState: async () => {
      calls.push('readLaunchState');
      return null;
    },
    clearPersistedLaunchState: async () => {
      calls.push('clearPersistedLaunchState');
    },
    getTeamsBasePath: () => {
      calls.push('getTeamsBasePath');
      return '/workspace/teams';
    },
    migrateLegacyOpenCodeRuntimeState: async () => {
      calls.push('migrateLegacyState');
    },
    upsertOpenCodeRuntimeLaneIndexEntry: async () => {
      calls.push('upsertLaneIndex');
    },
    getOpenCodeRuntimeLaunchCwd: () => {
      calls.push('getLaunchCwd');
      return '/repo/runtime';
    },
    setOpenCodeRuntimeActiveRunManifest: async () => {
      calls.push('setActiveRunManifest');
    },
    consumeCancelledRuntimeAdapterRunId: () => false,
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: async () => {
      calls.push('clearPrimaryLaneIfOwned');
    },
    persistOpenCodeRuntimeAdapterLaunchResult: async (result) => {
      calls.push('persistLaunchResult');
      return { result };
    },
    syncOpenCodeRuntimeToolApprovals: () => {
      calls.push('syncApprovals');
    },
    clearOpenCodeRuntimeLaneStorage: async () => {
      calls.push('clearLaneStorage');
    },
    deleteRuntimeAdapterRun: () => {
      calls.push('deleteRuntimeRun');
    },
    setRuntimeAdapterRun: () => {
      calls.push('setRuntimeRun');
    },
    deleteAliveRunId: () => {
      calls.push('deleteAliveRun');
    },
    setAliveRunId: () => {
      calls.push('setAliveRun');
    },
    invalidateRuntimeSnapshotCaches: () => {
      calls.push('invalidateRuntimeSnapshotCaches');
    },
    deleteProvisioningRunIfCurrent: () => {
      calls.push('deleteProvisioningRunIfCurrent');
    },
    emitTeamProcessChange: (event) => {
      calls.push(`emitTeamProcessChange:${event.detail}`);
    },
  };
}
