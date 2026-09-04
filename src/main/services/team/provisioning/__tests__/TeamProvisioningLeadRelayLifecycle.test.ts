import { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildIncompleteLaunchCleanupReason,
  cleanupProvisioningRun,
  shouldFinalizeIncompleteLaunchState,
  type TeamProvisioningCleanupPorts,
  type TeamProvisioningCleanupRun,
} from '../TeamProvisioningCleanup';
import { relayLeadInboxMessagesForTeam } from '../TeamProvisioningLeadInboxRelayFlow';
import {
  createTeamProvisioningLeadInboxRelayFlowPorts,
  createTeamProvisioningLeadInboxRelayPortsBoundary,
  type TeamProvisioningLeadInboxRelayPortsFactoryDeps,
} from '../TeamProvisioningLeadInboxRelayPortsFactory';
import {
  createTeamProvisioningTransientRunStatePorts,
  TeamProvisioningTransientRunState,
  type TeamProvisioningTransientRunStatePorts,
} from '../TeamProvisioningTransientRunState';

import type { LeadInboxRelayFlowRun } from '../TeamProvisioningLeadInboxRelayFlow';
import type { TeamProvisioningProgress } from '@shared/types';

function createRun(overrides: Partial<LeadInboxRelayFlowRun> = {}): LeadInboxRelayFlowRun {
  return {
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    child: {},
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: true,
    leadRelayCapture: null,
    activeCrossTeamReplyHints: [],
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<TeamProvisioningLeadInboxRelayPortsFactoryDeps<LeadInboxRelayFlowRun>> = {}
): TeamProvisioningLeadInboxRelayPortsFactoryDeps<LeadInboxRelayFlowRun> {
  const run = createRun();
  return {
    leadInboxRelayInFlight: new Map(),
    getAliveRunId: vi.fn().mockReturnValue(run.runId),
    getProvisioningRunId: vi.fn().mockReturnValue(null),
    getRun: vi.fn().mockReturnValue(run),
    isCurrentTrackedRun: vi.fn().mockReturnValue(true),
    readConfigForObservation: vi.fn().mockResolvedValue({ members: [] }),
    readLeadInboxMessages: vi.fn().mockResolvedValue([]),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    handleTeammatePermissionRequest: vi.fn(),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn().mockResolvedValue(undefined),
    confirmSameTeamNativeMatches: vi
      .fn()
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true }),
    scheduleSameTeamPersistRetry: vi.fn(),
    scheduleSameTeamDeferredRetry: vi.fn(),
    resolveControlApiBaseUrl: vi.fn().mockResolvedValue('http://127.0.0.1:3000'),
    sendMessageToRun: vi.fn().mockResolvedValue(undefined),
    hasAcceptedLeadWorkSyncReport: vi.fn().mockResolvedValue(true),
    scheduleLeadProofMissingWorkSyncRecovery: vi.fn().mockResolvedValue(false),
    pushLiveLeadTextMessage: vi.fn(),
    pushLiveLeadProcessMessage: vi.fn(),
    persistSentMessage: vi.fn(),
    emitTeamChange: vi.fn(),
    scheduleLeadInboxFollowUpRelay: vi.fn(),
    rememberLeadRecoveryMessage: vi.fn(),
    rememberSuccessfulLeadRecoveryMessage: vi.fn(),
    relayedLeadInboxMessageIds: new Map(),
    trimRelayedSet: vi.fn((relayedIds) => relayedIds),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    sameTeamRunStartSkewMs: 1_000,
    sameTeamNativeDeliveryGraceMs: 15_000,
    recentCrossTeamDeliveryTtlMs: 600_000,
    logger: { debug: vi.fn(), warn: vi.fn() },
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    nowIso: vi.fn().mockReturnValue('2026-01-01T00:01:00.000Z'),
    nowMs: vi.fn().mockReturnValue(123),
    setTimeout: vi.fn().mockReturnValue({} as NodeJS.Timeout),
    clearTimeout: vi.fn(),
    ...overrides,
  };
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Spawning teammates',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function cleanupRun(
  overrides: Partial<TeamProvisioningCleanupRun> = {}
): TeamProvisioningCleanupRun {
  const teamName = overrides.teamName ?? 'team-a';
  const runId = overrides.runId ?? 'run-1';
  return {
    runId,
    teamName,
    progress: progress({ runId, teamName }),
    isLaunch: true,
    launchStateClearedForRun: true,
    provisioningComplete: false,
    cancelRequested: false,
    launchCleanupStateFinalized: false,
    pendingDirectCrossTeamSendRefresh: true,
    timeoutHandle: null,
    silentUserDmForwardClearHandle: null,
    child: null,
    memberSpawnStatuses: new Map([
      ['worker-a', {}],
      ['worker-b', {}],
    ]),
    activeCrossTeamReplyHints: [{}],
    pendingInboxRelayCandidates: [{}],
    pendingApprovals: new Map([['approval-1', {}]]),
    mcpConfigPath: '/tmp/team-a-mcp.json',
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    pendingPostCompactReminder: true,
    postCompactReminderInFlight: true,
    suppressPostCompactReminderOutput: true,
    pendingGeminiPostLaunchHydration: true,
    geminiPostLaunchHydrationInFlight: true,
    suppressGeminiPostLaunchHydrationOutput: true,
    ...overrides,
  };
}

