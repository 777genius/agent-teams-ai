import { describe, expect, it, vi } from 'vitest';

import { OpenCodeMemberMessageDeliveryService } from '../../../../src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryService';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryStalePendingPolicy';
import { OpenCodeVisibleReplyProofService } from '../../../../src/main/services/team/opencode/delivery/OpenCodeVisibleReplyProofService';

import type {
  OpenCodeMemberMessageDeliveryServiceDependencies,
  OpenCodeRuntimeMessageAdapter,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

function makeAdapter(sendMessageToMember = vi.fn()): OpenCodeRuntimeMessageAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
    sendMessageToMember,
  } as unknown as OpenCodeRuntimeMessageAdapter;
}

function unexpected(name: string): never {
  throw new Error(`Unexpected OpenCode member delivery dependency call: ${name}`);
}

function makeLedgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord>
): OpenCodePromptDeliveryLedgerRecord {
  const now = '2026-05-09T12:00:00.000Z';
  return {
    id: 'opencode-prompt:team-a:primary:alice:msg-1',
    teamName: 'team-a',
    memberName: 'alice',
    laneId: 'primary',
    runId: 'run-1',
    runtimeSessionId: null,
    runtimePromptMessageId: null,
    runtimePromptMessageIds: [],
    lastRuntimePromptMessageId: null,
    lastDeliveryAttemptIdWithAcceptedPrompt: null,
    inboxMessageId: 'msg-1',
    inboxTimestamp: now,
    source: 'ui-send',
    messageKind: null,
    workSyncIntent: null,
    replyRecipient: 'user',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'sha256:test',
    status: 'pending',
    responseState: 'not_observed',
    attempts: 0,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    maxSessionRefreshAttempts: 5,
    lastSessionRefreshReason: null,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastObservedAt: null,
    acceptedAt: null,
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: null,
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<OpenCodeMemberMessageDeliveryServiceDependencies> = {}
): OpenCodeMemberMessageDeliveryServiceDependencies {
  return {
    getOpenCodeRuntimeMessageAdapter: () => makeAdapter(),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: {
        name: 'Team',
        color: 'blue',
        projectPath: '/tmp/project',
        members: [{ name: 'alice', providerId: 'opencode' as const }],
      },
      teamMeta: null,
      metaMembers: [],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: 'alice',
      laneId: 'primary',
      laneIdentity: {
        laneId: 'primary',
        laneKind: 'primary' as const,
        laneOwnerProviderId: 'opencode' as const,
      },
      configMember: { name: 'alice', providerId: 'opencode' as const },
    })),
    stoppingSecondaryRuntimeTeams: { has: vi.fn(() => false) },
    readPersistedTeamProjectPath: vi.fn(() => null),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => undefined) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => null),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => null),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () =>
      unexpected('tryRecoverOpenCodeRuntimeLaneBeforeDelivery')
    ),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () =>
      unexpected('tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery')
    ),
    deleteSecondaryRuntimeRun: vi.fn(() => unexpected('deleteSecondaryRuntimeRun')),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(() =>
      unexpected('cleanupStoppedTeamOpenCodeRuntimeLanesInBackground')
    ),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(async () => null),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () =>
      unexpected('stampOpenCodeAppMcpTransportEvidenceIfMissing')
    ),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(async ({ send }) => send()),
    rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => undefined),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => true),
    createOpenCodePromptDeliveryLedger: vi.fn(() =>
      unexpected('createOpenCodePromptDeliveryLedger')
    ),
    openCodeVisibleReplyProofService: {
      applyDestinationProof: vi.fn(async () => unexpected('applyDestinationProof')),
      materializePlainTextReplyIfNeeded: vi.fn(async () =>
        unexpected('materializePlainTextReplyIfNeeded')
      ),
      findByRelayOfMessageId: vi.fn(async () => unexpected('findByRelayOfMessageId')),
    },
    openCodePromptDeliveryWatchdogScheduler: { isEnabled: vi.fn(() => false) },
    openCodePromptDeliveryFollowUpPolicy: {
      schedule: vi.fn(async () => unexpected('openCodePromptDeliveryFollowUpPolicy.schedule')),
    },
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => true),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'opencode_delivery_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(async () =>
      unexpected('markOpenCodeAcceptedDeliveryMissingPromptProofForRetry')
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(() =>
      unexpected('scheduleOpenCodePromptDeliveryWatchdog')
    ),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(async () =>
      unexpected('requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded')
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(async () =>
      unexpected('observeOpenCodeDirectUserDeliveryInlineIfNeeded')
    ),
    ...overrides,
  };
}

