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
  TeamRuntimeStopInput,
} from '../../runtime';
import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

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
        allowExperimentalLocalModels: true,
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
      allowExperimentalLocalModels: true,
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
        getStopTeamGeneration: () => 0,
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
      allowExperimentalLocalModels: true,
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
      allowExperimentalLocalModels: true,
    });
    expect(aliveRuns.get('team-a')).toBe('run-1');
  });

  it('stops an invoked runtime after persistence loses launch authority', async () => {
    const calls: string[] = [];
    let provisioningOwner: string | undefined;
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));

    const result = await runOpenCodeTeamRuntimeAdapterLaunch(
      {
        adapter: {
          launch: vi.fn(async (input: TeamRuntimeLaunchInput) => {
            input.onInvocationDispatched?.();
            return runtimeResult();
          }),
          stop,
        } as unknown as TeamLaunchRuntimeAdapter,
        request: {
          teamName: 'team-a',
          cwd: '/repo',
          providerId: 'opencode',
          members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
        },
        members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...basePorts(calls),
        setProvisioningRun: (_teamName, runId) => {
          calls.push('setProvisioningRun');
          provisioningOwner = runId;
        },
        getProvisioningRun: () => provisioningOwner,
        persistOpenCodeRuntimeAdapterLaunchResult: async (launchResult) => {
          calls.push('persistLaunchResult');
          provisioningOwner = undefined;
          return { result: launchResult };
        },
      }
    );

    expect(result).toEqual({ runId: 'run-1' });
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', teamName: 'team-a', force: true })
    );
    expect(calls).toContain('clearPrimaryLaneIfOwned');
    expect(calls).not.toContain('syncApprovals');
    expect(calls).toContain('setRuntimeRun');
    expect(calls).not.toContain('setAliveRun');
  });

  it('awaits one partial-failure artifact with snapshot diagnostics and statuses before cleanup', async () => {
    const calls: string[] = [];
    const artifact = deferred<void>();
    const artifactInputs: unknown[] = [];
    const { ports } = ownedPorts(calls, {
      launchFailureArtifacts: {
        write: async (input) => {
          calls.push('artifact:start');
          artifactInputs.push(input);
          await artifact.promise;
          calls.push('artifact:end');
        },
      },
      persistOpenCodeRuntimeAdapterLaunchResult: async (result) => ({
        result,
        snapshot: failedSnapshot(),
      }),
    });

    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => failedRuntimeResult()),
      ports
    );
    await waitForCall(calls, 'artifact:start');

    expect(calls).not.toContain('clearLaneStorage');
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
    expect(artifactInputs).toEqual([
      expect.objectContaining({
        teamName: 'team-a',
        runId: 'run-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        cwd: '/repo/runtime',
        providerId: 'opencode',
        providerBackendId: 'opencode-cli',
        model: 'openai/gpt-5',
        expectedMembers: ['alice'],
        effectiveMembers: [expect.objectContaining({ name: 'alice' })],
        progress: expect.objectContaining({ state: 'failed' }),
        launchSnapshot: expect.objectContaining({ teamName: 'team-a' }),
        launchDiagnostics: [
          expect.objectContaining({ detail: 'inventory timeout' }),
          expect.objectContaining({ detail: 'config timeout' }),
        ],
        memberSpawnStatuses: {
          alice: expect.objectContaining({ status: 'error', launchState: 'failed_to_start' }),
        },
      }),
    ]);

    artifact.resolve(undefined);
    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(calls.indexOf('artifact:end')).toBeLessThan(calls.indexOf('clearLaneStorage'));
    expect(calls).toContain('deleteRuntimeOwnershipIfCurrent');
  });

  it('retains a confirmed first member when a later member fails', async () => {
    const calls: string[] = [];
    const { ports } = ownedPorts(calls);
    const retainedPartial = runtimeResult({
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
          diagnostics: ['failed second member'],
        },
      },
    });

    const params = launchParams(async () => retainedPartial);
    params.request.rosterLaunchBinding = fakeRosterLaunchBinding();
    await expect(runOpenCodeTeamRuntimeAdapterLaunch(params, ports)).resolves.toMatchObject({
      runId: 'run-1',
      launchStatus: 'started',
    });
    expect(calls).toContain('setRuntimeRun');
    expect(calls).toContain('setAliveRun');
    expect(calls).not.toContain('clearLaneStorage');
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
    expect(calls).not.toContain('writeLaunchFailureArtifact');
  });

  it('awaits a thrown setup failure artifact and preserves the original error object', async () => {
    const calls: string[] = [];
    const artifact = deferred<void>();
    const setupError = new Error('launch-state read exploded');
    const artifactInputs: unknown[] = [];
    const { ports } = ownedPorts(calls, {
      readLaunchState: async () => {
        calls.push('readLaunchState');
        throw setupError;
      },
      launchFailureArtifacts: {
        write: async (input) => {
          calls.push('artifact:start');
          artifactInputs.push(input);
          await artifact.promise;
        },
      },
    });

    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => runtimeResult()),
      ports
    );
    await waitForCall(calls, 'artifact:start');
    expect(calls).not.toContain('clearLaneStorage');
    expect(artifactInputs[0]).toEqual(
      expect.objectContaining({
        cwd: '/repo',
        launchSnapshot: null,
        launchDiagnostics: [expect.objectContaining({ detail: 'launch-state read exploded' })],
      })
    );
    expect(artifactInputs[0]).not.toHaveProperty('memberSpawnStatuses');

    artifact.resolve(undefined);
    await expect(launch).rejects.toMatchObject({
      name: 'RosterLaunchKnownNoStartError',
      message: expect.stringContaining(setupError.message),
    });
    expect(calls).toContain('clearLaneStorage');
  });

  it('swallows an asynchronously rejected artifact port and completes owned cleanup', async () => {
    const calls: string[] = [];
    const artifact = deferred<void>();
    const { ports } = ownedPorts(calls, {
      launchFailureArtifacts: {
        write: async () => {
          calls.push('artifact:start');
          await artifact.promise;
        },
      },
      persistOpenCodeRuntimeAdapterLaunchResult: async (result) => ({
        result,
        snapshot: failedSnapshot(),
      }),
    });
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => failedRuntimeResult()),
      ports
    );
    await waitForCall(calls, 'artifact:start');
    artifact.reject(new Error('artifact I/O failed'));

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(calls).toContain('clearLaneStorage');
    expect(calls).toContain('deleteRuntimeOwnershipIfCurrent');
  });

  it('does not certify no-start when all-failed lane storage cleanup is incomplete', async () => {
    const calls: string[] = [];
    const { ports } = ownedPorts(calls, {
      clearOpenCodeRuntimeLaneStorage: async () => {
        calls.push('clearLaneStorage:failed');
        throw new Error('storage cleanup failed');
      },
    });
    const params = launchParams(async () => failedRuntimeResult());
    params.request.rosterLaunchBinding = fakeRosterLaunchBinding();

    await expect(runOpenCodeTeamRuntimeAdapterLaunch(params, ports)).resolves.toEqual({
      runId: 'run-1',
    });
    expect(calls).toContain('clearLaneStorage:failed');
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
    expect(calls).not.toContain('deleteProvisioningRunIfCurrent');
  });

  it('keeps all-failed launch uncertain when the attempt-owned stop is unconfirmed', async () => {
    const calls: string[] = [];
    const { ports } = ownedPorts(calls);
    const params = launchParams(async () => failedRuntimeResult());
    params.adapter.stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: false,
      members: {},
      warnings: [],
      diagnostics: ['transport outcome unknown'],
    }));

    await expect(runOpenCodeTeamRuntimeAdapterLaunch(params, ports)).resolves.toEqual({
      runId: 'run-1',
    });
    expect(calls).not.toContain('clearLaneStorage');
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
    expect(calls).not.toContain('deleteProvisioningRunIfCurrent');
  });

  it('proves a synchronous pre-invocation error as no-start when cleanup is incomplete', async () => {
    const calls: string[] = [];
    const syncError = new Error('synchronous adapter failure');
    const { ports } = ownedPorts(calls, {
      clearOpenCodeRuntimeLaneStorage: async () => {
        throw new Error('storage cleanup failed');
      },
    });
    const params = launchParams(async () => runtimeResult());
    params.adapter.launch = () => {
      throw syncError;
    };

    await expect(runOpenCodeTeamRuntimeAdapterLaunch(params, ports)).rejects.toMatchObject({
      name: 'RosterLaunchKnownNoStartError',
      message: expect.stringContaining(syncError.message),
      cleanupDiagnostics: ['partial OpenCode lane cleanup remains durably targetable'],
    });
  });

  it('preserves a thrown adapter error identity when the artifact port rejects', async () => {
    const calls: string[] = [];
    const adapterError = new Error('adapter exploded');
    const { ports } = ownedPorts(calls, {
      launchFailureArtifacts: {
        write: async () => {
          await Promise.resolve();
          throw new Error('artifact I/O failed');
        },
      },
    });

    await expect(
      runOpenCodeTeamRuntimeAdapterLaunch(
        launchParams(async (input) => {
          await input.onInvocationBoundary?.();
          input.onInvocationDispatched?.();
          throw adapterError;
        }),
        ports
      )
    ).rejects.toBe(adapterError);
    expect(calls).toContain('clearLaneStorage');
    expect(calls).toContain('deleteRuntimeOwnershipIfCurrent');
  });

  it('observes a per-team stop published while the adapter invocation is deferred', async () => {
    const calls: string[] = [];
    const invocation = deferred<void>();
    let stopGeneration = 0;
    const persist = vi.fn(async (result: TeamRuntimeLaunchResult) => ({ result }));
    const { ports } = ownedPorts(calls, {
      getStopTeamGeneration: () => stopGeneration,
      persistOpenCodeRuntimeAdapterLaunchResult: persist,
    });
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async (input) => {
        await input.onInvocationBoundary?.();
        input.onInvocationDispatched?.();
        calls.push('adapter:invocation-started');
        await invocation.promise;
        return runtimeResult();
      }),
      ports
    );
    await waitForCall(calls, 'adapter:invocation-started');

    stopGeneration += 1;
    expect(calls).not.toContain('persistLaunchResult');
    invocation.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(persist).not.toHaveBeenCalled();
    expect(calls).toContain('clearPrimaryLaneIfOwned');
  });

  it('does not stop when cancellation wins after authorization but before dispatch', async () => {
    const calls: string[] = [];
    const boundaryReached = deferred<void>();
    const releaseBoundary = deferred<void>();
    let stopGeneration = 0;
    const stop = vi.fn();
    const { ports } = ownedPorts(calls, {
      getStopTeamGeneration: () => stopGeneration,
    });
    const params = launchParams(async (input) => {
      await input.onInvocationBoundary?.();
      boundaryReached.resolve(undefined);
      await releaseBoundary.promise;
      throw new Error('cancelled before provider dispatch');
    });
    params.adapter.stop = stop;
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(params, ports);

    await boundaryReached.promise;
    stopGeneration += 1;
    releaseBoundary.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('retains exact run ownership when dispatched cancellation cleanup is unconfirmed', async () => {
    const calls: string[] = [];
    const dispatched = deferred<void>();
    const releaseResult = deferred<void>();
    let stopGeneration = 0;
    let runtimeOwner: Parameters<OpenCodeRuntimeAdapterLaunchPorts['setRuntimeAdapterRun']>[1];
    const clearPrimaryLane = vi.fn(async () => false);
    const { ports } = ownedPorts(calls, {
      getStopTeamGeneration: () => stopGeneration,
      setRuntimeAdapterRun: (_teamName, owner) => {
        runtimeOwner = owner;
      },
      clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: clearPrimaryLane,
    });
    const params = launchParams(async (input) => {
      await input.onInvocationBoundary?.();
      input.onInvocationDispatched?.();
      dispatched.resolve(undefined);
      await releaseResult.promise;
      return runtimeResult({
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
    });
    params.adapter.stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: false,
      members: {},
      warnings: [],
      diagnostics: ['stop confirmation unavailable'],
    }));

    const launch = runOpenCodeTeamRuntimeAdapterLaunch(params, ports);
    await dispatched.promise;
    stopGeneration += 1;
    releaseResult.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(clearPrimaryLane).not.toHaveBeenCalled();
    expect(runtimeOwner!).toMatchObject({
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/repo/runtime',
      members: { alice: { model: 'openai/gpt-5' } },
    });
  });

  it('reports transaction-bound known-no-start after exact dispatched cleanup', async () => {
    const calls: string[] = [];
    const dispatched = deferred<void>();
    const releaseResult = deferred<void>();
    let stopGeneration = 0;
    const { ports } = ownedPorts(calls, {
      getStopTeamGeneration: () => stopGeneration,
    });
    const params = launchParams(async (input) => {
      await input.onInvocationBoundary?.();
      input.onInvocationDispatched?.();
      dispatched.resolve(undefined);
      await releaseResult.promise;
      return runtimeResult();
    });
    params.request.rosterLaunchBinding = {
      transactionId: 'transaction-1',
      teamName: 'team-a',
      rosterFingerprint: 'roster-1',
      rosterRevision: 'revision-1',
      launchCommandId: 'command-1',
    };
    params.adapter.stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));

    const launch = runOpenCodeTeamRuntimeAdapterLaunch(params, ports);
    await dispatched.promise;
    stopGeneration += 1;
    releaseResult.resolve(undefined);

    await expect(launch).resolves.toEqual({
      runId: 'run-1',
      launchStatus: 'not_started',
    });
    expect(params.adapter.stop).toHaveBeenCalledTimes(1);
    expect(calls).toContain('clearPrimaryLaneIfOwned');
  });

  it('retains the primary pre-invocation classification when run-owned cleanup also fails', async () => {
    const calls: string[] = [];
    const adapterError = new Error('adapter exploded');
    const { ports } = ownedPorts(calls, {
      clearOpenCodeRuntimeLaneStorage: async () => {
        throw new Error('storage cleanup exploded');
      },
      deleteRuntimeOwnershipIfCurrent: () => {
        throw new Error('ownership cleanup exploded');
      },
      invalidateRuntimeSnapshotCaches: () => {
        throw new Error('cache cleanup exploded');
      },
      deleteProvisioningRunIfCurrent: () => {
        throw new Error('provisioning cleanup exploded');
      },
    });

    await expect(
      runOpenCodeTeamRuntimeAdapterLaunch(
        launchParams(async () => {
          throw adapterError;
        }),
        ports
      )
    ).rejects.toMatchObject({
      name: 'RosterLaunchKnownNoStartError',
      message: expect.stringContaining(adapterError.message),
      cleanupDiagnostics: ['partial OpenCode lane cleanup remains durably targetable'],
    });
  });

  it.each(['clean_success', 'partial_pending'] as const)(
    'writes no artifact for %s',
    async (teamLaunchState) => {
      const calls: string[] = [];
      const write = vi.fn(async () => undefined);
      const { ports } = ownedPorts(calls, {
        launchFailureArtifacts: { write },
      });
      await runOpenCodeTeamRuntimeAdapterLaunch(
        launchParams(async () => runtimeResult({ teamLaunchState })),
        ports
      );
      expect(write).not.toHaveBeenCalled();
    }
  );

  it.each(['launch', 'persistence', 'progress'] as const)(
    'writes zero and performs only owned cleanup when authority is lost during %s',
    async (lossPoint) => {
      const calls: string[] = [];
      const gate = deferred<void>();
      const write = vi.fn(async () => undefined);
      const owned = ownedPorts(calls, { launchFailureArtifacts: { write } });
      const adapter = async () => {
        calls.push('adapter.launch');
        if (lossPoint === 'launch') await gate.promise;
        return failedRuntimeResult();
      };
      if (lossPoint === 'persistence') {
        owned.ports.persistOpenCodeRuntimeAdapterLaunchResult = async (result) => {
          calls.push('persistLaunchResult:start');
          await gate.promise;
          return { result, snapshot: failedSnapshot() };
        };
      }
      if (lossPoint === 'progress') {
        const original = owned.ports.setRuntimeAdapterProgress;
        owned.ports.setRuntimeAdapterProgress = (nextProgress, onProgress) => {
          const result = original(nextProgress, onProgress);
          if (nextProgress.state === 'failed') owned.setOwner('newer-run');
          return result;
        };
      }

      const launch = runOpenCodeTeamRuntimeAdapterLaunch(launchParams(adapter), owned.ports);
      if (lossPoint === 'launch') {
        await waitForCall(calls, 'adapter.launch');
        owned.setOwner('newer-run');
        gate.resolve(undefined);
      } else if (lossPoint === 'persistence') {
        await waitForCall(calls, 'persistLaunchResult:start');
        owned.setOwner('newer-run');
        gate.resolve(undefined);
      }
      await expect(launch).resolves.toEqual({ runId: 'run-1' });
      expect(write).not.toHaveBeenCalled();
      expect(calls).not.toContain('clearLaneStorage');
      expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
      expect(calls).toContain('clearPrimaryLaneIfOwned');
    }
  );

  it('does not delete newer ownership when authority is lost during the artifact wait', async () => {
    const calls: string[] = [];
    const artifact = deferred<void>();
    const owned = ownedPorts(calls, {
      persistOpenCodeRuntimeAdapterLaunchResult: async (result) => ({
        result,
        snapshot: failedSnapshot(),
      }),
      launchFailureArtifacts: {
        write: async () => {
          calls.push('artifact:start');
          await artifact.promise;
        },
      },
    });
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => failedRuntimeResult()),
      owned.ports
    );
    await waitForCall(calls, 'artifact:start');
    owned.setOwner('newer-run');
    artifact.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(calls).not.toContain('clearLaneStorage');
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
    expect(calls).toContain('clearPrimaryLaneIfOwned');
  });

  it('passes expectedRunId and skips ownership deletion when superseded during storage cleanup', async () => {
    const calls: string[] = [];
    const cleanup = deferred<void>();
    const cleanupInputs: unknown[] = [];
    const owned = ownedPorts(calls, {
      persistOpenCodeRuntimeAdapterLaunchResult: async (result) => ({
        result,
        snapshot: failedSnapshot(),
      }),
      clearOpenCodeRuntimeLaneStorage: async (cleanupInput) => {
        calls.push('clearLaneStorage:start');
        cleanupInputs.push(cleanupInput);
        await cleanup.promise;
      },
    });
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => failedRuntimeResult()),
      owned.ports
    );
    await waitForCall(calls, 'clearLaneStorage:start');
    owned.setOwner('newer-run');
    cleanup.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(cleanupInputs).toEqual([
      expect.objectContaining({ expectedRunId: 'run-1', laneId: 'primary' }),
    ]);
    expect(calls).not.toContain('deleteRuntimeOwnershipIfCurrent');
  });

  it('consumes cancellation once at terminal handling and writes nothing', async () => {
    const calls: string[] = [];
    const launchGate = deferred<void>();
    let cancelled = false;
    let consumeCount = 0;
    const write = vi.fn(async () => undefined);
    const owned = ownedPorts(calls, {
      launchFailureArtifacts: { write },
      isCancelledRuntimeAdapterRunId: () => cancelled,
      consumeCancelledRuntimeAdapterRunId: () => {
        consumeCount += 1;
        const wasCancelled = cancelled;
        cancelled = false;
        return wasCancelled;
      },
    });
    const launch = runOpenCodeTeamRuntimeAdapterLaunch(
      launchParams(async () => {
        calls.push('adapter:waiting');
        await launchGate.promise;
        return failedRuntimeResult();
      }),
      owned.ports
    );
    await waitForCall(calls, 'adapter:waiting');
    cancelled = true;
    launchGate.resolve(undefined);

    await expect(launch).resolves.toEqual({ runId: 'run-1' });
    expect(consumeCount).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitForCall(calls: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50 && !calls.includes(expected); attempt += 1) {
    await Promise.resolve();
  }
  expect(calls).toContain(expected);
}

function launchParams(
  launch: (input: TeamRuntimeLaunchInput) => Promise<TeamRuntimeLaunchResult>
): Parameters<typeof runOpenCodeTeamRuntimeAdapterLaunch>[0] {
  return {
    adapter: {
      launch: async (input: TeamRuntimeLaunchInput) => {
        return launch(input);
      },
      stop: async (input: TeamRuntimeStopInput) => ({
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      }),
    } as unknown as TeamLaunchRuntimeAdapter,
    request: {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'openai/gpt-5',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    },
    members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    prompt: 'launch',
    onProgress: vi.fn(),
  };
}

function fakeRosterLaunchBinding(): NonNullable<TeamCreateRequest['rosterLaunchBinding']> {
  return {
    transactionId: '11111111-1111-4111-8111-111111111111',
    teamName: 'team-a',
    rosterFingerprint: 'roster-fingerprint',
    rosterRevision: 'roster-revision',
    launchCommandId: '11111111-1111-4111-8111-111111111111',
    executionProof: {
      authorityId: 'authority',
      generation: 1,
      completedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:01:00.000Z',
      requestDigest: 'request-digest',
    },
    launchRequestFingerprint: 'launch-request',
  };
}

function failedRuntimeResult(): TeamRuntimeLaunchResult {
  return runtimeResult({
    teamLaunchState: 'partial_failure',
    diagnostics: ['inventory timeout\nconfig timeout'],
    members: {
      alice: {
        memberName: 'alice',
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'readiness timed out',
        diagnostics: ['readiness timed out'],
      },
    },
  });
}

function failedSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 3,
    teamName: 'team-a',
    expectedMembers: ['alice'],
    bootstrapExpectedMembers: ['alice'],
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members: {
      alice: {
        name: 'alice',
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'readiness timed out',
        lastEvaluatedAt: '2026-01-01T00:00:02.000Z',
        diagnostics: ['readiness timed out'],
      },
    },
    summary: {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
    },
    updatedAt: '2026-01-01T00:00:02.000Z',
  } as PersistedTeamLaunchSnapshot;
}