function makeCleanupPorts(
  trackedRunId: string | null
): TeamProvisioningCleanupPorts<TeamProvisioningCleanupRun> & {
  provisioningRunByTeam: Map<string, string>;
  aliveRunByTeam: Map<string, string>;
  leadInboxRelayInFlight: Map<string, string>;
  relayedLeadInboxMessageIds: Map<string, string>;
  leadRecoveryMessageIds: Map<string, string>;
  successfulLeadRecoveryMessageIds: Map<string, string>;
  pendingCrossTeamFirstReplies: Map<string, string>;
  recentCrossTeamLeadDeliveryMessageIds: Map<string, string>;
  recentSameTeamNativeFingerprints: Map<string, string>;
  pendingTimeouts: Map<string, NodeJS.Timeout>;
  memberInboxRelayInFlight: Map<string, string>;
  openCodeMemberInboxRelayInFlight: Map<string, string>;
  openCodeMemberSendInFlightByLane: Map<string, string>;
  relayedMemberInboxMessageIds: Map<string, string>;
  liveLeadProcessMessages: Map<string, string>;
  inFlightResponses: Map<string, string>;
  retainedClaudeLogsByTeam: Map<string, { lines: string[]; updatedAt?: string }>;
  runs: Map<string, string>;
} {
  return {
    getTrackedRunId: vi.fn(() => trackedRunId),
    isRunIdTracked: vi.fn(() => true),
    buildRetainedClaudeLogsSnapshot: vi.fn(() => ({
      lines: ['log line'],
      updatedAt: '2026-01-01T00:00:02.000Z',
    })),
    shouldFinalizeIncompleteLaunchState,
    buildIncompleteLaunchCleanupReason,
    markIncompleteLaunchStateFinalized: vi.fn(),
    persistLaunchStateSnapshot: vi.fn(() => Promise.resolve()),
    writeLaunchFailureArtifactPackBestEffort: vi.fn(),
    resetRuntimeToolActivity: vi.fn(),
    setLeadActivity: vi.fn(),
    stopStallWatchdog: vi.fn(),
    stopFilesystemMonitor: vi.fn(),
    provisioningRunByTeam: new Map(),
    aliveRunByTeam: new Map(),
    deleteAliveRunId: vi.fn(),
    clearSecondaryRuntimeRuns: vi.fn(),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    invalidateMemberSpawnStatusesCache: vi.fn(),
    leadInboxRelayInFlight: new Map(),
    relayedLeadInboxMessageIds: new Map(),
    leadRecoveryMessageIds: new Map(),
    successfulLeadRecoveryMessageIds: new Map(),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentSameTeamNativeFingerprints: new Map(),
    clearSameTeamRetryTimers: vi.fn(),
    clearLeadInboxFollowUpRelayTimer: vi.fn(),
    getMemberLaunchGraceKey: vi.fn(
      (cleanup, memberName: string) => `member-launch-grace:${cleanup.runId}:${memberName}`
    ),
    pendingTimeouts: new Map(),
    memberInboxRelayInFlight: new Map(),
    openCodeMemberInboxRelayInFlight: new Map(),
    openCodeMemberSendInFlightByLane: new Map(),
    openCodePromptDeliveryWatchdogScheduler: { cancelTeam: vi.fn() },
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    relayedMemberInboxMessageIds: new Map(),
    liveLeadProcessMessages: new Map(),
    pruneLiveLeadMessagesForCleanedRun: vi.fn(),
    clearApprovalTimeout: vi.fn(),
    inFlightResponses: new Map(),
    dismissApprovalNotification: vi.fn(),
    emitToolApprovalEvent: vi.fn(),
    mcpConfigBuilder: { removeConfigFile: vi.fn() },
    removeRunMemberMcpConfigFilesLater: vi.fn(),
    retainedClaudeLogsByTeam: new Map(),
    retainProvisioningProgress: vi.fn(),
    runs: new Map(),
  };
}

