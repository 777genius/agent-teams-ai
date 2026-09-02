import { describe, expect, it, vi } from 'vitest';

import { isInformationalOpenCodeRuntimeDeliveryDiagnostic } from '../../opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics';
import {
  buildOpenCodeCoalesceDeferredDiagnostic,
  buildOpenCodeCoalescedNoticeText,
  buildOpenCodeCoalesceNotDispatchedDiagnostic,
  canCoalesceNoticesIntoOpenCodeDelivery,
  COALESCABLE_MESSAGE_KINDS,
  findNextUnreadUserMessageIndex,
  isCoalescableNoticeKind,
  isOpenCodeCoalescedNoticeDeliveryProven,
  OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT,
  type OpenCodeReplyOptionalCoalescePorts,
  selectOpenCodeReplyOptionalCoalescedFollowers,
  selectOpenCodeSettleableQueuedNotices,
} from '../TeamProvisioningOpenCodeInboxCoalescePolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';

function ledgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    inboxMessageId: 'anchor',
    status: 'pending',
    attempts: 0,
    acceptedAt: null,
    inboxReadCommittedAt: null,
    diagnostics: [],
    ...overrides,
  } as OpenCodePromptDeliveryLedgerRecord;
}

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'Scribe',
    to: 'team-lead',
    text: 'section 2 done',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
    ...overrides,
  };
}

