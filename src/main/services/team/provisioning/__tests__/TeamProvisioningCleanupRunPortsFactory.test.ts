import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningCleanupRunPorts,
  createTeamProvisioningCleanupRunPortsDepsFromService,
  type TeamProvisioningCleanupRunServiceHost,
  type TeamProvisioningCleanupRunPortsFactoryDeps,
} from '../TeamProvisioningCleanupRunPortsFactory';

import type { TeamProvisioningCleanupRun } from '../TeamProvisioningCleanup';
import type { RetainedLogsRunLike } from '../TeamProvisioningRetainedLogs';
import type { TeamProvisioningProgress } from '@shared/types';

type CleanupRunWithLogs = TeamProvisioningCleanupRun & RetainedLogsRunLike;

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

function cleanupRun(overrides: Partial<CleanupRunWithLogs> = {}): CleanupRunWithLogs {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: progress(),
    isLaunch: true,
    launchStateClearedForRun: true,
    provisioningComplete: false,
    cancelRequested: false,
    launchCleanupStateFinalized: false,
    pendingDirectCrossTeamSendRefresh: false,
    timeoutHandle: null,
    silentUserDmForwardClearHandle: null,
    child: null,
    memberSpawnStatuses: new Map(),
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    pendingApprovals: new Map(),
    mcpConfigPath: null,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    pendingPostCompactReminder: false,
    postCompactReminderInFlight: false,
    suppressPostCompactReminderOutput: false,
    pendingGeminiPostLaunchHydration: false,
    geminiPostLaunchHydrationInFlight: false,
    suppressGeminiPostLaunchHydrationOutput: false,
    ...overrides,
  };
}

