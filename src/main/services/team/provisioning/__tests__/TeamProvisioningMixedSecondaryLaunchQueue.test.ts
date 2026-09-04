import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  launchMixedSecondaryLaneIfNeeded,
  launchQueuedMixedSecondaryLaneInBackground,
  type MixedSecondaryLaunchQueuePorts,
  type MixedSecondaryLaunchQueueRun,
} from '../TeamProvisioningMixedSecondaryLaunchQueue';
import {
  OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS,
  OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS,
  OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC,
} from '../TeamProvisioningOpenCodeSharedRuntimeFailurePolicy';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimePreLaunchGate,
} from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchPhase, PersistedTeamLaunchSnapshot } from '@shared/types';

interface TestRun extends MixedSecondaryLaunchQueueRun {
  teamName: string;
  request: { cwd: string };
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
    request: { cwd: '/workspace/root' },
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
    deleteSecondaryRuntimeRunIfOwned: vi.fn(() => true),
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

  it('caches shared preflight failures by resolved cwd and finishes only matching skipped lanes', async () => {
    const rootFailure = 'Failed to query OpenCode models: request timed out';
    const first = createLane({
      laneId: 'secondary:opencode:first',
      member: { name: 'First', providerId: 'opencode', cwd: '/workspace/root' },
    });
    const sameProject = createLane({
      laneId: 'secondary:opencode:same',
      member: { name: 'Same', providerId: 'opencode', cwd: '/workspace/root/./' },
    });
    const healthySibling = createLane({
      laneId: 'secondary:opencode:healthy',
      member: { name: 'Healthy', providerId: 'opencode', cwd: '/workspace/other' },
    });
    const run = createRun({ mixedSecondaryLanes: [first, sameProject, healthySibling] });
    const launchSingleMixedSecondaryLane = vi.fn<
      MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
    >(async (_run, lane) => {
      lane.state = 'finished';
      lane.result =
        lane === first
          ? createFailureResult({
              runId: lane.runId!,
              teamName: run.teamName,
              memberName: lane.member.name,
              message: rootFailure,
            })
          : {
              runId: lane.runId!,
              teamName: run.teamName,
              launchPhase: 'finished',
              teamLaunchState: 'clean_success',
              members: {},
              warnings: [],
              diagnostics: [],
            };
    });
    const ports = createPorts({ launchSingleMixedSecondaryLane });

    await launchMixedSecondaryLaneIfNeeded(run, ports, { waitForCompletion: true });

    expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(2);
    expect(launchSingleMixedSecondaryLane).toHaveBeenNthCalledWith(1, run, first);
    expect(launchSingleMixedSecondaryLane).toHaveBeenNthCalledWith(2, run, healthySibling);
    expect(sameProject).toMatchObject({
      state: 'finished',
      result: {
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          Same: {
            launchState: 'failed_to_start',
            hardFailure: true,
          },
        },
      },
    });
    expect(sameProject.diagnostics).toEqual([
      rootFailure,
      expect.stringContaining(
        'This lane was not attempted because it uses the same project runtime.'
      ),
    ]);
    expect(run.mixedSecondarySharedRuntimeFailuresByProject).toEqual(
      // The queue keys failures by resolved cwd, which anchors to a drive on Windows.
      new Map([
        [
          path.resolve('/workspace/root'),
          { rootCause: rootFailure, transient: true, recordedAtMs: 1234 },
        ],
      ])
    );
    expect(ports.publishMixedSecondaryLaneStatusChange).toHaveBeenCalledWith(run, sameProject);
  });

  it('finishes a canceled queued lane without clearing storage it never acquired', async () => {
    const lane = createLane();
    const run = createRun({ cancelRequested: true, mixedSecondaryLanes: [lane] });
    const ports = createPorts();

    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
    await run.mixedSecondaryLaneLaunchQueue;

    expect(ports.clearOpenCodeRuntimeLaneStorage).not.toHaveBeenCalled();
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.deleteSecondaryRuntimeRunIfOwned).not.toHaveBeenCalled();
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
    expect(lanes.map((lane) => lane.runId)).toEqual(['generated-run-id', 'existing-run-id']);
    expect(lanes.every((lane) => lane.result?.runId === lane.runId)).toBe(true);
    expect(ports.randomUuid).toHaveBeenCalledTimes(1);
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
  it('fences late rejected launch cleanup to the generation captured when queued', async () => {
    const lane = createLane({ runId: 'cancelled-run' });
    const run = createRun({ mixedSecondaryLanes: [lane] });
    let releaseLaunch!: () => void;
    let markLaunchEntered!: () => void;
    const launchEntered = new Promise<void>((resolve) => {
      markLaunchEntered = resolve;
    });
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const ports = createPorts({
      launchSingleMixedSecondaryLane: vi.fn(async () => {
        markLaunchEntered();
        await launchReleased;
        throw new Error('cancelled launch returned late');
      }),
    });
    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
    await launchEntered;
    run.cancelRequested = true;
    lane.runId = 'fresh-run';
    lane.state = 'launching';
    releaseLaunch();
    await run.mixedSecondaryLaneLaunchQueue;

    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: lane.laneId,
      expectedRunId: 'cancelled-run',
    });
    expect(ports.deleteSecondaryRuntimeRunIfOwned).toHaveBeenCalledWith(
      'team-a',
      lane.laneId,
      'cancelled-run'
    );
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane).toMatchObject({ runId: 'fresh-run', state: 'launching' });
  });

  const MODELS_QUERY_TIMEOUT =
    'Failed to query OpenCode models: OpenCode command timed out after 10000ms';
  const HOST_UNHEALTHY = 'OpenCode host is not healthy: exit 1';
  const CONNECTION_REFUSED = 'OpenCode readiness bridge failed: internal_error: ECONNREFUSED';
  // Proof that the state-changing bridge command never ran, so the lane may relaunch.
  const RETRYABLE_PRE_LAUNCH_GATE: TeamRuntimePreLaunchGate = {
    blocked: true,
    reason: 'unknown_error',
    retryable: true,
  };

  function gatedFailureResult(input: {
    runId: string;
    teamName: string;
    memberName: string;
    message: string;
  }): TeamRuntimeLaunchResult {
    return { ...createFailureResult(input), preLaunchGate: RETRYABLE_PRE_LAUNCH_GATE };
  }

  function cleanResult(runId: string, teamName: string): TeamRuntimeLaunchResult {
    return {
      runId,
      teamName,
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {},
      warnings: [],
      diagnostics: [],
    };
  }

  async function drainTransientBackoff(run: TestRun): Promise<void> {
    await vi.advanceTimersByTimeAsync(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS);
    await run.mixedSecondaryLaneLaunchQueue;
  }

  it('retries a gated models-query timeout once and leaves the project unblocked on success', async () => {
    vi.useFakeTimers();
    try {
      const lane = createLane();
      const run = createRun({ mixedSecondaryLanes: [lane] });
      const launchSingleMixedSecondaryLane = vi
        .fn<MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']>()
        .mockImplementationOnce(async (_run, launchedLane) => {
          launchedLane.state = 'finished';
          launchedLane.result = gatedFailureResult({
            runId: launchedLane.runId!,
            teamName: run.teamName,
            memberName: launchedLane.member.name,
            message: MODELS_QUERY_TIMEOUT,
          });
        })
        .mockImplementationOnce(async (_run, launchedLane) => {
          launchedLane.state = 'finished';
          launchedLane.result = cleanResult(launchedLane.runId!, run.teamName);
        });
      const ports = createPorts({ launchSingleMixedSecondaryLane });

      launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
      await drainTransientBackoff(run);

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(2);
      expect(lane.result).toMatchObject({ teamLaunchState: 'clean_success' });
      expect(lane.diagnostics).toContain(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC);
      // A healthy result proves the shared runtime answered: nothing is left blocking.
      expect(run.mixedSecondarySharedRuntimeFailuresByProject?.size ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a timeout that carries no pre-launch gate marker', async () => {
    vi.useFakeTimers();
    try {
      const lane = createLane();
      const run = createRun({ mixedSecondaryLanes: [lane] });
      const launchSingleMixedSecondaryLane = vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
      >(async (_run, launchedLane) => {
        launchedLane.state = 'finished';
        // No marker: the bridge may already own a host for this lane.
        launchedLane.result = createFailureResult({
          runId: launchedLane.runId!,
          teamName: run.teamName,
          memberName: launchedLane.member.name,
          message: MODELS_QUERY_TIMEOUT,
        });
      });
      const ports = createPorts({ launchSingleMixedSecondaryLane });

      launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
      await drainTransientBackoff(run);

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(1);
      expect(lane.diagnostics).not.toContain(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([HOST_UNHEALTHY, CONNECTION_REFUSED])(
    'keeps %j permanently blocking even with the pre-launch gate marker',
    async (message) => {
      vi.useFakeTimers();
      try {
        let now = 10_000;
        const first = createLane({
          laneId: 'secondary:opencode:first',
          member: { name: 'First', providerId: 'opencode' },
        });
        const late = createLane({
          laneId: 'secondary:opencode:late',
          member: { name: 'Late', providerId: 'opencode' },
        });
        const run = createRun({ mixedSecondaryLanes: [first, late] });
        const launchSingleMixedSecondaryLane = vi.fn<
          MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
        >(async (_run, launchedLane) => {
          launchedLane.state = 'finished';
          launchedLane.result = gatedFailureResult({
            runId: launchedLane.runId!,
            teamName: run.teamName,
            memberName: launchedLane.member.name,
            message,
          });
        });
        const ports = createPorts({ nowMs: vi.fn(() => now), launchSingleMixedSecondaryLane });

        launchQueuedMixedSecondaryLaneInBackground(run, first, ports);
        await drainTransientBackoff(run);
        // Well past the transient TTL: a non-transient record never expires.
        now += 4 * OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS;
        launchQueuedMixedSecondaryLaneInBackground(run, late, ports);
        await drainTransientBackoff(run);

        expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(1);
        expect(launchSingleMixedSecondaryLane).toHaveBeenCalledWith(run, first);
        expect(late.diagnostics).toEqual([
          message,
          expect.stringContaining(
            'This lane was not attempted because it uses the same project runtime.'
          ),
        ]);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('spends the retry budget once: a second gated timeout blocks the sibling lanes', async () => {
    vi.useFakeTimers();
    try {
      const first = createLane({
        laneId: 'secondary:opencode:first',
        member: { name: 'First', providerId: 'opencode' },
      });
      const sibling = createLane({
        laneId: 'secondary:opencode:sibling',
        member: { name: 'Sibling', providerId: 'opencode' },
      });
      const run = createRun({ mixedSecondaryLanes: [first, sibling] });
      const launchSingleMixedSecondaryLane = vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
      >(async (_run, launchedLane) => {
        launchedLane.state = 'finished';
        launchedLane.result = gatedFailureResult({
          runId: launchedLane.runId!,
          teamName: run.teamName,
          memberName: launchedLane.member.name,
          message: MODELS_QUERY_TIMEOUT,
        });
      });
      const ports = createPorts({ launchSingleMixedSecondaryLane });

      launchQueuedMixedSecondaryLaneInBackground(run, first, ports);
      await drainTransientBackoff(run);
      launchQueuedMixedSecondaryLaneInBackground(run, sibling, ports);
      await drainTransientBackoff(run);

      // One retry for the failing lane, no attempt at all for the sibling.
      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(2);
      expect(launchSingleMixedSecondaryLane).toHaveBeenNthCalledWith(1, run, first);
      expect(launchSingleMixedSecondaryLane).toHaveBeenNthCalledWith(2, run, first);
      expect(sibling.diagnostics).toEqual([
        MODELS_QUERY_TIMEOUT,
        expect.stringContaining(
          'This lane was not attempted because it uses the same project runtime.'
        ),
      ]);
      expect(run.mixedSecondarySharedRuntimeFailuresByProject).toEqual(
        new Map([
          [
            path.resolve('/workspace/root'),
            { rootCause: MODELS_QUERY_TIMEOUT, transient: true, recordedAtMs: 1234 },
          ],
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the next lane attempt again once a transient record has expired', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const first = createLane({
        laneId: 'secondary:opencode:first',
        member: { name: 'First', providerId: 'opencode' },
      });
      const late = createLane({
        laneId: 'secondary:opencode:late',
        member: { name: 'Late', providerId: 'opencode' },
      });
      const run = createRun({ mixedSecondaryLanes: [first, late] });
      const launchSingleMixedSecondaryLane = vi.fn<
        MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']
      >(async (_run, launchedLane) => {
        launchedLane.state = 'finished';
        launchedLane.result =
          launchedLane === first
            ? // No pre-launch gate: this lane is not retried in place.
              createFailureResult({
                runId: launchedLane.runId!,
                teamName: run.teamName,
                memberName: launchedLane.member.name,
                message: MODELS_QUERY_TIMEOUT,
              })
            : cleanResult(launchedLane.runId!, run.teamName);
      });
      const ports = createPorts({ nowMs: vi.fn(() => now), launchSingleMixedSecondaryLane });

      launchQueuedMixedSecondaryLaneInBackground(run, first, ports);
      await drainTransientBackoff(run);

      expect(run.mixedSecondarySharedRuntimeFailuresByProject?.size).toBe(1);

      now += OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS;
      launchQueuedMixedSecondaryLaneInBackground(run, late, ports);
      await drainTransientBackoff(run);

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(2);
      expect(launchSingleMixedSecondaryLane).toHaveBeenNthCalledWith(2, run, late);
      expect(late.result).toMatchObject({ teamLaunchState: 'clean_success' });
      expect(run.mixedSecondarySharedRuntimeFailuresByProject?.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not relaunch after the backoff when the lane changed hands meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const lane = createLane();
      const run = createRun({ mixedSecondaryLanes: [lane] });
      const launchSingleMixedSecondaryLane = vi
        .fn<MixedSecondaryLaunchQueuePorts<TestRun>['launchSingleMixedSecondaryLane']>()
        .mockImplementationOnce(async (_run, launchedLane) => {
          launchedLane.state = 'finished';
          launchedLane.result = gatedFailureResult({
            runId: launchedLane.runId!,
            teamName: run.teamName,
            memberName: launchedLane.member.name,
            message: MODELS_QUERY_TIMEOUT,
          });
        });
      const ports = createPorts({ launchSingleMixedSecondaryLane });

      launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
      await vi.advanceTimersByTimeAsync(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS - 1);
      // A manual lane retry re-owned the lane while the backoff was still pending.
      lane.runId = 'successor-run-id';
      await drainTransientBackoff(run);

      expect(launchSingleMixedSecondaryLane).toHaveBeenCalledTimes(1);
      expect(lane.runId).toBe('successor-run-id');
      expect(lane.result).toMatchObject({ teamLaunchState: 'partial_failure' });
    } finally {
      vi.useRealTimers();
    }
  });
});