function makePorts(
  overrides: Partial<TeamProvisioningTransientRunStatePorts> = {}
): TeamProvisioningTransientRunStatePorts {
  return createTeamProvisioningTransientRunStatePorts({
    pendingTimeouts: new Map(),
    teamOpLocks: new Map(),
    cancelPendingAutoResume: vi.fn(),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    clearRuntimeProcessRowsForTeam: vi.fn(),
    retainedClaudeLogsByTeam: new Map(),
    persistedTranscriptClaudeLogs: { invalidate: vi.fn() },
    leadInboxRelayInFlight: new Map(),
    relayedLeadInboxMessageIds: new Map(),
    leadRecoveryMessageIds: new Map(),
    successfulLeadRecoveryMessageIds: new Map(),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentSameTeamNativeFingerprints: new Map(),
    memberInboxRelayInFlight: new Map(),
    openCodeMemberInboxRelayInFlight: new Map(),
    openCodeMemberSendInFlightByLane: new Map(),
    openCodePromptDeliveryWatchdogScheduler: { cancelTeam: vi.fn() },
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn(), resetTeamForNewRun: vi.fn() },
    relayedMemberInboxMessageIds: new Map(),
    liveLeadProcessMessages: new Map(),
    relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
    warn: vi.fn(),
    nowMs: () => Date.parse('2026-01-02T03:04:05.000Z'),
    ...overrides,
  });
}