describe('OpenCodeMemberMessageDeliveryService', () => {
  it('returns bridge unavailable before reading member directory when runtime adapter is missing', async () => {
    const readOpenCodeMemberDirectory = vi.fn(async () =>
      unexpected('readOpenCodeMemberDirectory')
    );
    const deps = makeDeps({
      getOpenCodeRuntimeMessageAdapter: () => null,
      readOpenCodeMemberDirectory,
    });

    await expect(
      new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
        memberName: 'alice',
        text: 'hello',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });
    expect(readOpenCodeMemberDirectory).not.toHaveBeenCalled();
  });

  it('keeps the legacy unavailable-recipient reason mapping at the facade boundary', async () => {
    const deps = makeDeps({
      resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
        ok: false as const,
        reason: 'opencode_recipient_unavailable' as const,
      })),
    });

    await expect(
      new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
        memberName: 'missing',
        text: 'hello',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_is_not_opencode',
    });
  });

  it('serializes a watchdog-disabled runtime send and reports accepted delivery', async () => {
    const sendMessageToMember = vi.fn(async () => ({
      ok: true,
      providerId: 'opencode' as const,
      memberName: 'alice',
      sessionId: 'session-1',
      runtimePid: 1234,
      diagnostics: [],
    }));
    const deps = makeDeps({
      getOpenCodeRuntimeMessageAdapter: () => makeAdapter(sendMessageToMember),
    });

    const delivery = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
      memberName: 'alice',
      text: 'ship this',
      messageId: 'msg-1',
      source: 'ui-send',
    });

    expect(delivery).toEqual({
      delivered: true,
      accepted: true,
      responsePending: false,
      responseState: undefined,
      diagnostics: [],
    });
    expect(deps.sendOpenCodeMemberMessageToRuntimeSerialized).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        laneId: 'primary',
      })
    );
    expect(sendMessageToMember).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        cwd: '/tmp/project',
        text: 'ship this',
        messageId: 'msg-1',
      })
    );
    expect(deps.rememberOpenCodeRuntimePidFromBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        memberName: 'alice',
        laneId: 'primary',
        runId: 'run-1',
        runtimeSessionId: 'session-1',
        runtimePid: 1234,
      })
    );
  });

  it('uses the prompt delivery ledger for message ids even when source is absent', async () => {
    const sendMessageToMember = vi.fn(async () => ({
      ok: true,
      providerId: 'opencode' as const,
      memberName: 'alice',
      diagnostics: [],
    }));
    const activeRecord = makeLedgerRecord({
      id: 'opencode-prompt:team-a:primary:alice:msg-active',
      inboxMessageId: 'msg-active',
      status: 'retry_scheduled',
      responseState: 'pending',
      nextAttemptAt: '2026-05-09T12:01:00.000Z',
    });
    const ledger = {
      getActiveForMember: vi.fn(async () => activeRecord),
      getByInboxMessage: vi.fn(async () => activeRecord),
    };
    const deps = makeDeps({
      getOpenCodeRuntimeMessageAdapter: () => makeAdapter(sendMessageToMember),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ledger as never),
      openCodePromptDeliveryWatchdogScheduler: { isEnabled: vi.fn(() => true) },
      openCodeVisibleReplyProofService: {
        applyDestinationProof: vi.fn(async () => ({
          ledgerRecord: activeRecord,
          visibleReply: null,
        })),
        materializePlainTextReplyIfNeeded: vi.fn(async () => ({
          ledgerRecord: activeRecord,
          visibleReply: null,
        })),
        findByRelayOfMessageId: vi.fn(async () => null),
      },
      isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
      scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    });

    const delivery = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
      memberName: 'alice',
      text: 'new message',
      messageId: 'msg-new',
    });

    expect(deps.createOpenCodePromptDeliveryLedger).toHaveBeenCalledWith('team-a', 'primary');
    expect(ledger.getActiveForMember).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      laneId: 'primary',
    });
    expect(delivery).toMatchObject({
      delivered: true,
      accepted: false,
      responsePending: true,
      queuedBehindMessageId: 'msg-active',
      reason: 'opencode_delivery_response_pending',
    });
    expect(sendMessageToMember).not.toHaveBeenCalled();
  });

  it('returns a terminal response when send-exception follow-up exhausts retries', async () => {
    const pendingRecord = makeLedgerRecord({});
    const failedRetryableRecord = makeLedgerRecord({
      status: 'failed_retryable',
      responseState: 'reconcile_failed',
      attempts: 3,
      maxAttempts: 3,
      lastReason: 'opencode_message_delivery_exception: bridge down',
      diagnostics: ['opencode_message_delivery_exception: bridge down'],
    });
    const terminalRecord = makeLedgerRecord({
      status: 'failed_terminal',
      responseState: 'reconcile_failed',
      attempts: 3,
      maxAttempts: 3,
      failedAt: '2026-05-09T12:00:01.000Z',
      lastReason: 'opencode_message_delivery_exception: bridge down',
      diagnostics: ['opencode_message_delivery_exception: bridge down'],
    });
    const ledger = {
      getActiveForMember: vi.fn(async () => null),
      ensurePending: vi.fn(async () => pendingRecord),
      getByInboxMessage: vi.fn(async () => pendingRecord),
      applyDeliveryResult: vi.fn(async () => failedRetryableRecord),
    };
    const deps = makeDeps({
      getOpenCodeRuntimeMessageAdapter: () =>
        makeAdapter(
          vi.fn(async () => {
            throw new Error('bridge down');
          })
        ),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ledger as never),
      openCodePromptDeliveryWatchdogScheduler: { isEnabled: vi.fn(() => true) },
      openCodeVisibleReplyProofService: {
        applyDestinationProof: vi.fn(async () => ({
          ledgerRecord: pendingRecord,
          visibleReply: null,
        })),
        materializePlainTextReplyIfNeeded: vi.fn(async () => ({
          ledgerRecord: pendingRecord,
          visibleReply: null,
        })),
        findByRelayOfMessageId: vi.fn(async () => null),
      },
      isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
      requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(async () => pendingRecord),
      openCodePromptDeliveryFollowUpPolicy: {
        schedule: vi.fn(async () => terminalRecord),
      },
    });

    const delivery = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
      memberName: 'alice',
      text: 'ship this',
      messageId: 'msg-1',
      source: 'ui-send',
    });

    expect(deps.openCodePromptDeliveryFollowUpPolicy.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        ledger,
        ledgerRecord: failedRetryableRecord,
        retry: true,
      })
    );
    expect(delivery).toMatchObject({
      delivered: false,
      accepted: false,
      responsePending: false,
      responseState: 'reconcile_failed',
      ledgerStatus: 'failed_terminal',
      reason: 'opencode_message_delivery_exception: bridge down',
    });
  });
  it.each(['queued', 'pid', 'permissions', 'read'] as const)(
    'fences legacy delivery when its run changes during %s',
    async (phase) => {
      let runId = 'run-1';
      const bridge = vi.fn(async () => ({ ok: true, diagnostics: [], sessionId: 'old-session' }));
      const deps = makeDeps({
        getOpenCodeRuntimeMessageAdapter: () => makeAdapter(bridge),
        resolveDeliverableTrackedRuntimeRunId: vi.fn(() => runId),
        sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(async ({ send }) => {
          if (phase === 'queued') runId = 'run-2';
          return await send();
        }),
        rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => {
          if (phase === 'pid') runId = 'run-2';
        }),
        maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => {
          if (phase === 'permissions') runId = 'run-2';
        }),
        isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => {
          if (phase === 'read') runId = 'run-2';
          return true;
        }),
      });
      await expect(
        new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
          memberName: 'alice',
          text: 'sync',
          messageId: 'msg-1',
          messageKind: 'member_work_sync_nudge',
        })
      ).resolves.toMatchObject({ delivered: false, accepted: false, responsePending: false });
      if (phase === 'queued') {
        expect(bridge).not.toHaveBeenCalled();
        expect(deps.rememberOpenCodeRuntimePidFromBridge).not.toHaveBeenCalled();
      }
      if (phase === 'queued' || phase === 'pid') {
        expect(deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery).not.toHaveBeenCalled();
      }
      if (phase !== 'read') {
        expect(deps.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['busy', 'unknown', 'cancelled-proof', 'superseded-proof'] as const)(
    'keeps the next delivery blocked by a %s active record',
    async (state) => {
      const active = makeLedgerRecord({
        status: 'accepted',
        responseState: 'pending',
        inboxMessageId: 'older-message',
        runtimePromptMessageId: 'prompt-1',
        acceptanceUnknown: state === 'unknown',
      });
      let current = active;
      let runId = 'run-1';
      const ledger = {
        getActiveForMember: vi.fn(async () => active),
        getByInboxMessage: vi.fn(async () => current),
        ensurePending: vi.fn(),
      };
      const bridge = vi.fn();
      const deps = makeDeps({
        getOpenCodeRuntimeMessageAdapter: () => makeAdapter(bridge),
        resolveDeliverableTrackedRuntimeRunId: vi.fn(() => runId),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger as never),
        openCodePromptDeliveryWatchdogScheduler: { isEnabled: vi.fn(() => true) },
        openCodeVisibleReplyProofService: {
          applyDestinationProof: vi.fn(async () => {
            if (state === 'superseded-proof') runId = 'run-2';
            if (state === 'cancelled-proof')
              current = {
                ...active,
                status: 'failed_terminal',
                cancelledAt: '2026-05-09T12:00:10.000Z',
                lastReason: 'opencode_prompt_delivery_cancelled',
              };
            return { ledgerRecord: active, visibleReply: null };
          }),
          materializePlainTextReplyIfNeeded: vi.fn(async () => ({
            ledgerRecord: active,
            visibleReply: null,
          })),
          findByRelayOfMessageId: vi.fn(async () => null),
        },
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
        scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
      });
      const result = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
        memberName: 'alice',
        text: 'next',
        messageId: 'msg-1',
      });
      expect(bridge).not.toHaveBeenCalled();
      expect(ledger.ensurePending).not.toHaveBeenCalled();
      if (state === 'cancelled-proof' || state === 'superseded-proof') {
        expect(result).toMatchObject({ delivered: false, responsePending: false });
        expect(
          deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded
        ).not.toHaveBeenCalled();
        expect(deps.scheduleOpenCodePromptDeliveryWatchdog).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          responsePending: true,
          queuedBehindMessageId: 'older-message',
        });
      }
    }
  );

  it.each(['resolve', 'reject', 'observe', 'successor', 'queued'] as const)(
    'suppresses late %s callbacks after cancellation',
    async (outcome) => {
      const pending = makeLedgerRecord(
        outcome === 'observe'
          ? {
              status: 'accepted',
              responseState: 'pending',
              runtimePromptMessageId: 'prompt-1',
            }
          : {}
      );
      let current = pending;
      let currentRunId = 'run-1';
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bridge = vi.fn(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (outcome === 'reject') throw new Error('bridge stopped');
        return {
          ok: true,
          diagnostics: [],
          runtimePid: 123,
          sessionId: 'old-session',
          runtimePromptMessageId: 'prompt-1',
          responseObservation: { state: 'responded_plain_text' },
        };
      });
      const adapter = makeAdapter(bridge);
      if (outcome === 'observe') adapter.observeMessageDelivery = bridge as never;
      const ledger = {
        getActiveForMember: vi.fn(async () => null),
        ensurePending: vi.fn(async () => pending),
        getByInboxMessage: vi.fn(async () => current),
        applyDeliveryResult: vi.fn(),
        applyObservation: vi.fn(),
      };
      const deps = makeDeps({
        getOpenCodeRuntimeMessageAdapter: () => adapter,
        resolveDeliverableTrackedRuntimeRunId: vi.fn(() => currentRunId),
        sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(async ({ send }) => {
          if (outcome === 'queued') {
            started();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return await send();
        }),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger as never),
        openCodePromptDeliveryWatchdogScheduler: { isEnabled: vi.fn(() => true) },
        openCodeVisibleReplyProofService: {
          applyDestinationProof: vi.fn(async () => ({ ledgerRecord: pending, visibleReply: null })),
          materializePlainTextReplyIfNeeded: vi.fn(async () => ({
            ledgerRecord: pending,
            visibleReply: null,
          })),
          findByRelayOfMessageId: vi.fn(async () => null),
        },
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
        requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(async () => pending),
      });
      const work = new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
        memberName: 'alice',
        text: 'ship this',
        messageId: 'msg-1',
      });
      await entered;
      if (outcome === 'successor') currentRunId = 'run-2';
      else
        current = {
          ...pending,
          status: 'failed_terminal',
          cancelledAt: '2026-05-09T12:00:10.000Z',
          lastReason: 'opencode_prompt_delivery_cancelled',
        };
      const proofCallsBeforeCancel = vi.mocked(
        deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded
      ).mock.calls.length;
      release();
      await expect(work).resolves.toMatchObject({
        delivered: false,
        accepted: false,
        responsePending: false,
        ...(outcome === 'successor' ? {} : { ledgerStatus: 'failed_terminal' }),
      });
      expect(deps.rememberOpenCodeRuntimePidFromBridge).not.toHaveBeenCalled();
      expect(deps.maybeSyncOpenCodeRuntimePermissionsAfterDelivery).not.toHaveBeenCalled();
      expect(deps.emitOpenCodePromptDeliveryTaskLogChange).not.toHaveBeenCalled();
      expect(deps.openCodePromptDeliveryFollowUpPolicy.schedule).not.toHaveBeenCalled();
      expect(ledger.applyDeliveryResult).not.toHaveBeenCalled();
      expect(ledger.applyObservation).not.toHaveBeenCalled();
      if (outcome === 'queued') expect(bridge).not.toHaveBeenCalled();
      expect(
        deps.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded
      ).toHaveBeenCalledTimes(proofCallsBeforeCancel);
    }
  );
});

