import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeAggregateFailureProgress,
  buildOpenCodeAggregateFinalProgress,
  createOpenCodeAggregateProvisioningRun,
  type OpenCodeAggregateProvisioningRun,
  type OpenCodeWorktreeRootAggregateLaunchPorts,
  prepareOpenCodeWorktreeRootAggregateLaunchPreflight,
  runOpenCodeWorktreeRootAggregateLaunch,
} from '../TeamProvisioningOpenCodeAggregateRun';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeStopInput,
} from '../../runtime';
import type { SecondaryRuntimeRunEntry } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

type OpenCodeMemberLanePlan = Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
type OpenCodeMember = OpenCodeMemberLanePlan['allMembers'][number];

const testTeamsBasePath = '/safe-test/teams';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}

function member(name: string, extra: Partial<OpenCodeMember> = {}): OpenCodeMember {
  return {
    name,
    role: 'Engineer',
    providerId: 'opencode',
    ...extra,
  } as OpenCodeMember;
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-open-code',
    teamName: 'open-code-team',
    state: 'spawning',
    message: 'Launching',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function runtimeResult(overrides: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'run-open-code',
    teamName: 'open-code-team',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {},
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

function retainableRuntimeResult(memberName: string): TeamRuntimeLaunchResult {
  return runtimeResult({
    members: {
      [memberName]: {
        memberName,
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
}

function sharedPreflightFailureResult(
  memberName: string,
  message: string
): TeamRuntimeLaunchResult {
  return runtimeResult({
    teamLaunchState: 'partial_failure',
    members: {
      [memberName]: {
        memberName,
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: message,
        diagnostics: [message],
      },
    },
    diagnostics: [message],
  });
}

function request(members: TeamCreateRequest['members']): TeamCreateRequest {
  return {
    teamName: 'open-code-team',
    cwd: '/fake/project',
    providerId: 'opencode',
    members,
  } as TeamCreateRequest;
}

function lanePlan(input: {
  primaryMembers: OpenCodeMember[];
  sideMembers?: OpenCodeMember[];
}): OpenCodeMemberLanePlan {
  return {
    mode: 'pure_opencode_member_lanes',
    primaryMembers: input.primaryMembers,
    allMembers: [...input.primaryMembers, ...(input.sideMembers ?? [])],
    sideLanes: (input.sideMembers ?? []).map((sideMember) => ({
      laneId: `secondary:opencode:${sideMember.name}`,
      providerId: 'opencode',
      member: sideMember,
    })),
  };
}

describe('TeamProvisioningOpenCodeAggregateRun', () => {
  it('builds aggregate defaults with expected members scoped to the primary lane', () => {
    const alice = member('alice', { cwd: '/fake/project' });
    const bob = member('bob', { cwd: '/fake/project/bob' });
    const request = {
      teamName: 'open-code-team',
      cwd: '/fake/project',
      providerId: 'opencode',
      members: [alice],
      description: 'fake launch request',
    } as unknown as TeamCreateRequest;
    const lanePlan: OpenCodeMemberLanePlan = {
      mode: 'pure_opencode_member_lanes',
      primaryMembers: [alice],
      allMembers: [alice, bob],
      sideLanes: [{ laneId: 'secondary:opencode:bob', providerId: 'opencode', member: bob }],
    };
    const onProgress = vi.fn();
    const runProgress = progress();

    const run = createOpenCodeAggregateProvisioningRun({
      runId: 'run-open-code',
      startedAt: '2026-01-01T00:00:00.000Z',
      progress: runProgress,
      request,
      members: [alice, bob],
      lanePlan,
      onProgress,
    });

    expect(run).toMatchObject({
      runId: 'run-open-code',
      teamName: 'open-code-team',
      startedAt: '2026-01-01T00:00:00.000Z',
      progress: runProgress,
      stdoutBuffer: '',
      stderrBuffer: '',
      claudeLogLines: [],
      lastClaudeLogStream: null,
      stdoutLogLineBuf: '',
      stderrLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      deterministicBootstrapMemberSpawnSeen: false,
      deterministicBootstrapMemberResultSeen: false,
      processKilled: false,
      finalizingByTimeout: false,
      cancelRequested: false,
      child: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      expectedMembers: ['alice'],
      allEffectiveMembers: [alice, bob],
      effectiveMembers: [alice],
      launchIdentity: null,
      lastLogProgressAt: 0,
      lastDataReceivedAt: 0,
      lastStdoutReceivedAt: 0,
      stallCheckHandle: null,
      stallWarningIndex: null,
      preStallMessage: null,
      lastRetryAt: 0,
      apiRetryWarningIndex: null,
      apiErrorWarningEmitted: false,
      fsPhase: 'all_files_found',
      waitingTasksSince: null,
      provisioningComplete: false,
      processClosed: false,
      requiresFirstRealTurnSuccess: false,
      firstRealTurnSucceeded: false,
      mcpConfigPath: null,
      memberMcpConfigPaths: [],
      bootstrapSpecPath: null,
      bootstrapUserPromptPath: null,
      isLaunch: true,
      launchStateClearedForRun: false,
      deterministicBootstrap: false,
      workspaceTrustPlan: null,
      workspaceTrustExecution: null,
      workspaceTrustDiagnostics: null,
      workspaceTrustRetryAttempted: false,
      leadRelayCapture: null,
      activeCrossTeamReplyHints: [],
      leadMsgSeq: 0,
      liveLeadTextBuffer: null,
      pendingToolCalls: [],
      pendingDirectCrossTeamSendRefresh: false,
      lastLeadTextEmitMs: 0,
      silentUserDmForward: null,
      silentUserDmForwardClearHandle: null,
      pendingInboxRelayCandidates: [],
      provisioningOutputParts: [],
      provisioningTraceLines: [],
      lastProvisioningTraceKey: null,
      detectedSessionId: null,
      leadActivityState: 'active',
      authFailureRetried: false,
      authRetryInProgress: false,
      leadContextUsage: null,
      spawnContext: null,
      anthropicApiKeyHelper: null,
      pendingPostCompactReminder: false,
      postCompactReminderInFlight: false,
      suppressPostCompactReminderOutput: false,
      pendingGeminiPostLaunchHydration: false,
      geminiPostLaunchHydrationInFlight: false,
      geminiPostLaunchHydrationSent: false,
      suppressGeminiPostLaunchHydrationOutput: false,
      lastDeterministicBootstrapSeq: 0,
      lastMemberSpawnAuditAt: 0,
      lastMemberSpawnAuditConfigReadWarningAt: 0,
    });
    expect(run.request).toEqual({ ...request, members: [alice, bob] });
    expect(run.onProgress).toBe(onProgress);
    expect(run.teamsBasePathsToProbe.length).toBeGreaterThan(0);
    expect(run.mixedSecondaryLanes).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        member: bob,
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ]);
    expect(run.activeToolCalls).toBeInstanceOf(Map);
    expect(run.provisioningOutputIndexByMessageId).toBeInstanceOf(Map);
    expect(run.pendingApprovals).toBeInstanceOf(Map);
    expect(run.processedPermissionRequestIds).toBeInstanceOf(Set);
    expect(run.memberSpawnStatuses).toBeInstanceOf(Map);
    expect(run.memberSpawnToolUseIds).toBeInstanceOf(Map);
    expect(run.pendingMemberRestarts).toBeInstanceOf(Map);
    expect(run.memberSpawnLeadInboxCursorByMember).toBeInstanceOf(Map);
    expect(run.lastMemberSpawnAuditMissingWarningAt).toBeInstanceOf(Map);
  });

  it('projects aggregate final progress for ready, pending, failed, and missing diagnostics', () => {
    expect(
      buildOpenCodeAggregateFinalProgress({
        launching: progress({ warnings: undefined }),
        launchState: 'clean_success',
        laneDiagnostics: [],
        updatedAt: '2026-01-01T00:00:02.000Z',
      })
    ).toMatchObject({
      state: 'ready',
      message: 'OpenCode member lanes are ready',
      messageSeverity: undefined,
      updatedAt: '2026-01-01T00:00:02.000Z',
      error: undefined,
      cliLogsTail: undefined,
      configReady: true,
    });

    expect(
      buildOpenCodeAggregateFinalProgress({
        launching: progress(),
        launchState: 'partial_pending',
        laneDiagnostics: ['waiting for permission'],
        updatedAt: '2026-01-01T00:00:03.000Z',
      })
    ).toMatchObject({
      state: 'ready',
      message: 'OpenCode member lanes are waiting for runtime evidence or permissions',
      messageSeverity: 'warning',
      cliLogsTail: 'waiting for permission',
      error: undefined,
    });

    expect(
      buildOpenCodeAggregateFinalProgress({
        launching: progress(),
        launchState: 'partial_failure',
        laneDiagnostics: ['missing bootstrap', '', 'permission denied'],
        updatedAt: '2026-01-01T00:00:04.000Z',
      })
    ).toMatchObject({
      state: 'failed',
      message: 'OpenCode member lane launch failed readiness gate',
      messageSeverity: 'error',
      error: 'missing bootstrap\npermission denied',
      cliLogsTail: 'missing bootstrap\n\npermission denied',
      configReady: true,
    });

    expect(
      buildOpenCodeAggregateFinalProgress({
        launching: progress(),
        launchState: 'partial_failure',
        laneDiagnostics: [],
        updatedAt: '2026-01-01T00:00:05.000Z',
      }).error
    ).toBe('OpenCode member lane launch failed');

    expect(
      buildOpenCodeAggregateFailureProgress({
        launching: progress(),
        message: 'runtime exploded',
        updatedAt: '2026-01-01T00:00:06.000Z',
      })
    ).toMatchObject({
      state: 'failed',
      message: 'OpenCode member lane launch failed',
      messageSeverity: 'error',
      error: 'runtime exploded',
      cliLogsTail: 'runtime exploded',
    });
  });

  it('runs previous primary and secondary cleanup before recording stop-all cancellation', async () => {
    const calls: string[] = [];
    let stopAllGeneration = 0;
    const previousProgress = progress({ runId: 'pending-run', state: 'spawning' });

    const result = await prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
      {
        teamName: 'open-code-team',
        sourceWarning: 'source warning',
        onProgress: vi.fn(),
      },
      {
        getStopAllTeamsGeneration: () => stopAllGeneration,
        getRuntimeAdapterRun: () => ({ runId: 'old-run', providerId: 'opencode' }),
        stopOpenCodeRuntimeAdapterTeam: async () => {
          calls.push('stopPreviousRuntimeRun');
        },
        hasSecondaryRuntimeRuns: () => true,
        stopMixedSecondaryRuntimeLanes: async () => {
          calls.push('stopSecondaryRuntimeLanes');
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
          expect(teamName).toBe('open-code-team');
          expect(sourceWarning).toBe('source warning');
          return { runId: 'cancelled-run' };
        },
      }
    );

    expect(result).toEqual({ runId: 'cancelled-run' });
    expect(calls).toEqual([
      'stopPreviousRuntimeRun',
      'stopSecondaryRuntimeLanes',
      'cancelPreviousPendingRun',
      'recordCancelledLaunch',
    ]);
  });

  it('coordinates successful aggregate launch side effects without runtime smoke work', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    const provisioningRuns = new Map<string, string>();
    const aliveRuns = new Map<string, string>();
    const runById = new Map<string, OpenCodeAggregateProvisioningRun>();

    const result = await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        sourceWarning: 'source warning',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        setProvisioningRun: (teamName, runId) => {
          calls.push('setProvisioningRun');
          provisioningRuns.set(teamName, runId);
        },
        getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
        getRun: (runId) => runById.get(runId),
        setRun: (runId, run) => {
          calls.push('setRun');
          runById.set(runId, run);
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

    expect(result).toEqual({ runId: 'run-open-code' });
    expect(calls).toEqual([
      'getLaunchCwd',
      'getLaunchCwd',
      'readLaunchState',
      'setProvisioningRun',
      'setProgress:validating',
      'setRun',
      'resetTransientState',
      'clearPersistedLaunchState',
      'invalidateRuntimeSnapshotCaches',
      'setProgress:spawning',
      'launchPrimary',
      'launchSecondary:secondary:opencode:bob',
      'summarizeLaunchState',
      'persistLaunchState:finished',
      'setProgress:ready',
      'setAliveRun',
      'deleteProvisioningRunIfCurrent',
      'invalidateRuntimeSnapshotCaches',
      'emitTeamProcessChange:ready',
    ]);
    expect(aliveRuns.get('open-code-team')).toBe('run-open-code');
    expect(provisioningRuns.has('open-code-team')).toBe(false);
    expect(runById.get('run-open-code')?.provisioningComplete).toBe(true);
  });

  it('validates the primary lane cwd before stopping or mutating team state', async () => {
    const alice = member('alice', { isolation: 'worktree' });
    const calls: string[] = [];
    const ports = baseAggregatePorts(calls);
    ports.getOpenCodeRuntimeLaunchCwd = vi.fn(() => {
      throw new Error('invalid aggregate worktree shape');
    });

    await expect(
      runOpenCodeWorktreeRootAggregateLaunch(
        {
          adapter: {} as TeamLaunchRuntimeAdapter,
          request: request([alice]),
          members: [alice],
          lanePlan: lanePlan({ primaryMembers: [alice] }),
          prompt: 'launch',
          onProgress: vi.fn(),
        },
        ports
      )
    ).rejects.toThrow('invalid aggregate worktree shape');

    expect(calls).toEqual([]);
  });

  it('shares resolved-cwd failures while keeping a healthy sibling lane alive', async () => {
    const alice = member('alice');
    const bob = member('bob', { cwd: '/fake/project/./' });
    const carol = member('carol', { cwd: '/fake/other-project' });
    const calls: string[] = [];
    const rootFailure = 'Failed to query OpenCode models: request timed out';
    let capturedRun: OpenCodeAggregateProvisioningRun | null = null;

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice, bob, carol]),
        members: [alice, bob, carol],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob, carol] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        setRun: (_runId, run) => {
          calls.push('setRun');
          capturedRun = run;
        },
        getRun: () => capturedRun ?? undefined,
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
          return sharedPreflightFailureResult('alice', rootFailure);
        },
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          calls.push(`launchSecondary:${lane.laneId}`);
          lane.state = 'finished';
          lane.result = retainableRuntimeResult(lane.member.name);
        },
        summarizeOpenCodeAggregateLaunchState: () => {
          calls.push('summarizeLaunchState');
          return 'partial_failure';
        },
      }
    );

    const run = capturedRun as OpenCodeAggregateProvisioningRun | null;
    if (!run) throw new Error('Expected captured aggregate run.');
    const bobLane = run.mixedSecondaryLanes[0];
    expect(bobLane).toMatchObject({
      state: 'finished',
      result: {
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
      },
    });
    expect(bobLane.diagnostics).toEqual([
      rootFailure,
      expect.stringContaining(
        'This lane was not attempted because it uses the same project runtime.'
      ),
    ]);
    expect(calls).not.toContain('launchSecondary:secondary:opencode:bob');
    expect(calls).toContain('launchSecondary:secondary:opencode:carol');
    expect(calls).toContain('publishLane:secondary:opencode:bob:finished');
    expect(calls).toContain('setProgress:ready');
    expect(calls).toContain('setAliveRun');
    expect(calls).not.toContain('cleanupRun');
  });

  it('cancels an exact late lane without stopping or clearing newer owners', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    let provisioningOwner = 'run-open-code';
    let primaryOwner: { runId: string; providerId: 'opencode' } | undefined;
    let secondaryOwner:
      | {
          runId: string;
          providerId: 'opencode';
          laneId: string;
          memberName: string;
          cwd: string;
        }
      | undefined;
    const adapterStop = vi.fn().mockResolvedValue({});
    const adapter = { stop: adapterStop } as unknown as TeamLaunchRuntimeAdapter;
    const stopPrimary = vi.fn(async () => {
      calls.push('stopPrimary');
    });

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        getProvisioningRun: () => provisioningOwner,
        getRuntimeAdapterRun: () => primaryOwner,
        stopOpenCodeRuntimeAdapterTeam: stopPrimary,
        getSecondaryRuntimeRun: () => secondaryOwner,
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
          primaryOwner = { runId: 'run-open-code', providerId: 'opencode' };
          return retainableRuntimeResult('alice');
        },
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          calls.push(`launchSecondary:${lane.laneId}`);
          lane.runId = 'old-secondary-run';
          lane.state = 'finished';
          lane.result = retainableRuntimeResult('bob');
          provisioningOwner = 'newer-aggregate-run';
          primaryOwner = { runId: 'newer-aggregate-run', providerId: 'opencode' };
          secondaryOwner = {
            runId: 'newer-secondary-run',
            providerId: 'opencode',
            laneId: lane.laneId,
            memberName: lane.member.name,
            cwd: '/fake/project',
          };
        },
      }
    );

    expect(stopPrimary).not.toHaveBeenCalled();
    expect(adapterStop).not.toHaveBeenCalled();
    expect(calls).not.toContain('clearLaneStorage:primary');
    expect(calls).not.toContain('clearLaneStorage:secondary:opencode:bob');
    expect(calls).not.toContain('setAliveRun');
    expect(calls).toContain('cleanupRun');
  });

  it('retains exact primary ownership and storage when terminal rollback stop fails', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    let primaryStarted = false;
    let secondaryStarted = false;
    const stopOwnedPrimary = vi.fn(async () => {
      calls.push('stopOwnedPrimary');
      throw new Error('primary stop failed');
    });
    const stopOwnedSecondaries = vi.fn(async () => {
      calls.push('stopOwnedSecondaries');
      throw new Error('secondary stop failed');
    });
    const cleanupRun = vi.fn(() => {
      calls.push('cleanupRun');
    });

    const result = await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        getRuntimeAdapterRun: () =>
          primaryStarted ? { runId: 'run-open-code', providerId: 'opencode' } : undefined,
        stopOpenCodeRuntimeAdapterTeam: stopOwnedPrimary,
        hasSecondaryRuntimeRuns: () => secondaryStarted,
        stopMixedSecondaryRuntimeLanes: stopOwnedSecondaries,
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
          primaryStarted = true;
          return runtimeResult();
        },
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          calls.push(`launchSecondary:${lane.laneId}`);
          secondaryStarted = true;
          lane.diagnostics.push('secondary failed');
          lane.result = runtimeResult({ teamLaunchState: 'partial_failure' });
        },
        summarizeOpenCodeAggregateLaunchState: () => {
          calls.push('summarizeLaunchState');
          return 'partial_failure';
        },
        cleanupRun,
      }
    );

    expect(result).toEqual({ runId: 'run-open-code' });
    expect(stopOwnedPrimary).toHaveBeenCalledTimes(1);
    expect(stopOwnedPrimary).toHaveBeenCalledWith('open-code-team', 'run-open-code');
    expect(stopOwnedSecondaries).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();

    const stopPrimaryIndex = calls.indexOf('stopOwnedPrimary');
    const clearSecondaryIndex = calls.indexOf('clearLaneStorage:secondary:opencode:bob');
    const clearPrimaryIndex = calls.indexOf('clearLaneStorage:primary');
    expect(stopPrimaryIndex).toBeGreaterThan(calls.indexOf('persistLaunchState:finished'));
    expect(clearSecondaryIndex).toBe(-1);
    expect(clearPrimaryIndex).toBe(-1);
    expect(calls).toContain('setProgress:failed');
    expect(calls).not.toContain('deleteAliveRun');
    expect(calls).not.toContain('deleteRuntimeRun');
    expect(calls).not.toContain('deleteProvisioningRunIfCurrent');
    expect(calls).not.toContain('setAliveRun');
    expect(calls).toContain('emitTeamProcessChange:failed');
  });

  it('fences delivery and publishes exact ownership before a slow untracked primary rollback stop', async () => {
    const alice = member('alice');
    const calls: string[] = [];
    const stopStarted = deferred();
    const stopRelease = deferred();
    const provisioningRuns = new Map<string, string>();
    const runtimeOwners = new Map<
      string,
      { runId: string; providerId: 'opencode'; cwd?: string }
    >();
    const progresses = new Map<string, TeamProvisioningProgress>();
    const runs = new Map<string, OpenCodeAggregateProvisioningRun>();
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => {
      stopStarted.resolve();
      await stopRelease.promise;
      return {
        runId: stopInput.runId,
        teamName: stopInput.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const delivery = new TeamProvisioningRunTrackingDeliveryHelper({
      state: {
        provisioningRunByTeam: provisioningRuns,
        aliveRunByTeam: new Map(),
        runs,
        runtimeAdapterProgressByRunId: progresses,
        runtimeAdapterRunByTeam: runtimeOwners,
        getRetainedProvisioningProgressMap: () => new Map(),
      },
      ports: {
        notifyTeamWatchScopeChanged: vi.fn(),
        isTeamAlive: vi.fn(() => true),
        hasAlivePersistedTeamProcess: vi.fn(() => true),
        hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
        logDebug: vi.fn(),
      },
      liveRuntimeSnapshotCacheTtlMs: 2_000,
      persistedRuntimeSnapshotCacheTtlMs: 10_000,
    });

    const launching = runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: adapterStop } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        setProvisioningRun: (teamName, runId) => {
          provisioningRuns.set(teamName, runId);
        },
        getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
        getRuntimeAdapterRun: (teamName) => runtimeOwners.get(teamName),
        setRuntimeAdapterRun: (teamName, owner) => {
          runtimeOwners.set(teamName, owner);
        },
        setRuntimeAdapterProgress: (nextProgress) => {
          progresses.set(nextProgress.runId, nextProgress);
          return nextProgress;
        },
        setRun: (runId, run) => {
          runs.set(runId, run);
        },
        getRun: (runId) => runs.get(runId),
        launchOpenCodeAggregatePrimaryLane: async () => {
          throw new Error('primary launch failed after process spawn');
        },
      }
    );
    await stopStarted.promise;

    expect(runtimeOwners.get('open-code-team')).toMatchObject({
      runId: 'run-open-code',
      providerId: 'opencode',
      cwd: '/fake/project',
    });
    expect(progresses.get('run-open-code')?.state).toBe('disconnected');
    expect(delivery.canDeliverToTrackedRuntimeRun('open-code-team', 'run-open-code')).toBe(false);
    expect(delivery.canDeliverToOpenCodeRuntimeForTeam('open-code-team')).toBe(false);

    stopRelease.resolve();
    await expect(launching).rejects.toThrow('primary launch failed after process spawn');
  });

  it('fences delivery while retaining a secondary owner through a slow rollback stop', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    const stopStarted = deferred();
    const stopRelease = deferred();
    const provisioningRuns = new Map<string, string>();
    const progresses = new Map<string, TeamProvisioningProgress>();
    const runs = new Map<string, OpenCodeAggregateProvisioningRun>();
    let secondaryOwner: SecondaryRuntimeRunEntry | undefined;
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => {
      stopStarted.resolve();
      await stopRelease.promise;
      return {
        runId: stopInput.runId,
        teamName: stopInput.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const delivery = new TeamProvisioningRunTrackingDeliveryHelper({
      state: {
        provisioningRunByTeam: provisioningRuns,
        aliveRunByTeam: new Map(),
        runs,
        runtimeAdapterProgressByRunId: progresses,
        runtimeAdapterRunByTeam: new Map(),
        getRetainedProvisioningProgressMap: () => new Map(),
      },
      ports: {
        notifyTeamWatchScopeChanged: vi.fn(),
        isTeamAlive: vi.fn(() => true),
        hasAlivePersistedTeamProcess: vi.fn(() => true),
        hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
        logDebug: vi.fn(),
      },
      liveRuntimeSnapshotCacheTtlMs: 2_000,
      persistedRuntimeSnapshotCacheTtlMs: 10_000,
    });

    const launching = runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: adapterStop } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        setProvisioningRun: (teamName, runId) => {
          provisioningRuns.set(teamName, runId);
        },
        getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
        setRuntimeAdapterProgress: (nextProgress) => {
          progresses.set(nextProgress.runId, nextProgress);
          return nextProgress;
        },
        setRun: (runId, run) => {
          runs.set(runId, run);
        },
        getRun: (runId) => runs.get(runId),
        getSecondaryRuntimeRun: () => secondaryOwner,
        setSecondaryRuntimeRun: (owner) => {
          secondaryOwner = owner;
        },
        launchOpenCodeAggregatePrimaryLane: async () => runtimeResult(),
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          lane.runId = 'secondary-run';
          lane.state = 'finished';
          lane.result = runtimeResult({ teamLaunchState: 'partial_failure' });
          secondaryOwner = {
            runId: 'secondary-run',
            providerId: 'opencode',
            laneId: lane.laneId,
            memberName: lane.member.name,
            cwd: '/fake/project',
          };
        },
        summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
      }
    );
    await stopStarted.promise;

    expect(secondaryOwner).toMatchObject({
      runId: 'secondary-run',
      laneId: 'secondary:opencode:bob',
    });
    expect(progresses.get('run-open-code')?.state).toBe('disconnected');
    expect(delivery.canDeliverToTrackedRuntimeRun('open-code-team', 'run-open-code')).toBe(false);
    expect(delivery.canDeliverToOpenCodeRuntimeForTeam('open-code-team')).toBe(false);

    stopRelease.resolve();
    await expect(launching).resolves.toEqual({ runId: 'run-open-code' });
  });

  it('retains a failed secondary stop after primary rollback removed team ownership', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    let provisioningOwner: string | undefined;
    let primaryOwner: { runId: string; providerId: 'opencode' } | undefined;
    let secondaryOwner:
      | {
          runId: string;
          providerId: 'opencode';
          laneId: string;
          memberName: string;
          cwd: string;
        }
      | undefined;
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => ({
      runId: stopInput.runId,
      teamName: stopInput.teamName,
      stopped: false,
      members: {},
      warnings: [],
      diagnostics: ['secondary process still running'],
    }));
    const cleanupRun = vi.fn(() => {
      calls.push('cleanupRun');
    });

    const result = await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: adapterStop } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        setProvisioningRun: (_teamName, runId) => {
          calls.push('setProvisioningRun');
          provisioningOwner = runId;
        },
        getProvisioningRun: () => provisioningOwner,
        getRuntimeAdapterRun: () => primaryOwner,
        getSecondaryRuntimeRun: () => secondaryOwner,
        stopOpenCodeRuntimeAdapterTeam: async () => {
          calls.push('stopOwnedPrimary');
          primaryOwner = undefined;
          provisioningOwner = undefined;
        },
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
          primaryOwner = { runId: 'run-open-code', providerId: 'opencode' };
          return runtimeResult();
        },
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          calls.push(`launchSecondary:${lane.laneId}`);
          lane.runId = 'secondary-run';
          lane.state = 'finished';
          lane.diagnostics.push('secondary failed');
          lane.result = runtimeResult({ teamLaunchState: 'partial_failure' });
          secondaryOwner = {
            runId: 'secondary-run',
            providerId: 'opencode',
            laneId: lane.laneId,
            memberName: lane.member.name,
            cwd: '/fake/project',
          };
        },
        summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
        cleanupRun,
      }
    );

    expect(result).toEqual({ runId: 'run-open-code' });
    expect(adapterStop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'secondary-run',
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      })
    );
    expect(secondaryOwner).toMatchObject({
      runId: 'secondary-run',
      laneId: 'secondary:opencode:bob',
    });
    expect(calls).not.toContain('clearLaneStorage:secondary:opencode:bob');
    expect(calls).not.toContain('deleteSecondaryRuntimeRun:secondary:opencode:bob');
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(calls).toContain('emitTeamProcessChange:failed');
  });

  it('does not replace a newer secondary owner after an untracked stop fails', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    let secondaryOwner:
      | {
          runId: string;
          providerId: 'opencode';
          laneId: string;
          memberName: string;
          cwd?: string;
        }
      | undefined;
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => {
      secondaryOwner = {
        runId: 'newer-secondary-run',
        providerId: 'opencode',
        laneId: stopInput.laneId ?? 'primary',
        memberName: 'bob',
        cwd: '/newer-project',
      };
      return {
        runId: stopInput.runId,
        teamName: stopInput.teamName,
        stopped: false,
        members: {},
        warnings: [],
        diagnostics: ['old secondary process still running'],
      };
    });
    const setSecondaryRuntimeRun = vi.fn(
      (
        input: Parameters<OpenCodeWorktreeRootAggregateLaunchPorts['setSecondaryRuntimeRun']>[0]
      ) => {
        secondaryOwner = input;
      }
    );

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: adapterStop } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice, bob]),
        members: [alice, bob],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        getSecondaryRuntimeRun: () => secondaryOwner,
        setSecondaryRuntimeRun,
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          lane.runId = 'old-secondary-run';
          lane.state = 'finished';
          lane.result = runtimeResult({ teamLaunchState: 'partial_failure' });
        },
        summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
      }
    );

    expect(adapterStop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'old-secondary-run',
        laneId: 'secondary:opencode:bob',
      })
    );
    expect(setSecondaryRuntimeRun).toHaveBeenCalledOnce();
    expect(setSecondaryRuntimeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'old-secondary-run',
        laneId: 'secondary:opencode:bob',
      })
    );
    expect(secondaryOwner).toMatchObject({
      runId: 'newer-secondary-run',
      laneId: 'secondary:opencode:bob',
      cwd: '/newer-project',
    });
    expect(calls).not.toContain('clearLaneStorage:secondary:opencode:bob');
    expect(calls).not.toContain('cleanupRun');
  });

  it('cleans aggregate lane storage and records diagnostics when launch throws', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    const stopUntrackedPrimary = vi.fn(async (stopInput: TeamRuntimeStopInput) => {
      calls.push('stopUntrackedPrimary');
      return {
        runId: stopInput.runId,
        teamName: stopInput.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });

    await expect(
      runOpenCodeWorktreeRootAggregateLaunch(
        {
          adapter: { stop: stopUntrackedPrimary } as unknown as TeamLaunchRuntimeAdapter,
          request: request([alice, bob]),
          members: [alice, bob],
          lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
          prompt: 'launch',
          onProgress: vi.fn(),
        },
        {
          ...baseAggregatePorts(calls),
          launchOpenCodeAggregatePrimaryLane: async () => {
            calls.push('launchPrimary');
            throw new Error('primary launch failed');
          },
        }
      )
    ).rejects.toThrow('primary launch failed');

    expect(calls).toEqual([
      'getLaunchCwd',
      'getLaunchCwd',
      'readLaunchState',
      'setProvisioningRun',
      'setProgress:validating',
      'setRun',
      'resetTransientState',
      'clearPersistedLaunchState',
      'invalidateRuntimeSnapshotCaches',
      'setProgress:spawning',
      'launchPrimary',
      'setRuntimeRun',
      'setProgress:disconnected',
      'invalidateRuntimeSnapshotCaches',
      'stopUntrackedPrimary',
      'getTeamsBasePath',
      'clearLaneStorage:primary',
      'setProgress:failed',
      'deleteRuntimeRun',
      'deleteAliveRun',
      'deleteProvisioningRunIfCurrent',
      'cleanupRun',
      'invalidateRuntimeSnapshotCaches',
    ]);
    expect(stopUntrackedPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-open-code',
        teamName: 'open-code-team',
        laneId: 'primary',
        reason: 'cleanup',
        force: true,
      })
    );
  });

  it('delegates owned primary stop and storage cleanup without issuing a second lane clear', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];

    await expect(
      runOpenCodeWorktreeRootAggregateLaunch(
        {
          adapter: {} as TeamLaunchRuntimeAdapter,
          request: request([alice, bob]),
          members: [alice, bob],
          lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
          prompt: 'launch',
          onProgress: vi.fn(),
        },
        {
          ...baseAggregatePorts(calls),
          // The primary lane came up and is owned by this run, then a later step throws.
          getRuntimeAdapterRun: () => ({ runId: 'run-open-code', providerId: 'opencode' }),
          hasSecondaryRuntimeRuns: () => true,
          launchOpenCodeAggregatePrimaryLane: async () => {
            calls.push('launchPrimary');
            return runtimeResult();
          },
          launchSingleMixedSecondaryLane: async () => {
            calls.push('launchSecondary');
            throw new Error('secondary launch failed');
          },
        }
      )
    ).rejects.toThrow('secondary launch failed');

    // The owned primary adapter process must be stopped in the error handler.
    // That stop boundary already owns exact-runtime storage cleanup, so the
    // aggregate rollback must not issue a second unfenced clear.
    const launchSecondaryIdx = calls.indexOf('launchSecondary');
    const catchStopIdx = calls.lastIndexOf('stopPreviousRuntimeRun');
    const clearPrimaryIdx = calls.indexOf('clearLaneStorage:primary');
    expect(launchSecondaryIdx).toBeGreaterThanOrEqual(0);
    expect(catchStopIdx).toBeGreaterThan(launchSecondaryIdx); // stop happened in the catch
    expect(clearPrimaryIdx).toBe(-1);
  });

  it('cleans up the run on terminal failure so it does not leak in the runs map', async () => {
    const alice = member('alice');
    const calls: string[] = [];

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        // A terminal failure (not clean_success / partial_pending) takes the
        // else-branch, which must tear the run down (cleanupRun) rather than
        // register it alive.
        summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
      }
    );

    expect(calls).toContain('cleanupRun');
    expect(calls).not.toContain('setAliveRun');
  });

  it('does not stop or delete a conflicting primary runtime owner on partial failure', async () => {
    const alice = member('alice');
    const calls: string[] = [];
    let primaryStarted = false;
    const stopPrimary = vi.fn(async () => {
      calls.push('stopPrimary');
    });

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        getRuntimeAdapterRun: () =>
          primaryStarted ? { runId: 'newer-run', providerId: 'opencode' } : undefined,
        stopOpenCodeRuntimeAdapterTeam: stopPrimary,
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
          primaryStarted = true;
          return runtimeResult();
        },
        summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
      }
    );

    expect(stopPrimary).not.toHaveBeenCalled();
    expect(calls).not.toContain('deleteRuntimeRun');
    expect(calls).not.toContain('deleteAliveRun');
    expect(calls).toContain('cleanupRun');
  });

  it('does not register alive when the run was superseded/stopped during the launch tail', async () => {
    const alice = member('alice');
    const calls: string[] = [];
    let superseded = false;

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: {} as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        // A concurrent lockless stop takes over the team while the snapshot
        // persists (the last await before the success-tail registration).
        persistLaunchStateSnapshot: async () => {
          superseded = true;
          return null;
        },
        getProvisioningRun: () => (superseded ? 'run-superseded-by-stop' : 'run-open-code'),
      }
    );

    // The success tail must bail out (cleanupRun) instead of resurrecting the run.
    expect(calls).toContain('cleanupRun');
    expect(calls).not.toContain('setAliveRun');
  });

  it('fences primary ownership publication when stop supersedes persistence', async () => {
    const alice = member('alice');
    const calls: string[] = [];
    let superseded = false;
    const stopUntrackedPrimary = vi.fn(async (stopInput: TeamRuntimeStopInput) => ({
      runId: stopInput.runId,
      teamName: stopInput.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));

    await runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: stopUntrackedPrimary } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        getProvisioningRun: () => (superseded ? undefined : 'run-open-code'),
        launchOpenCodeAggregatePrimaryLane: async (input) => {
          calls.push('launchPrimary');
          superseded = true;
          expect(input.assertStillCurrentAfterPersistence).toBeTypeOf('function');
          input.assertStillCurrentAfterPersistence?.();
          throw new Error('unreachable after authority fence');
        },
      }
    );

    expect(stopUntrackedPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-open-code',
        teamName: 'open-code-team',
        laneId: 'primary',
        reason: 'cleanup',
        force: true,
      })
    );
    expect(calls).toContain('cleanupRun');
    expect(calls).not.toContain('setAliveRun');
    expect(calls).not.toContain('launchSecondary');
  });

  it('cleans a persistence-race cancellation by exact run without deleting successor state', async () => {
    const alice = member('alice');
    const calls: string[] = [];
    const persistenceStarted = deferred();
    const persistenceGate = deferred();
    const previousLaunchState = {
      teamName: 'open-code-team',
      expectedMembers: ['previous-member'],
      members: {},
    } as unknown as PersistedTeamLaunchSnapshot;
    let provisioningOwner = 'run-open-code';
    const runtimeOwnership: {
      current?: { runId: string; providerId: 'opencode' };
    } = {};
    let persistedSnapshot = 'previous-snapshot';
    const stopExactPrimary = vi.fn(async (stopInput: TeamRuntimeStopInput) => {
      calls.push('stopExactPrimary');
      return {
        runId: stopInput.runId,
        teamName: stopInput.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const clearPersistedLaunchState = vi.fn<
      OpenCodeWorktreeRootAggregateLaunchPorts['clearPersistedLaunchState']
    >(async (_teamName, options) => {
      calls.push(`clearPersistedLaunchState:${options?.expectedRunId}`);
      if (options?.expectedRunId === undefined || options.expectedRunId === provisioningOwner) {
        persistedSnapshot = 'cleared';
      }
    });

    const launching = runOpenCodeWorktreeRootAggregateLaunch(
      {
        adapter: { stop: stopExactPrimary } as unknown as TeamLaunchRuntimeAdapter,
        request: request([alice]),
        members: [alice],
        lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [] }),
        prompt: 'launch',
        onProgress: vi.fn(),
      },
      {
        ...baseAggregatePorts(calls),
        readLaunchState: async () => {
          calls.push('readLaunchState');
          return previousLaunchState;
        },
        clearPersistedLaunchState,
        getProvisioningRun: () => provisioningOwner,
        getRuntimeAdapterRun: () => runtimeOwnership.current,
        launchOpenCodeAggregatePrimaryLane: async (input) => {
          calls.push('launchPrimary');
          persistenceStarted.resolve();
          await persistenceGate.promise;
          input.assertStillCurrentAfterPersistence?.();
          throw new Error('unreachable after authority fence');
        },
      }
    );
    await persistenceStarted.promise;

    provisioningOwner = 'successor-run';
    runtimeOwnership.current = { runId: 'successor-run', providerId: 'opencode' };
    persistedSnapshot = 'successor-snapshot';
    persistenceGate.resolve();
    await expect(launching).resolves.toEqual({ runId: 'run-open-code' });

    expect(clearPersistedLaunchState).toHaveBeenNthCalledWith(1, 'open-code-team');
    expect(clearPersistedLaunchState).toHaveBeenNthCalledWith(2, 'open-code-team', {
      expectedRunId: 'run-open-code',
    });
    expect(persistedSnapshot).toBe('successor-snapshot');
    expect(stopExactPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-open-code',
        teamName: 'open-code-team',
        laneId: 'primary',
        cwd: '/fake/project',
        providerId: 'opencode',
        reason: 'cleanup',
        force: true,
        previousLaunchState,
      })
    );
    expect(calls.indexOf('clearPersistedLaunchState:run-open-code')).toBeGreaterThan(
      calls.indexOf('stopExactPrimary')
    );
    expect(calls).not.toContain('clearLaneStorage:primary');
    expect(calls).toContain('cleanupRun');
    expect(calls).not.toContain('setAliveRun');
  });
});

