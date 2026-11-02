import { describe, expect, it, vi } from 'vitest';

import {
  launchSingleMixedSecondaryLaneWithPorts,
  type MixedSecondaryLaneLaunchFlowPorts,
  type MixedSecondaryLaneLaunchFlowRun,
} from '../TeamProvisioningMixedSecondaryLaneLaunchFlow';
import {
  type OpenCodeRuntimeStopFlowPorts,
  stopMixedSecondaryRuntimeLanes,
} from '../TeamProvisioningOpenCodeRuntimeStopFlow';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

interface TestRun extends MixedSecondaryLaneLaunchFlowRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  request: {
    cwd: string;
    skipPermissions?: boolean;
    allowExperimentalLocalModels?: boolean;
    color?: string;
    displayName?: string;
  };
}

function createLane(
  input: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:bob',
    providerId: 'opencode',
    member: { name: 'Bob', providerId: 'opencode', role: 'Engineer' },
    runId: null,
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
    ...input,
  };
}

function createRun(input: Partial<TestRun> = {}): TestRun {
  return {
    teamName: 'team-a',
    cancelRequested: false,
    processKilled: false,
    request: {
      cwd: '/repo/root',
      color: '#123456',
      displayName: 'Team A',
    },
    ...input,
  };
}

function createSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: '2026-07-03T00:00:00.000Z',
    launchPhase: 'active',
    expectedMembers: [],
    members: {},
    summary: {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
      shellOnlyPendingCount: 0,
      runtimeProcessPendingCount: 0,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 0,
    },
    teamLaunchState: 'partial_pending',
  };
}

function createLaunchResult(input: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'lane-run-id',
    teamName: 'team-a',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      Bob: {
        memberName: 'Bob',
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        diagnostics: ['member launched'],
      },
    },
    warnings: ['launch warning'],
    diagnostics: ['launch diagnostic'],
    ...input,
  };
}

function createAdapter(
  launch: TeamLaunchRuntimeAdapter['launch'] = vi.fn(async () => createLaunchResult())
): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch,
    reconcile: vi.fn(),
    stop: vi.fn(),
  } as TeamLaunchRuntimeAdapter;
}

