import { describe, expect, it, vi } from 'vitest';

import {
  launchMixedSecondaryLaneIfNeeded,
  launchQueuedMixedSecondaryLaneInBackground,
  type MixedSecondaryLaunchQueuePorts,
  type MixedSecondaryLaunchQueueRun,
} from '../TeamProvisioningMixedSecondaryLaunchQueue';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchPhase, PersistedTeamLaunchSnapshot } from '@shared/types';

interface TestRun extends MixedSecondaryLaunchQueueRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  mixedSecondaryLanes: MixedSecondaryRuntimeLaneState[];
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
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
    mixedSecondaryLanes: [],
    ...input,
  };
}

function createSnapshot(launchPhase: PersistedTeamLaunchPhase): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: '2026-07-03T00:00:00.000Z',
    launchPhase,
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
    teamLaunchState: launchPhase === 'finished' ? 'clean_success' : 'partial_pending',
  };
}

function createFailureResult(input: {
  runId: string;
  teamName: string;
  memberName: string;
  message: string;
}): TeamRuntimeLaunchResult {
  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members: {
      [input.memberName]: {
        memberName: input.memberName,
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: input.message,
        diagnostics: [input.message],
      },
    },
    warnings: [],
    diagnostics: [input.message],
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
  overrides: Partial<MixedSecondaryLaunchQueuePorts<TestRun>> = {}
): MixedSecondaryLaunchQueuePorts<TestRun> {
  return {
    nowMs: vi.fn<() => number>(() => 1234),
    randomUuid: vi.fn<() => string>(() => 'generated-run-id'),
    teamsBasePath: vi.fn<() => string>(() => '/teams'),
    clearOpenCodeRuntimeLaneStorage: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['clearOpenCodeRuntimeLaneStorage']
    >(async () => undefined),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['upsertOpenCodeRuntimeLaneIndexEntry']
    >(async () => undefined),
    deleteSecondaryRuntimeRun:
      vi.fn<MixedSecondaryLaunchQueuePorts<TestRun>['deleteSecondaryRuntimeRun']>(),
    launchSingleMixedSecondaryLane: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
    >(async () => undefined),
    publishMixedSecondaryLaneStatusChange: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['publishMixedSecondaryLaneStatusChange']
    >(async () => undefined),
    persistLaunchStateSnapshot: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['persistLaunchStateSnapshot']
    >(async (_run, launchPhase) => createSnapshot(launchPhase)),
    readLaunchState: vi.fn<MixedSecondaryLaunchQueuePorts<TestRun>['readLaunchState']>(async () =>
      createSnapshot('active')
    ),
    getOpenCodeRuntimeAdapter: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['getOpenCodeRuntimeAdapter']
    >(() => createAdapter()),
    getMixedSecondaryLaunchPhase: vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['getMixedSecondaryLaunchPhase']
    >(() => 'active'),
    createUnexpectedMixedSecondaryLaneFailureResult:
      vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['createUnexpectedMixedSecondaryLaneFailureResult']
      >(createFailureResult),
    logger: {
      warn: vi.fn<(message: string) => void>(),
    },
    ...overrides,
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolvePromise: (() => void) | null = null;
  let rejectPromise: ((error: unknown) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

describe('TeamProvisioningMixedSecondaryLaunchQueue', () => {
  it('no-ops queued launch guard for non-queued or already scheduled lanes', () => {
    const finishedLane = createLane({ state: 'finished' });
    const scheduledLane = createLane({ launchScheduled: true });
    const run = createRun({ mixedSecondaryLanes: [finishedLane, scheduledLane] });
    const ports = createPorts();

    launchQueuedMixedSecondaryLaneInBackground(run, finishedLane, ports);
    launchQueuedMixedSecondaryLaneInBackground(run, scheduledLane, ports);

    expect(ports.nowMs).not.toHaveBeenCalled();
    expect(ports.randomUuid).not.toHaveBeenCalled();
    expect(ports.launchSingleMixedSecondaryLane).not.toHaveBeenCalled();
    expect(run.mixedSecondaryLaneLaunchQueue).toBeUndefined();
  });

  it('initializes queued lanes and chains launch after the previous queue promise', async () => {
    const lane = createLane();
    const previous = createDeferred();
    const run = createRun({
      mixedSecondaryLanes: [lane],
      mixedSecondaryLaneLaunchQueue: previous.promise,
    });
    const ports = createPorts();

    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);

    expect(lane.queuedAtMs).toBe(1234);
    expect(lane.launchScheduled).toBe(true);
    expect(lane.runId).toBe('generated-run-id');
    expect(ports.launchSingleMixedSecondaryLane).not.toHaveBeenCalled();

    previous.resolve();
    await run.mixedSecondaryLaneLaunchQueue;

    expect(lane.state).toBe('launching');
    expect(ports.launchSingleMixedSecondaryLane).toHaveBeenCalledWith(run, lane);
  });

  it('cleans up and finishes a canceled queued lane before launch', async () => {
    const lane = createLane();
    const run = createRun({ cancelRequested: true, mixedSecondaryLanes: [lane] });
    const ports = createPorts();

    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
    await run.mixedSecondaryLaneLaunchQueue;

    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
    });
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith(
      'team-a',
      'secondary:opencode:bob'
    );
    expect(lane.state).toBe('finished');
    expect(ports.launchSingleMixedSecondaryLane).not.toHaveBeenCalled();
    expect(ports.publishMixedSecondaryLaneStatusChange).not.toHaveBeenCalled();
  });

  it('records degraded result and publishes the finished state after launch failure', async () => {
    const lane = createLane({ diagnostics: ['existing diagnostic'], warnings: ['old warning'] });
    const run = createRun({ mixedSecondaryLanes: [lane] });
    const publishStates: MixedSecondaryRuntimeLaneState['state'][] = [];
    const ports = createPorts({
      launchSingleMixedSecondaryLane: vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
      >(async () => {
        throw new Error('launch exploded');
      }),
      publishMixedSecondaryLaneStatusChange: vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['publishMixedSecondaryLaneStatusChange']
      >(async (_run, publishedLane) => {
        publishStates.push(publishedLane.state);
      }),
    });

    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
    await run.mixedSecondaryLaneLaunchQueue;

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] OpenCode secondary lane secondary:opencode:bob crashed during launch orchestration: launch exploded'
    );
    expect(ports.createUnexpectedMixedSecondaryLaneFailureResult).toHaveBeenCalledWith({
      runId: 'generated-run-id',
      teamName: 'team-a',
      memberName: 'Bob',
      message: 'launch exploded',
    });
    expect(lane.result).toMatchObject({
      runId: 'generated-run-id',
      teamLaunchState: 'partial_failure',
      members: {
        Bob: {
          launchState: 'failed_to_start',
          hardFailureReason: 'launch exploded',
        },
      },
    });
    expect(lane.warnings).toEqual([]);
    expect(lane.diagnostics).toEqual(['existing diagnostic', 'launch exploded']);
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
      diagnostics: ['launch exploded'],
    });
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith(
      'team-a',
      'secondary:opencode:bob'
    );
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, lane);
    expect(publishStates).toEqual(['finished']);
    expect(lane.state).toBe('finished');
  });

  it('returns the read launch state when mixed secondary launch is canceled or killed', async () => {
    const run = createRun({ processKilled: true, mixedSecondaryLanes: [createLane()] });
    const snapshot = createSnapshot('active');
    const ports = createPorts({
      readLaunchState: vi.fn<MixedSecondaryLaunchQueuePorts<TestRun>['readLaunchState']>(
        async () => snapshot
      ),
    });

    await expect(launchMixedSecondaryLaneIfNeeded(run, ports)).resolves.toBe(snapshot);

    expect(ports.readLaunchState).toHaveBeenCalledWith('team-a');
    expect(ports.persistLaunchStateSnapshot).not.toHaveBeenCalled();
  });

  it('persists finished when there are no mixed secondary lanes', async () => {
    const run = createRun({ mixedSecondaryLanes: [] });
    const ports = createPorts();

    await launchMixedSecondaryLaneIfNeeded(run, ports);

    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
    expect(ports.getOpenCodeRuntimeAdapter).not.toHaveBeenCalled();
  });

  it('marks every lane failed and persists finished when the adapter is missing', async () => {
    const lanes = [
      createLane({ member: { name: 'Bob', providerId: 'opencode' } }),
      createLane({
        laneId: 'secondary:opencode:sue',
        member: { name: 'Sue', providerId: 'opencode' },
        runId: 'existing-run-id',
      }),
    ];
    const run = createRun({ mixedSecondaryLanes: lanes });
    const ports = createPorts({
      getOpenCodeRuntimeAdapter: vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['getOpenCodeRuntimeAdapter']
      >(() => null),
    });

    await launchMixedSecondaryLaneIfNeeded(run, ports);

    expect(lanes.map((lane) => lane.state)).toEqual(['finished', 'finished']);
    expect(lanes[0].result).toMatchObject({
      runId: 'generated-run-id',
      teamLaunchState: 'partial_failure',
      members: {
        Bob: {
          launchState: 'failed_to_start',
          hardFailureReason: 'opencode_runtime_adapter_missing',
          diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
        },
      },
      diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
    });
    expect(lanes[0].diagnostics).toEqual([
      'OpenCode runtime adapter is not registered for mixed team launch.',
    ]);
    expect(lanes[1].result?.runId).toBe('existing-run-id');
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledTimes(2);
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
  });

  it('schedules queued lanes and persists the current mixed secondary launch phase', async () => {
    const lanes = [createLane(), createLane({ laneId: 'secondary:opencode:sue' })];
    const run = createRun({ mixedSecondaryLanes: lanes });
    const ports = createPorts();

    await launchMixedSecondaryLaneIfNeeded(run, ports);
    await run.mixedSecondaryLaneLaunchQueue;

    expect(lanes.map((lane) => lane.launchScheduled)).toEqual([true, true]);
    expect(ports.getMixedSecondaryLaunchPhase).toHaveBeenCalledWith(run);
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
    expect(ports.launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(2);
  });
});
