import { describe, expect, it, vi } from 'vitest';

import {
  type MixedSecondaryLaneLaunchSetupPorts,
  type MixedSecondaryLaneLaunchSetupRun,
  setupMixedSecondaryLaneLaunch,
} from '../TeamProvisioningMixedSecondaryLaneLaunchSetup';

import type { TeamLaunchRuntimeAdapter } from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

interface TestRun extends MixedSecondaryLaneLaunchSetupRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  request: { cwd: string };
}

function createLane(
  input: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:bob',
    providerId: 'opencode',
    member: { name: 'Bob', providerId: 'opencode' },
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
    request: { cwd: '/repo/root' },
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

function createAdapter(): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
  } as TeamLaunchRuntimeAdapter;
}

function createPorts(
  overrides: Partial<MixedSecondaryLaneLaunchSetupPorts<TestRun>> = {}
): MixedSecondaryLaneLaunchSetupPorts<TestRun> {
  return {
    nowMs: vi.fn<() => number>(() => 1000),
    randomUuid: vi.fn<() => string>(() => 'generated-run-id'),
    teamsBasePath: vi.fn<() => string>(() => '/teams'),
    isStoppingSecondaryRuntimeTeam: vi.fn<(teamName: string) => boolean>(() => false),
    clearOpenCodeRuntimeLaneStorage: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['clearOpenCodeRuntimeLaneStorage']
    >(async () => undefined),
    deleteSecondaryRuntimeRun:
      vi.fn<MixedSecondaryLaneLaunchSetupPorts<TestRun>['deleteSecondaryRuntimeRun']>(),
    getOpenCodeRuntimeAdapter: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['getOpenCodeRuntimeAdapter']
    >(() => createAdapter()),
    migrateLegacyOpenCodeRuntimeState: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['migrateLegacyOpenCodeRuntimeState']
    >(async () => ({ degraded: false, diagnostics: [] })),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['upsertOpenCodeRuntimeLaneIndexEntry']
    >(async () => undefined),
    buildOpenCodeSecondaryLaneTimingDiagnostic: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['buildOpenCodeSecondaryLaneTimingDiagnostic']
    >(() => 'timing'),
    publishMixedSecondaryLaneStatusChange: vi.fn<
      MixedSecondaryLaneLaunchSetupPorts<TestRun>['publishMixedSecondaryLaneStatusChange']
    >(async () => undefined),
    readLaunchState: vi.fn<MixedSecondaryLaneLaunchSetupPorts<TestRun>['readLaunchState']>(
      async () => createSnapshot()
    ),
    setSecondaryRuntimeRun:
      vi.fn<MixedSecondaryLaneLaunchSetupPorts<TestRun>['setSecondaryRuntimeRun']>(),
    ...overrides,
  };
}