function baseAggregatePorts(calls: string[]): OpenCodeWorktreeRootAggregateLaunchPorts {
  const provisioningRuns = new Map<string, string>();
  const runs = new Map<string, OpenCodeAggregateProvisioningRun>();
  return {
    randomUUID: () => 'run-open-code',
    nowMs: () => 1_000,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getStopAllTeamsGeneration: () => 0,
    getRuntimeAdapterRun: () => undefined,
    stopOpenCodeRuntimeAdapterTeam: async () => {
      calls.push('stopPreviousRuntimeRun');
    },
    hasSecondaryRuntimeRuns: () => false,
    stopMixedSecondaryRuntimeLanes: async () => {
      calls.push('stopSecondaryRuntimeLanes');
    },
    getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
    getRuntimeAdapterProgress: () => undefined,
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => {
      calls.push('cancelPreviousPendingRun');
    },
    recordCancelledOpenCodeRuntimeAdapterLaunch: () => {
      calls.push('recordCancelledLaunch');
      return { runId: 'cancelled-run' };
    },
    setProvisioningRun: (teamName, runId) => {
      calls.push('setProvisioningRun');
      provisioningRuns.set(teamName, runId);
    },
    getRun: (runId) => runs.get(runId),
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
    setRun: (runId, run) => {
      calls.push('setRun');
      runs.set(runId, run);
    },
    invalidateRuntimeSnapshotCaches: () => {
      calls.push('invalidateRuntimeSnapshotCaches');
    },
    launchOpenCodeAggregatePrimaryLane: async () => {
      calls.push('launchPrimary');
      return runtimeResult();
    },
    launchSingleMixedSecondaryLane: async (_run, lane) => {
      calls.push(`launchSecondary:${lane.laneId}`);
      lane.state = 'finished';
      lane.result = runtimeResult();
    },
    publishMixedSecondaryLaneStatusChange: async (_run, lane) => {
      calls.push(`publishLane:${lane.laneId}:${lane.state}`);
    },
    getOpenCodeRuntimeLaunchCwd: (baseCwd, members) => {
      calls.push('getLaunchCwd');
      return members[0]?.cwd?.trim() || baseCwd;
    },
    getSecondaryRuntimeRun: () => undefined,
    summarizeOpenCodeAggregateLaunchState: () => {
      calls.push('summarizeLaunchState');
      return 'clean_success';
    },
    persistLaunchStateSnapshot: async (_run, launchPhase) => {
      calls.push(`persistLaunchState:${launchPhase}`);
      return null;
    },
    syncRunMemberSpawnStatusesFromSnapshot: () => {
      calls.push('syncSpawnStatuses');
    },
    setAliveRunId: () => {
      calls.push('setAliveRun');
    },
    setRuntimeAdapterRun: () => {
      calls.push('setRuntimeRun');
    },
    deleteAliveRunId: () => {
      calls.push('deleteAliveRun');
    },
    deleteRuntimeAdapterRun: () => {
      calls.push('deleteRuntimeRun');
    },
    cleanupRun: () => {
      calls.push('cleanupRun');
    },
    deleteProvisioningRunIfCurrent: (teamName, runId) => {
      calls.push('deleteProvisioningRunIfCurrent');
      if (provisioningRuns.get(teamName) === runId) {
        provisioningRuns.delete(teamName);
      }
    },
    emitTeamProcessChange: (event) => {
      calls.push(`emitTeamProcessChange:${event.detail}`);
    },
    consumeCancelledRuntimeAdapterRunId: () => false,
    getTeamsBasePath: () => {
      calls.push('getTeamsBasePath');
      return testTeamsBasePath;
    },
    clearOpenCodeRuntimeLaneStorage: async (input) => {
      calls.push(`clearLaneStorage:${input.laneId}`);
      return true;
    },
    setSecondaryRuntimeRun: (input) => {
      calls.push(`setSecondaryRuntimeRun:${input.laneId}`);
    },
    deleteSecondaryRuntimeRun: (_teamName, laneId) => {
      calls.push(`deleteSecondaryRuntimeRun:${laneId}`);
    },
  };
}
