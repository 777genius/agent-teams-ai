import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodePromptDeliveryWatchdogCoordinator } from '../../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { createDefaultOpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import { createOpenCodeBootstrapWakePorts } from '../TeamProvisioningOpenCodeDeliveryComposition';
import { createOpenCodePromptDeliveryWatchdogSchedulerFromService } from '../TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory';
import { tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type { OpenCodeRuntimeLaneRecoveryPorts } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import type { TeamProvisioningProgress } from '@shared/types';

const input = {
  teamName: 'bootstrap-wake-test',
  laneId: 'secondary:opencode:oc',
  runId: 'lane-run-1',
  memberName: 'oc',
};
const unread = {
  from: 'team-lead',
  to: 'oc',
  text: 'Assigned task',
  read: false,
  messageId: 'assignment-1',
  timestamp: '2026-09-06T15:14:25.748Z',
};

function createHarness() {
  const run = {
    processKilled: false,
    cancelRequested: false,
    progress: { state: 'verifying' as TeamProvisioningProgress['state'] },
    mixedSecondaryLanes: [{ laneId: input.laneId, runId: input.runId }],
  };
  const runs = new Map([['root-run-1', run]]);
  const provisioningRunByTeam = new Map([[input.teamName, 'root-run-1']]);
  const runTracking = new TeamProvisioningRunTrackingDeliveryHelper({
    state: {
      runs,
      provisioningRunByTeam,
      aliveRunByTeam: new Map(),
      runtimeAdapterRunByTeam: new Map(),
      runtimeAdapterProgressByRunId: new Map(),
      getRetainedProvisioningProgressMap: () => new Map(),
    },
    ports: {
      isTeamAlive: () => false,
      hasAlivePersistedTeamProcess: () => false,
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: () => false,
      notifyTeamWatchScopeChanged: vi.fn(),
      logDebug: vi.fn(),
    },
    liveRuntimeSnapshotCacheTtlMs: 2000,
    persistedRuntimeSnapshotCacheTtlMs: 10000,
  });
  const runtimeProbe = vi.fn(async () => {
    throw new Error('No runtime probe/host start is permitted');
  });
  const recoveryPorts = {
    readOpenCodeMemberDirectory: vi.fn(async () => ({ config: null, metaMembers: [] })),
    resolveOpenCodeMemberIdentityFromDirectory: () => ({ ok: true, laneId: input.laneId }),
    readOpenCodeRuntimeLaneIndex: vi.fn(async () => ({
      lanes: { [input.laneId]: { state: 'active' } },
    })),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: runtimeProbe,
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: runtimeProbe,
    readLaunchState: runtimeProbe,
  } as unknown as OpenCodeRuntimeLaneRecoveryPorts;
  const recover = vi.fn((member: { teamName: string; memberName: string }) =>
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(member, recoveryPorts)
  );
  const relay = vi.fn(async () => ({
    attempted: 1,
    delivered: 1,
    relayed: 1,
    failed: 0,
    skipped: 0,
  }));
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), diagnostic: vi.fn() };
  const scheduler = createOpenCodePromptDeliveryWatchdogSchedulerFromService(
    {
      canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
        runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: recover,
      relayOpenCodeMemberInboxMessages: relay,
      inboxReader: { getMessagesFor: async () => [unread] },
      openCodeRuntimeRecoveryIdentity: {
        resolveOpenCodeMemberDeliveryIdentity: async () => ({ ok: true, laneId: input.laneId }),
        isOpenCodeRuntimeLaneIndexActive: async () => true,
      },
    },
    { logger, getErrorMessage: String }
  );
  const evidencePorts = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
    teamsBasePath: '/unused-test-only',
  });
  evidencePorts.readCommittedBootstrapSessionEvidence = vi.fn(async () => ({
    state: 'healthy' as const,
    committed: true,
    activeRunId: input.runId,
    diagnostics: [],
    sessions: [
      {
        id: 'session-1',
        ...input,
        observedAt: unread.timestamp,
        source: 'runtime_bootstrap_checkin' as const,
      },
    ],
  }));
  const getInboxMessages = vi.fn(async () => [unread]);
  const coordinator = createOpenCodePromptDeliveryWatchdogCoordinator({
    ...createOpenCodeBootstrapWakePorts({ runTracking, runs }, () => evidencePorts),
    hasAcceptedMemberWorkSyncReport: async () => false,
    taskRefsIncludeAll: () => true,
    visibleReplyProofService: {
      applyDestinationProof: vi.fn(),
      materializePlainTextReplyIfNeeded: vi.fn(),
    },
    maybeSyncRuntimePermissionsAfterDelivery: async () => undefined,
    rememberRuntimePidFromBridge: async () => undefined,
    watchdogScheduler: scheduler,
    canDeliverToTeamRuntime: (teamName) => runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
    recoverRuntimeLanesForWatchdog: async () => [],
    stopRuntimeLanesForStoppedTeam: async () => 0,
    readActiveRuntimeLaneIds: async () => [input.laneId],
    createLedger: vi.fn(),
    resolveMembersForRuntimeLane: async () => ['oc'],
    getInboxMessages,
    resolveCurrentRuntimeRunId: async () => input.runId,
    hasStableInboxMessageId: (message): message is typeof message & { messageId: string } =>
      Boolean(message.messageId),
    logPromptDeliveryEvent: vi.fn(),
  });
  return {
    coordinator,
    scheduler,
    runTracking,
    run,
    runs,
    provisioningRunByTeam,
    relay,
    recover,
    runtimeProbe,
    evidencePorts,
    getInboxMessages,
  };
}

