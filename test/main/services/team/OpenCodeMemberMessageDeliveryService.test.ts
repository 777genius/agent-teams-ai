import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeMemberMessageDeliveryService,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
  type OpenCodeRuntimeMessageAdapter,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryService';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

function makeAdapter(
  sendMessageToMember = vi.fn()
): OpenCodeRuntimeMessageAdapter {
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
  it(
    'returns bridge unavailable before reading member directory when runtime adapter is missing',
    async () => {
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
    }
  );

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
      applyDeliveryResult: vi.fn(async () => failedRetryableRecord),
    };
    const deps = makeDeps({
      getOpenCodeRuntimeMessageAdapter: () =>
        makeAdapter(vi.fn(async () => {
          throw new Error('bridge down');
        })),
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
});
