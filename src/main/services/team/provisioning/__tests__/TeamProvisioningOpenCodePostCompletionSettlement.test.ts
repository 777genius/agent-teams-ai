import { describe, expect, it, vi } from 'vitest';

import { OPENCODE_BOARD_COMPLETE_MESSAGE_ID_PREFIX } from '../TeamProvisioningOpenCodeInboxCoalescePolicy';
import {
  findFinalUserMessage,
  hasBoardMovedSinceSettlement,
  OPENCODE_POST_COMPLETION_READ_COMMIT_DIAGNOSTIC,
  type OpenCodePostCompletionSettlementPorts,
  resolveBoardCompletionEpochMs,
  resolveOpenCodePostCompletionSettlement,
  settleOpenCodePostCompletionNotices,
} from '../TeamProvisioningOpenCodePostCompletionSettlement';

import type { RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';
import type { InboxMessage, TeamTask } from '@shared/types';

const EPOCH = '2026-01-01T10:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH);

function completedTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    subject: 'write the section',
    status: 'completed',
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: EPOCH,
    historyEvents: [
      {
        id: 'event-1',
        type: 'task_created',
        timestamp: '2026-01-01T09:00:00.000Z',
        status: 'pending',
      },
      {
        id: 'event-2',
        type: 'status_changed',
        timestamp: EPOCH,
        from: 'in_progress',
        to: 'completed',
      },
    ],
    ...overrides,
  } as TeamTask;
}

function userInboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    to: 'user',
    text: 'Everything on the board is done.',
    timestamp: '2026-01-01T10:00:05.000Z',
    read: false,
    messageId: 'final-1',
    ...overrides,
  };
}

function notice(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'Scribe',
    to: 'team-lead',
    text: '#de5126de done.',
    timestamp: '2026-01-01T10:00:10.000Z',
    read: false,
    messageId: 'notice-1',
    ...overrides,
  };
}

function createSettlementPorts(
  overrides: Partial<OpenCodePostCompletionSettlementPorts> = {}
): OpenCodePostCompletionSettlementPorts {
  return {
    readTasks: vi.fn().mockResolvedValue([completedTask()]),
    readTasksAfterCommit: vi.fn().mockResolvedValue([completedTask()]),
    readUserInbox: vi.fn().mockResolvedValue([userInboxMessage()]),
    resolveReplyRecipient: () => 'Scribe',
    hasExistingRecord: vi.fn().mockResolvedValue(false),
    markRead: vi.fn().mockResolvedValue(undefined),
    logReadCommitFailure: vi.fn(),
    isCurrentGeneration: () => true,
    ...overrides,
  };
}