afterEach(() => vi.useRealTimers());

describe('OpenCode bootstrap delivery while the lead is finalizing', () => {
  it('uses actual tracked-run admission and existing active-lane recovery without starting a host', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    expect(h.runTracking.canDeliverToOpenCodeRuntimeForTeam(input.teamName)).toBe(false);
    expect(h.runTracking.resolveDeliverableTrackedRuntimeRunId(input.teamName)).toBe('root-run-1');
    await expect(h.coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(1);
    expect(h.relay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.recover).toHaveBeenCalledExactlyOnceWith({
      teamName: input.teamName,
      memberName: 'oc',
    });
    expect(h.relay).toHaveBeenCalledExactlyOnceWith(input.teamName, 'oc', {
      onlyMessageId: unread.messageId,
      source: 'watchdog',
    });
    expect(h.runtimeProbe).not.toHaveBeenCalled();
    expect(h.runTracking.canDeliverToOpenCodeRuntimeForTeam(input.teamName)).toBe(false);
  });

  it.each([
    'cancelled',
    'killed',
    'failed',
    'stale lane',
    'new root with old lane index',
    'missing proof',
    'cancel during proof',
    'cancel during inbox',
  ])('does not schedule for %s', async (scenario) => {
    const h = createHarness();
    if (scenario === 'cancelled') h.run.cancelRequested = true;
    if (scenario === 'killed') h.run.processKilled = true;
    if (scenario === 'failed') h.run.progress.state = 'failed';
    if (scenario === 'stale lane') h.run.mixedSecondaryLanes[0].runId = 'new-lane-run';
    if (scenario === 'new root with old lane index') {
      h.provisioningRunByTeam.set(input.teamName, 'root-run-2');
      h.runs.set('root-run-2', { ...h.run, mixedSecondaryLanes: [] });
    }
    if (scenario === 'missing proof')
      h.evidencePorts.readCommittedBootstrapSessionEvidence = vi.fn(async () => ({
        state: 'healthy' as const,
        committed: false,
        activeRunId: input.runId,
        sessions: [],
        diagnostics: [],
      }));
    if (scenario === 'cancel during proof') {
      const read = h.evidencePorts.readCommittedBootstrapSessionEvidence;
      h.evidencePorts.readCommittedBootstrapSessionEvidence = async (params) => {
        h.run.cancelRequested = true;
        return read(params);
      };
    }
    if (scenario === 'cancel during inbox')
      h.getInboxMessages.mockImplementation(async () => {
        h.run.cancelRequested = true;
        return [unread];
      });
    await expect(h.coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(0);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.runtimeProbe).not.toHaveBeenCalled();
  });

  it('cancels an already scheduled bootstrap wake through the existing Stop cleanup', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await h.coordinator.wakeAfterBootstrapCommit(input);
    h.run.cancelRequested = true;
    h.scheduler.cancelTeam(input.teamName);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
  });
});
