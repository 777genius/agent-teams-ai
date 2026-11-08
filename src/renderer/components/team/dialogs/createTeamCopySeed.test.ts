import { describe, expect, it } from 'vitest';

import { consumeTeamCopySeedOnce } from './createTeamCopySeed';

describe('team creation copy seed', () => {
  it('applies a seed once across pane remounts, but accepts a new explicit copy', () => {
    const first = { teamName: 'copy', members: [] };
    expect(consumeTeamCopySeedOnce(first)).toBe(true);
    expect(consumeTeamCopySeedOnce(first)).toBe(false);
    expect(consumeTeamCopySeedOnce({ teamName: 'copy', members: [] })).toBe(true);
  });
});