it.each([false, true])(
  'prevents old-run reply writes when successor replaces run during lookup (active blocker: %s)',
  async (activeBlocker) => {
    let currentRun = 'run-1';
    let current = makeLedgerRecord({
      status: 'responded',
      responseState: 'responded_plain_text',
      observedAssistantPreview: 'The requested implementation is complete.',
    });
    const sendMessage = vi.fn(() =>
      Promise.resolve({ messageId: 'reply-old-run', deliveredToInbox: true })
    );
    const advisory = vi.fn();
    const proof = new OpenCodeVisibleReplyProofService({
      inboxReader: { getMessagesFor: vi.fn(() => Promise.resolve([])) },
      inboxWriter: {
        sendMessage,
        mergeRuntimeDeliveryTaskRefs: vi.fn(),
        correlateRuntimeDeliveryReply: vi.fn(),
      },
      getConfiguredLeadName: vi.fn(() => Promise.resolve(null)),
      emitRuntimeDeliveryReplyAdvisoryRefresh: advisory,
      warn: vi.fn(),
      getErrorMessage: String,
    });
    let findCount = 0;
    vi.spyOn(proof, 'findByRelayOfMessageId').mockImplementation(() => {
      findCount++;
      if (findCount === 2) currentRun = 'run-2';
      return Promise.resolve(null);
    });
    const ledger = {
      getActiveForMember: vi.fn(() => Promise.resolve(current)),
      ensurePending: vi.fn(() => Promise.resolve(current)),
      getByInboxMessage: vi.fn(() => Promise.resolve(current)),
      applyDestinationProof: vi.fn(() => {
        current = { ...current, visibleReplyMessageId: 'reply-old-run', visibleReplyInbox: 'user' };
        return Promise.resolve(current);
      }),
    };
    const deps = makeDeps({
      resolveDeliverableTrackedRuntimeRunId: vi.fn(() => currentRun),
      openCodePromptDeliveryWatchdogScheduler: { isEnabled: () => true },
      openCodeVisibleReplyProofService: proof,
      createOpenCodePromptDeliveryLedger: () => ledger as never,
    });
    const result = await new OpenCodeMemberMessageDeliveryService(deps).deliver('team-a', {
      memberName: 'alice',
      text: 'hello',
      messageId: activeBlocker ? 'msg-next' : 'msg-1',
    });
    expect(result.reason).toBe('opencode_prompt_delivery_cancelled');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(advisory).not.toHaveBeenCalled();
  }
);