describe('resolveBoardCompletionEpochMs', () => {
  it('takes the newest structural board event of a fully completed board', () => {
    expect(
      resolveBoardCompletionEpochMs([
        completedTask(),
        completedTask({
          id: 'task-2',
          historyEvents: [
            {
              id: 'event-3',
              type: 'owner_changed',
              timestamp: '2026-01-01T10:30:00.000Z',
              from: 'Scribe',
              to: 'Drafter',
            },
          ],
          createdAt: '2026-01-01T09:30:00.000Z',
          updatedAt: '2026-01-01T10:30:00.000Z',
        }),
      ])
    ).toBe(Date.parse('2026-01-01T10:30:00.000Z'));
  });

  it('returns null for an empty board and for a board that still has open work', () => {
    expect(resolveBoardCompletionEpochMs([])).toBeNull();
    expect(resolveBoardCompletionEpochMs([completedTask({ status: 'in_progress' })])).toBeNull();
    expect(
      resolveBoardCompletionEpochMs([
        completedTask(),
        completedTask({ id: 'task-2', status: 'pending' }),
      ])
    ).toBeNull();
    // A board whose only rows are deleted is an empty board, not a finished one.
    expect(resolveBoardCompletionEpochMs([completedTask({ status: 'deleted' })])).toBeNull();
  });

  it('does not move the epoch for a task comment that only bumped updatedAt', () => {
    const commented = completedTask({
      updatedAt: '2026-01-01T12:00:00.000Z',
      comments: [
        {
          id: 'comment-1',
          author: 'Scribe',
          text: 'Risks are on the board.',
          createdAt: '2026-01-01T12:00:00.000Z',
          type: 'regular',
        },
      ],
    } as Partial<TeamTask>);

    expect(resolveBoardCompletionEpochMs([commented])).toBe(EPOCH_MS);
  });

  it('does not move the epoch for review history events', () => {
    const reviewed = completedTask({
      updatedAt: EPOCH,
      historyEvents: [
        ...(completedTask().historyEvents ?? []),
        {
          id: 'event-review',
          type: 'review_approved',
          timestamp: '2026-01-01T11:00:00.000Z',
          from: 'review',
          to: 'completed',
        },
      ],
    } as Partial<TeamTask>);

    expect(resolveBoardCompletionEpochMs([reviewed])).toBe(EPOCH_MS);
  });

  it('falls back to task timestamps when a task carries no structural event', () => {
    expect(
      resolveBoardCompletionEpochMs([
        completedTask({
          historyEvents: [],
          createdAt: '2026-01-01T09:00:00.000Z',
          updatedAt: EPOCH,
        }),
      ])
    ).toBe(EPOCH_MS);
    expect(
      resolveBoardCompletionEpochMs([
        completedTask({ historyEvents: undefined, createdAt: undefined, updatedAt: undefined }),
      ])
    ).toBeNull();
  });
});

describe('findFinalUserMessage', () => {
  it('returns the newest team message written at or after the epoch', () => {
    expect(
      findFinalUserMessage(
        [
          userInboxMessage({ messageId: 'old', timestamp: '2026-01-01T09:59:00.000Z' }),
          userInboxMessage({ messageId: 'final-1', timestamp: EPOCH }),
          userInboxMessage({ messageId: 'final-2', timestamp: '2026-01-01T10:00:05.000Z' }),
        ],
        EPOCH_MS
      )?.messageId
    ).toBe('final-2');
  });

  it('never treats a message from the user as the team final word', () => {
    expect(
      findFinalUserMessage(
        [
          userInboxMessage({
            messageId: 'user-follow-up',
            from: 'user',
            to: 'team-lead',
            text: 'one more thing',
            timestamp: '2026-01-01T10:05:00.000Z',
          }),
        ],
        EPOCH_MS
      )
    ).toBeNull();
  });

  it('ignores messages written before the epoch', () => {
    expect(
      findFinalUserMessage([userInboxMessage({ timestamp: '2026-01-01T09:00:00.000Z' })], EPOCH_MS)
    ).toBeNull();
  });
});

describe('resolveOpenCodePostCompletionSettlement', () => {
  it('settles a completed board whose final message already reached the user', async () => {
    await expect(
      resolveOpenCodePostCompletionSettlement({
        readTasks: () => Promise.resolve([completedTask()]),
        readUserInbox: () => Promise.resolve([userInboxMessage()]),
      })
    ).resolves.toEqual({
      epochMs: EPOCH_MS,
      finalMessageId: 'final-1',
      finalMessageAt: '2026-01-01T10:00:05.000Z',
    });
  });

  it('does not settle while work is open, and does not settle without a final message', async () => {
    await expect(
      resolveOpenCodePostCompletionSettlement({
        readTasks: () => Promise.resolve([completedTask({ status: 'in_progress' })]),
        readUserInbox: () => Promise.resolve([userInboxMessage()]),
      })
    ).resolves.toBeNull();
    await expect(
      resolveOpenCodePostCompletionSettlement({
        readTasks: () => Promise.resolve([completedTask()]),
        readUserInbox: () => Promise.resolve([]),
      })
    ).resolves.toBeNull();
  });

  it('treats an unreadable board or inbox as not settled', async () => {
    await expect(
      resolveOpenCodePostCompletionSettlement({
        readTasks: () => Promise.reject(new Error('board unreadable')),
        readUserInbox: () => Promise.resolve([userInboxMessage()]),
      })
    ).resolves.toBeNull();
    await expect(
      resolveOpenCodePostCompletionSettlement({
        readTasks: () => Promise.resolve([completedTask()]),
        readUserInbox: () => Promise.reject(new Error('inbox unreadable')),
      })
    ).resolves.toBeNull();
  });
});

