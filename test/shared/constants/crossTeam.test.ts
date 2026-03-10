import { describe, expect, it } from 'vitest';

import { parseCrossTeamPrefix, stripCrossTeamPrefix } from '@shared/constants/crossTeam';

describe('crossTeam protocol helpers', () => {
  it('parses canonical cross-team prefix metadata', () => {
    const parsed = parseCrossTeamPrefix(
      '[Cross-team from dream-team.team-lead | depth:0 | conversation:conv-1 | replyTo:conv-0]\nHello'
    );

    expect(parsed).toEqual({
      from: 'dream-team.team-lead',
      chainDepth: 0,
      conversationId: 'conv-1',
      replyToConversationId: 'conv-0',
    });
  });

  it('strips canonical prefix from UI text', () => {
    expect(stripCrossTeamPrefix('[Cross-team from a.b | depth:0 | conversation:conv-1]\nHello')).toBe(
      'Hello'
    );
  });
});
