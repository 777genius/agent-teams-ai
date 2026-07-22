import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type LeadInboxRelayFlowPorts,
  type LeadInboxRelayFlowRun,
  relayLeadInboxMessagesForTeam,
} from '../TeamProvisioningLeadInboxRelayFlow';

import type { InboxMessage, TeamChangeEvent } from '@shared/types';

type TestLeadInboxRelayFlowPorts = Omit<
  LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>,
  | 'rememberLeadRecoveryMessage'
  | 'rememberSuccessfulLeadRecoveryMessage'
  | 'sendMessageToRun'
  | 'setTimeout'
> & {
  rememberLeadRecoveryMessage: Mock<
    LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>['rememberLeadRecoveryMessage']
  >;
  rememberSuccessfulLeadRecoveryMessage: Mock<
    LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>['rememberSuccessfulLeadRecoveryMessage']
  >;
  sendMessageToRun: Mock<LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>['sendMessageToRun']>;
  setTimeout: Mock<LeadInboxRelayFlowPorts<LeadInboxRelayFlowRun>['setTimeout']>;
};

function permissionText(id = 'req-1'): string {
  return JSON.stringify({
    type: 'permission_request',
    request_id: id,
    agent_id: 'dev',
    tool_name: 'Edit',
    tool_use_id: 'tool-1',
    description: 'edit',
    input: {},
    permission_suggestions: [],
  });
}

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

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    to: 'team-lead',
    text: 'Please check this.',
    timestamp: '2026-01-01T00:01:00.000Z',
    read: false,
    messageId: 'msg-1',
    source: 'user_sent',
    ...overrides,
  };
}

function createRecoveryMessage(): InboxMessage {
  const message = createMessage({ messageId: 'recovery-1' });
  Object.assign(message, { messageKind: 'runtime_recovery_nudge' });
  return message;
}

function createPorts(
  run: LeadInboxRelayFlowRun,
  messages: InboxMessage[]
): TestLeadInboxRelayFlowPorts & {
  emittedEvents: TeamChangeEvent[];
  persistedMessages: InboxMessage[];
  sentMessages: string[];
} {
  const emittedEvents: TeamChangeEvent[] = [];
  const persistedMessages: InboxMessage[] = [];
  const sentMessages: string[] = [];

  return {
    getAliveRunId: vi.fn().mockReturnValue(run.runId),
    getProvisioningRunId: vi.fn().mockReturnValue(null),
    getRun: vi.fn().mockReturnValue(run),
    isCurrentTrackedRun: vi.fn().mockReturnValue(true),
    readConfigForObservation: vi.fn().mockResolvedValue({
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'dev', role: 'Developer' },
      ],
    }),
    readLeadInboxMessages: vi.fn().mockResolvedValue(messages),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    handleTeammatePermissionRequest: vi.fn(),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn().mockResolvedValue(undefined),
    confirmSameTeamNativeMatches: vi
      .fn()
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true }),
    scheduleSameTeamPersistRetry: vi.fn(),
    scheduleSameTeamDeferredRetry: vi.fn(),
    resolveControlApiBaseUrl: vi.fn().mockResolvedValue(null),
    sendMessageToRun: vi.fn().mockImplementation(async (_run, message: string) => {
      sentMessages.push(message);
      run.leadRelayCapture?.resolveOnce('I created a task for this.');
    }),
    hasAcceptedLeadWorkSyncReport: vi.fn().mockResolvedValue(true),
    scheduleLeadProofMissingWorkSyncRecovery: vi.fn().mockResolvedValue(false),
    pushLiveLeadTextMessage: vi.fn(),
    pushLiveLeadProcessMessage: vi.fn(),
    persistSentMessage: vi.fn((_teamName, message) => {
      persistedMessages.push(message);
    }),
    emitTeamChange: vi.fn((event) => {
      emittedEvents.push(event);
    }),
    scheduleLeadInboxFollowUpRelay: vi.fn(),
    rememberLeadRecoveryMessage: vi.fn(),
    rememberSuccessfulLeadRecoveryMessage: vi.fn(),
    relayedLeadInboxMessageIds: new Map(),
    trimRelayedSet: vi.fn((relayedIds) => relayedIds),
    pendingCrossTeamFirstReplies: new Map(),
    recentCrossTeamLeadDeliveryMessageIds: new Map(),
    sameTeamRunStartSkewMs: 1_000,
    sameTeamNativeDeliveryGraceMs: 0,
    recentCrossTeamDeliveryTtlMs: 10_000,
    logger: { debug: vi.fn() },
    nowIso: vi.fn().mockReturnValue('2026-01-01T00:02:00.000Z'),
    nowMs: vi.fn().mockReturnValue(123),
    setTimeout: vi.fn().mockReturnValue({} as NodeJS.Timeout),
    clearTimeout: vi.fn(),
    emittedEvents,
    persistedMessages,
    sentMessages,
  };
}