function makeDeps(): TeamProvisioningCleanupRunPortsFactoryDeps<CleanupRunWithLogs> {
  return {
    getTrackedRunId: vi.fn(() => 'run-1'),
    isRunIdTracked: vi.fn(() => true),
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
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    recentSameTeamNativeFingerprints: new Map(),
    clearSameTeamRetryTimers: vi.fn(),
    clearLeadInboxFollowUpRelayTimer: vi.fn(),
    getMemberLaunchGraceKey: vi.fn((run, memberName) => `${run.runId}:${memberName}`),
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

describe('createTeamProvisioningCleanupRunPorts', () => {
  it('builds cleanup deps from service-shaped dependencies', async () => {
    const deps = makeDeps();
    const run = cleanupRun();
    const runtimeAdapterProgressByRunId = new Map<string, unknown>();
    const runTracking = {
      getTrackedRunId: vi.fn(() => 'run-1'),
      deleteAliveRunId: vi.fn(),
    };
    const service = {
      runTracking,
      runs: deps.runs as TeamProvisioningCleanupRunServiceHost<CleanupRunWithLogs>['runs'],
      runtimeAdapterProgressByRunId,
      markIncompleteLaunchStateFinalized: deps.markIncompleteLaunchStateFinalized,
      persistLaunchStateSnapshot: deps.persistLaunchStateSnapshot,
      configTaskActivityBoundary: {
        writeLaunchFailureArtifactPackBestEffort: deps.writeLaunchFailureArtifactPackBestEffort,
      },
      resetRuntimeToolActivity: deps.resetRuntimeToolActivity,
      setLeadActivity: deps.setLeadActivity,
      outputRecoveryFacade: {
        stopStallWatchdog: deps.stopStallWatchdog,
      },
      stopFilesystemMonitor: deps.stopFilesystemMonitor,
      provisioningRunByTeam: deps.provisioningRunByTeam,
      aliveRunByTeam: deps.aliveRunByTeam,
      clearSecondaryRuntimeRuns: deps.clearSecondaryRuntimeRuns,
      invalidateRuntimeSnapshotCaches: deps.invalidateRuntimeSnapshotCaches,
      invalidateMemberSpawnStatusesCache: deps.invalidateMemberSpawnStatusesCache,
      leadInboxRelayInFlight: deps.leadInboxRelayInFlight,
      relayedLeadInboxMessageIds: deps.relayedLeadInboxMessageIds,
      pendingCrossTeamFirstReplies: deps.pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds: deps.recentCrossTeamLeadDeliveryMessageIds,
      sameTeamNativeDelivery: deps.recentSameTeamNativeFingerprints,
      clearSameTeamRetryTimers: deps.clearSameTeamRetryTimers,
      clearLeadInboxFollowUpRelayTimer: deps.clearLeadInboxFollowUpRelayTimer,
      getMemberLaunchGraceKey: deps.getMemberLaunchGraceKey,
      pendingTimeouts: deps.pendingTimeouts,
      memberInboxRelayInFlight: deps.memberInboxRelayInFlight,
      openCodeMemberInboxRelayInFlight: deps.openCodeMemberInboxRelayInFlight,
      openCodeMemberSendInFlightByLane: deps.openCodeMemberSendInFlightByLane,
      openCodePromptDeliveryWatchdogScheduler: deps.openCodePromptDeliveryWatchdogScheduler,
      openCodeRuntimeDeliveryAdvisory: deps.openCodeRuntimeDeliveryAdvisory,
      relayedMemberInboxMessageIds: deps.relayedMemberInboxMessageIds,
      liveLeadProcessMessages: deps.liveLeadProcessMessages,
      pruneLiveLeadMessagesForCleanedRun: deps.pruneLiveLeadMessagesForCleanedRun,
      toolApprovalFacade: {
        clearApprovalTimeout: deps.clearApprovalTimeout,
        inFlightResponsesForCleanup: deps.inFlightResponses,
        dismissApprovalNotification: deps.dismissApprovalNotification,
        emitToolApprovalEvent: deps.emitToolApprovalEvent,
      },
      mcpConfigBuilder: deps.mcpConfigBuilder,
      removeRunMemberMcpConfigFilesLater: deps.removeRunMemberMcpConfigFilesLater,
      retainedClaudeLogsByTeam: deps.retainedClaudeLogsByTeam,
      retainProvisioningProgress: deps.retainProvisioningProgress,
    } satisfies TeamProvisioningCleanupRunServiceHost<CleanupRunWithLogs>;
    const builtDeps = createTeamProvisioningCleanupRunPortsDepsFromService(service);

    expect(builtDeps.getTrackedRunId('team-a')).toBe('run-1');
    expect(builtDeps.isRunIdTracked('run-1')).toBe(false);
    runtimeAdapterProgressByRunId.set('runtime-run', {});
    expect(builtDeps.isRunIdTracked('runtime-run')).toBe(true);
    builtDeps.markIncompleteLaunchStateFinalized(run, 'cleanup');
    await builtDeps.persistLaunchStateSnapshot(run, 'finished');
    builtDeps.writeLaunchFailureArtifactPackBestEffort(run, {
      reason: 'launch_progress_failed',
    });
    builtDeps.resetRuntimeToolActivity(run);
    builtDeps.setLeadActivity(run, 'offline');
    builtDeps.stopStallWatchdog(run);
    builtDeps.stopFilesystemMonitor(run);
    builtDeps.deleteAliveRunId('team-a');
    builtDeps.clearSecondaryRuntimeRuns('team-a');
    builtDeps.invalidateRuntimeSnapshotCaches('team-a');
    builtDeps.invalidateMemberSpawnStatusesCache('team-a');
    builtDeps.clearSameTeamRetryTimers('team-a');
    builtDeps.clearLeadInboxFollowUpRelayTimer('team-a');
    expect(builtDeps.getMemberLaunchGraceKey(run, 'Lead')).toBe('run-1:Lead');
    builtDeps.pruneLiveLeadMessagesForCleanedRun(run);
    builtDeps.clearApprovalTimeout('approval-1');
    builtDeps.dismissApprovalNotification('approval-1');
    builtDeps.emitToolApprovalEvent({ dismissed: true, teamName: 'team-a', runId: 'run-1' });
    builtDeps.removeRunMemberMcpConfigFilesLater(run);
    builtDeps.retainProvisioningProgress('run-1', run.progress);

    expect(runTracking.getTrackedRunId).toHaveBeenCalledWith('team-a');
    expect(deps.markIncompleteLaunchStateFinalized).toHaveBeenCalledWith(run, 'cleanup');
    expect(deps.writeLaunchFailureArtifactPackBestEffort).toHaveBeenCalledWith(run, {
      reason: 'launch_progress_failed',
    });
    expect(deps.stopStallWatchdog).toHaveBeenCalledWith(run);
    expect(runTracking.deleteAliveRunId).toHaveBeenCalledWith('team-a');
    expect(deps.clearSecondaryRuntimeRuns).toHaveBeenCalledWith('team-a');
    expect(deps.clearApprovalTimeout).toHaveBeenCalledWith('approval-1');
    expect(deps.emitToolApprovalEvent).toHaveBeenCalledWith({
      dismissed: true,
      teamName: 'team-a',
      runId: 'run-1',
    });
    expect(builtDeps.provisioningRunByTeam).toBe(deps.provisioningRunByTeam);
    expect(builtDeps.recentSameTeamNativeFingerprints).toBe(deps.recentSameTeamNativeFingerprints);
    expect(builtDeps.inFlightResponses).toBe(deps.inFlightResponses);
    expect(builtDeps.runs).toBe(deps.runs);
  });

  it('adds the cleanup policy helpers while preserving explicit dependency ports', () => {
    const deps = makeDeps();
    const ports = createTeamProvisioningCleanupRunPorts(deps);
    const run = cleanupRun({
      progress: progress({ state: 'failed', message: ' failed message ' }),
    });

    expect(ports.provisioningRunByTeam).toBe(deps.provisioningRunByTeam);
    expect(ports.aliveRunByTeam).toBe(deps.aliveRunByTeam);
    expect(ports.runs).toBe(deps.runs);
    expect(ports.shouldFinalizeIncompleteLaunchState(run)).toBe(true);
    expect(ports.buildIncompleteLaunchCleanupReason(run)).toBe('failed message');
    expect(
      ports.buildRetainedClaudeLogsSnapshot({
        ...run,
        claudeLogLines: ['line one'],
        claudeLogsUpdatedAt: '2026-01-01T00:00:02.000Z',
      })
    ).toEqual({
      lines: ['line one'],
      updatedAt: '2026-01-01T00:00:02.000Z',
    });

    ports.markIncompleteLaunchStateFinalized(run, 'cleanup reason');
    ports.resetRuntimeToolActivity(run);
    ports.setLeadActivity(run, 'offline');

    expect(deps.markIncompleteLaunchStateFinalized).toHaveBeenCalledWith(run, 'cleanup reason');
    expect(deps.resetRuntimeToolActivity).toHaveBeenCalledWith(run);
    expect(deps.setLeadActivity).toHaveBeenCalledWith(run, 'offline');
  });
});
