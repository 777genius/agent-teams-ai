import { describe, expect, it, vi } from 'vitest';

import {
  buildLeadInboxRelayPrompt,
  buildMemberInboxRelayPrompt,
  collectConfirmedSameTeamPairs,
  inferOpenCodeInboxMessageTaskRefs,
  type NativeSameTeamFingerprint,
  planLeadInboxRelayReadOnlyMessages,
  type RelayInboxMessage,
  selectActionableLeadRelayUnread,
  selectLeadInboxRelayBatch,
  selectMemberInboxRelayBatch,
  selectOpenCodeInboxRelayBatch,
  shouldDeferSameTeamMessage,
  splitMemberInboxRelayUnread,
  trimRelayedMessageIdSet,
} from '../TeamProvisioningInboxRelayPolicy';

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'user',
    to: 'team-lead',
    text: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
    ...overrides,
  };
}

function ids(messages: readonly RelayInboxMessage[]): string[] {
  return messages.map((item) => item.messageId);
}

describe('inbox relay unread policy', () => {
  it('keeps small relayed message id sets by reference', () => {
    const set = new Set(['a', 'b']);

    expect(trimRelayedMessageIdSet(set, 3)).toBe(set);
  });

  it('trims relayed message id sets to the most recent ids in insertion order', () => {
    const set = new Set(['a', 'b', 'c', 'd']);

    expect([...trimRelayedMessageIdSet(set, 2)]).toEqual(['c', 'd']);
    expect([...set]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('uses structured OpenCode inbox task refs without reading tasks', async () => {
    const taskRef = { teamName: 'team', taskId: 'task-1', displayId: '7' };
    const readTasks = vi.fn();

    await expect(
      inferOpenCodeInboxMessageTaskRefs({
        teamName: 'team',
        message: message({ taskRefs: [taskRef] }),
        readTasks,
      })
    ).resolves.toEqual([taskRef]);
    expect(readTasks).not.toHaveBeenCalled();
  });

  it('returns no OpenCode inbox task refs when task storage is empty', async () => {
    await expect(
      inferOpenCodeInboxMessageTaskRefs({
        teamName: 'team',
        message: message({ text: 'Please look at #7' }),
        readTasks: vi.fn().mockResolvedValue([]),
      })
    ).resolves.toEqual([]);
  });

  it('infers OpenCode inbox task refs from message text', async () => {
    await expect(
      inferOpenCodeInboxMessageTaskRefs({
        teamName: 'team',
        message: message({ text: 'Please look at #7' }),
        readTasks: vi.fn().mockResolvedValue([{ id: 'task-1', displayId: '7' }]),
      })
    ).resolves.toEqual([{ teamName: 'team', taskId: 'task-1', displayId: '7' }]);
  });

  it('pairs same-team native fingerprints with inbox rows in FIFO order', () => {
    const firstSeenAt = Date.parse('2026-01-01T00:00:01.000Z');
    const secondSeenAt = Date.parse('2026-01-01T00:00:02.000Z');
    const result = collectConfirmedSameTeamPairs({
      leadName: 'lead',
      matchWindowMs: 30_000,
      fingerprints: [
        {
          id: 'fp-2',
          from: 'worker',
          text: 'Done',
          summary: 'second',
          seenAt: secondSeenAt,
        },
        {
          id: 'fp-1',
          from: 'worker',
          text: 'Done',
          summary: 'first',
          seenAt: firstSeenAt,
        },
      ],
      messages: [
        message({
          messageId: 'msg-2',
          from: 'worker',
          to: 'lead',
          text: 'Done',
          summary: 'second',
          timestamp: '2026-01-01T00:00:02.000Z',
        }),
        message({
          messageId: 'msg-1',
          from: 'worker',
          to: 'lead',
          text: 'Done',
          summary: 'first',
          timestamp: '2026-01-01T00:00:01.000Z',
        }),
      ],
    });

    expect([...result.confirmedMessageIds]).toEqual(['msg-1', 'msg-2']);
    expect([...result.matchedFingerprintIds]).toEqual(['fp-1', 'fp-2']);
  });

  it('rejects same-team native matches when metadata or eligibility filters fail', () => {
    const seenAt = Date.parse('2026-01-01T00:00:00.000Z');
    const baseFingerprint: NativeSameTeamFingerprint = {
      id: 'fp-1',
      from: 'worker',
      text: 'Done',
      summary: 'expected',
      seenAt,
    };
    const baseMessage = message({
      messageId: 'candidate',
      from: 'worker',
      to: 'lead',
      text: 'Done',
      summary: 'expected',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const isConfirmed = (
      messageOverrides: Partial<RelayInboxMessage> = {},
      fingerprintOverrides: Partial<NativeSameTeamFingerprint> = {}
    ): boolean => {
      const candidate = { ...baseMessage, ...messageOverrides };
      const result = collectConfirmedSameTeamPairs({
        leadName: 'lead',
        matchWindowMs: 30_000,
        fingerprints: [{ ...baseFingerprint, ...fingerprintOverrides }],
        messages: [candidate],
      });
      return result.confirmedMessageIds.has(candidate.messageId);
    };

    expect(isConfirmed()).toBe(true);
    expect(isConfirmed({ summary: 'actual' })).toBe(false);
    expect(isConfirmed({ timestamp: '2026-01-01T00:00:30.000Z' })).toBe(true);
    expect(isConfirmed({ timestamp: '2026-01-01T00:00:30.001Z' })).toBe(false);
    expect(isConfirmed({ read: true })).toBe(false);
    expect(isConfirmed({ source: 'cross_team' })).toBe(false);
    expect(isConfirmed({ from: 'lead' })).toBe(false);
    expect(isConfirmed({ from: 'user' })).toBe(false);
    expect(isConfirmed({ timestamp: 'not-a-date' })).toBe(false);
    expect(isConfirmed({ messageId: '' })).toBe(false);
  });

  it('defers recent same-team source-less messages inside the native delivery grace window', () => {
    const nowMs = Date.parse('2026-01-01T00:00:10.000Z');

    expect(
      shouldDeferSameTeamMessage({
        message: message({
          messageId: 'recent',
          from: 'worker',
          to: 'lead',
          timestamp: '2026-01-01T00:00:09.000Z',
        }),
        leadName: 'lead',
        runStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
        nowMs,
        runStartSkewMs: 1_000,
        nativeDeliveryGraceMs: 15_000,
      })
    ).toBe(true);

    expect(
      shouldDeferSameTeamMessage({
        message: message({
          messageId: 'cross',
          from: 'worker',
          to: 'lead',
          source: 'cross_team',
          timestamp: '2026-01-01T00:00:09.000Z',
        }),
        leadName: 'lead',
        runStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
        nowMs,
        runStartSkewMs: 1_000,
        nativeDeliveryGraceMs: 15_000,
      })
    ).toBe(false);
  });

  it('does not defer stale or ineligible same-team source-less messages', () => {
    const nowMs = Date.parse('2026-01-01T00:00:10.000Z');
    const runStartedAtMs = Date.parse('2026-01-01T00:00:00.000Z');
    const baseMessage = message({
      messageId: 'candidate',
      from: 'worker',
      to: 'lead',
      timestamp: '2026-01-01T00:00:09.000Z',
    });
    const isDeferred = (
      messageOverrides: Partial<RelayInboxMessage> = {},
      inputOverrides: Partial<
        Omit<Parameters<typeof shouldDeferSameTeamMessage>[0], 'message'>
      > = {}
    ): boolean =>
      shouldDeferSameTeamMessage({
        leadName: 'lead',
        runStartedAtMs,
        nowMs,
        runStartSkewMs: 1_000,
        nativeDeliveryGraceMs: 15_000,
        ...inputOverrides,
        message: { ...baseMessage, ...messageOverrides },
      });

    expect(isDeferred()).toBe(true);
    expect(
      isDeferred(
        { timestamp: '2025-12-31T23:59:55.000Z' },
        { runStartedAtMs: Date.parse('2025-12-31T23:59:00.000Z') }
      )
    ).toBe(false);
    expect(isDeferred({ timestamp: '2025-12-31T23:59:58.000Z' })).toBe(false);
    expect(isDeferred({ timestamp: '2026-01-01T00:00:11.000Z' })).toBe(false);
    expect(isDeferred({ to: 'other-lead' })).toBe(false);
    expect(isDeferred({ from: 'lead' })).toBe(false);
    expect(isDeferred({ from: 'user' })).toBe(false);
    expect(isDeferred({ source: 'cross_team' })).toBe(false);
    expect(isDeferred({ timestamp: 'not-a-date' })).toBe(false);
  });

  it('splits unread member relay rows into silent, passive, and actionable buckets', () => {
    const split = splitMemberInboxRelayUnread([
      message({
        messageId: 'silent-heartbeat',
        text: JSON.stringify({ type: 'idle_notification', idleReason: 'available' }),
      }),
      message({
        messageId: 'passive-heartbeat',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: 'still reviewing',
        }),
      }),
      message({
        messageId: 'shutdown-noise',
        text: JSON.stringify({ type: 'shutdown_request' }),
      }),
      message({
        messageId: 'interrupted-idle',
        text: JSON.stringify({ type: 'idle_notification', idleReason: 'interrupted' }),
      }),
      message({ messageId: 'plain-action', text: 'please take a look' }),
      message({
        messageId: 'cross-team-action',
        from: 'other-team.lead',
        source: 'cross_team',
        text: JSON.stringify({ type: 'shutdown_request' }),
      }),
    ]);

    expect(ids(split.silentNoiseUnread)).toEqual(['silent-heartbeat', 'shutdown-noise']);
    expect(ids(split.passiveIdleUnread)).toEqual(['passive-heartbeat']);
    expect(ids(split.actionableUnread)).toEqual([
      'interrupted-idle',
      'plain-action',
      'cross-team-action',
    ]);
    expect(ids(split.readOnlyIgnoredUnread)).toEqual([
      'silent-heartbeat',
      'shutdown-noise',
      'passive-heartbeat',
    ]);
  });

  it('selects max relay batches using priority before timestamp ordering', () => {
    const batch = selectMemberInboxRelayBatch(
      [
        message({ messageId: 'normal-old', timestamp: '2026-01-01T00:00:01.000Z' }),
        message({
          messageId: 'sync-new',
          timestamp: '2026-01-01T00:00:03.000Z',
          messageKind: 'member_work_sync_nudge',
        }),
        message({ messageId: 'normal-mid', timestamp: '2026-01-01T00:00:02.000Z' }),
        message({
          messageId: 'sync-old',
          timestamp: '2026-01-01T00:00:00.000Z',
          messageKind: 'member_work_sync_nudge',
        }),
      ],
      3
    );

    expect(ids(batch)).toEqual(['sync-old', 'sync-new', 'normal-old']);
  });

  it('selects OpenCode relay batches with system notifications before routine rows', () => {
    const batch = selectOpenCodeInboxRelayBatch(
      [
        message({ messageId: 'normal-old', timestamp: '2026-01-01T00:00:01.000Z' }),
        message({
          messageId: 'system-new',
          timestamp: '2026-01-01T00:00:03.000Z',
          source: 'system_notification',
        }),
        message({
          messageId: 'sync-mid',
          timestamp: '2026-01-01T00:00:02.000Z',
          messageKind: 'member_work_sync_nudge',
        }),
      ],
      2
    );

    expect(ids(batch)).toEqual(['sync-mid', 'system-new']);
  });

  it('selects lead relay batches with priority rows before user-visible rows', () => {
    const allUnread = [
      message({
        messageId: 'user-old',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_sent',
      }),
      message({
        messageId: 'sync-new',
        timestamp: '2026-01-01T00:00:02.000Z',
        messageKind: 'member_work_sync_nudge',
      }),
      message({ messageId: 'system-mid', timestamp: '2026-01-01T00:00:01.000Z' }),
    ];

    const selection = selectLeadInboxRelayBatch({
      actionableUnread: allUnread,
      unread: allUnread,
      readOnlyIgnoredIds: new Set(),
      maxRelay: 1,
    });

    expect(ids(selection.batch)).toEqual(['sync-new']);
    expect(selection.replyVisibility).toBe('internal_activity');
    expect(selection.hasPendingFollowUpRelay).toBe(true);
  });

  it('plans lead read-only rows separately from remaining unread relay candidates', () => {
    const permanent = message({ messageId: 'permanent' });
    const passive = message({ messageId: 'passive' });
    const coarse = message({ messageId: 'coarse' });
    const actionable = message({ messageId: 'actionable' });

    const plan = planLeadInboxRelayReadOnlyMessages({
      unread: [permanent, passive, coarse, actionable],
      silentIdleIds: new Set(),
      passiveIdleIds: new Set(['passive']),
      coarseNonIdleNoiseIds: new Set(['coarse']),
      isPermanentlyIgnored: (candidate) => candidate.messageId === 'permanent',
    });

    expect(ids(plan.permanentlyIgnored)).toEqual(['permanent', 'coarse']);
    expect(ids(plan.passiveIdleUnread)).toEqual(['passive']);
    expect(plan.readOnlyIgnoredIds).toEqual(new Set(['permanent', 'coarse', 'passive']));
    expect(ids(plan.remainingUnread)).toEqual(['actionable']);
  });

  it('selects actionable lead unread rows after native, deferred, and permission filters', () => {
    const result = selectActionableLeadRelayUnread({
      remainingUnread: [
        message({ messageId: 'native' }),
        message({ messageId: 'deferred' }),
        message({ messageId: 'permission' }),
        message({ messageId: 'actionable' }),
      ],
      nativeMatchedMessageIds: new Set(['native']),
      deferredIds: new Set(['deferred']),
      permissionRequestIds: new Set(['permission']),
    });

    expect(ids(result)).toEqual(['actionable']);
  });
});

describe('inbox relay prompt builders', () => {
  it('builds member relay prompts with canonical SendMessage and work-sync rules', () => {
    const prompt = buildMemberInboxRelayPrompt({
      memberName: 'worker-1',
      batch: [
        message({
          messageId: 'sync-1',
          source: 'system_notification',
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'agenda_sync',
          text: 'sync agenda',
        }),
      ],
    });

    expect(prompt).toContain('The ONLY valid destination is to="worker-1"');
    expect(prompt).toContain('Use the SendMessage tool with to="worker-1".');
    expect(prompt).toContain('member_work_sync_status call alone is incomplete');
    expect(prompt).toContain('member_work_sync_report');
    expect(prompt).toContain('The SendMessage tool input must use the actual tool field names');
    expect(prompt).toContain('Message kind: member_work_sync_nudge');
  });

  it('builds lead cross-team instructions as tool calls, not SendMessage recipients', () => {
    const prompt = buildLeadInboxRelayPrompt({
      teamName: 'receiving-team',
      leadName: 'team-lead',
      replyVisibility: 'internal_activity',
      teammates: [],
      workSyncControlUrl: null,
      batch: [
        message({
          messageId: 'cross-1',
          from: 'source-team.lead',
          source: 'cross_team',
          conversationId: 'conv-123',
          text: 'Can you confirm the interface?',
        }),
      ],
    });

    expect(prompt).toContain(
      'Call the MCP tool named cross_team_send with toTeam="source-team", conversationId="conv-123", and replyToConversationId="conv-123". Do NOT use SendMessage or message_send. NEVER set recipient/to to "cross_team_send".'
    );
    expect(prompt).toContain(
      'If a message below is marked Source: cross_team, CALL the MCP tool named cross_team_send. Do NOT use SendMessage or message_send for cross-team replies.'
    );
    expect(prompt).not.toContain('Use the SendMessage tool with to="cross_team_send"');
  });

  it('includes authoritative structured task context in lead relay prompts', () => {
    const prompt = buildLeadInboxRelayPrompt({
      teamName: 'receiving-team',
      leadName: 'team-lead',
      replyVisibility: 'internal_activity',
      teammates: [],
      workSyncControlUrl: null,
      batch: [
        message({
          messageId: 'comment-1',
          source: 'system_notification',
          messageKind: 'task_comment_notification',
          commentId: 'comment-123',
          taskRefs: [
            {
              teamName: 'source-team',
              taskId: 'task-123',
              displayId: '#123',
            },
          ],
          text: 'Comment on #123',
        }),
      ],
    });

    expect(prompt).toContain('Authoritative structured task context');
    expect(prompt).toContain('teamName="source-team", taskId="task-123", displayId="#123"');
    expect(prompt).toContain(
      'task_get_comment { teamName: "source-team", taskId: "task-123", commentId: "comment-123" }'
    );
  });
});