describe('lead inbox relay flow', () => {
  it('scans permission requests before provisioning is complete and does not relay', async () => {
    const run = createRun({ provisioningComplete: false });
    const ports = createPorts(run, [createMessage({ text: permissionText(), from: 'dev' })]);

    const relayed = await relayLeadInboxMessagesForTeam('alpha', ports);

    expect(relayed).toBe(0);
    expect(ports.handleTeammatePermissionRequest).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ requestId: 'req-1', agentId: 'dev' }),
      '2026-01-01T00:01:00.000Z'
    );
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('alpha', 'team-lead', [
      { messageId: 'msg-1' },
    ]);
    expect(ports.sendMessageToRun).not.toHaveBeenCalled();
  });

  it('relays actionable lead inbox messages and persists user-visible replies', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);

    const relayed = await relayLeadInboxMessagesForTeam('alpha', ports);

    expect(relayed).toBe(1);
    expect(ports.sentMessages[0]).toContain('Messages:');
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(true);
    expect(ports.markInboxMessagesRead).toHaveBeenLastCalledWith(
      'alpha',
      'team-lead',
      expect.arrayContaining([expect.objectContaining({ messageId: 'msg-1' })])
    );
    expect(ports.persistedMessages).toEqual([
      expect.objectContaining({
        from: 'team-lead',
        to: 'user',
        text: 'I created a task for this.',
        source: 'lead_process',
      }),
    ]);
    expect(ports.emittedEvents).toEqual([
      { type: 'inbox', teamName: 'alpha', detail: 'lead-process-reply' },
    ]);
    expect(run.leadRelayCapture).toBeNull();
  });

  it('records recovery delivery only after terminal-result capture resolution', async () => {
    const run = createRun();
    const ports = createPorts(run, [createRecoveryMessage()]);

    await expect(
      relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'recovery-1' })
    ).resolves.toBe(1);

    expect(ports.rememberLeadRecoveryMessage).toHaveBeenCalledWith('alpha', 'recovery-1');
    expect(ports.rememberSuccessfulLeadRecoveryMessage).toHaveBeenCalledWith('alpha', 'recovery-1');
  });

  it('times out recovery capture before text-idle can masquerade as terminal proof', async () => {
    const run = createRun();
    const ports = createPorts(run, [createRecoveryMessage()]);
    const scheduled: { callback: () => void; ms: number }[] = [];
    vi.mocked(ports.setTimeout).mockImplementation((callback, ms) => {
      scheduled.push({ callback, ms });
      return {} as NodeJS.Timeout;
    });
    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      const capture = run.leadRelayCapture;
      if (!capture) throw new Error('missing capture');
      expect(capture.requireTerminalResult).toBe(true);
      expect(capture.idleMs).toBe(15_001);
      capture.textParts.push('Partial recovery reply.');
      capture.idleHandle = ports.setTimeout(
        () => capture.resolveOnce('Partial recovery reply.'),
        capture.idleMs
      );
    });

    const relay = relayLeadInboxMessagesForTeam('alpha', ports, {
      onlyMessageId: 'recovery-1',
    });
    await vi.waitFor(() => expect(ports.sendMessageToRun).toHaveBeenCalledOnce());
    scheduled.find(({ ms }) => ms === 15_000)?.callback();

    await expect(relay).resolves.toBe(0);
    expect(ports.rememberSuccessfulLeadRecoveryMessage).not.toHaveBeenCalled();
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('recovery-1') ?? false).toBe(false);
  });

  it('relays only the requested native lead inbox message when scoped by message id', async () => {
    const run = createRun();
    const ports = createPorts(run, [
      createMessage({ messageId: 'msg-1', text: 'Do not relay this yet.' }),
      createMessage({ messageId: 'msg-2', text: 'Relay only this.' }),
    ]);

    const relayed = await relayLeadInboxMessagesForTeam('alpha', ports, {
      onlyMessageId: 'msg-2',
    });

    expect(relayed).toBe(1);
    expect(ports.sentMessages[0]).toContain('Relay only this.');
    expect(ports.sentMessages[0]).not.toContain('Do not relay this yet.');
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-2')).toBe(true);
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(false);
  });

  it('serializes scoped and unscoped relays so the same message is delivered once', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);

    const results = await Promise.all([
      relayLeadInboxMessagesForTeam('alpha', ports),
      relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'msg-1' }),
    ]);

    expect(results).toEqual([1, 0]);
    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1);
    expect(ports.relayedLeadInboxMessageIds.get('alpha')).toEqual(new Set(['msg-1']));
  });

  it('lets an unscoped relay deliver remaining unread work after a scoped relay', async () => {
    const run = createRun();
    const ports = createPorts(run, [
      createMessage({ messageId: 'msg-1', text: 'Relay after the scoped message.' }),
      createMessage({ messageId: 'msg-2', text: 'Relay this scoped message first.' }),
    ]);

    const results = await Promise.all([
      relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'msg-2' }),
      relayLeadInboxMessagesForTeam('alpha', ports),
    ]);

    expect(results).toEqual([1, 1]);
    expect(ports.sentMessages).toHaveLength(2);
    expect(ports.sentMessages[0]).toContain('Relay this scoped message first.');
    expect(ports.sentMessages[0]).not.toContain('Relay after the scoped message.');
    expect(ports.sentMessages[1]).toContain('Relay after the scoped message.');
    expect(ports.sentMessages[1]).not.toContain('Relay this scoped message first.');
  });

  it('allows a queued relay to retry after the preceding delivery errors', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    vi.mocked(ports.sendMessageToRun).mockRejectedValueOnce(new Error('stdin unavailable'));

    const results = await Promise.all([
      relayLeadInboxMessagesForTeam('alpha', ports),
      relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'msg-1' }),
    ]);

    expect(results).toEqual([0, 1]);
    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(2);
    expect(ports.relayedLeadInboxMessageIds.get('alpha')).toEqual(new Set(['msg-1']));
    expect(run.leadRelayCapture).toBeNull();
  });

  it('keeps an unconfirmed scoped delivery retryable for a queued unscoped relay', async () => {
    const run = createRun();
    const ports = createPorts(run, [
      createMessage({
        from: 'peer-team.team-lead',
        source: 'cross_team',
        conversationId: 'conv-1',
      }),
    ]);
    const captureTimeouts: (() => void)[] = [];
    vi.mocked(ports.setTimeout).mockImplementation((callback) => {
      captureTimeouts.push(callback);
      return {} as NodeJS.Timeout;
    });
    let sendAttempt = 0;
    vi.mocked(ports.sendMessageToRun).mockImplementation(async (_run, message) => {
      ports.sentMessages.push(message);
      sendAttempt += 1;
      if (sendAttempt === 1) {
        captureTimeouts.shift()?.();
      } else {
        run.leadRelayCapture?.resolveOnce('Retry delivery completed.');
      }
    });

    const results = await Promise.all([
      relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'msg-1' }),
      relayLeadInboxMessagesForTeam('alpha', ports),
    ]);

    expect(results).toEqual([0, 1]);
    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(2);
    expect(ports.relayedLeadInboxMessageIds.get('alpha')).toEqual(new Set(['msg-1']));
    expect(ports.markInboxMessagesRead).toHaveBeenCalledTimes(1);
    expect(ports.scheduleLeadInboxFollowUpRelay).toHaveBeenCalledTimes(1);
  });

  it('rechecks cancellation before starting a queued relay', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    let releaseFirstSend: (() => void) | undefined;
    const firstSendBlocked = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    vi.mocked(ports.sendMessageToRun).mockImplementationOnce(async () => {
      await firstSendBlocked;
      run.leadRelayCapture?.resolveOnce('First delivery completed.');
    });

    const first = relayLeadInboxMessagesForTeam('alpha', ports);
    const queued = relayLeadInboxMessagesForTeam('alpha', ports, { onlyMessageId: 'msg-1' });
    await vi.waitFor(() => expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1));
    run.cancelRequested = true;
    releaseFirstSend?.();

    await expect(Promise.all([first, queued])).resolves.toEqual([1, 0]);
    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1);
  });
});
