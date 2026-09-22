import { describe, expect, it, vi } from 'vitest';

import {
  buildCrossTeamConversationKey,
  buildLeadActiveCrossTeamReplyHints,
  clearPendingCrossTeamReplyExpectation,
  createCrossTeamLeadSuppressionState,
  extractCrossTeamPseudoTargetTeam,
  getCrossTeamSourceTeam,
  getPendingCrossTeamReplyExpectationKeys,
  getPendingHistoricalCrossTeamReplyKeys,
  isCrossTeamLeadReplyToOwnOutbound,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  looksLikeQualifiedExternalRecipientName,
  markCrossTeamReplyToOwnOutbound,
  matchCrossTeamLeadInboxMessages,
  parseCrossTeamRecipient,
  parseCrossTeamTargetTeam,
  readAndMatchCrossTeamLeadInboxMessages,
  registerPendingCrossTeamReplyExpectation,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  resolveCrossTeamLeadName,
  resolveSingleActiveCrossTeamReplyHint,
  wasRecentlyDeliveredCrossTeamLeadMessage,
  wasRecentlyDeliveredToLead,
} from '../TeamProvisioningCrossTeamRelayHelpers';

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

describe('cross-team relay helpers', () => {
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

  it('builds lead suppression state from pending historical and transient cross-team replies', () => {
    const pendingReplies = new Map<string, Map<string, number>>([
      [
        'local-team',
        new Map([[buildCrossTeamConversationKey('transient-team', 'transient-conv'), 10_000]]),
      ],
    ]);
    const state = createCrossTeamLeadSuppressionState({
      leadInboxMessages: [
        inboxMessage({
          source: 'cross_team_sent',
          from: 'local-team.team-lead',
          to: 'peer-team.team-lead',
          conversationId: 'conv-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          read: true,
        }),
        inboxMessage({
          source: 'cross_team',
          from: 'peer-team.team-lead',
          conversationId: 'conv-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: true,
        }),
      ],
      pendingReplies,
      teamName: 'local-team',
      now: 10_500,
      ttlMs: 1000,
    });

    expect(
      markCrossTeamReplyToOwnOutbound(inboxMessage({ from: 'peer-team.team-lead' }), state)
    ).toBe(true);
    expect(
      markCrossTeamReplyToOwnOutbound(
        inboxMessage({
          from: 'transient-team.team-lead',
          conversationId: 'transient-conv',
        }),
        state
      )
    ).toBe(true);
    expect(state.matchedTransientReplyKeys).toEqual(
      new Set([buildCrossTeamConversationKey('transient-team', 'transient-conv')])
    );
    expect(
      markCrossTeamReplyToOwnOutbound(
        inboxMessage({ from: 'unrelated-team.team-lead', conversationId: 'other-conv' }),
        state
      )
    ).toBe(false);
  });

  it('detects recently delivered cross-team lead messages', () => {
    const recentMessageIds = new Map<string, Map<string, number>>([
      ['local-team', new Map([['message-1', 10_000]])],
    ]);

    expect(
      wasRecentlyDeliveredCrossTeamLeadMessage({
        message: inboxMessage({ messageId: 'message-1' }),
        recentMessageIds,
        teamName: 'local-team',
        now: 10_500,
        ttlMs: 1000,
      })
    ).toBe(true);
    expect(
      wasRecentlyDeliveredCrossTeamLeadMessage({
        message: inboxMessage({ source: 'cross_team_sent', messageId: 'message-1' }),
        recentMessageIds,
        teamName: 'local-team',
        now: 10_500,
        ttlMs: 1000,
      })
    ).toBe(false);
  });

  it('detects historical cross-team replies only when outbound is newer than read inbound', () => {
    const pending = getPendingHistoricalCrossTeamReplyKeys([
      inboxMessage({
        source: 'cross_team_sent',
        to: 'peer-team.team-lead',
        conversationId: 'conv-new',
        timestamp: '2026-01-01T00:00:10.000Z',
      }),
      inboxMessage({
        source: 'cross_team',
        from: 'peer-team.team-lead',
        conversationId: 'conv-new',
        read: true,
        timestamp: '2026-01-01T00:00:05.000Z',
      }),
      inboxMessage({
        source: 'cross_team_sent',
        to: 'quiet-team.team-lead',
        conversationId: 'conv-done',
        timestamp: '2026-01-01T00:00:10.000Z',
      }),
      inboxMessage({
        source: 'cross_team',
        from: 'quiet-team.team-lead',
        conversationId: 'conv-done',
        read: true,
        timestamp: '2026-01-01T00:00:11.000Z',
      }),
    ]);

    expect(pending).toEqual(new Set([buildCrossTeamConversationKey('peer-team', 'conv-new')]));
  });

  it('recognizes cross-team lead replies to historical and transient outbound expectations', () => {
    const matchedTransientReplyKeys = new Set<string>();
    const transientKey = buildCrossTeamConversationKey('transient-team', 'conv-transient');

    expect(
      isCrossTeamLeadReplyToOwnOutbound({
        message: inboxMessage({ from: 'peer-team.lead', conversationId: 'conv-1' }),
        pendingHistoricalReplies: new Set([buildCrossTeamConversationKey('peer-team', 'conv-1')]),
        pendingTransientReplies: new Set(),
        matchedTransientReplyKeys,
      })
    ).toBe(true);

    expect(
      isCrossTeamLeadReplyToOwnOutbound({
        message: inboxMessage({
          from: 'transient-team.lead',
          conversationId: 'conv-transient',
        }),
        pendingHistoricalReplies: new Set(),
        pendingTransientReplies: new Set([transientKey]),
        matchedTransientReplyKeys,
      })
    ).toBe(true);

    expect(matchedTransientReplyKeys).toEqual(new Set([transientKey]));
  });

  it('builds lead active cross-team reply hints from relay batches', () => {
    expect(
      buildLeadActiveCrossTeamReplyHints([
        inboxMessage({ from: 'peer-team.lead', conversationId: 'conv-1' }),
        inboxMessage({ source: 'inbox', from: 'alice', conversationId: 'ignored' }),
        inboxMessage({
          from: 'other-team.lead',
          conversationId: undefined,
          text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-2" />\nHi',
        }),
      ])
    ).toEqual([
      { toTeam: 'peer-team', conversationId: 'conv-1' },
      { toTeam: 'other-team', conversationId: 'conv-2' },
    ]);
  });

  it('resolves the run lead name from lead-like member roles with team-lead fallback', () => {
    expect(
      resolveCrossTeamLeadName([
        { name: 'worker-1', role: 'worker' },
        { name: 'custom-lead', role: 'Team Lead' },
      ])
    ).toBe('custom-lead');
    expect(resolveCrossTeamLeadName([{ name: 'worker-1', role: 'worker' }])).toBe('team-lead');
    expect(resolveCrossTeamLeadName([{ name: '', role: 'lead' }])).toBe('team-lead');
    expect(resolveCrossTeamLeadName(null)).toBe('team-lead');
  });

  it('skips lead inbox reads when there are no delivered blocks', async () => {
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [inboxMessage()]),
    };

    await expect(
      readAndMatchCrossTeamLeadInboxMessages({
        inboxReader,
        teamName: 'local-team',
        leadName: 'team-lead',
        deliveredBlocks: [],
      })
    ).resolves.toEqual([]);
    expect(inboxReader.getMessagesFor).not.toHaveBeenCalled();
  });

  it('returns no lead inbox matches when inbox reads fail', async () => {
    const inboxReader = {
      getMessagesFor: vi.fn(async () => {
        throw new Error('read failed');
      }),
    };

    await expect(
      readAndMatchCrossTeamLeadInboxMessages({
        inboxReader,
        teamName: 'local-team',
        leadName: 'team-lead',
        deliveredBlocks: [
          {
            teammateId: 'peer-team.lead',
            content: 'hello',
            toTeam: 'peer-team',
            conversationId: 'conv-1',
          },
        ],
      })
    ).resolves.toEqual([]);
  });

  it('reads the lead inbox and matches delivered blocks through the shared matcher', async () => {
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        inboxMessage({ messageId: 'exact', text: 'hello', read: true }),
      ]),
    };

    await expect(
      readAndMatchCrossTeamLeadInboxMessages({
        inboxReader,
        teamName: 'local-team',
        leadName: 'custom-lead',
        deliveredBlocks: [
          {
            teammateId: 'peer-team.lead',
            content: 'hello',
            toTeam: 'peer-team',
            conversationId: 'conv-1',
          },
        ],
      })
    ).resolves.toEqual([
      {
        teammateId: 'peer-team.lead',
        content: 'hello',
        toTeam: 'peer-team',
        conversationId: 'conv-1',
        messageId: 'exact',
        wasRead: true,
      },
    ]);
    expect(inboxReader.getMessagesFor).toHaveBeenCalledWith('local-team', 'custom-lead');
  });
});
