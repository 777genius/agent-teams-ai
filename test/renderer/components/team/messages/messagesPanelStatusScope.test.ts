import {
  pendingApprovalsForConversation,
  pendingRepliesForConversation,
} from '@renderer/components/team/messages/messagesPanelStatusScope';
import { describe, expect, it, vi } from 'vitest';

import type { ToolApprovalRequest } from '@shared/types';

vi.mock('@renderer/store', () => ({ useStore: vi.fn() }));

const leadNames = ['team-lead'];

describe('conversation-scoped status', () => {
  it('shows a pending send in its direct chat and team feed, but not another direct chat', () => {
    const pending = { alice: 10, bob: 20, 'team-lead': 30 };

    expect(pendingRepliesForConversation(pending, { kind: 'team-feed' }, leadNames)).toBe(pending);
    expect(
      pendingRepliesForConversation(pending, { kind: 'direct', participant: 'alice' }, leadNames)
    ).toEqual({ alice: 10 });
    expect(
      pendingRepliesForConversation(pending, { kind: 'direct', participant: 'bob' }, leadNames)
    ).toEqual({ bob: 20 });
    expect(
      pendingRepliesForConversation(pending, { kind: 'direct', participant: 'lead' }, leadNames)
    ).toEqual({ 'team-lead': 30 });
  });

  it('keeps cross-team destinations out of a local direct chat', () => {
    expect(
      pendingRepliesForConversation(
        { 'other-team/alice': 10 },
        { kind: 'direct', participant: 'alice' },
        leadNames
      )
    ).toEqual({});
  });

  it('scopes approval status to this team and its direct source', () => {
    const approval = (teamName: string, source: string): ToolApprovalRequest =>
      ({ teamName, source, receivedAt: '2026-09-24T12:00:00.000Z' }) as ToolApprovalRequest;
    const approvals = [
      approval('sandbox', 'alice'),
      approval('sandbox', 'bob'),
      approval('other-team', 'alice'),
    ];

    expect(
      pendingApprovalsForConversation(approvals, 'sandbox', { kind: 'team-feed' }, leadNames)
    ).toEqual(approvals.slice(0, 2));
    expect(
      pendingApprovalsForConversation(
        approvals,
        'sandbox',
        { kind: 'direct', participant: 'alice' },
        leadNames
      )
    ).toEqual([approvals[0]]);
  });
});
