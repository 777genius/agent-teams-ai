import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodePromptDeliveryWatchdogCoordinator } from '../../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { createDefaultOpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import { createOpenCodeBootstrapWakePorts } from '../TeamProvisioningOpenCodeDeliveryComposition';
import { createOpenCodePromptDeliveryWatchdogSchedulerFromService } from '../TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from '../TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { OpenCodeRetainedSecondaryDelivery } from '../OpenCodeRetainedSecondaryOwnership';
import type { OpenCodeRuntimeLaneRecoveryPorts } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import type { SecondaryRuntimeRunEntry } from '../TeamProvisioningSecondaryRuntimeRuns';
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
    retainedSecondaryDelivery: undefined as OpenCodeRetainedSecondaryDelivery | undefined,
    processKilled: false,
    cancelRequested: false,
    progress: { state: 'verifying' as TeamProvisioningProgress['state'] },
    mixedSecondaryLanes: [{ laneId: input.laneId, runId: input.runId }],
  };
  const runs = new Map([['root-run-1', run]]);
  const provisioningRunByTeam = new Map([[input.teamName, 'root-run-1']]);
  const aliveRunByTeam = new Map<string, string>();
  const secondaryRuns = new Map<string, SecondaryRuntimeRunEntry>();
  let stopGeneration = 0;
  const runTracking = new TeamProvisioningRunTrackingDeliveryHelper({
    state: {
      runs,
      provisioningRunByTeam,
      aliveRunByTeam,
      runtimeAdapterRunByTeam: new Map(),
      runtimeAdapterProgressByRunId: new Map(),
      getRetainedProvisioningProgressMap: () => new Map(),
    },
    ports: {
      getSecondaryRuntimeRuns: () => secondaryRuns,
      getStopAllTeamsGeneration: () => 0,
      getStopTeamGeneration: () => stopGeneration,
      isTeamAlive: () => false,
      hasAlivePersistedTeamProcess: () => false,
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: () => false,
      notifyTeamWatchScopeChanged: vi.fn(),
      logDebug: vi.fn(),
    },
    liveRuntimeSnapshotCacheTtlMs: 2000,
    persistedRuntimeSnapshotCacheTtlMs: 10000,
  });
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), diagnostic: vi.fn() };
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
  const projectPath = '/TEST/bootstrap-recovery';
  const member = { name: input.memberName, providerId: 'opencode' as const, cwd: projectPath };
  const runtimeProbe = vi.fn<TeamLaunchRuntimeAdapter['reconcile']>(async (request) => ({
    runId: request.runId,
    teamName: request.teamName,
    launchPhase: 'active',
    teamLaunchState: 'clean_success',
    members: {
      [input.memberName]: {
        memberName: input.memberName,
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        diagnostics: [],
      },
    },
    snapshot: null,
    warnings: [],
    diagnostics: [],
  }));
  const startHost = vi.fn(async () => {
    throw new Error('Native launch/preparation is forbidden during observation');
  });
  const missingHostRecovery = vi.fn(async () => {
    throw new Error('Missing-host recovery is forbidden for this active lane');
  });
  const adapter: TeamLaunchRuntimeAdapter = {
    providerId: 'opencode',
    prepare: startHost,
    launch: startHost,
    reconcile: runtimeProbe,
    stop: vi.fn(async () => {
      throw new Error('Recovery cannot stop an existing host');
    }),
  };
  const recoveryBoundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary({
    teamsBasePath: evidencePorts.teamsBasePath,
    logger,
    getOpenCodeRuntimeAdapter: () => adapter,
    createRunId: () => 'read-only-reconciliation',
  });
  const recoveryPorts: OpenCodeRuntimeLaneRecoveryPorts = {
    teamsBasePath: evidencePorts.teamsBasePath,
    logger,
    canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
      runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
    canAttemptCommittedOpenCodeSessionRecovery: (teamName) =>
      runTracking.canAttemptCommittedOpenCodeSessionRecovery(teamName),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: null,
      teamMeta: null,
      metaMembers: [member],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: () => ({
      ok: true,
      canonicalMemberName: input.memberName,
      laneId: input.laneId,
      metaMember: member,
      memberRuntimeCwd: projectPath,
      laneIdentity: {
        laneId: input.laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
      },
    }),
    readOpenCodeRuntimeLaneIndex: vi.fn<
      NonNullable<OpenCodeRuntimeLaneRecoveryPorts['readOpenCodeRuntimeLaneIndex']>
    >(async () => ({
      version: 1,
      updatedAt: unread.timestamp,
      lanes: {
        [input.laneId]: { laneId: input.laneId, state: 'active', updatedAt: unread.timestamp },
      },
    })),
    readCommittedOpenCodeBootstrapSessionEvidence: vi.fn((request) =>
      evidencePorts.readCommittedBootstrapSessionEvidence(request)
    ),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (request) =>
      recoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(request),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: missingHostRecovery,
    readLaunchState: vi.fn(async () => null),
    readConfigForObservation: async () => null,
    readTeamMeta: async () => null,
    readMetaMembers: async () => [member],
    readPersistedTeamProjectPath: () => projectPath,
    isOpenCodeRuntimeLaneIndexActive: async () => true,
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
    setOpenCodeRuntimeActiveRunManifest: vi.fn(async () => undefined),
  };
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
    aliveRunByTeam,
    secondaryRuns,
    stop: () => {
      stopGeneration += 1;
    },
    run,
    runs,
    provisioningRunByTeam,
    relay,
    recover,
    runtimeProbe,
    startHost,
    missingHostRecovery,
    recoveryPorts,
    adapter,
    evidencePorts,
    getInboxMessages,
  };
}

