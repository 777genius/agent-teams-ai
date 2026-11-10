import { resolveReplyRecipient } from '@renderer/components/team/messages/messagesPanelReplyRecipient';
import { describe, expect, it } from 'vitest';

import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage } from '@shared/types';

const members = [{ name: 'lead' }, { name: 'alice' }, { name: 'bob' }, { name: 'ops.alice' }];

function message(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'alice',
    text: 'hello',
    timestamp: '2026-09-22T10:00:00.000Z',
    read: true,
    source: 'inbox',
    ...overrides,
  };
}

function resolve(input: {
  message: InboxMessage;
  scope?: ConversationScope;
  availableMembers?: readonly { name: string }[];
}): string {
  return resolveReplyRecipient({
    message: input.message,
    scope: input.scope ?? { kind: 'team-feed' },
    teamName: 'atlas',
    members: input.availableMembers ?? members,
  });
}

describe('resolveReplyRecipient', () => {
  it('routes every supported local message in a DM to the conversation participant', () => {
    expect(
      resolve({
        scope: { kind: 'direct', participant: 'Alice' },
        message: message({ from: 'user', to: 'alice', source: 'user_sent' }),
      })
    ).toBe('alice');
    expect(
      resolve({
        scope: { kind: 'direct', participant: 'alice' },
        message: message({ from: 'bob', to: 'user' }),
      })
    ).toBe('alice');
  });

  it('routes Group incoming messages to their local author', () => {
    expect(resolve({ message: message({ from: 'alice', to: 'user' }) })).toBe('alice');
  });

  it('routes Group user messages to their valid local recipient', () => {
    expect(
      resolve({ message: message({ from: 'user', to: 'bob', source: 'user_sent' }) })
    ).toBe('bob');
  });

  it('does not mistake a dotted local member name for a cross-team route', () => {
    expect(resolve({ message: message({ from: 'ops.alice', to: 'user' }) })).toBe('ops.alice');
  });

  it('leaves removed and unknown local recipients unresolved', () => {
    expect(
      resolve({
        message: message({ from: 'user', to: 'bob', source: 'user_sent' }),
        availableMembers: [{ name: 'alice' }],
      })
    ).toBe('');
    expect(resolve({ message: message({ from: 'ghost', to: 'user' }) })).toBe('');
  });

  it.each([
    message({ from: 'alice', source: 'cross_team' }),
    message({ from: 'user', to: 'other.bob', source: 'cross_team_sent' }),
    message({
      from: 'alice',
      text: '<cross-team from="other.alice" depth="0" />\nhello',
    }),
    message({ from: 'user', to: 'other.bob', source: 'user_sent' }),
  ])('leaves cross-team and ambiguous qualified routes unresolved', (candidate) => {
    expect(resolve({ message: candidate })).toBe('');
  });
});
