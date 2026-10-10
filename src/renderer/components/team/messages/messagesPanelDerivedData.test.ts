import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/store', () => ({ useStore: vi.fn() }));
vi.mock('./messagesPanelConversations', () => ({
  conversationScopeKey: vi.fn((scope) => JSON.stringify(scope)),
  filterScopedMessages: vi.fn((messages) => messages),
}));
vi.mock('../activity/LeadThoughtsGroup', () => ({
  getThoughtGroupKey: vi.fn(),
  groupTimelineItems: vi.fn(),
}));

import { DEFAULT_TEAM_GROUP_CHAT_ID } from '@features/team-group-chats/contracts';

import {
  canonicalTeamMessages,
  canOpenConversationAddress,
  conversationDraftAddress,
  localDraftsByConversationScope,
  memberConversationParticipants,
  outboxViewAddress,
  visibleTeamMessages,
} from './messagesPanelDerivedData';

import type { ComposerDraftAddress, ComposerWorkingSummary } from '@renderer/types/composerDraft';
import type { CrossTeamTarget, InboxMessage } from '@shared/types';

const message: InboxMessage = {
  from: 'Alice',
  to: 'user',
  text: 'Hidden by current search',
  timestamp: '2026-04-08T12:00:00.000Z',
  read: true,
  messageId: 'sent-1',
  source: 'inbox',
};

describe('messages panel derived data', () => {
  it('maps the open direct conversation to its draft address', () => {
    expect(
      conversationDraftAddress('local', 'team-alpha', { kind: 'direct', participant: 'alice' })
    ).toEqual({
      contextId: 'local',
      teamName: 'team-alpha',
      target: { kind: 'direct', participant: 'alice' },
    });
    const allAddress: ComposerDraftAddress = {
      contextId: 'local',
      teamName: 'team-alpha',
      target: { kind: 'group', groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID },
    };
    const allDraft: ComposerWorkingSummary = {
      version: 1,
      workingRevision: 'test-draft',
      address: allAddress,
      preview: 'All draft',
      updatedAt: 2,
      attachmentCount: 0,
      chipCount: 0,
      editorKind: 'plain',
    };
    const leadDraft: ComposerWorkingSummary = {
      ...allDraft,
      address: { ...allAddress, target: { kind: 'team-feed' } },
      preview: 'Lead draft',
      updatedAt: 1,
    };
    const key = JSON.stringify({ kind: 'team-feed' });
    expect(
      localDraftsByConversationScope([allDraft, leadDraft], 'local', 'team-alpha').get(key)?.preview
    ).toBe('All draft');
    expect(
      localDraftsByConversationScope([leadDraft, allDraft], 'local', 'team-alpha').get(key)?.preview
    ).toBe('All draft');
    expect(allDraft.address).toBe(allAddress);
  });

  it('filters root and team before mapping summaries with the same group UUID', () => {
    const current: ComposerWorkingSummary = {
      version: 1,
      workingRevision: 'current',
      address: {
        contextId: 'root-a',
        teamName: 'same-team',
        target: { kind: 'group', groupChatId: 'same-uuid' },
      },
      preview: 'Current group draft',
      updatedAt: 1,
      attachmentCount: 0,
      chipCount: 0,
      editorKind: 'plain',
    };
    const otherRoot = {
      ...current,
      preview: 'Foreign root draft',
      updatedAt: 100,
      address: { ...current.address, contextId: 'root-b' },
    };
    const otherTeam = {
      ...current,
      preview: 'Foreign team draft',
      updatedAt: 200,
      address: { ...current.address, teamName: 'another-team' },
    };
    const drafts = localDraftsByConversationScope(
      [current, otherRoot, otherTeam],
      'root-a',
      'same-team'
    );
    expect([...drafts.entries()]).toEqual([
      [
        JSON.stringify({ kind: 'group', groupChatId: 'same-uuid' }),
        expect.objectContaining({ preview: 'Current group draft', updatedAt: 1 }),
      ],
    ]);
    expect(localDraftsByConversationScope([otherRoot, otherTeam], 'root-a', 'same-team').size).toBe(
      0
    );
  });

  it('recognizes a normalized direct address for a mixed-case member', () => {
    const participants = memberConversationParticipants([{ name: 'Alice' }]);

    expect(
      canOpenConversationAddress(
        {
          contextId: 'local',
          teamName: 'team-a',
          target: { kind: 'direct', participant: 'alice' },
        },
        participants,
        []
      )
    ).toBe(true);
  });

  it('recognizes only selectable cross-team group and member addresses', () => {
    const targets: CrossTeamTarget[] = [
      { teamName: 'team-beta', displayName: 'Beta', members: [{ name: 'carol' }] },
    ];
    const address: ComposerDraftAddress = {
      contextId: 'local',
      teamName: 'team-alpha',
      target: { kind: 'cross-team', toTeam: 'team-beta', toMember: null },
    };
    const participants = new Set<string>();

    expect(canOpenConversationAddress(address, participants, targets)).toBe(true);
    expect(
      canOpenConversationAddress(
        { ...address, target: { kind: 'cross-team', toTeam: 'team-beta', toMember: 'carol' } },
        participants,
        targets
      )
    ).toBe(true);
    expect(
      canOpenConversationAddress(
        { ...address, target: { kind: 'cross-team', toTeam: 'team-beta', toMember: 'absent' } },
        participants,
        targets
      )
    ).toBe(false);
    expect(canOpenConversationAddress(address, participants, [])).toBe(false);
    expect(
      canOpenConversationAddress(
        {
          ...address,
          target: { kind: 'cross-team', toTeam: 'team-alpha', toMember: null },
        },
        participants,
        [{ teamName: 'team-alpha', displayName: 'Alpha' }]
      )
    ).toBe(false);
  });

  it('shows cross-team recovery at the selected composer address', () => {
    const conversationAddress: ComposerDraftAddress = {
      contextId: 'local',
      teamName: 'team-alpha',
      target: { kind: 'team-feed' },
    };
    const crossTeamAddress: ComposerDraftAddress = {
      ...conversationAddress,
      target: { kind: 'cross-team', toTeam: 'team-beta', toMember: 'carol' },
    };
    expect(outboxViewAddress(conversationAddress, { address: crossTeamAddress })).toBe(
      crossTeamAddress
    );
    expect(outboxViewAddress(conversationAddress, { address: conversationAddress })).toBe(
      conversationAddress
    );
  });

  it('keeps canonical messages available for outbox reconciliation when the view filters them', () => {
    const messages = [message];
    const visible = visibleTeamMessages({
      messages,
      leadNames: [],
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: 'unrelated',
    });

    expect(visible).toEqual([]);
    expect(canonicalTeamMessages(messages, [])).toEqual([message]);
  });
});
