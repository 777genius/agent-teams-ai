import { describe, expect, it } from 'vitest';

import {
  formatCrossTeamPrefix,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';

describe('crossTeam protocol helpers', () => {
  it('parses canonical cross-team prefix metadata', () => {
    const parsed = parseCrossTeamPrefix(
      '<cross-team from="dream-team.team-lead" depth="0" conversationId="conv-1" replyToConversationId="conv-0" />\nHello'
    );

    expect(parsed).toEqual({
      from: 'dream-team.team-lead',
      chainDepth: 0,
      conversationId: 'conv-1',
      replyToConversationId: 'conv-0',
    });
  });

  it('strips canonical prefix from UI text', () => {
    expect(
      stripCrossTeamPrefix('<cross-team from="a.b" depth="0" conversationId="conv-1" />\nHello')
    ).toBe('Hello');
  });

  it('parseCrossTeamAttributes regex: parses attr="value" pairs', () => {
    const text = formatCrossTeamPrefix('team.user', 0, {
      conversationId: 'c1',
      replyToConversationId: 'c0',
    });
    const parsed = parseCrossTeamPrefix(text + '\nbody');
    expect(parsed).not.toBeNull();
    expect(parsed!.from).toBe('team.user');
    expect(parsed!.conversationId).toBe('c1');
    expect(parsed!.replyToConversationId).toBe('c0');
  });

  it('handles depth attribute', () => {
    const parsed = parseCrossTeamPrefix(
      '<cross-team from="a.b" depth="2" />\nHi'
    );
    expect(parsed?.chainDepth).toBe(2);
  });
});