function ownedPorts(
  calls: string[],
  overrides: Partial<OpenCodeRuntimeAdapterLaunchPorts> = {}
): {
  ports: OpenCodeRuntimeAdapterLaunchPorts;
  setOwner(runId: string | undefined): void;
} {
  let owner: string | undefined;
  const ports: OpenCodeRuntimeAdapterLaunchPorts = {
    ...basePorts(calls),
    setProvisioningRun: (_teamName, runId) => {
      calls.push('setProvisioningRun');
      owner = runId;
    },
    getProvisioningRun: () => owner,
    ...overrides,
  };
  return {
    ports,
    setOwner: (runId) => {
      owner = runId;
    },
  };
}

function basePorts(calls: string[]): OpenCodeRuntimeAdapterLaunchPorts {
  return {
    randomUUID: () => 'run-1',
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getStopAllTeamsGeneration: () => 0,
    getStopTeamGeneration: () => 0,
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
    isCancelledRuntimeAdapterRunId: () => false,
    consumeCancelledRuntimeAdapterRunId: () => false,
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: async () => {
      calls.push('clearPrimaryLaneIfOwned');
      return true;
    },
    persistOpenCodeRuntimeAdapterLaunchResult: async (result) => {
      calls.push('persistLaunchResult');
      return { result };
    },
    launchFailureArtifacts: {
      write: async () => {
        calls.push('writeLaunchFailureArtifact');
      },
    },
    syncOpenCodeRuntimeToolApprovals: () => {
      calls.push('syncApprovals');
    },
    clearOpenCodeRuntimeLaneStorage: async () => {
      calls.push('clearLaneStorage');
    },
    deleteRuntimeOwnershipIfCurrent: () => {
      calls.push('deleteRuntimeOwnershipIfCurrent');
    },
    setRuntimeAdapterRun: () => {
      calls.push('setRuntimeRun');
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