describe('TeamProvisioningMixedSecondaryLaneLaunchSetup', () => {
  it('aborts before adapter lookup with storage cleanup and a cancelled result', async () => {
    const lane = createLane();
    const run = createRun({ cancelRequested: true });
    const ports = createPorts({
      clearOpenCodeRuntimeLaneStorage: vi.fn<
        MixedSecondaryLaneLaunchSetupPorts<TestRun>['clearOpenCodeRuntimeLaneStorage']
      >(async () => {
        throw new Error('best effort failure');
      }),
    });

    const result = await setupMixedSecondaryLaneLaunch(run, lane, ports);

    expect(result.outcome).toBe('cancelled');
    expect(lane.state).toBe('finished');
    expect(lane.launchStartedAtMs).toBe(1000);
    expect(lane.queuedAtMs).toBe(1000);
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
    });
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith(
      'team-a',
      'secondary:opencode:bob'
    );
    expect(ports.getOpenCodeRuntimeAdapter).not.toHaveBeenCalled();
  });

  it('handles a missing adapter by finishing the lane with failed result and diagnostics', async () => {
    const lane = createLane({ queuedAtMs: 900, diagnostics: ['requested diagnostic'] });
    const run = createRun();
    const ports = createPorts({
      nowMs: vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1075),
      getOpenCodeRuntimeAdapter: vi.fn<
        MixedSecondaryLaneLaunchSetupPorts<TestRun>['getOpenCodeRuntimeAdapter']
      >(() => null),
    });

    const result = await setupMixedSecondaryLaneLaunch(run, lane, ports);

    const message = 'OpenCode runtime adapter is not registered for mixed team launch.';
    expect(result.outcome).toBe('handled');
    expect(lane.state).toBe('finished');
    expect(lane.runId).toBe('generated-run-id');
    expect(lane.result?.runId).toBe(lane.runId);
    expect(ports.randomUuid).toHaveBeenCalledTimes(1);
    expect(lane.launchFinishedAtMs).toBe(1075);
    expect(lane.result).toMatchObject({
      runId: 'generated-run-id',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      warnings: [],
      diagnostics: ['requested diagnostic', message, 'timing'],
      members: {
        Bob: {
          memberName: 'Bob',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          hardFailure: true,
          hardFailureReason: 'opencode_runtime_adapter_missing',
          diagnostics: [message, 'timing'],
        },
      },
    });
    expect(lane.warnings).toEqual([]);
    expect(lane.diagnostics).toEqual(['requested diagnostic', message, 'timing']);
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(ports.migrateLegacyOpenCodeRuntimeState).not.toHaveBeenCalled();
  });

  it('upserts a degraded lane index entry when legacy migration reports degradation', async () => {
    const lane = createLane();
    const run = createRun();
    const ports = createPorts({
      migrateLegacyOpenCodeRuntimeState: vi.fn<
        MixedSecondaryLaneLaunchSetupPorts<TestRun>['migrateLegacyOpenCodeRuntimeState']
      >(async () => ({ degraded: true, diagnostics: ['legacy degraded'] })),
    });

    const result = await setupMixedSecondaryLaneLaunch(run, lane, ports);

    expect(result.outcome).toBe('ready');
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
      diagnostics: ['legacy degraded'],
    });
  });

  it('initializes active setup state, runtime run, status publish, and previous launch state', async () => {
    const previousLaunchState = createSnapshot();
    const lane = createLane({
      member: { name: 'Bob', providerId: 'opencode', cwd: ' /repo/member ' },
      diagnostics: ['requested diagnostic'],
    });
    const run = createRun({ request: { cwd: '/repo/request' } });
    const ports = createPorts({
      migrateLegacyOpenCodeRuntimeState: vi.fn<
        MixedSecondaryLaneLaunchSetupPorts<TestRun>['migrateLegacyOpenCodeRuntimeState']
      >(async () => ({ degraded: false, diagnostics: ['migrated diagnostic'] })),
      readLaunchState: vi.fn<MixedSecondaryLaneLaunchSetupPorts<TestRun>['readLaunchState']>(
        async () => previousLaunchState
      ),
    });

    const result = await setupMixedSecondaryLaneLaunch(run, lane, ports);

    expect(result).toMatchObject({
      outcome: 'ready',
      laneRunId: 'generated-run-id',
      laneCwd: '/repo/member',
      requestedDiagnostics: ['requested diagnostic'],
      previousLaunchState,
    });
    expect(lane).toMatchObject({
      state: 'launching',
      runId: 'generated-run-id',
      warnings: [],
      diagnostics: ['requested diagnostic', 'migrated diagnostic'],
      launchStartedAtMs: 1000,
      queuedAtMs: 1000,
    });
    expect(ports.setSecondaryRuntimeRun).toHaveBeenCalledWith({
      teamName: 'team-a',
      runId: 'generated-run-id',
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      memberName: 'Bob',
      cwd: '/repo/member',
    });
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(ports.readLaunchState).toHaveBeenCalledWith('team-a');
    expect(
      vi.mocked(ports.publishMixedSecondaryLaneStatusChange).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(ports.readLaunchState).mock.invocationCallOrder[0]);
  });

  it('aborts after migration and index upsert with cleanup and a cancelled result', async () => {
    const lane = createLane();
    const run = createRun();
    const ports = createPorts({
      isStoppingSecondaryRuntimeTeam: vi
        .fn<(teamName: string) => boolean>()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      migrateLegacyOpenCodeRuntimeState: vi.fn<
        MixedSecondaryLaneLaunchSetupPorts<TestRun>['migrateLegacyOpenCodeRuntimeState']
      >(async () => ({ degraded: false, diagnostics: ['migrated diagnostic'] })),
    });

    const result = await setupMixedSecondaryLaneLaunch(run, lane, ports);

    expect(result.outcome).toBe('cancelled');
    expect(lane.state).toBe('finished');
    expect(ports.migrateLegacyOpenCodeRuntimeState).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
    });
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: ['migrated diagnostic'],
    });
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
    });
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith(
      'team-a',
      'secondary:opencode:bob'
    );
    expect(ports.setSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.publishMixedSecondaryLaneStatusChange).not.toHaveBeenCalled();
    expect(ports.readLaunchState).not.toHaveBeenCalled();
  });
});