function notices(count: number, prefix = 'notice'): RelayInboxMessage[] {
  return Array.from({ length: count }, (_unused, index) =>
    message({
      messageId: `${prefix}-${index + 1}`,
      text: `notice body ${index + 1}`,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
  );
}

function createPorts(
  overrides: Partial<OpenCodeReplyOptionalCoalescePorts> = {}
): OpenCodeReplyOptionalCoalescePorts {
  return {
    resolveReplyRecipient: () => 'Scribe',
    hasExistingRecord: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeInboxCoalescePolicy', () => {
  it('coalesces the reply-optional notices queued behind the anchor', async () => {
    const unread = [message({ messageId: 'anchor' }), ...notices(3)];

    const followers = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread,
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });

    expect(followers.map((follower) => follower.messageId)).toEqual([
      'notice-1',
      'notice-2',
      'notice-3',
    ]);
  });

  it('never coalesces into a reply-required anchor', async () => {
    const unread = [message({ messageId: 'anchor', from: 'user' }), ...notices(2)];

    const followers = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread,
      index: 0,
      anchorReplyRecipient: 'user',
      ports: createPorts(),
    });

    expect(followers).toEqual([]);
  });

  // Negative control 1: the walk stops at the first reply-required row instead
  // of skipping it, so that row keeps its own prompt and its own reply contract.
  it('stops coalescing at a reply-required message and leaves everything behind it out', async () => {
    const unread = [
      message({ messageId: 'anchor' }),
      message({ messageId: 'notice-1' }),
      message({ messageId: 'user-question', from: 'user', text: 'status?' }),
      message({ messageId: 'notice-2' }),
    ];

    const followers = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread,
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts({
        resolveReplyRecipient: (candidate) => (candidate.from === 'user' ? 'user' : 'Scribe'),
      }),
    });

    // notice-2 sits behind the user question and is deliberately not pulled
    // forward: coalescing must never reorder the inbox.
    expect(followers.map((follower) => follower.messageId)).toEqual(['notice-1']);
  });

  // Negative control 2: the limit is a hard boundary, tested on both sides.
  it('coalesces up to the limit and leaves the message past it for the next pass', async () => {
    expect(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT).toBe(8);

    const atLimit = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'anchor' }),
        ...notices(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(atLimit).toHaveLength(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT);
    expect(atLimit.at(-1)?.messageId).toBe(`notice-${OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT}`);

    const pastLimit = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'anchor' }),
        ...notices(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT + 1),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(pastLimit).toHaveLength(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT);
    expect(pastLimit.map((follower) => follower.messageId)).not.toContain(
      `notice-${OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT + 1}`
    );
  });

  // Negative control 4: every kind outside the allowlist carries its own
  // delivery contract and must never ride inside somebody else's prompt.
  it('never coalesces a message kind outside the allowlist, as anchor or as rider', async () => {
    expect([...COALESCABLE_MESSAGE_KINDS]).toEqual(['default', 'task_comment_notification']);
    expect(isCoalescableNoticeKind(message({ messageKind: 'member_work_sync_nudge' }))).toBe(false);
    expect(isCoalescableNoticeKind(message({ messageKind: 'task_comment_notification' }))).toBe(
      true
    );
    // An inbox row without an explicit kind is an ordinary message.
    expect(isCoalescableNoticeKind(message())).toBe(true);

    const riders = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'anchor' }),
        message({ messageId: 'nudge', messageKind: 'member_work_sync_nudge' }),
        message({ messageId: 'notice-1' }),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(riders).toEqual([]);

    const fromNudgeAnchor = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'nudge', messageKind: 'member_work_sync_nudge' }),
        message({ messageId: 'notice-1' }),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(fromNudgeAnchor).toEqual([]);
  });

  it('stops at an already read row, an empty row, and a row that already has a ledger record', async () => {
    const alreadyRead = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'anchor' }),
        message({ messageId: 'notice-1', read: true }),
        message({ messageId: 'notice-2' }),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(alreadyRead).toEqual([]);

    const blank = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [message({ messageId: 'anchor' }), message({ messageId: 'notice-1', text: '   ' })],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(blank).toEqual([]);

    const withRecord = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread: [
        message({ messageId: 'anchor' }),
        message({ messageId: 'notice-1' }),
        message({ messageId: 'notice-2' }),
      ],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts({
        hasExistingRecord: (candidate) => Promise.resolve(candidate.messageId === 'notice-1'),
      }),
    });
    expect(withRecord).toEqual([]);
  });

  it('builds one tagged block that names every rider and carries no anchor text', () => {
    const text = buildOpenCodeCoalescedNoticeText([
      message({ messageId: 'notice-1', from: 'Scribe', text: 'first rider' }),
      message({
        messageId: 'notice-2',
        from: '   ',
        text: 'second rider',
        timestamp: '2026-01-01T00:00:05.000Z',
      }),
    ]);

    expect(text.startsWith('<opencode_coalesced_notices count="2">')).toBe(true);
    expect(text).toContain('--- notice 1 (from Scribe, messageId notice-1');
    expect(text).toContain('first rider');
    // An unaddressable sender is named as the system rather than as an empty
    // string, so the runtime never reads a blank reply target.
    expect(text).toContain('--- notice 2 (from system, messageId notice-2');
    expect(text).toContain('second rider');
    expect(text.endsWith('</opencode_coalesced_notices>')).toBe(true);
  });

  it('only folds riders into an anchor whose prompt body is still going to be sent', () => {
    // A first attempt at a row nobody has delivered yet.
    expect(canCoalesceNoticesIntoOpenCodeDelivery(null)).toBe(true);
    expect(canCoalesceNoticesIntoOpenCodeDelivery(ledgerRecord({ status: 'pending' }))).toBe(true);
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(ledgerRecord({ status: 'retry_scheduled' }))
    ).toBe(true);
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(ledgerRecord({ status: 'failed_retryable' }))
    ).toBe(true);

    // The runtime already has the anchor's prompt: this call can only observe
    // it, so a rider added now would be settled without ever being sent.
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(
        ledgerRecord({ status: 'pending', acceptedAt: '2026-01-01T00:00:01.000Z' })
      )
    ).toBe(false);
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(
        ledgerRecord({ status: 'pending', runtimePromptMessageId: 'prompt-1' })
      )
    ).toBe(false);
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(
        ledgerRecord({ status: 'pending', inboxReadCommittedAt: '2026-01-01T00:00:02.000Z' })
      )
    ).toBe(false);
    expect(canCoalesceNoticesIntoOpenCodeDelivery(ledgerRecord({ status: 'responded' }))).toBe(
      false
    );
    expect(
      canCoalesceNoticesIntoOpenCodeDelivery(ledgerRecord({ status: 'failed_terminal' }))
    ).toBe(false);
  });

  it('treats only the explicit dispatch proof as proof, never `delivered`', () => {
    expect(isOpenCodeCoalescedNoticeDeliveryProven({ coalescedNoticesDelivered: true })).toBe(true);
    expect(isOpenCodeCoalescedNoticeDeliveryProven({ coalescedNoticesDelivered: false })).toBe(
      false
    );
    // A delivery result that says nothing about riders never settles them, even
    // when it reports a successful delivery.
    expect(isOpenCodeCoalescedNoticeDeliveryProven({})).toBe(false);
  });

  it('reports deferred and undispatched riders as informational diagnostics', () => {
    const deferred = buildOpenCodeCoalesceDeferredDiagnostic({
      anchorMessageId: 'anchor',
      deferredMessageId: 'notice-1',
      record: ledgerRecord({ status: 'pending', acceptedAt: '2026-01-01T00:00:01.000Z' }),
    });
    expect(deferred).toContain('anchor');
    expect(deferred).toContain('deferred=notice-1');
    expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(deferred)).toBe(true);

    const notDispatched = buildOpenCodeCoalesceNotDispatchedDiagnostic({
      anchorMessageId: 'anchor',
      deferredMessageIds: ['notice-1', 'notice-2'],
      delivery: { delivered: true, responsePending: true },
    });
    expect(notDispatched).toContain('anchor -> notice-1,notice-2');
    expect(notDispatched).toContain('accepted=unknown');
    expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(notDispatched)).toBe(true);
  });

  // The settlement pass read-commits instead of delivering, so the prompt-length
  // cap does not apply to it. Negative control: the same queue through the
  // prompt selector stops at the limit.
  it('selects the whole settleable run past the prompt coalesce limit', async () => {
    const unread = [
      message({ messageId: 'anchor' }),
      ...notices(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT + 4),
    ];

    const settleable = await selectOpenCodeSettleableQueuedNotices({
      unread,
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(settleable).toHaveLength(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT + 4);
    expect(settleable.at(-1)?.messageId).toBe(
      `notice-${OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT + 4}`
    );

    const delivered = await selectOpenCodeReplyOptionalCoalescedFollowers({
      unread,
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts(),
    });
    expect(delivered).toHaveLength(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT);
  });

  // Removing the cap must not loosen any other boundary: the settlement walk
  // stops exactly where the delivery walk does.
  it('keeps every non-limit boundary while settling the queued run', async () => {
    const unread = [
      message({ messageId: 'anchor' }),
      message({ messageId: 'notice-1' }),
      message({ messageId: 'user-question', from: 'user', text: 'status?' }),
      ...notices(OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT, 'tail'),
    ];

    const settleable = await selectOpenCodeSettleableQueuedNotices({
      unread,
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts({
        resolveReplyRecipient: (candidate) => (candidate.from === 'user' ? 'user' : 'Scribe'),
      }),
    });
    expect(settleable.map((notice) => notice.messageId)).toEqual(['notice-1']);

    const recorded = await selectOpenCodeSettleableQueuedNotices({
      unread: [message({ messageId: 'anchor' }), ...notices(3)],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      ports: createPorts({
        hasExistingRecord: (candidate) => Promise.resolve(candidate.messageId === 'notice-2'),
      }),
    });
    expect(recorded.map((notice) => notice.messageId)).toEqual(['notice-1']);

    const replyRequiredAnchor = await selectOpenCodeSettleableQueuedNotices({
      unread: [message({ messageId: 'anchor' }), ...notices(3)],
      index: 0,
      anchorReplyRecipient: 'user',
      ports: createPorts(),
    });
    expect(replyRequiredAnchor).toEqual([]);
  });

  it('finds the next unread user message only for a non-user delivery', () => {
    const unread = [
      message({ messageId: 'notice-1' }),
      message({ messageId: 'read-user', from: 'user', read: true }),
      message({ messageId: 'user-2', from: 'user' }),
    ];

    expect(
      findNextUnreadUserMessageIndex({ unread, afterIndex: 0, currentReplyRecipient: 'Scribe' })
    ).toBe(2);
    expect(
      findNextUnreadUserMessageIndex({ unread, afterIndex: 0, currentReplyRecipient: 'user' })
    ).toBe(-1);
    expect(
      findNextUnreadUserMessageIndex({ unread, afterIndex: 2, currentReplyRecipient: 'Scribe' })
    ).toBe(-1);
  });
});
