import { describe, expect, it } from 'vitest';

import { buildGraphMemberNodeId } from './graphOwnerIdentity';

describe('buildGraphMemberNodeId', () => {
  it('normalizes surrounding whitespace in identity parts', () => {
    expect(buildGraphMemberNodeId(' team-alpha ', ' owner-1 ')).toBe('member:team-alpha:owner-1');
  });

  it.each([
    ['', 'owner-1'],
    ['team-alpha', '  '],
  ])('rejects an incomplete identity', (teamName, ownerId) => {
    expect(() => buildGraphMemberNodeId(teamName, ownerId)).toThrow(
      'Graph member node identity requires a team and owner'
    );
  });
});
