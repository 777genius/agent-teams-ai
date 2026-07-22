import { describe, expect, it, vi } from 'vitest';

import {
  launchSingleMixedSecondaryLaneWithPorts,
  type MixedSecondaryLaneLaunchFlowPorts,
  type MixedSecondaryLaneLaunchFlowRun,
} from '../TeamProvisioningMixedSecondaryLaneLaunchFlow';

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

function createLaunchResult(
  input: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
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
    nowMs: vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockReturnValue(1250),
    randomUuid: vi.fn<() => string>(() => 'lane-run-id'),
    teamsBasePath: vi.fn<() => string>(() => '/teams'),
    isStoppingSecondaryRuntimeTeam: vi.fn<(teamName: string) => boolean>(() => false),
    clearOpenCodeRuntimeLaneStorage: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['clearOpenCodeRuntimeLaneStorage']
    >(async () => undefined),
    deleteSecondaryRuntimeRun: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['deleteSecondaryRuntimeRun']
    >(),
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
    setSecondaryRuntimeRun: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['setSecondaryRuntimeRun']
    >(),
    prepareOpenCodeRuntimeLaneForLaunchGeneration: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['prepareOpenCodeRuntimeLaneForLaunchGeneration']
    >(async () => ({ diagnostics: [] })),
    buildOpenCodeSecondaryAppManagedLaunchPrompt: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['buildOpenCodeSecondaryAppManagedLaunchPrompt']
    >(async () => 'app managed prompt'),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['guardCommittedOpenCodeSecondaryLaneEvidence']
    >(async ({ result }) => result),
    syncOpenCodeRuntimeToolApprovals: vi.fn<
      MixedSecondaryLaneLaunchFlowPorts<TestRun>['syncOpenCodeRuntimeToolApprovals']
    >(),
    ...overrides,
  };
}

describe('TeamProvisioningMixedSecondaryLaneLaunchFlow', () => {
  it('resets stale launch generation state and retries a stale manifest launch failure', async () => {
    const staleMessage = 'Bridge server runtime manifest high watermark is stale';
    const launch = vi
      .fn<TeamLaunchRuntimeAdapter['launch']>()
      .mockRejectedValueOnce(new Error(`OpenCode bridge failed: ${staleMessage}`))
      .mockResolvedValueOnce(createLaunchResult());
    const adapter = createAdapter(launch);
    const lane = createLane({ diagnostics: ['requested diagnostic'] });
    const run = createRun();
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn<
        MixedSecondaryLaneLaunchFlowPorts<TestRun>['getOpenCodeRuntimeAdapter']
      >(() => adapter),
      prepareOpenCodeRuntimeLaneForLaunchGeneration: vi
        .fn<MixedSecondaryLaneLaunchFlowPorts<TestRun>['prepareOpenCodeRuntimeLaneForLaunchGeneration']>()
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

  it('marks definitive partial failures degraded and deletes the secondary runtime run', async () => {
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
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith(
      'team-a',
      'secondary:opencode:bob'
    );
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
});