describe('hasBoardMovedSinceSettlement', () => {
  const settlement = { epochMs: EPOCH_MS, finalMessageId: 'final-1', finalMessageAt: EPOCH };

  it('reports a move for every structural board event', () => {
    for (const event of [
      {
        id: 'e',
        type: 'task_created' as const,
        timestamp: '2026-01-01T11:00:00.000Z',
        status: 'pending' as const,
      },
      {
        id: 'e',
        type: 'status_changed' as const,
        timestamp: '2026-01-01T11:00:00.000Z',
        from: 'in_progress' as const,
        to: 'completed' as const,
      },
      {
        id: 'e',
        type: 'owner_changed' as const,
        timestamp: '2026-01-01T11:00:00.000Z',
        from: 'Scribe',
        to: 'Drafter',
      },
    ]) {
      expect(
        hasBoardMovedSinceSettlement(
          [completedTask(), completedTask({ id: 'task-2', historyEvents: [event] })],
          settlement
        )
      ).toBe(true);
    }
  });

  it('reports a move when work reopened', () => {
    expect(
      hasBoardMovedSinceSettlement([completedTask({ status: 'in_progress' })], settlement)
    ).toBe(true);
    expect(hasBoardMovedSinceSettlement([], settlement)).toBe(true);
  });

  it('does not report a move for a task comment', () => {
    expect(
      hasBoardMovedSinceSettlement(
        [
          completedTask({
            updatedAt: '2026-01-01T12:00:00.000Z',
            comments: [
              {
                id: 'comment-1',
                author: 'Scribe',
                text: 'Risks are on the board.',
                createdAt: '2026-01-01T12:00:00.000Z',
                type: 'regular',
              },
            ],
          } as Partial<TeamTask>),
        ],
        settlement
      )
    ).toBe(false);
  });
});