describe('lead relay lifecycle integration', () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    'releases stopped capture before relaunch (transport pending: %s)',
    async (pendingSend) => {
      vi.useFakeTimers();
      const oldRun = {
        ...cleanupRun({
          teamName: 'alpha',
          mcpConfigPath: null,
          timeoutHandle: null,
          silentUserDmForwardClearHandle: null,
        }),
        ...createRun(),
        child: new ChildProcess(),
      };
      let currentRun: LeadInboxRelayFlowRun = oldRun;
      const deps = createDeps({
        getAliveRunId: () => currentRun.runId,
        getRun: (id) => (id === currentRun.runId ? currentRun : undefined),
        isCurrentTrackedRun: (run) => run === currentRun,
        readConfigForObservation: async () => ({
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        }),
        readLeadInboxMessages: async () => [
          {
            from: 'user',
            to: 'team-lead',
            text: 'Continue my task',
            messageId: currentRun.runId,
            timestamp: '2026-01-01T00:01:00.000Z',
            read: false,
            source: 'user_sent',
          },
        ],
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (timer) => clearTimeout(timer),
        nowMs: () => Date.now(),
        sendMessageToRun: vi.fn(async (run) => {
          if (run.runId === 'run-2') run.leadRelayCapture?.resolveOnce('Handled');
          else if (pendingSend) await new Promise<void>(() => undefined);
        }),
      });
      const boundary = createTeamProvisioningLeadInboxRelayPortsBoundary(deps);
      const first = boundary.relayLeadInboxMessages('alpha');
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.sendMessageToRun).toHaveBeenCalledTimes(1);
      const oldCapture = oldRun.leadRelayCapture!;
      oldRun.cancelRequested = true;
      oldRun.processKilled = true;
      cleanupProvisioningRun(oldRun, {
        ...makeCleanupPorts(oldRun.runId),
        leadInboxRelayInFlight: deps.leadInboxRelayInFlight,
        relayedLeadInboxMessageIds: deps.relayedLeadInboxMessageIds,
      });
      new TeamProvisioningTransientRunState(
        makePorts({
          leadInboxRelayInFlight: deps.leadInboxRelayInFlight,
          relayedLeadInboxMessageIds: deps.relayedLeadInboxMessageIds,
        })
      ).resetTeamScopedTransientStateForNewRun('alpha');
      currentRun = createRun({ runId: 'run-2' });
      const second = boundary.relayLeadInboxMessages('alpha');
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toBe(0);
      expect(await second).toBe(1);
      expect(deps.sendMessageToRun).toHaveBeenCalledTimes(2);
      expect(oldCapture.settled).toBe(true);
      expect(oldRun.leadRelayCapture).toBeNull();
      oldCapture.touch?.();
      oldCapture.resolveOnce('Late reply from old run');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(deps.markInboxMessagesRead).toHaveBeenCalledTimes(1);
      expect(deps.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'team-lead', [
        expect.objectContaining({ messageId: 'run-2' }),
      ]);
      expect(deps.relayedLeadInboxMessageIds.get('alpha')).toEqual(new Set(['run-2']));
      expect(deps.persistSentMessage).toHaveBeenCalledTimes(1);
      expect(deps.scheduleLeadInboxFollowUpRelay).not.toHaveBeenCalled();
    }
  );

  it('bounds repeated activity extensions at 600 seconds and leaves no-proof delivery retryable', async () => {
    vi.useFakeTimers();
    const run = createRun();
    const deps = createDeps({
      getRun: () => run,
      readConfigForObservation: async () => ({
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      readLeadInboxMessages: async () => [
        {
          from: 'user',
          to: 'team-lead',
          text: 'Continue my task',
          messageId: 'msg-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          read: false,
          source: 'user_sent',
        },
      ],
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      nowMs: () => Date.now(),
    });
    const delivery = relayLeadInboxMessagesForTeam(
      'alpha',
      createTeamProvisioningLeadInboxRelayFlowPorts(deps)
    );
    await vi.advanceTimersByTimeAsync(0);
    const capture = run.leadRelayCapture!;
    for (let turn = 0; turn < 5; turn++) {
      await vi.advanceTimersByTimeAsync(110_000);
      capture.touch?.();
      expect(capture.settled).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(49_999);
    capture.touch?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(await delivery).toBe(0);
    expect(capture.settled).toBe(true);
    expect(run.leadRelayCapture).toBeNull();
    expect(deps.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(deps.scheduleLeadInboxFollowUpRelay).toHaveBeenCalledWith('alpha', 10_000);
    capture.touch?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps healthy capture ownership beyond caller timeout and shares its result', async () => {
    vi.useFakeTimers();
    const run = createRun();
    const deps = createDeps({
      getRun: () => run,
      readConfigForObservation: async () => ({
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      readLeadInboxMessages: async () => [
        {
          from: 'user',
          to: 'team-lead',
          text: 'Continue my task',
          messageId: 'msg-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          read: false,
          source: 'user_sent',
        },
      ],
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      nowMs: () => Date.now(),
    });
    const boundary = createTeamProvisioningLeadInboxRelayPortsBoundary(deps);
    const first = boundary.relayLeadInboxMessages('alpha');
    await vi.advanceTimersByTimeAsync(110_000);
    run.leadRelayCapture?.touch?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toBe(0);
    expect(run.leadRelayCapture?.settled).toBe(false);
    expect(deps.leadInboxRelayInFlight.has('alpha')).toBe(true);
    const second = boundary.relayLeadInboxMessages('alpha');
    run.leadRelayCapture?.resolveOnce('Handled');
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(1);
    expect(deps.sendMessageToRun).toHaveBeenCalledTimes(1);
    expect(deps.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(true);
    expect(deps.leadInboxRelayInFlight.has('alpha')).toBe(false);
  });
});
