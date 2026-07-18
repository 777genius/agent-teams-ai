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

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../../runtime';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

type OpenCodeMemberLanePlan = Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
type OpenCodeMember = OpenCodeMemberLanePlan['allMembers'][number];

const testTeamsBasePath = '/safe-test/teams';

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
  it('builds the OpenCode aggregate provisioning run defaults without launching runtime work', () => {
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
      expectedMembers: ['alice', 'bob'],
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
      'setProvisioningRun',
      'setProgress:validating',
      'resetTransientState',
      'readLaunchState',
      'clearPersistedLaunchState',
      'setRun',
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

  it('records failed aggregate progress while retaining a surviving primary runtime', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];

    await runOpenCodeWorktreeRootAggregateLaunch(
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
        launchOpenCodeAggregatePrimaryLane: async () => {
          calls.push('launchPrimary');
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
                runtimePid: 1001,
                sessionId: 'session-alice',
                diagnostics: [],
              },
            },
          });
        },
        launchSingleMixedSecondaryLane: async (_run, lane) => {
          calls.push(`launchSecondary:${lane.laneId}`);
          lane.diagnostics.push('secondary failed');
          lane.result = runtimeResult({ teamLaunchState: 'partial_failure' });
        },
        summarizeOpenCodeAggregateLaunchState: () => {
          calls.push('summarizeLaunchState');
          return 'partial_failure';
        },
      }
    );

    expect(calls).toContain('setProgress:failed');
    expect(calls).toContain('setAliveRun');
    expect(calls).not.toContain('deleteAliveRun');
    expect(calls).not.toContain('deleteRuntimeRun');
    expect(calls).toContain('emitTeamProcessChange:failed');
  });

  it('cleans aggregate lane storage and records diagnostics when launch throws', async () => {
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
          launchOpenCodeAggregatePrimaryLane: async () => {
            calls.push('launchPrimary');
            throw new Error('primary launch failed');
          },
        }
      )
    ).rejects.toThrow('primary launch failed');

    expect(calls).toEqual([
      'setProvisioningRun',
      'setProgress:validating',
      'resetTransientState',
      'readLaunchState',
      'clearPersistedLaunchState',
      'setRun',
      'invalidateRuntimeSnapshotCaches',
      'setProgress:spawning',
      'launchPrimary',
      'setProgress:failed',
      'getTeamsBasePath',
      'clearLaneStorage:secondary:opencode:bob',
      'deleteSecondaryRuntimeRun:secondary:opencode:bob',
      'getTeamsBasePath',
      'clearLaneStorage:primary',
      'deleteProvisioningRunIfCurrent',
      'deleteRuntimeRun',
      'deleteAliveRun',
      'invalidateRuntimeSnapshotCaches',
    ]);
  });

  it('stops the owned primary OpenCode adapter process before clearing storage on launch error', async () => {
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

    // The owned primary adapter process must be stopped in the ERROR handler
    // (after the launch got as far as the secondary lane), BEFORE its storage is
    // cleared - otherwise the adapter process is orphaned. The catch-branch stop
    // is distinguished from the preflight stop by occurring AFTER launchSecondary.
    const launchSecondaryIdx = calls.indexOf('launchSecondary');
    const catchStopIdx = calls.lastIndexOf('stopPreviousRuntimeRun');
    const clearPrimaryIdx = calls.indexOf('clearLaneStorage:primary');
    expect(launchSecondaryIdx).toBeGreaterThanOrEqual(0);
    expect(catchStopIdx).toBeGreaterThan(launchSecondaryIdx); // stop happened in the catch
    expect(clearPrimaryIdx).toBeGreaterThan(catchStopIdx); // stop before storage clear
  });

  it('aggregates stop rejection and preserves runtime tracking and storage evidence', async () => {
    const alice = member('alice');
    const bob = member('bob');
    const calls: string[] = [];
    let runtimeOwnedByLaunch = false;

    const error = await runOpenCodeWorktreeRootAggregateLaunch(
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
          runtimeOwnedByLaunch ? { runId: 'run-open-code', providerId: 'opencode' } : undefined,
        stopOpenCodeRuntimeAdapterTeam: async () => {
          calls.push('stopOwnedRuntime');
          throw new Error('adapter stop rejected');
        },
        launchSingleMixedSecondaryLane: async () => {
          calls.push('launchSecondary');
          runtimeOwnedByLaunch = true;
          throw new Error('secondary launch failed');
        },
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: 'OpenCode aggregate launch failed and runtime cleanup was not confirmed',
      errors: [
        expect.objectContaining({ message: 'secondary launch failed' }),
        expect.objectContaining({ message: 'adapter stop rejected' }),
      ],
    });
    expect(calls.indexOf('stopOwnedRuntime')).toBeGreaterThan(calls.indexOf('launchSecondary'));
    expect(calls).toContain('setProgress:failed');
    expect(calls).not.toContain('clearLaneStorage:primary');
    expect(calls).not.toContain('clearLaneStorage:secondary:opencode:bob');
    expect(calls).not.toContain('deleteSecondaryRuntimeRun:secondary:opencode:bob');
    expect(calls).not.toContain('deleteRuntimeRun');
    expect(calls).not.toContain('deleteAliveRun');
    expect(calls).not.toContain('deleteProvisioningRunIfCurrent');
  });
});

function baseAggregatePorts(calls: string[]): OpenCodeWorktreeRootAggregateLaunchPorts {
  const provisioningRuns = new Map<string, string>();
  return {
    randomUUID: () => 'run-open-code',
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
    setRun: () => {
      calls.push('setRun');
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
    deleteAliveRunId: () => {
      calls.push('deleteAliveRun');
    },
    deleteRuntimeAdapterRun: () => {
      calls.push('deleteRuntimeRun');
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
    },
    deleteSecondaryRuntimeRun: (_teamName, laneId) => {
      calls.push(`deleteSecondaryRuntimeRun:${laneId}`);
    },
  };
}