describe('settleOpenCodePostCompletionNotices', () => {
  it('read-commits the anchor and every reply-optional notice behind it', async () => {
    const anchor = notice();
    const follower = notice({ messageId: 'notice-2', timestamp: '2026-01-01T10:00:11.000Z' });
    const markRead = vi.fn().mockResolvedValue(undefined);

    const outcome = await settleOpenCodePostCompletionNotices({
      unread: [anchor, follower],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      anchorHasLedgerRecord: false,
      ports: createSettlementPorts({ markRead }),
    });

    expect(markRead).toHaveBeenCalledWith([anchor, follower]);
    expect(outcome).toEqual({
      kind: 'read_committed',
      messages: [anchor, follower],
      diagnostic: `${OPENCODE_POST_COMPLETION_READ_COMMIT_DIAGNOSTIC}: notice-1,notice-2 (final user message final-1 at 2026-01-01T10:00:05.000Z)`,
    });
  });

  it('delivers normally for a reply-required anchor and for an anchor that already has a record', async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);

    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice({ from: 'user', text: 'status?' })],
        index: 0,
        anchorReplyRecipient: 'user',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({ markRead }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice()],
        index: 0,
        anchorReplyRecipient: 'Scribe',
        anchorHasLedgerRecord: true,
        ports: createSettlementPorts({ markRead }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    // A kind that carries its own contract (a work-sync nudge expects a report)
    // is never absorbed either.
    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice({ messageKind: 'member_work_sync_nudge' })],
        index: 0,
        anchorReplyRecipient: 'Scribe',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({ markRead }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('delivers normally while the board still has open work', async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);

    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice()],
        index: 0,
        anchorReplyRecipient: 'Scribe',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({
          markRead,
          readTasks: vi.fn().mockResolvedValue([completedTask({ status: 'in_progress' })]),
        }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('delivers the anchor as a catch-up when the board moved during the read-commit', async () => {
    const anchor = notice();
    const reopened = [
      completedTask(),
      completedTask({
        id: 'task-2',
        historyEvents: [
          {
            id: 'event-new',
            type: 'task_created',
            timestamp: '2026-01-01T10:00:12.000Z',
            status: 'pending',
          },
        ],
        createdAt: '2026-01-01T10:00:12.000Z',
        updatedAt: '2026-01-01T10:00:12.000Z',
      }),
    ];

    const outcome = await settleOpenCodePostCompletionNotices({
      unread: [anchor],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      anchorHasLedgerRecord: false,
      ports: createSettlementPorts({
        readTasksAfterCommit: vi.fn().mockResolvedValue(reopened),
      }),
    });

    expect(outcome).toMatchObject({ kind: 'catch_up', tasks: reopened });
    expect(outcome.kind === 'catch_up' && outcome.diagnostic).toContain(
      'board moved, delivering anchor as catch-up'
    );
  });

  it('never absorbs the board completion notice, as anchor or as follower', async () => {
    const boardComplete = notice({
      messageId: `${OPENCODE_BOARD_COMPLETE_MESSAGE_ID_PREFIX}team:de5126de`,
      from: 'system',
      source: 'system_notification',
      text: 'Every task on the board is completed.',
      timestamp: '2026-01-01T10:00:12.000Z',
    });
    const anchorMarkRead = vi.fn().mockResolvedValue(undefined);

    // As the anchor: the settled team does not swallow it.
    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [boardComplete],
        index: 0,
        anchorReplyRecipient: 'system',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({ markRead: anchorMarkRead }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    expect(anchorMarkRead).not.toHaveBeenCalled();

    // Behind an ordinary notice: the commit stops in front of it, so it becomes
    // the anchor of the next pass instead of being marked read unseen.
    const anchor = notice();
    const trailing = notice({ messageId: 'notice-3', timestamp: '2026-01-01T10:00:13.000Z' });
    const followerMarkRead = vi.fn().mockResolvedValue(undefined);

    const outcome = await settleOpenCodePostCompletionNotices({
      unread: [anchor, boardComplete, trailing],
      index: 0,
      anchorReplyRecipient: 'Scribe',
      anchorHasLedgerRecord: false,
      ports: createSettlementPorts({ markRead: followerMarkRead }),
    });

    expect(followerMarkRead).toHaveBeenCalledWith([anchor]);
    expect(outcome).toMatchObject({ kind: 'read_committed', messages: [anchor] });
  });

  it('leaves the notices unread and delivers normally when the read-commit fails', async () => {
    const logReadCommitFailure = vi.fn();

    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice()],
        index: 0,
        anchorReplyRecipient: 'Scribe',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({
          markRead: vi.fn().mockRejectedValue(new Error('inbox locked')),
          logReadCommitFailure,
        }),
      })
    ).resolves.toEqual({ kind: 'deliver' });
    expect(logReadCommitFailure).toHaveBeenCalledWith(expect.any(Error));
  });

  it('abandons the pass when a newer relay generation took over', async () => {
    const generations = [false];

    await expect(
      settleOpenCodePostCompletionNotices({
        unread: [notice()],
        index: 0,
        anchorReplyRecipient: 'Scribe',
        anchorHasLedgerRecord: false,
        ports: createSettlementPorts({ isCurrentGeneration: () => generations.shift() ?? true }),
      })
    ).resolves.toEqual({ kind: 'superseded' });
  });
});