afterEach(() => vi.useRealTimers());

describe('OpenCode bootstrap delivery while the lead is finalizing', () => {
  it('confirms the committed active lane through native reconciliation while the lead is finalizing', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    expect(h.runTracking.canDeliverToOpenCodeRuntimeForTeam(input.teamName)).toBe(false);
    expect(h.runTracking.canAttemptCommittedOpenCodeSessionRecovery(input.teamName)).toBe(true);
    expect(h.secondaryRuns.size).toBe(0);
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
    expect(h.runtimeProbe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        teamName: input.teamName,
        laneId: input.laneId,
        runId: 'read-only-reconciliation',
        reason: 'startup_recovery',
        expectedMembers: [
          expect.objectContaining({ name: input.memberName, cwd: '/TEST/bootstrap-recovery' }),
        ],
      })
    );
    expect(
      h.recoveryPorts.readCommittedOpenCodeBootstrapSessionEvidence
    ).toHaveBeenCalledExactlyOnceWith({
      teamsBasePath: h.evidencePorts.teamsBasePath,
      teamName: input.teamName,
      laneId: input.laneId,
    });
    expect(h.recoveryPorts.setOpenCodeRuntimeActiveRunManifest).toHaveBeenCalledExactlyOnceWith({
      teamsBasePath: h.evidencePorts.teamsBasePath,
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
    });
    expect(h.startHost).not.toHaveBeenCalled();
    expect(h.missingHostRecovery).not.toHaveBeenCalled();
    expect(h.adapter.stop).not.toHaveBeenCalled();
    expect(h.runTracking.canDeliverToOpenCodeRuntimeForTeam(input.teamName)).toBe(false);
  });

  it('keeps the inbox pending when native reconciliation has no recoverable member evidence', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.runtimeProbe.mockResolvedValue({
      runId: 'read-only-reconciliation',
      teamName: input.teamName,
      launchPhase: 'reconciled',
      teamLaunchState: 'partial_pending',
      members: {},
      snapshot: null,
      warnings: [],
      diagnostics: [],
    });
    await expect(h.coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.runtimeProbe).toHaveBeenCalledTimes(1);
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.recoveryPorts.setOpenCodeRuntimeActiveRunManifest).not.toHaveBeenCalled();
    expect(h.startHost).not.toHaveBeenCalled();
    expect(h.missingHostRecovery).not.toHaveBeenCalled();
    expect(unread.read).toBe(false);
  });

  it('rejects a scheduled recovery after its tracked owner is stopped', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await expect(h.coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(1);
    h.run.cancelRequested = true;
    h.stop();
    expect(h.runTracking.canAttemptCommittedOpenCodeSessionRecovery(input.teamName)).toBe(false);
    // Leave the timer present to exercise the real recovery gate, not timer cancellation.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(
      h.recoveryPorts.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground
    ).toHaveBeenCalledExactlyOnceWith(input.teamName);
    expect(h.runtimeProbe).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.startHost).not.toHaveBeenCalled();
    expect(h.missingHostRecovery).not.toHaveBeenCalled();
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

it.each([false, true])(
  'real watchdog retains secondary delivery after failed primary, Stop=%s',
  async (stopped) => {
    vi.useFakeTimers();
    const h = createHarness();
    const lane = {
      providerId: 'opencode' as const,
      laneId: input.laneId,
      runId: input.runId,
      memberName: input.memberName,
    };
    h.run.progress.state = 'failed';
    h.run.retainedSecondaryDelivery = {
      ownerRunId: 'root-run-1',
      stopAllTeamsGeneration: 0,
      stopTeamGeneration: 0,
      lanes: [lane],
    };
    h.aliveRunByTeam.set(input.teamName, 'root-run-1');
    h.secondaryRuns.set(input.laneId, lane);
    h.scheduler.schedule({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: unread.messageId,
      delayMs: 500,
    });
    if (stopped) {
      h.stop();
      h.recover.mockResolvedValue(false);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(h.relay).toHaveBeenCalledTimes(stopped ? 0 : 1);
    if (!stopped) expect(h.recover).not.toHaveBeenCalled();
    expect(h.run.progress.state).toBe('failed');
    expect(
      h.runTracking.canDeliverToTrackedRuntimeRun(
        input.teamName,
        'root-run-1',
        'primary',
        'root-run-1'
      )
    ).toBe(false);
  }
);
