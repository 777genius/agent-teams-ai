import {
  compareLeadInboxRelayMessagesByPriority,
  compareMemberInboxRelayMessagesByPriority,
  compareOpenCodeInboxRelayMessagesByPriority,
  getLeadInboxRelayPriority,
  hasStableInboxMessageId,
  isCurrentProofMissingRecoveryForegroundMessage,
  isCurrentReviewPickupRequestForegroundMessage,
  normalizeSameTeamText,
  openCodeTaskRefsOverlap,
  shouldSuppressUnverifiedLeadRelayStateLine,
} from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import { describe, expect, it } from 'vitest';

const baseMessage = {
  messageKind: undefined,
  source: undefined,
  timestamp: '2026-04-24T12:00:00.000Z',
};

describe('TeamProvisioningInboxRelayPolicy', () => {
  it('normalizes same-team text line endings without collapsing intentional spacing', () => {
    expect(normalizeSameTeamText('  hello\r\n  world  ')).toBe('hello\n  world');
  });

  it('prioritizes OpenCode work-sync nudges, then system notifications, then timestamp', () => {
    const messages = [
      { ...baseMessage, messageId: 'normal-newer', timestamp: '2026-04-24T12:02:00.000Z' },
      {
        ...baseMessage,
        messageId: 'system',
        source: 'system_notification' as const,
        timestamp: '2026-04-24T12:03:00.000Z',
      },
      {
        ...baseMessage,
        messageId: 'nudge',
        messageKind: 'member_work_sync_nudge' as const,
        timestamp: '2026-04-24T12:04:00.000Z',
      },
      { ...baseMessage, messageId: 'normal-older', timestamp: '2026-04-24T12:01:00.000Z' },
    ];

    const sorted = [...messages].sort(compareOpenCodeInboxRelayMessagesByPriority);

    expect(sorted.map((m) => m.messageId)).toEqual([
      'nudge',
      'system',
      'normal-older',
      'normal-newer',
    ]);
  });

  it('uses member and lead relay priorities without system notification boost', () => {
    const messages = [
      {
        ...baseMessage,
        messageId: 'system',
        source: 'system_notification' as const,
        timestamp: '2026-04-24T12:01:00.000Z',
      },
      {
        ...baseMessage,
        messageId: 'nudge',
        messageKind: 'member_work_sync_nudge' as const,
        timestamp: '2026-04-24T12:02:00.000Z',
      },
      { ...baseMessage, messageId: 'normal', timestamp: '2026-04-24T12:00:00.000Z' },
    ];

    const memberSorted = [...messages].sort(compareMemberInboxRelayMessagesByPriority);
    const leadSorted = [...messages].sort(compareLeadInboxRelayMessagesByPriority);

    expect(memberSorted.map((m) => m.messageId)).toEqual(['nudge', 'normal', 'system']);
    expect(getLeadInboxRelayPriority(memberSorted[0])).toBe(30);
    expect(leadSorted.map((m) => m.messageId)).toEqual(['nudge', 'normal', 'system']);
  });

  it('falls back to message id when relay timestamps are equal or invalid', () => {
    const messages = [
      { ...baseMessage, messageId: 'b', timestamp: 'invalid' },
      { ...baseMessage, messageId: 'a', timestamp: 'invalid' },
    ];

    const sorted = [...messages].sort(compareOpenCodeInboxRelayMessagesByPriority);

    expect(sorted.map((m) => m.messageId)).toEqual(['a', 'b']);
  });

  it('suppresses unverified lead relay state claims but keeps ordinary text', () => {
    expect(shouldSuppressUnverifiedLeadRelayStateLine('PR #123 is merged')).toBe(true);
    expect(shouldSuppressUnverifiedLeadRelayStateLine('task queue clear')).toBe(true);
    expect(shouldSuppressUnverifiedLeadRelayStateLine('I checked the docs and found the API')).toBe(
      false
    );
    expect(shouldSuppressUnverifiedLeadRelayStateLine('mergeable branch notes')).toBe(false);
  });

  it('matches OpenCode review pickup foreground messages by structured task refs', () => {
    const taskRef = { teamName: 'team', taskId: 'task-1', displayId: '42' };

    expect(
      isCurrentReviewPickupRequestForegroundMessage(
        {
          from: 'system',
          to: 'dev',
          text: '**Please review** review_start',
          timestamp: baseMessage.timestamp,
          read: false,
          source: 'system_notification',
          taskRefs: [taskRef],
        },
        { workSyncIntent: 'review_pickup', taskRefs: [taskRef] }
      )
    ).toBe(true);
  });

  it('matches proof-missing recovery messages by stable message id', () => {
    expect(
      isCurrentProofMissingRecoveryForegroundMessage(
        {
          from: 'system',
          to: 'dev',
          text: 'retry',
          timestamp: baseMessage.timestamp,
          read: false,
          messageId: 'msg-1',
        },
        { workSyncIntent: 'agenda_sync', workSyncIntentKey: 'proof-missing:msg-1' }
      )
    ).toBe(true);
    expect(
      hasStableInboxMessageId({
        ...baseMessage,
        text: '',
        from: 'user',
        to: 'dev',
        read: false,
      })
    ).toBe(false);
  });

  it('detects overlapping OpenCode task refs after normalization', () => {
    expect(
      openCodeTaskRefsOverlap(
        [{ teamName: 'team', taskId: 'task-1', displayId: '42' }],
        [{ teamName: 'team', taskId: 'task-1', displayId: '42' }]
      )
    ).toBe(true);
  });
});
