/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { describe, expect, it, vi } from 'vitest';

import {
  buildIncompleteLaunchCleanupReason,
  cleanupProvisioningRun,
  type IncompleteLaunchCleanupRun,
  shouldFinalizeIncompleteLaunchState,
  type TeamProvisioningCleanupPorts,
  type TeamProvisioningCleanupRun,
} from '../TeamProvisioningCleanup';

import type { TeamProvisioningProgress } from '@shared/types';

function run(overrides: Partial<IncompleteLaunchCleanupRun> = {}): IncompleteLaunchCleanupRun {
  return {
    isLaunch: true,
    launchStateClearedForRun: true,
    provisioningComplete: false,
    cancelRequested: false,
    launchCleanupStateFinalized: false,
    progress: {
      state: 'spawning',
      message: '',
    },
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

function makeTimer(): NodeJS.Timeout {
  return setTimeout(() => undefined, 60_000);
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
    timeoutHandle: makeTimer(),
    silentUserDmForwardClearHandle: makeTimer(),
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

function seedTeamScopedCleanupState(
  ports: ReturnType<typeof makeCleanupPorts>,
  run: TeamProvisioningCleanupRun,
  trackedRunId = run.runId
): void {
  ports.provisioningRunByTeam.set(run.teamName, trackedRunId);
  ports.aliveRunByTeam.set(run.teamName, trackedRunId);
  ports.leadInboxRelayInFlight.set(run.teamName, 'lead');
  ports.relayedLeadInboxMessageIds.set(run.teamName, 'lead-message');
  ports.pendingCrossTeamFirstReplies.set(run.teamName, 'cross-team');
  ports.recentCrossTeamLeadDeliveryMessageIds.set(run.teamName, 'cross-team-message');
  ports.recentSameTeamNativeFingerprints.set(run.teamName, 'same-team');
  ports.memberInboxRelayInFlight.set(`${run.teamName}:worker-a`, 'member');
  ports.memberInboxRelayInFlight.set('other-team:worker-a', 'other');
  ports.openCodeMemberInboxRelayInFlight.set(`opencode:${run.teamName}:worker-a`, 'opencode');
  ports.openCodeMemberInboxRelayInFlight.set('opencode:other-team:worker-a', 'other');
  ports.openCodeMemberSendInFlightByLane.set(`opencode-send:${run.teamName}:lane-a`, 'send');
  ports.openCodeMemberSendInFlightByLane.set('opencode-send:other-team:lane-a', 'other');
  ports.relayedMemberInboxMessageIds.set(`${run.teamName}:worker-a`, 'member-message');
  ports.relayedMemberInboxMessageIds.set('other-team:worker-a', 'other');
  ports.liveLeadProcessMessages.set(run.teamName, 'live');
  ports.inFlightResponses.set('approval-1', 'response');
  ports.runs.set(run.runId, 'run');
  for (const memberName of run.memberSpawnStatuses.keys()) {
    const graceKey = `member-launch-grace:${run.runId}:${memberName}`;
    ports.pendingTimeouts.set(graceKey, makeTimer());
    ports.pendingTimeouts.set(`${graceKey}:bootstrap-stall`, makeTimer());
  }
}

describe('team provisioning cleanup policy', () => {
  it('finalizes incomplete launch state only for unfinished active launch runs', () => {
    expect(shouldFinalizeIncompleteLaunchState(run())).toBe(true);
    expect(shouldFinalizeIncompleteLaunchState(run({ isLaunch: false }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ launchStateClearedForRun: false }))).toBe(
      false
    );
    expect(shouldFinalizeIncompleteLaunchState(run({ provisioningComplete: true }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ cancelRequested: true }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ launchCleanupStateFinalized: true }))).toBe(
      false
    );
  });

  it('prefers explicit progress error, then failed progress message, then fallback reason', () => {
    expect(
      buildIncompleteLaunchCleanupReason(
        run({
          progress: {
            state: 'failed',
            message: 'failed message',
            error: ' explicit error ',
          },
        })
      )
    ).toBe('explicit error');

    expect(
      buildIncompleteLaunchCleanupReason(
        run({
          progress: {
            state: 'failed',
            message: ' failed message ',
          },
        })
      )
    ).toBe('failed message');

    expect(buildIncompleteLaunchCleanupReason(run(), 'fallback')).toBe('fallback');
  });

  it('clears current-run team-scoped cleanup state', () => {
    const cleanup = cleanupRun();
    const ports = makeCleanupPorts(cleanup.runId);
    seedTeamScopedCleanupState(ports, cleanup);

    cleanupProvisioningRun(cleanup, ports);

    expect(cleanup.timeoutHandle).toBeNull();
    expect(cleanup.silentUserDmForwardClearHandle).toBeNull();
    expect(cleanup.pendingDirectCrossTeamSendRefresh).toBe(false);
    expect(cleanup.pendingPostCompactReminder).toBe(false);
    expect(cleanup.pendingGeminiPostLaunchHydration).toBe(false);
    expect(cleanup.activeCrossTeamReplyHints).toEqual([]);
    expect(cleanup.pendingInboxRelayCandidates).toEqual([]);
    expect(cleanup.pendingApprovals.size).toBe(0);
    expect(cleanup.mcpConfigPath).toBeNull();

    expect(ports.provisioningRunByTeam.has(cleanup.teamName)).toBe(false);
    expect(ports.deleteAliveRunId).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.clearSecondaryRuntimeRuns).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.invalidateMemberSpawnStatusesCache).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.leadInboxRelayInFlight.has(cleanup.teamName)).toBe(false);
    expect(ports.relayedLeadInboxMessageIds.has(cleanup.teamName)).toBe(false);
    expect(ports.pendingCrossTeamFirstReplies.has(cleanup.teamName)).toBe(false);
    expect(ports.recentCrossTeamLeadDeliveryMessageIds.has(cleanup.teamName)).toBe(false);
    expect(ports.recentSameTeamNativeFingerprints.has(cleanup.teamName)).toBe(false);
    expect(ports.clearSameTeamRetryTimers).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.clearLeadInboxFollowUpRelayTimer).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.pendingTimeouts.size).toBe(0);
    expect(ports.memberInboxRelayInFlight.has(`${cleanup.teamName}:worker-a`)).toBe(false);
    expect(ports.memberInboxRelayInFlight.has('other-team:worker-a')).toBe(true);
    expect(
      ports.openCodeMemberInboxRelayInFlight.has(`opencode:${cleanup.teamName}:worker-a`)
    ).toBe(false);
    expect(
      ports.openCodeMemberSendInFlightByLane.has(`opencode-send:${cleanup.teamName}:lane-a`)
    ).toBe(false);
    expect(ports.relayedMemberInboxMessageIds.has(`${cleanup.teamName}:worker-a`)).toBe(false);
    expect(ports.liveLeadProcessMessages.has(cleanup.teamName)).toBe(false);
    expect(ports.openCodePromptDeliveryWatchdogScheduler.cancelTeam).toHaveBeenCalledWith(
      cleanup.teamName
    );
    expect(ports.pruneLiveLeadMessagesForCleanedRun).not.toHaveBeenCalled();
    expect(ports.markIncompleteLaunchStateFinalized).toHaveBeenCalledWith(
      cleanup,
      'Launch ended before teammate bootstrap completed.'
    );
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(cleanup, 'finished');
    expect(ports.writeLaunchFailureArtifactPackBestEffort).toHaveBeenCalledWith(cleanup, {
      reason: 'launch_cleanup_unconfirmed_bootstrap',
    });
    expect(ports.resetRuntimeToolActivity).toHaveBeenCalledWith(cleanup);
    expect(ports.setLeadActivity).toHaveBeenCalledWith(cleanup, 'offline');
    expect(ports.clearApprovalTimeout).toHaveBeenCalledWith('approval-1');
    expect(ports.dismissApprovalNotification).toHaveBeenCalledWith('approval-1');
    expect(ports.emitToolApprovalEvent).toHaveBeenCalledWith({
      dismissed: true,
      teamName: cleanup.teamName,
      runId: cleanup.runId,
    });
    expect(ports.retainedClaudeLogsByTeam.get(cleanup.teamName)).toEqual({
      lines: ['log line'],
      updatedAt: '2026-01-01T00:00:02.000Z',
    });
    expect(ports.retainProvisioningProgress).toHaveBeenCalledWith(cleanup.runId, cleanup.progress);
    expect(ports.runs.has(cleanup.runId)).toBe(false);
  });

  it('keeps newer-run team-scoped state when cleaning a stale run', () => {
    const cleanup = cleanupRun();
    const ports = makeCleanupPorts('newer-run');
    seedTeamScopedCleanupState(ports, cleanup, 'newer-run');
    const newerGraceKey = 'member-launch-grace:newer-run:worker-a';
    ports.pendingTimeouts.set(newerGraceKey, makeTimer());
    ports.pendingTimeouts.set(`${newerGraceKey}:bootstrap-stall`, makeTimer());

    cleanupProvisioningRun(cleanup, ports);

    expect(ports.buildRetainedClaudeLogsSnapshot).not.toHaveBeenCalled();
    expect(ports.markIncompleteLaunchStateFinalized).not.toHaveBeenCalled();
    expect(ports.persistLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.writeLaunchFailureArtifactPackBestEffort).not.toHaveBeenCalled();
    expect(ports.resetRuntimeToolActivity).not.toHaveBeenCalled();
    expect(ports.setLeadActivity).not.toHaveBeenCalled();
    expect(ports.provisioningRunByTeam.get(cleanup.teamName)).toBe('newer-run');
    expect(ports.deleteAliveRunId).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.leadInboxRelayInFlight.get(cleanup.teamName)).toBe('lead');
    expect(ports.relayedLeadInboxMessageIds.get(cleanup.teamName)).toBe('lead-message');
    expect(ports.pendingCrossTeamFirstReplies.get(cleanup.teamName)).toBe('cross-team');
    expect(ports.recentSameTeamNativeFingerprints.get(cleanup.teamName)).toBe('same-team');
    expect(ports.memberInboxRelayInFlight.get(`${cleanup.teamName}:worker-a`)).toBe('member');
    expect(
      ports.openCodeMemberInboxRelayInFlight.get(`opencode:${cleanup.teamName}:worker-a`)
    ).toBe('opencode');
    expect(
      ports.openCodeMemberSendInFlightByLane.get(`opencode-send:${cleanup.teamName}:lane-a`)
    ).toBe('send');
    expect(ports.relayedMemberInboxMessageIds.get(`${cleanup.teamName}:worker-a`)).toBe(
      'member-message'
    );
    expect(ports.liveLeadProcessMessages.get(cleanup.teamName)).toBe('live');
    expect(ports.openCodePromptDeliveryWatchdogScheduler.cancelTeam).not.toHaveBeenCalled();
    expect(ports.pruneLiveLeadMessagesForCleanedRun).toHaveBeenCalledWith(cleanup);
    expect(ports.retainedClaudeLogsByTeam.has(cleanup.teamName)).toBe(false);
    expect(ports.pendingTimeouts.has('member-launch-grace:run-1:worker-a')).toBe(false);
    expect(ports.pendingTimeouts.has('member-launch-grace:run-1:worker-a:bootstrap-stall')).toBe(
      false
    );
    expect(ports.pendingTimeouts.has('member-launch-grace:run-1:worker-b')).toBe(false);
    expect(ports.pendingTimeouts.has('member-launch-grace:run-1:worker-b:bootstrap-stall')).toBe(
      false
    );
    expect(ports.pendingTimeouts.has(newerGraceKey)).toBe(true);
    expect(ports.pendingTimeouts.has(`${newerGraceKey}:bootstrap-stall`)).toBe(true);
    for (const timer of ports.pendingTimeouts.values()) {
      clearTimeout(timer);
    }
    expect(ports.runs.has(cleanup.runId)).toBe(false);
  });

  it('treats a newer alive run as current even when a stale provisioning id masks it', () => {
    const cleanup = cleanupRun();
    const ports = makeCleanupPorts(cleanup.runId);
    seedTeamScopedCleanupState(ports, cleanup, cleanup.runId);
    ports.aliveRunByTeam.set(cleanup.teamName, 'newer-alive-run');

    cleanupProvisioningRun(cleanup, ports);

    expect(ports.provisioningRunByTeam.has(cleanup.teamName)).toBe(false);
    expect(ports.deleteAliveRunId).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.leadInboxRelayInFlight.get(cleanup.teamName)).toBe('lead');
    expect(ports.memberInboxRelayInFlight.get(`${cleanup.teamName}:worker-a`)).toBe('member');
    expect(ports.liveLeadProcessMessages.get(cleanup.teamName)).toBe('live');
    expect(ports.pruneLiveLeadMessagesForCleanedRun).toHaveBeenCalledWith(cleanup);
    expect(ports.runs.has(cleanup.runId)).toBe(false);
  });

  it('ignores a residual untracked alive id and still performs full team-scoped cleanup', () => {
    const cleanup = cleanupRun();
    const ports = makeCleanupPorts(cleanup.runId);
    seedTeamScopedCleanupState(ports, cleanup, cleanup.runId);
    ports.aliveRunByTeam.set(cleanup.teamName, 'stale-dead-run');
    ports.isRunIdTracked = vi.fn((runId: string) => runId !== 'stale-dead-run');

    cleanupProvisioningRun(cleanup, ports);

    expect(ports.setLeadActivity).toHaveBeenCalledWith(cleanup, 'offline');
    expect(ports.resetRuntimeToolActivity).toHaveBeenCalledWith(cleanup);
    expect(ports.clearSecondaryRuntimeRuns).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith(cleanup.teamName);
    expect(ports.leadInboxRelayInFlight.has(cleanup.teamName)).toBe(false);
    expect(ports.memberInboxRelayInFlight.has(`${cleanup.teamName}:worker-a`)).toBe(false);
    expect(ports.liveLeadProcessMessages.has(cleanup.teamName)).toBe(false);
    expect(ports.runs.has(cleanup.runId)).toBe(false);
  });
});
/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */
