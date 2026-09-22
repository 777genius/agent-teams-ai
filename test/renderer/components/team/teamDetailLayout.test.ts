import { resolvePinnedTeamActionTop } from '@renderer/components/team/teamDetailLayout';
import { describe, expect, it } from 'vitest';

describe('resolvePinnedTeamActionTop', () => {
  it('pins below visible header actions', () => {
    expect(resolvePinnedTeamActionTop({ containerTop: 40, headerActionsBottom: 82 })).toBe(90);
  });

  it('uses the container inset when header actions are absent or above it', () => {
    expect(resolvePinnedTeamActionTop({ containerTop: 40 })).toBe(52);
    expect(resolvePinnedTeamActionTop({ containerTop: 40, headerActionsBottom: 30 })).toBe(52);
  });
});