function createPorts(
  overrides: Partial<MixedSecondaryLaneLaunchFlowPorts<TestRun>> = {}
): MixedSecondaryLaneLaunchFlowPorts<TestRun> {
  const adapter = createAdapter();
  return {
    nowMs: vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValue(1250),
    randomUuid: vi.fn<() => string>(() => 'lane-run-id'),
    teamsBasePath: vi.fn<() => string>(() => '/teams'),
    isCurrentTrackedRun: vi.fn(() => true),
    isStoppingSecondaryRuntimeTeam: vi.fn<(teamName: string) => boolean>(() => false),
    clearOpenCodeRuntimeLaneStorage: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['clearOpenCodeRuntimeLaneStorage']
    >(async () => undefined),
    deleteSecondaryRuntimeRunIfOwned: vi.fn(() => true),
    deleteSecondaryRuntimeRun:
      vi.fn<MixedSecondaryLaneLaunchFlowPorts<TestRun>['deleteSecondaryRuntimeRun']>(),
    getOpenCodeRuntimeAdapter: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['getOpenCodeRuntimeAdapter']
    >(() => adapter),
    migrateLegacyOpenCodeRuntimeState: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['migrateLegacyOpenCodeRuntimeState']
    >(async () => ({ degraded: false, diagnostics: ['migrated diagnostic'] })),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['upsertOpenCodeRuntimeLaneIndexEntry']
    >(async () => undefined),
    buildOpenCodeSecondaryLaneTimingDiagnostic: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['buildOpenCodeSecondaryLaneTimingDiagnostic']
    >(() => 'timing diagnostic'),
    publishMixedSecondaryLaneStatusChange: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['publishMixedSecondaryLaneStatusChange']
    >(async () => undefined),
    readLaunchState: vi.fn<MixedSecondaryLaneLaunchFlowPorts<TestRun>['readLaunchState']>(
      async () => createSnapshot()
    ),
    setSecondaryRuntimeRun:
      vi.fn<MixedSecondaryLaneLaunchFlowPorts<TestRun>['setSecondaryRuntimeRun']>(),
    prepareOpenCodeRuntimeLaneForLaunchGeneration: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['prepareOpenCodeRuntimeLaneForLaunchGeneration']
    >(async () => ({ diagnostics: [] })),
    buildOpenCodeSecondaryAppManagedLaunchPrompt: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['buildOpenCodeSecondaryAppManagedLaunchPrompt']
    >(async () => 'app managed prompt'),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['guardCommittedOpenCodeSecondaryLaneEvidence']
    >(async ({ result }) => result),
    syncOpenCodeRuntimeToolApprovals:
      vi.fn<MixedSecondaryLaneLaunchFlowPorts<TestRun>['syncOpenCodeRuntimeToolApprovals']>(),
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

describe('TeamProvisioningMixedSecondaryLaneLaunchFlow', () => {
  it.each(['blocked', 'cancelled', 'dispatched', 'unknown'] as const)(
    'joins an exact %s attempt before deciding whether native Stop is needed',
    async (outcome) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lane = createLane();
      const run = createRun();
      const failure = createLaunchResult({
        teamLaunchState: 'partial_failure',
        members: {},
        warnings: [],
        diagnostics: ['preflight unavailable'],
        preLaunchGate: { blocked: true, reason: 'unknown_error', retryable: true },
      });
      const stop = vi.fn(async (input: Parameters<TeamLaunchRuntimeAdapter['stop']>[0]) => ({
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      }));
      const adapter = createAdapter(
        vi.fn(async (input) => {
          if (outcome === 'unknown' || outcome === 'dispatched')
            expect(input.mayDispatch?.()).toBe(true);
          entered();
          await pending;
          if (outcome === 'unknown') throw new Error('native bridge outcome unknown');
          if (outcome === 'cancelled') expect(input.mayDispatch?.()).toBe(false);
          return outcome === 'dispatched' ? createLaunchResult() : failure;
        })
      );
      adapter.stop = stop;
      let registered:
        | import('../TeamProvisioningSecondaryRuntimeRuns').SecondaryRuntimeRunEntry
        | undefined;
      const clear = vi.fn(async () => true);
      const ports = createPorts({
        getOpenCodeRuntimeAdapter: () => adapter,
        setSecondaryRuntimeRun: (input) => {
          registered = input;
        },
        clearOpenCodeRuntimeLaneStorage: clear,
        deleteSecondaryRuntimeRunIfOwned: (_team, _lane, id) => {
          if (registered?.runId !== id) return false;
          registered = undefined;
          return true;
        },
      });
      const launching = launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);
      await started;
      const stopPorts = {
        teamsBasePath: '/teams',
        getSecondaryRuntimeRuns: () => (registered ? [registered] : []),
        stoppingSecondaryRuntimeTeams: new Set<string>(),
        getOpenCodeRuntimeAdapter: () => adapter,
        readLaunchState: async () => null,
        readPersistedTeamProjectPath: () => '/repo/root',
        clearOpenCodeRuntimeLaneStorage: clear,
        deleteSecondaryRuntimeRun: vi.fn(() => {
          registered = undefined;
        }),
        logger: { warn: vi.fn(), info: vi.fn() },
        isRuntimeProcessAlive: () => false,
      } as unknown as OpenCodeRuntimeStopFlowPorts;
      const stopping = stopMixedSecondaryRuntimeLanes(run.teamName, stopPorts);
      await Promise.resolve();
      expect(clear).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      release();
      await Promise.all([launching, stopping]);
      expect(stop).toHaveBeenCalledTimes(outcome === 'unknown' || outcome === 'dispatched' ? 1 : 0);
      if (outcome === 'unknown' || outcome === 'dispatched') expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: 'lane-run-id' }));
      expect(registered).toBeUndefined();
    }
  );

  it('retires only the exact reservation after a definite pre-launch failure', async () => {
    const lane = createLane();
    const failure = createLaunchResult({
      teamLaunchState: 'partial_failure',
      members: {},
      preLaunchGate: { blocked: true, reason: 'not_authenticated', retryable: false },
    });
    const adapter = createAdapter(async () => failure);
    const ports = createPorts({ getOpenCodeRuntimeAdapter: () => adapter });
    await launchSingleMixedSecondaryLaneWithPorts(createRun(), lane, ports);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: lane.laneId,
      expectedRunId: 'lane-run-id',
    });
    expect(ports.deleteSecondaryRuntimeRunIfOwned).toHaveBeenCalledWith(
      'team-a',
      lane.laneId,
      'lane-run-id'
    );
    expect(lane.result?.diagnostics).toContain('launch diagnostic');
  });

  it('clears a definite pre-launch failure without losing a replacement generation', async () => {
    const lane = createLane();
    const run = createRun();
    const failure = createLaunchResult({
      teamLaunchState: 'partial_failure',
      members: {},
      preLaunchGate: { blocked: true, reason: 'not_authenticated', retryable: false },
    });
    const clear = vi.fn(async () => {
      lane.runId = 'replacement';
      return false;
    });
    const remove = vi.fn(() => false);
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: () => createAdapter(async () => failure),
      clearOpenCodeRuntimeLaneStorage: clear,
      deleteSecondaryRuntimeRunIfOwned: remove,
    });
    await launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: 'lane-run-id' }));
    expect(remove).not.toHaveBeenCalled();
    expect(lane.runId).toBe('replacement');
  });

  it.each(['setup', 'generation', 'prompt'] as const)(
    'does not launch when the tracked run changes as %s preparation resolves',
    async (stage) => {
      const run = createRun();
      const lane = createLane({ runId: 'superseded-lane-run' });
      let currentRun = run;
      let markPrepared!: () => void;
      let releasePreparation!: () => void;
      const prepared = new Promise<void>((resolve) => (markPrepared = resolve));
      const preparation = new Promise<void>((resolve) => (releasePreparation = resolve));
      const waitForPreparation = async <T>(result: T): Promise<T> => {
        markPrepared();
        await preparation;
        return result;
      };
      const adapter = createAdapter();
      const ports = createPorts({
        isCurrentTrackedRun: vi.fn((candidate) => candidate === currentRun),
        getOpenCodeRuntimeAdapter: () => adapter,
        ...(stage === 'setup'
          ? { readLaunchState: () => waitForPreparation(createSnapshot()) }
          : stage === 'generation'
            ? {
                prepareOpenCodeRuntimeLaneForLaunchGeneration: () =>
                  waitForPreparation({ diagnostics: [] }),
              }
            : { buildOpenCodeSecondaryAppManagedLaunchPrompt: () => waitForPreparation('prompt') }),
      });

      const launching = launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);
      await prepared;
      releasePreparation();
      currentRun = createRun();
      await launching;

      expect(run).toMatchObject({ cancelRequested: false, processKilled: false });
      expect(adapter.launch).not.toHaveBeenCalled();
      if (stage === 'setup') {
        // Cancellation preceded registration and manifest acquisition.
        expect(ports.clearOpenCodeRuntimeLaneStorage).not.toHaveBeenCalled();
        expect(ports.deleteSecondaryRuntimeRunIfOwned).not.toHaveBeenCalled();
      } else {
        expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
          teamsBasePath: '/teams',
          teamName: run.teamName,
          laneId: lane.laneId,
          expectedRunId: 'superseded-lane-run',
        });
        expect(ports.deleteSecondaryRuntimeRunIfOwned).toHaveBeenCalledWith(
          run.teamName,
          lane.laneId,
          'superseded-lane-run'
        );
      }
      expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
      expect(lane).toMatchObject({ state: 'finished', result: null });
    }
  );

  it('resets stale launch generation state and retries a stale manifest launch failure', async () => {
    const staleMessage = 'Bridge server runtime manifest high watermark is stale';
    const launch = vi
      .fn<TeamLaunchRuntimeAdapter['launch']>()
      .mockRejectedValueOnce(new Error(`OpenCode bridge failed: ${staleMessage}`))
      .mockResolvedValueOnce(createLaunchResult());
    const adapter = createAdapter(launch);
    const lane = createLane({ diagnostics: ['requested diagnostic'] });
    const run = createRun({
      request: {
        cwd: '/repo/root',
        allowExperimentalLocalModels: true,
        color: '#123456',
        displayName: 'Team A',
      },
    });
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn<
        MixedSecondaryLaneLaunchFlowPorts<TestRun>['getOpenCodeRuntimeAdapter']
      >(() => adapter),
      publishMixedSecondaryLaneStatusChange: vi.fn(async (_run, publishedLane) => {
        if (!publishedLane.result) return;
        expect(publishedLane.state).toBe('finished');
        expect(publishedLane.result?.members.Bob.bootstrapConfirmed).toBe(true);
      }),
      prepareOpenCodeRuntimeLaneForLaunchGeneration: vi
        .fn<
          MixedSecondaryLaneLaunchFlowPorts<TestRun>['prepareOpenCodeRuntimeLaneForLaunchGeneration']
        >()
        .mockResolvedValueOnce({ diagnostics: [] })
        .mockResolvedValueOnce({ diagnostics: ['reset stale manifest'] }),
    });

    await launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);

    expect(ports.prepareOpenCodeRuntimeLaneForLaunchGeneration).toHaveBeenNthCalledWith(1, {
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      runId: 'lane-run-id',
      reason: 'mixed_secondary_launch',
    });
    expect(ports.prepareOpenCodeRuntimeLaneForLaunchGeneration).toHaveBeenNthCalledWith(2, {
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      runId: 'lane-run-id',
      reason: 'mixed_secondary_launch_stale_manifest_recovery',
      forceReset: true,
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExperimentalLocalModels: true,
      })
    );
    expect(lane.result?.teamLaunchState).toBe('clean_success');
    expect(lane.state).toBe('finished');
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        runId: 'lane-run-id',
        laneId: 'secondary:opencode:bob',
        cwd: '/repo/root',
        teamColor: '#123456',
        teamDisplayName: 'Team A',
      })
    );
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
  });

  it('keeps a partial failure without a pre-launch gate registered for native Stop', async () => {
    const partialFailure = createLaunchResult({
      teamLaunchState: 'partial_failure',
      members: {
        Bob: {
          memberName: 'Bob',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'provider-auth-failed',
          diagnostics: ['provider auth failed'],
        },
      },
      warnings: [],
      diagnostics: ['provider auth failed'],
    });
    const adapter = createAdapter(vi.fn(async () => partialFailure));
    const lane = createLane({ diagnostics: ['requested diagnostic'] });
    const run = createRun();
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn<
        MixedSecondaryLaneLaunchFlowPorts<TestRun>['getOpenCodeRuntimeAdapter']
      >(() => adapter),
    });

    await launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);

    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenLastCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
      diagnostics: expect.arrayContaining(['provider auth failed', 'timing diagnostic']),
    });
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.result?.teamLaunchState).toBe('partial_failure');
    expect(lane.diagnostics).toEqual(
      expect.arrayContaining([
        'requested diagnostic',
        'migrated diagnostic',
        'provider auth failed',
        'timing diagnostic',
      ])
    );
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenLastCalledWith(run, lane);
    expect(lane.state).toBe('finished');
  });

  it('keeps a successfully launched lane finished when the tail status publish rejects', async () => {
    const lane = createLane();
    const run = createRun();
    const ports = createPorts({
      publishMixedSecondaryLaneStatusChange: vi.fn(async () => {
        throw new Error('publish exploded');
      }),
    });

    await launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);
    await Promise.resolve();
    await Promise.resolve();

    expect(lane.state).toBe('finished');
    expect(lane.result?.teamLaunchState).toBe('clean_success');
    expect(lane.result?.members.Bob?.launchState).toBe('confirmed_alive');
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'degraded' })
    );
    expect(ports.logger.warn).toHaveBeenCalledWith(
      `[team-a] OpenCode secondary lane secondary:opencode:bob status publish failed (finished): publish exploded`
    );
  });

  it('does not block on a tail status publish that never settles', async () => {
    const lane = createLane();
    const run = createRun();
    const ports = createPorts({
      publishMixedSecondaryLaneStatusChange: vi.fn(() => new Promise<void>(() => undefined)),
    });

    await launchSingleMixedSecondaryLaneWithPorts(run, lane, ports);

    expect(lane.state).toBe('finished');
    expect(lane.result?.teamLaunchState).toBe('clean_success');
  });
});
