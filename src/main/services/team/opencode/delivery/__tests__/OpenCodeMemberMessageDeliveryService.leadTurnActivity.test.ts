import * as memberWorkSync from '@features/member-work-sync/main';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningMemberLifecycleOperationRunner } from '../../../provisioning/TeamProvisioningMemberLifecycleOperationRunner';
import { createDefaultOpenCodeRuntimeBootstrapEvidencePorts } from '../../../provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import { createOpenCodeBootstrapWakePorts } from '../../../provisioning/TeamProvisioningOpenCodeDeliveryComposition';
import { stopSingleMixedSecondaryRuntimeLane } from '../../../provisioning/TeamProvisioningOpenCodeRuntimeStopFlow';
import { updateProvisioningProgressMetadata } from '../../../provisioning/TeamProvisioningSecondaryStopProgress';
import { openCodeLaneTurnActivityRegistry } from '../OpenCodeLaneTurnActivityRegistry';
import {
  type OpenCodeLeadTurnActivityNotification,
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';
import { OpenCodePromptDeliveryFollowUpPolicy } from '../OpenCodePromptDeliveryFollowUpPolicy';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../OpenCodePromptDeliveryLedger';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../OpenCodePromptDeliveryStalePendingPolicy';
import { createOpenCodePromptDeliveryWatchdogCoordinator } from '../OpenCodePromptDeliveryWatchdogCoordinator';
import { OpenCodePromptDeliveryWatchdogScheduler } from '../OpenCodePromptDeliveryWatchdogScheduler';

import type { MixedSecondaryRuntimeLaneState } from '../../../provisioning/TeamProvisioningSecondaryRuntimeRuns';
import type { TeamRuntimeStopInput } from '../../../runtime';
import type { OpenCodeTeamRuntimeMessageResult } from '../../../runtime';
import type { TeamProvisioningProgress } from '@shared/types';

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const SECONDARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'secondary:opencode:muse',
  laneKind: 'secondary',
  laneOwnerProviderId: 'opencode',
};

function acceptedResult(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    sessionId: 'session-1',
    runtimePromptMessageId: 'prompt-1',
    diagnostics: [],
  };
}

/** Read-commit gate that settles only once the runtime has accepted the prompt. */
const settleAfterAcceptance = (record?: OpenCodePromptDeliveryLedgerRecord | null): boolean =>
  record != null && record.status !== 'pending';

function createDeps(input: {
  ledgerDir: string;
  laneIdentity: OpenCodeMemberLaneIdentity;
  memberName: string;
  send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  readAllowed: (record?: OpenCodePromptDeliveryLedgerRecord | null) => boolean;
  notify: ReturnType<typeof vi.fn>;
}): OpenCodeMemberMessageDeliveryServiceDependencies {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(input.ledgerDir, `${input.laneIdentity.laneId.replace(/:/g, '_')}.json`),
  });
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  return {
    getOpenCodeRuntimeMessageAdapter: vi.fn(
      () => ({ sendMessageToMember: vi.fn(async () => await input.send()) }) as never
    ),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: 'team-a', projectPath: '/repo', members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: input.memberName, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: input.memberName,
      laneId: input.laneIdentity.laneId,
      laneIdentity: input.laneIdentity,
      metaMember: { name: input.memberName, providerId: 'opencode' as const },
      memberRuntimeCwd: '/repo',
    })),
    isMemberLifecycleOperationActive: () => false,
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => '/repo'),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => ({ mixedSecondaryLanes: [] })) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'runtime-run-1'),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () => false),
    deleteSecondaryRuntimeRun: vi.fn(),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(
      async () => ({ appMcpTransportHash: 'hash' }) as never
    ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () => undefined),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(
      async ({ send }: { send: () => Promise<OpenCodeTeamRuntimeMessageResult> }) => await send()
    ),
    rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => undefined),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => true),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
    openCodeVisibleReplyProofService: {
      applyDestinationProof: passthroughProof as never,
      materializePlainTextReplyIfNeeded: passthroughProof as never,
      findByRelayOfMessageId: vi.fn(async () => null),
    },
    openCodePromptDeliveryWatchdogScheduler: { isEnabled: () => true },
    openCodePromptDeliveryFollowUpPolicy: {
      schedule: vi.fn(
        async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) =>
          ledgerRecord
      ),
    },
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null }) =>
        input.readAllowed(ledgerRecord)
    ),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'opencode_delivery_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    notifyOpenCodeLeadTurnActivity: input.notify as never,
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })
    ),
  };
}

