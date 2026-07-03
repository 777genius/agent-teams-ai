import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningCleanupRunPorts,
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
