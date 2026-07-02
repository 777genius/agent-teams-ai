import { describe, expect, it } from 'vitest';

import {
  buildCrossTeamConversationKey,
  clearPendingCrossTeamReplyExpectation,
  extractCrossTeamPseudoTargetTeam,
  getCrossTeamSourceTeam,
  getPendingCrossTeamReplyExpectationKeys,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  looksLikeQualifiedExternalRecipientName,
  matchCrossTeamLeadInboxMessages,
  parseCrossTeamRecipient,
  parseCrossTeamTargetTeam,
  registerPendingCrossTeamReplyExpectation,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  resolveSingleActiveCrossTeamReplyHint,
  wasRecentlyDeliveredToLead,
} from '../TeamProvisioningCrossTeamRouting';

import type { InboxMessage } from '@shared/types';

function inboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'peer-team.lead',
    to: 'team-lead',
    text: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    source: 'cross_team',
    messageId: 'message-1',
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('cross-team routing policy', () => {
  it('routes pseudo recipients to the target team lead outside the current team', () => {
    expect(parseCrossTeamRecipient('local-team', 'cross-team:peer-team', new Set())).toEqual({
      teamName: 'peer-team',
      memberName: 'team-lead',
    });
    expect(parseCrossTeamRecipient('peer-team', 'cross-team:peer-team', new Set())).toBeNull();
  });

  it('routes qualified external recipients and ignores local recipients', () => {
    const localRecipients = new Set(['worker-1']);

    expect(parseCrossTeamRecipient('local-team', 'peer-team.worker-2', localRecipients)).toEqual({
      teamName: 'peer-team',
      memberName: 'worker-2',
    });
    expect(parseCrossTeamRecipient('local-team', 'worker-1', localRecipients)).toBeNull();
    expect(
      parseCrossTeamRecipient('local-team', 'local-team.worker-2', localRecipients)
    ).toBeNull();
    expect(parseCrossTeamRecipient('local-team', 'BadTeam.worker-2', localRecipients)).toBeNull();
  });

  it('detects tool recipients, pseudo recipients, and qualified external names', () => {
    expect(isCrossTeamToolRecipientName(' cross_team_send ')).toBe(true);
    expect(isCrossTeamToolRecipientName('worker-1')).toBe(false);
    expect(extractCrossTeamPseudoTargetTeam('cross_team::peer-team')).toBe('peer-team');
    expect(isCrossTeamPseudoRecipientName('cross_team--peer-team')).toBe(true);
    expect(isCrossTeamPseudoRecipientName('cross_team--BadTeam')).toBe(false);
    expect(looksLikeQualifiedExternalRecipientName('peer-team.worker-1')).toBe(true);
    expect(looksLikeQualifiedExternalRecipientName('worker-1')).toBe(false);
  });

  it('deduplicates active reply hints and returns only a single unique conversation', () => {
    expect(
      resolveSingleActiveCrossTeamReplyHint([
        { toTeam: 'peer-team', conversationId: 'conv-1' },
        { toTeam: ' peer-team ', conversationId: ' conv-1 ' },
      ])
    ).toEqual({ toTeam: 'peer-team', conversationId: 'conv-1' });

    expect(
      resolveSingleActiveCrossTeamReplyHint([
        { toTeam: 'peer-team', conversationId: 'conv-1' },
        { toTeam: 'other-team', conversationId: 'conv-2' },
      ])
    ).toBeNull();
  });

  it('normalizes cross-team conversation keys and target/source teams', () => {
    expect(buildCrossTeamConversationKey(' peer-team ', ' conv-1 ')).toBe('peer-team\0conv-1');
    expect(parseCrossTeamTargetTeam('cross-team:peer-team')).toBe('peer-team');
    expect(parseCrossTeamTargetTeam('peer-team.worker-1')).toBe('peer-team');
    expect(parseCrossTeamTargetTeam('BadTeam.worker-1')).toBeNull();
    expect(getCrossTeamSourceTeam('peer-team.worker-1')).toBe('peer-team');
    expect(getCrossTeamSourceTeam('cross-team:peer-team')).toBeNull();
  });

  it('matches delivered cross-team blocks to lead inbox messages with exact text first', () => {
    const matches = matchCrossTeamLeadInboxMessages(
      [
        inboxMessage({ messageId: 'fallback', text: 'different text' }),
        inboxMessage({ messageId: 'exact', text: 'hello', read: true }),
      ],
      [
        {
          teammateId: 'peer-team.lead',
          content: 'hello',
          toTeam: 'peer-team',
          conversationId: 'conv-1',
        },
      ]
    );

    expect(matches).toEqual([
      {
        teammateId: 'peer-team.lead',
        content: 'hello',
        toTeam: 'peer-team',
        conversationId: 'conv-1',
        messageId: 'exact',
        wasRead: true,
      },
    ]);
  });

  it('deduplicates matched lead inbox messages across delivered blocks', () => {
    const matches = matchCrossTeamLeadInboxMessages(
      [inboxMessage({ messageId: 'shared', text: 'different text' })],
      [
        {
          teammateId: 'peer-team.lead',
          content: 'first',
          toTeam: 'peer-team',
          conversationId: 'conv-1',
        },
        {
          teammateId: 'peer-team.lead',
          content: 'second',
          toTeam: 'peer-team',
          conversationId: 'conv-1',
        },
      ]
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.messageId).toBe('shared');
  });

  it('manages pending cross-team reply expectations with ttl pruning', () => {
    const pendingReplies = new Map<string, Map<string, number>>();
    const ttlMs = 1000;

    registerPendingCrossTeamReplyExpectation(
      pendingReplies,
      ' local-team ',
      ' peer-team ',
      ' conv-1 ',
      10_000
    );
    pendingReplies.get('local-team')?.set(buildCrossTeamConversationKey('old-team', 'old'), 1);

    expect(
      getPendingCrossTeamReplyExpectationKeys(pendingReplies, 'local-team', 10_500, ttlMs)
    ).toEqual(new Set([buildCrossTeamConversationKey('peer-team', 'conv-1')]));

    clearPendingCrossTeamReplyExpectation(pendingReplies, 'local-team', 'peer-team', 'conv-1');
    expect(
      getPendingCrossTeamReplyExpectationKeys(pendingReplies, 'local-team', 10_500, ttlMs)
    ).toEqual(new Set());
    expect(pendingReplies.has('local-team')).toBe(false);
  });

  it('tracks recent lead delivery message ids and prunes expired entries', () => {
    const recentMessageIds = new Map<string, Map<string, number>>();
    const ttlMs = 1000;

    rememberRecentCrossTeamLeadDeliveryMessageIds(
      recentMessageIds,
      ' local-team ',
      [' message-1 ', '', 'message-2'],
      10_000,
      ttlMs
    );
    recentMessageIds.get('local-team')?.set('expired', 1);

    expect(
      wasRecentlyDeliveredToLead(recentMessageIds, 'local-team', ' message-1 ', 10_500, ttlMs)
    ).toBe(true);
    expect(
      wasRecentlyDeliveredToLead(recentMessageIds, 'local-team', 'expired', 10_500, ttlMs)
    ).toBe(false);
    expect(
      wasRecentlyDeliveredToLead(recentMessageIds, 'local-team', 'message-2', 12_000, ttlMs)
    ).toBe(false);
    expect(recentMessageIds.has('local-team')).toBe(false);
  });
});
