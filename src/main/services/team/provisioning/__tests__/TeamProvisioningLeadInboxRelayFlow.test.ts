import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type LeadInboxRelayFlowPorts,
  type LeadInboxRelayFlowRun,
  relayLeadInboxMessagesForTeam,
} from '../TeamProvisioningLeadInboxRelayFlow';
import { cancelRunLeadRelayCapture } from '../TeamProvisioningLeadRelayCancellation';

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

interface ScheduledTimer {
  callback: () => void;
  ms: number;
  handle: NodeJS.Timeout;
}

/**
 * Replaces the flow's timer ports with an observable clock so a test can see which deadline is
 * armed, which one was retired, and how far the capture believes it has run.
 */
function createTimerHarness(ports: TestLeadInboxRelayFlowPorts): {
  advance: (ms: number) => void;
  cleared: () => NodeJS.Timeout[];
  pending: () => ScheduledTimer[];
} {
  const scheduled: ScheduledTimer[] = [];
  const clearedHandles: NodeJS.Timeout[] = [];
  let clock = 123;

  vi.mocked(ports.nowMs).mockImplementation(() => clock);
  vi.mocked(ports.setTimeout).mockImplementation((callback, ms) => {
    const handle = {} as NodeJS.Timeout;
    scheduled.push({ callback, ms, handle });
    return handle;
  });
  vi.mocked(ports.clearTimeout).mockImplementation((handle) => {
    clearedHandles.push(handle);
    const index = scheduled.findIndex((timer) => timer.handle === handle);
    if (index >= 0) scheduled.splice(index, 1);
  });

  return {
    advance: (ms: number) => {
      clock += ms;
    },
    cleared: () => [...clearedHandles],
    pending: () => [...scheduled],
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

  it('does not dispatch transport when cancellation wins the queued microtask', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    ports.setTimeout.mockImplementation((_callback, ms) => {
      if (ms === 600_000) queueMicrotask(() => cancelRunLeadRelayCapture(run));
      return {} as NodeJS.Timeout;
    });
    expect(await relayLeadInboxMessagesForTeam('alpha', ports)).toBe(0);
    expect(ports.sendMessageToRun).not.toHaveBeenCalled();
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(ports.persistSentMessage).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'waits for transport after successful capture (%s)',
    async (outcome) => {
      const run = createRun();
      const ports = createPorts(run, [createMessage()]);
      let resolveSend!: () => void;
      let rejectSend!: (error: Error) => void;
      const send = new Promise<void>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
      ports.sendMessageToRun.mockImplementation(() => {
        run.leadRelayCapture?.resolveOnce('Handled your request.');
        return send;
      });
      let completed = false;
      const delivery = relayLeadInboxMessagesForTeam('alpha', ports).then((result) => {
        completed = true;
        return result;
      });
      await vi.waitFor(() => expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1));
      expect(completed).toBe(false);
      expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
      expect(ports.persistSentMessage).not.toHaveBeenCalled();
      expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1') ?? false).toBe(false);

      if (outcome === 'resolve') resolveSend();
      else rejectSend(new Error('Transport failed after reply capture'));
      expect(await delivery).toBe(outcome === 'resolve' ? 1 : 0);
      expect(ports.markInboxMessagesRead).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
      expect(ports.persistSentMessage).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    }
  );

  it('does not schedule work-sync recovery after cancellation during proof lookup', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage({ messageKind: 'member_work_sync_nudge' })]);
    let resolveProof!: (accepted: boolean) => void;
    ports.hasAcceptedLeadWorkSyncReport = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProof = resolve;
        })
    );
    const delivery = relayLeadInboxMessagesForTeam('alpha', ports);
    await vi.waitFor(() => expect(ports.hasAcceptedLeadWorkSyncReport).toHaveBeenCalledTimes(1));
    run.cancelRequested = true;
    resolveProof(false);
    expect(await delivery).toBe(0);
    expect(ports.scheduleLeadProofMissingWorkSyncRecovery).not.toHaveBeenCalled();
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(ports.persistSentMessage).not.toHaveBeenCalled();
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
    const observedCapture: { requireTerminalResult?: boolean; idleMs?: number } = {};
    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      const capture = run.leadRelayCapture;
      if (!capture) throw new Error('missing capture');
      observedCapture.requireTerminalResult = capture.requireTerminalResult;
      observedCapture.idleMs = capture.idleMs;
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
    const captureDeadline = scheduled.find(({ ms }) => ms === 120_000);
    expect(captureDeadline).toBeDefined();
    captureDeadline?.callback();

    // Asserted out here, not inside the send mock: the flow swallows a throw from
    // sendMessageToRun, which would silently turn a failing expectation into a passing test.
    expect(observedCapture).toEqual({ requireTerminalResult: true, idleMs: 120_001 });
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

    await expect(Promise.all([first, queued])).resolves.toEqual([0, 0]);
    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1);
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(ports.persistSentMessage).not.toHaveBeenCalled();
  });

  it('keeps a delivery alive while the lead proves the turn is running with stream activity', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    const timers = createTimerHarness(ports);

    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      const capture = run.leadRelayCapture;
      if (!capture) throw new Error('missing capture');
      const armedAtSend = timers.pending();
      expect(armedAtSend.map(({ ms }) => ms)).toContain(120_000);

      // A tool-only lead turn: no assistant text, only activity. The relay flow's touch must
      // retire the deadline that was armed at send time instead of letting it fire and declare
      // the delivered message undelivered.
      timers.advance(119_000);
      capture.touch?.();
      expect(timers.cleared()).toContain(armedAtSend[0]?.handle);
      expect(timers.pending().map(({ ms }) => ms)).toContain(120_000);

      capture.resolveOnce('Created the tasks.');
    });

    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(1);

    expect(ports.sendMessageToRun).toHaveBeenCalledTimes(1);
    expect(ports.scheduleLeadInboxFollowUpRelay).not.toHaveBeenCalled();
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1')).toBe(true);
    expect(ports.markInboxMessagesRead).toHaveBeenLastCalledWith(
      'alpha',
      'team-lead',
      expect.arrayContaining([expect.objectContaining({ messageId: 'msg-1' })])
    );
  });

  it('stops touching a capture that has outlived the absolute delivery cap', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    const timers = createTimerHarness(ports);

    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      const capture = run.leadRelayCapture;
      if (!capture) throw new Error('missing capture');
      const armedAtSend = timers.pending()[0];
      timers.advance(600_000);
      capture.touch?.();
      expect(timers.cleared()).not.toContain(armedAtSend?.handle);
      armedAtSend?.callback();
    });

    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(0);
    expect(ports.scheduleLeadInboxFollowUpRelay).toHaveBeenCalledWith('alpha', 10_000);
  });

  it('re-arms a touched deadline within what is left of the absolute delivery cap', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    const timers = createTimerHarness(ports);

    // One millisecond before the cap the lane is still alive, so activity still re-arms the reply
    // deadline - but a full 120s base deadline here would let the capture run to roughly 720s and
    // outlive the cap that is supposed to bound a wedged lane.
    const elapsedMs = 599_999;
    let retiredDeadlineArmedAtSend = false;
    let rearmedMs: number | null = null;
    let pendingMsAfterTouch: number[] = [];

    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      const capture = run.leadRelayCapture;
      if (!capture) throw new Error('missing capture');
      const armedAtSendHandle = timers.pending().find(({ ms }) => ms === 120_000)?.handle;

      timers.advance(elapsedMs);
      capture.touch?.();

      retiredDeadlineArmedAtSend =
        armedAtSendHandle !== undefined && timers.cleared().includes(armedAtSendHandle);
      pendingMsAfterTouch = timers.pending().map(({ ms }) => ms);
      const rearmed = timers.pending().at(-1);
      rearmedMs = rearmed?.ms ?? null;
      rearmed?.callback();
    });

    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(0);

    expect(retiredDeadlineArmedAtSend).toBe(true);
    expect(rearmedMs).toBe(600_000 - elapsedMs);
    expect(pendingMsAfterTouch).not.toContain(120_000);
    expect(ports.scheduleLeadInboxFollowUpRelay).toHaveBeenCalledWith('alpha', 10_000);
  });

  it('backs off before retrying a delivery that produced no proof at all', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    const timers = createTimerHarness(ports);

    vi.mocked(ports.sendMessageToRun).mockImplementation(async () => {
      timers
        .pending()
        .find(({ ms }) => ms === 120_000)
        ?.callback();
    });

    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(0);

    expect(ports.scheduleLeadInboxFollowUpRelay).toHaveBeenCalledWith('alpha', 10_000);
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(ports.relayedLeadInboxMessageIds.get('alpha')?.has('msg-1') ?? false).toBe(false);
  });

  it('announces a resent message as a redelivery and leaves a fresh row unmarked', async () => {
    const run = createRun();
    const ports = createPorts(run, [createMessage()]);
    const timers = createTimerHarness(ports);
    vi.mocked(ports.sendMessageToRun).mockImplementationOnce(async (_run, message: string) => {
      ports.sentMessages.push(message);
      timers
        .pending()
        .find(({ ms }) => ms === 120_000)
        ?.callback();
    });

    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(0);
    expect(ports.sentMessages[0]).not.toContain('REDELIVERY:');

    vi.mocked(ports.readLeadInboxMessages).mockResolvedValue([
      createMessage(),
      createMessage({ messageId: 'msg-2', text: 'A brand new request.' }),
    ]);
    await expect(relayLeadInboxMessagesForTeam('alpha', ports)).resolves.toBe(2);

    const retryPrompt = ports.sentMessages[1] ?? '';
    const rows = retryPrompt.slice(retryPrompt.indexOf('Messages:')).split(/^(?=\d\) From: )/m);
    expect(rows[1]).toContain('REDELIVERY: this exact message was already delivered to you');
    expect(rows[2]).not.toContain('REDELIVERY:');
  });
});