function states(notify: ReturnType<typeof vi.fn>): OpenCodeLeadTurnActivityNotification['state'][] {
  return notify.mock.calls.map(([call]) => (call as OpenCodeLeadTurnActivityNotification).state);
}

const leadMessage: OpenCodeMemberMessageDeliveryInput = {
  memberName: 'team-lead',
  text: 'plan the sprint',
  messageId: 'user-1',
  messageKind: 'default',
  source: 'ui-send',
};

describe('OpenCodeMemberMessageDeliveryService lead turn activity', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-lead-turn-activity-'));
    openCodeLaneTurnActivityRegistry.clear();
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it("emits 'active' on acceptance and 'idle' once the primary-lane response is read-committable", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(false);
    expect(states(notify)).toEqual(['active', 'idle']);
    expect(notify).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'active',
    });
  });

  it("keeps the lead 'active' while an accepted primary-lane turn is still pending", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(true);
    expect(states(notify)).toEqual(['active']);
  });

  it("emits 'idle' when the primary-lane send throws", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => {
          throw new Error('bridge down');
        },
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.delivered).toBe(false);
    expect(states(notify)).toEqual(['idle']);
  });

  it('never reports lead activity for a secondary lane', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: SECONDARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    // The turn is still recorded: nothing else in the app sees a secondary lane settle.
    expect(openCodeLaneTurnActivityRegistry.get('team-a', 'Muse')).toMatchObject({
      laneId: SECONDARY_LANE.laneId,
      state: 'idle',
    });
  });

  it.each([true, false])(
    'observes an uncertain group handoff without sending it twice (proof=%s)',
    async (found) => {
      const send = vi.fn(async () => ({
        ok: false,
        providerId: 'opencode' as const,
        memberName: 'team-lead',
        diagnostics: ['OpenCode readiness phase host_start timed out after 24536ms'],
      }));
      const deps = createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send,
        readAllowed: (record) => record?.responseState === 'responded_visible_message',
        notify: vi.fn(),
      });
      const observe = vi.fn(async () => ({
        ok: true,
        providerId: 'opencode' as const,
        memberName: 'team-lead',
        diagnostics: [],
        responseObservation: {
          state: found ? ('responded_visible_message' as const) : ('not_observed' as const),
          deliveredUserMessageId: found ? 'accepted-prompt' : null,
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
      }));
      deps.getOpenCodeRuntimeMessageAdapter = () =>
        ({ sendMessageToMember: send, observeMessageDelivery: observe }) as never;
      const service = new OpenCodeMemberMessageDeliveryService(deps);
      const message = { ...leadMessage, groupChatId: 'test-group', groupRunKey: 'run-1' };
      await service.deliver('team-a', message);
      const ledger = deps.createOpenCodePromptDeliveryLedger('team-a', PRIMARY_LANE.laneId);
      const [record] = await ledger.list();
      await ledger.markAcceptanceUnknown({
        id: record.id,
        reason: 'bridge_timeout',
        nextAttemptAt: new Date(0).toISOString(),
        diagnostics: [],
        markedAt: new Date().toISOString(),
      });
      const result = await service.deliver('team-a', message);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(result.responsePending).toBe(!found);
      if (!found) {
        expect(result.acceptanceUnknown).toBe(true);
        const [deferred] = await ledger.list();
        expect(Date.parse(deferred.nextAttemptAt!)).toBeGreaterThan(Date.now());
        expect((await service.deliver('team-a', message)).acceptanceUnknown).toBe(true);
        expect(observe).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('retries a group send only after the runtime confirms it never submitted the prompt', async () => {
    const send = vi
      .fn<() => Promise<OpenCodeTeamRuntimeMessageResult>>()
      .mockResolvedValueOnce({
        ok: false,
        providerId: 'opencode',
        memberName: 'team-lead',
        promptNotSubmitted: true,
        diagnostics: ['host acquisition timed out'],
      })
      .mockResolvedValueOnce(acceptedResult('team-lead'));
    const deps = createDeps({
      ledgerDir,
      laneIdentity: PRIMARY_LANE,
      memberName: 'team-lead',
      send,
      readAllowed: (record) => Boolean(record?.runtimePromptMessageId),
      notify: vi.fn(),
    });
    deps.openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
      scheduleWatchdog: vi.fn(),
      logEvent: vi.fn(),
      markFailedTerminal: async (input) => input.ledger.markFailedTerminal(input),
    });
    const observe = vi.fn(async () => ({
      ok: true,
      providerId: 'opencode' as const,
      memberName: 'team-lead',
      diagnostics: [],
      responseObservation: {
        state: 'not_observed' as const,
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: null,
      },
    }));
    deps.getOpenCodeRuntimeMessageAdapter = () =>
      ({ sendMessageToMember: send, observeMessageDelivery: observe }) as never;
    const service = new OpenCodeMemberMessageDeliveryService(deps);
    const message = { ...leadMessage, groupChatId: 'test-group', groupRunKey: 'run-1' };
    await service.deliver('team-a', message);
    const ledger = deps.createOpenCodePromptDeliveryLedger('team-a', PRIMARY_LANE.laneId);
    const [failed] = await ledger.list();
    expect(failed).toMatchObject({
      status: 'retry_scheduled',
      acceptanceUnknown: false,
      attempts: 1,
    });
    await ledger.markNextAttemptScheduled({
      id: failed.id,
      status: 'retry_scheduled',
      nextAttemptAt: new Date(0).toISOString(),
      reason: failed.lastReason!,
      scheduledAt: new Date().toISOString(),
    });
    const recovered = await service.deliver('team-a', message);
    expect(recovered).toMatchObject({ accepted: true, responsePending: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('never reports lead activity for a same-model primary teammate', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    // Lane membership is not lead identity, but the turn still belongs in the registry.
    expect(openCodeLaneTurnActivityRegistry.get('team-a', 'Muse')).toMatchObject({
      laneId: 'primary',
      state: 'idle',
    });
  });

  it.each([false, true])(
    'does not downgrade recovered acceptance after late send failure (throw=%s)',
    async (throws) => {
      const deps = createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        readAllowed: () => false,
        notify: vi.fn(),
        send: async () => {
          const ledger = deps.createOpenCodePromptDeliveryLedger('team-a', PRIMARY_LANE.laneId);
          const [row] = await ledger.list();
          await ledger.applyObservation({
            id: row.id,
            observedAt: new Date().toISOString(),
            responseObservation: {
              state: 'pending',
              deliveredUserMessageId: 'fresh-prompt',
              assistantMessageId: null,
              toolCallNames: [],
              visibleMessageToolCallId: null,
              visibleReplyMessageId: null,
              visibleReplyCorrelation: null,
              latestAssistantPreview: null,
              reason: null,
            },
          });
          if (throws) throw new Error('late transport timeout');
          return {
            ok: false,
            providerId: 'opencode',
            memberName: 'team-lead',
            diagnostics: ['late transport timed out'],
          };
        },
      });
      const result = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
        ...leadMessage,
        groupChatId: 'test-group',
        groupRunKey: 'run-1',
      });
      expect(result).toMatchObject({ accepted: true, responsePending: true });
      const [record] = await deps
        .createOpenCodePromptDeliveryLedger('team-a', PRIMARY_LANE.laneId)
        .list();
      expect(record).toMatchObject({
        acceptanceUnknown: false,
        attempts: 1,
        responseState: 'pending',
        runtimePromptMessageId: 'fresh-prompt',
      });
    }
  );

  it('swallows notification failures without affecting the delivery result', async () => {
    const notify = vi.fn(() => {
      throw new Error('renderer gone');
    });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    try {
      const delivery = await service.deliver('team-a', leadMessage);

      expect(delivery.accepted).toBe(true);
      expect(delivery.responsePending).toBe(false);
      expect(states(notify)).toEqual(['active', 'idle']);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Service:OpenCodeMemberMessageDelivery]',
        expect.stringContaining('lead turn activity (active) notification failed: renderer gone')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

describe('secondary delivery waiting for a native bootstrap commit', () => {
  let ledgerDir: string;
  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-bootstrap-wake-'));
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(ledgerDir, { recursive: true, force: true });
  });

  function harness(responsePending = false, realFollowUps = false) {
    const send = vi.fn(async () => acceptedResult('Muse'));
    const deps = createDeps({
      ledgerDir,
      laneIdentity: SECONDARY_LANE,
      memberName: 'Muse',
      send,
      readAllowed: responsePending ? () => false : settleAfterAcceptance,
      notify: vi.fn(),
    });
    const lane = {
      laneId: SECONDARY_LANE.laneId,
      member: { name: 'Muse' },
      runId: 'runtime-run-1',
    };
    const root = { mixedSecondaryLanes: [lane] };
    deps.runs = { get: () => root };
    let committed = false;
    deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = vi.fn(async () =>
      committed ? ({ appMcpTransportHash: 'hash' } as never) : null
    );
    const service = new OpenCodeMemberMessageDeliveryService(deps);
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const message = { ...leadMessage, memberName: 'Muse', source: 'watcher' as const };
    const relay = vi.fn(async (wake: { isCurrent?: () => boolean }) => {
      try {
        return await service.deliver('team-a', { ...message, isCurrent: wake.isCurrent });
      } finally {
        complete();
      }
    });
    const scheduler = new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: () => true,
      recoverBeforeDelivery: async () => false,
      relay,
      getInboxMessages: async () => [],
      resolveIdentity: async () => null,
      isLaneActive: async () => true,
      isRecordNotFoundError: () => false,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      diagnostic: vi.fn(),
      getErrorMessage: String,
    });
    const scheduled = vi.fn(
      (input: Parameters<OpenCodePromptDeliveryWatchdogScheduler['schedule']>[0]) =>
        scheduler.schedule(input)
    );
    deps.scheduleOpenCodePromptDeliveryWatchdog = scheduled;
    if (realFollowUps)
      deps.openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
        scheduleWatchdog: scheduled,
        logEvent: vi.fn(),
        markFailedTerminal: async (input) => await input.ledger.markFailedTerminal(input),
      });
    return {
      deps,
      scheduled,
      service,
      scheduler,
      send,
      relay,
      message,
      lane,
      root,
      completed,
      commit: () => {
        committed = true;
      },
    };
  }

  it('keeps an admitted Relaunch task raw, restores copied stop progress, and submits only to the new lane after release', async () => {
    const h = harness();
    const lifecycle = createTeamProvisioningMemberLifecycleOperationRunner({
      memberLifecycleOperations: new Map(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      nowMs: Date.now,
    });
    h.deps.isMemberLifecycleOperationActive = lifecycle.isMemberLifecycleOperationActive;
    h.commit();
    const lane: MixedSecondaryRuntimeLaneState = Object.assign(h.lane, {
      providerId: 'opencode' as const,
      state: 'finished' as const,
      result: null,
      warnings: [],
      diagnostics: [],
    });
    const run = Object.assign(h.root, {
      runId: 'run-1',
      teamName: 'team-a',
      request: { cwd: ledgerDir },
      progress: {
        runId: 'run-1',
        teamName: 'team-a',
        state: 'ready',
        message: 'Ready',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as TeamProvisioningProgress,
    });
    h.deps.resolveDeliverableTrackedRuntimeRunId = () =>
      run.progress.state === 'ready' ? run.runId : null;
    h.deps.getCurrentOpenCodeRuntimeRunId = () => lane.runId;
    let admit!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bootstrapped!: () => void;
    const bootstrapReady = new Promise<void>((resolve) => {
      bootstrapped = resolve;
    });
    let continueStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      continueStop = resolve;
    });
    const operation = lifecycle.runMemberLifecycleOperation(
      'team-a',
      'Muse',
      'manual_restart',
      async () => {
        admit();
        await stopBarrier;
        await stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch', {
          teamsBasePath: ledgerDir,
          isCurrentRun: () => true,
          getOpenCodeRuntimeAdapter: () =>
            ({
              stop: async (input: TeamRuntimeStopInput) => {
                expect(run.progress.state).toBe('ready');
                expect((await h.service.deliver('team-a', h.message)).delivered).toBe(false);
                expect(h.deps.createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
                expect(h.send).not.toHaveBeenCalled();
                updateProvisioningProgressMetadata(run, {
                  cliLogsTail: 'Fresh diagnostics copied during Stop',
                });
                return {
                  runId: input.runId,
                  teamName: input.teamName,
                  stopped: true,
                  members: {},
                  warnings: [],
                  diagnostics: [],
                };
              },
            }) as never,
          readLaunchState: async () => null,
          isRuntimeProcessAlive: () => false,
          upsertOpenCodeRuntimeLaneIndexEntry: async () => undefined,
          clearOpenCodeRuntimeLaneStorage: async () => true,
          deleteSecondaryRuntimeRun: vi.fn(),
          logger: { warn: vi.fn(), info: vi.fn() },
        });
        expect(run.progress.state).toBe('ready');
        expect(run.progress.cliLogsTail).toBe('Fresh diagnostics copied during Stop');
        lane.runId = 'runtime-run-new';
        h.commit();
        const evidence = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
          teamsBasePath: ledgerDir,
        });
        evidence.readCommittedBootstrapSessionEvidence = async () => ({
          state: 'healthy',
          committed: true,
          activeRunId: lane.runId,
          diagnostics: [],
          sessions: [
            {
              id: 'new-session',
              teamName: 'team-a',
              laneId: lane.laneId,
              runId: 'runtime-run-new',
              memberName: 'Muse',
              observedAt: new Date().toISOString(),
              source: 'runtime_bootstrap_checkin',
            },
          ],
        });
        const coordinator = createOpenCodePromptDeliveryWatchdogCoordinator({
          ...createOpenCodeBootstrapWakePorts(
            {
              runTracking: {
                resolveDeliverableTrackedRuntimeRunId: h.deps.resolveDeliverableTrackedRuntimeRunId,
              },
              runs: new Map([[run.runId, run]]),
            },
            () => evidence
          ),
          watchdogScheduler: h.scheduler,
          canDeliverToTeamRuntime: () => run.progress.state === 'ready',
          hasAcceptedMemberWorkSyncReport: async () => false,
          taskRefsIncludeAll: () => true,
          visibleReplyProofService: h.deps.openCodeVisibleReplyProofService,
          maybeSyncRuntimePermissionsAfterDelivery: async () => undefined,
          rememberRuntimePidFromBridge: async () => undefined,
          recoverRuntimeLanesForWatchdog: async () => [],
          stopRuntimeLanesForStoppedTeam: async () => 0,
          readActiveRuntimeLaneIds: async () => [lane.laneId],
          createLedger: h.deps.createOpenCodePromptDeliveryLedger,
          resolveMembersForRuntimeLane: async () => ['Muse'],
          getInboxMessages: async () => [
            {
              from: 'team-lead',
              to: 'Muse',
              read: false,
              text: h.message.text,
              timestamp: new Date().toISOString(),
              messageId: h.message.messageId,
            },
          ],
          resolveCurrentRuntimeRunId: async () => lane.runId,
          hasStableInboxMessageId: (message): message is typeof message & { messageId: string } =>
            Boolean(message.messageId),
          logPromptDeliveryEvent: vi.fn(),
        });
        expect(
          await coordinator.wakeAfterBootstrapCommit({
            teamName: 'team-a',
            memberName: 'Muse',
            laneId: lane.laneId,
            runId: lane.runId,
          })
        ).toBe(1);
        bootstrapped();
        await released;
      }
    );
    try {
      await admitted;
      await h.service.deliver('team-a', h.message);
      expect(h.deps.createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.deps.tryRecoverOpenCodeRuntimeLaneBeforeDelivery).not.toHaveBeenCalled();
      continueStop();
      // New bootstrap arms the same owned timer while its lifecycle operation remains admitted.
      await bootstrapReady;
      expect(lane.runId).toBe('runtime-run-new');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.deps.createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
      release();
      await operation;
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
      const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', lane.laneId);
      await vi.waitFor(async () =>
        expect(await ledger.list()).toEqual([
          expect.objectContaining({ runId: 'runtime-run-new', attempts: 1 }),
        ])
      );
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      continueStop();
      release();
      await operation;
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each([
    ['primary_member_updated', true],
    ['skip_for_launch', true],
    ['primary_member_updated', false],
  ] as const)(
    'records an accepted prompt when non-replacing %s is admitted during SDK submission (watchdog=%s)',
    async (kind, watchdog) => {
      const h = harness();
      h.commit();
      h.deps.openCodePromptDeliveryWatchdogScheduler = { isEnabled: () => watchdog };
      const lifecycle = createTeamProvisioningMemberLifecycleOperationRunner({
        memberLifecycleOperations: new Map(),
        invalidateRuntimeSnapshotCaches: vi.fn(),
        nowMs: Date.now,
      });
      h.deps.isMemberLifecycleOperationActive = (team, member) =>
        lifecycle.isMemberLifecycleOperationActive(team, member);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let operation: Promise<void> | undefined;
      h.send.mockImplementationOnce(async () => {
        operation = lifecycle.runMemberLifecycleOperation('team-a', 'Muse', kind, async () => {
          await hold;
        });
        return acceptedResult('Muse');
      });
      try {
        const result = await h.service.deliver('team-a', h.message);
        expect(result.accepted).toBe(true);
        if (watchdog) {
          const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', SECONDARY_LANE.laneId);
          expect(await ledger.list()).toEqual([
            expect.objectContaining({
              attempts: 1,
              runtimeSessionId: 'session-1',
              lastRuntimePromptMessageId: 'prompt-1',
            }),
          ]);
        } else expect(h.deps.createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
        expect(h.send).toHaveBeenCalledTimes(1);
        release();
        await operation;
        await vi.advanceTimersByTimeAsync(9_000);
        expect(h.send).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await operation;
        h.scheduler.cancelTeam('team-a');
      }
    }
  );

  it('commits a group submission before a non-replacing admission during the durable handoff write', async () => {
    const h = harness();
    h.commit();
    const lifecycle = createTeamProvisioningMemberLifecycleOperationRunner({
      memberLifecycleOperations: new Map(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      nowMs: Date.now,
    });
    h.deps.isMemberLifecycleOperationActive = (team, member) =>
      lifecycle.isMemberLifecycleOperationActive(team, member);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let operation: Promise<void> | undefined;
    const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', SECONDARY_LANE.laneId);
    const mark = ledger.markNextAttemptScheduled.bind(ledger);
    const handoff = vi
      .spyOn(ledger, 'markNextAttemptScheduled')
      .mockImplementation(async (input) => {
        const persisted = await mark(input);
        if (input.reason === 'group_handoff_started_acceptance_unknown') {
          expect(persisted.status).toBe('accepted');
          expect(h.send).not.toHaveBeenCalled();
          operation = lifecycle.runMemberLifecycleOperation(
            'team-a',
            'Muse',
            'primary_member_updated',
            async () => {
              await hold;
            }
          );
        }
        return persisted;
      });
    try {
      const result = await h.service.deliver('team-a', {
        ...h.message,
        groupChatId: 'owned-test-group',
        groupRunKey: h.lane.runId,
        groupMessageId: 'group-message-1',
        groupChatProtocolVersion: 1,
      });
      expect(result.accepted).toBe(true);
      expect(handoff).toHaveBeenCalledOnce();
      expect(h.send).toHaveBeenCalledOnce();
      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          attempts: 1,
          runtimeSessionId: 'session-1',
          lastRuntimePromptMessageId: 'prompt-1',
        }),
      ]);
      release();
      await operation;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.send).toHaveBeenCalledOnce();
    } finally {
      release();
      await operation;
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('leaves the message raw if restart admission happens during the bootstrap read', async () => {
    const h = harness();
    let active = false;
    h.deps.isMemberLifecycleOperationActive = () => active;
    h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = async () => {
      active = true;
      return { appMcpTransportHash: 'hash' } as never;
    };
    try {
      const result = await h.service.deliver('team-a', h.message);
      expect(result.delivered).toBe(false);
      expect(h.deps.createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.scheduled).toHaveBeenCalledOnce();
      h.lane.runId = 'new-owner';
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each(['policy-followup', 'queued-behind', 'not-due', 'new-retry'] as const)(
    'keeps %s watchdog descendants scoped when the lane is replaced',
    async (path) => {
      const h = harness(true, path !== 'queued-behind');
      h.commit();
      let current = true;
      if (path === 'new-retry')
        h.send.mockResolvedValueOnce({
          ...acceptedResult('Muse'),
          runtimePromptMessageId: undefined,
        });
      try {
        await h.service.deliver('team-a', { ...h.message, isCurrent: () => current });
        if (path === 'queued-behind' || path === 'not-due') {
          h.scheduler.cancelTeam('team-a');
          await h.service.deliver('team-a', {
            ...h.message,
            messageId: path === 'queued-behind' ? 'queued-second' : h.message.messageId,
            isCurrent: () => current,
          });
        }
        expect(h.scheduled.mock.calls.length).toBeGreaterThan(0);
        const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', SECONDARY_LANE.laneId);
        const before = await ledger.list();
        current = false;
        h.lane.runId = 'replacement-run';
        h.deps.getCurrentOpenCodeRuntimeRunId = () => 'replacement-run';
        await vi.advanceTimersByTimeAsync(15_000);
        if (h.relay.mock.calls.length) await h.completed;
        expect(h.relay).not.toHaveBeenCalled();
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(await ledger.list()).toEqual(before);
      } finally {
        h.scheduler.cancelTeam('team-a');
      }
    }
  );

  it('keeps a current scoped followup observing its one accepted send', async () => {
    const h = harness(true, true);
    h.commit();
    try {
      await h.service.deliver('team-a', { ...h.message, isCurrent: () => true });
      await vi.advanceTimersByTimeAsync(15_000);
      await h.completed;
      expect(h.relay).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('submits a message queued during Relaunch once after late native commit without another inbox mutation', async () => {
    const h = harness();
    try {
      const refused = await h.service.deliver('team-a', h.message);
      expect(refused.delivered).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
      h.commit();
      await vi.advanceTimersByTimeAsync(3_000);
      await h.completed;
      expect(h.relay).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('observes an already submitted prompt without sending it again when bootstrap temporarily disappears', async () => {
    const h = harness(true);
    try {
      h.commit();
      const accepted = await h.service.deliver('team-a', h.message);
      expect(accepted.accepted).toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
      const probe = h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence.bind(h.deps);
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = async () => null;
      await h.service.deliver('team-a', h.message);
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = probe;
      await vi.advanceTimersByTimeAsync(3_000);
      await h.completed;
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each(['stop', 'replacement', 'removed-lane', 'root-replacement', 'secondary-owner'] as const)(
    'does not resurrect a pending wake after %s during bootstrap read',
    async (change) => {
      const h = harness();
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = async () => {
        started();
        await waiting;
        return null;
      };
      const delivery = h.service.deliver('team-a', h.message);
      await reading;
      if (change === 'stop') h.deps.stoppingSecondaryRuntimeTeams = { has: () => true };
      if (change === 'replacement') h.lane.runId = 'replacement-run';
      if (change === 'removed-lane') h.root.mixedSecondaryLanes = [];
      if (change === 'root-replacement') h.deps.runs = { get: () => ({ ...h.root }) };
      if (change === 'secondary-owner') h.deps.getCurrentOpenCodeRuntimeRunId = () => 'other-run';
      h.scheduler.cancelTeam('team-a');
      finish();
      await delivery;
      expect(h.scheduled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it('restores the existing lane ticket when authorization is revoked during gate hydration', async () => {
    const h = harness();
    let current = true;
    const restore = vi.fn();
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockImplementationOnce(async () => {
        current = false;
        return { restore };
      });
    try {
      const result = await h.service.deliver('team-a', { ...h.message, isCurrent: () => current });
      expect(result.reason).toBe('opencode_prompt_delivery_cancelled');
      expect(restore).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.scheduled).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each([true, false])(
    'restores a consumed reservation after admission during serialization (watchdog=%s)',
    async (watchdog) => {
      const h = harness();
      h.commit();
      const ticket = {
        teamName: 'team-a',
        memberName: 'Muse',
        teamIncarnation: 'inc-1',
        runtimeInstanceId: 'opencode:secondary:session-1',
        expectedGeneration: 1,
        ticketId: 'serialization-ticket',
        intentId: h.message.messageId!,
        controlRevision: 1,
        admissionPayloadHash: 'owned-test-hash',
      };
      memberWorkSync.restoreOpenCodeWorkSyncLane(ticket);
      expect(memberWorkSync.peekOpenCodeWorkSyncLane(ticket)).toEqual(ticket);
      let active = false;
      h.deps.isMemberLifecycleOperationActive = () => active;
      h.deps.openCodePromptDeliveryWatchdogScheduler = { isEnabled: () => watchdog };
      h.deps.sendOpenCodeMemberMessageToRuntimeSerialized = async ({ send }) => {
        expect(memberWorkSync.peekOpenCodeWorkSyncLane(ticket)).toBeUndefined();
        active = true;
        return await send();
      };
      try {
        const result = await h.service.deliver('team-a', { ...h.message, source: 'ui-send' });
        expect(result.reason).toBe('opencode_prompt_delivery_cancelled');
        expect(h.send).not.toHaveBeenCalled();
        expect(memberWorkSync.peekOpenCodeWorkSyncLane(ticket)).toEqual(ticket);
      } finally {
        memberWorkSync.consumeOpenCodeWorkSyncLane({ ...ticket, messageId: ticket.intentId });
        h.scheduler.cancelTeam('team-a');
      }
    }
  );

  it('does not restore a ticket after a durable group handoff has begun', async () => {
    const h = harness();
    h.commit();
    let current = true;
    const restore = vi.fn();
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockResolvedValueOnce({ restore });
    const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', SECONDARY_LANE.laneId);
    const mark = ledger.markNextAttemptScheduled.bind(ledger);
    vi.spyOn(ledger, 'markNextAttemptScheduled').mockImplementationOnce(async (input) => {
      const row = await mark(input);
      current = false;
      return row;
    });
    try {
      const result = await h.service.deliver('team-a', {
        ...h.message,
        isCurrent: () => current,
        groupChatId: 'owned-test-group',
        groupRunKey: h.lane.runId,
        groupMessageId: 'cancelled-group-message',
        groupChatProtocolVersion: 1,
      });
      expect(result.reason).toBe('opencode_prompt_delivery_cancelled');
      expect(h.send).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          status: 'accepted',
          lastReason: 'group_handoff_started_acceptance_unknown',
          attempts: 0,
        }),
      ]);
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each([true, false])(
    'does not restore a consumed lane ticket after the provider accepted a revoked scoped send (watchdog=%s)',
    async (watchdog) => {
      const h = harness();
      h.commit();
      h.deps.openCodePromptDeliveryWatchdogScheduler = { isEnabled: () => watchdog };
      let current = true;
      const restore = vi.fn();
      const consumed = vi.fn(() => ({}));
      const gate = vi
        .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
        .mockResolvedValueOnce({ restore, consumeForSend: consumed });
      h.send.mockImplementationOnce(async () => {
        current = false;
        return acceptedResult('Muse');
      });
      try {
        await h.service.deliver('team-a', {
          ...h.message,
          messageKind: 'member_work_sync_nudge',
          workSyncRuntimeTicketId: 'ticket',
          isCurrent: () => current,
        });
        expect(consumed).toHaveBeenCalledTimes(watchdog ? 1 : 0);
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(restore).not.toHaveBeenCalled();
      } finally {
        gate.mockRestore();
        h.scheduler.cancelTeam('team-a');
      }
    }
  );

  it('restores a lane ticket before scheduling a bootstrap-pending retry', async () => {
    const h = harness();
    const restore = vi.fn();
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockResolvedValueOnce({ restore });
    try {
      await h.service.deliver('team-a', h.message);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(h.scheduled).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('delivers once for a replacement generation whose wake shares the previous message key', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.lane.runId = 'runtime-run-2';
    h.deps.getCurrentOpenCodeRuntimeRunId = () => 'runtime-run-2';
    await h.service.deliver('team-a', h.message);
    h.commit();
    await vi.advanceTimersByTimeAsync(3_000);
    await h.completed;
    expect(h.relay).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.scheduler.cancelTeam('team-a');
  });

  it('keeps the originating generation fence while the relay is reading delivery context', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.commit();
    const readDirectory = h.deps.readOpenCodeMemberDirectory.bind(h.deps);
    h.deps.readOpenCodeMemberDirectory = async (teamName) => {
      const directory = await readDirectory(teamName);
      h.lane.runId = 'replacement-run';
      return directory;
    };
    await vi.advanceTimersByTimeAsync(3_000);
    await h.completed;
    expect(h.send).not.toHaveBeenCalled();
    h.scheduler.cancelTeam('team-a');
  });

  it('drops an already scheduled wake when its lane owner changes', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.commit();
    h.lane.runId = 'replacement-run';
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    h.scheduler.cancelTeam('team-a');
  });
});
