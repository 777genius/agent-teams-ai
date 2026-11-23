import { describe, expect, it } from 'vitest';

import { consumeTeamCopySeedOnce } from './createTeamCopySeed';

describe('team creation copy seed', () => {
  it('applies a seed once across pane remounts, but accepts a new explicit copy', () => {
    const first = { teamName: 'copy', members: [] };
    expect(consumeTeamCopySeedOnce(first)).toBe(true);
    expect(consumeTeamCopySeedOnce(first)).toBe(false);
    expect(consumeTeamCopySeedOnce({ teamName: 'copy', members: [] })).toBe(true);
  });

  it.each(['shared', 'per_project'] as const)(
    'does not reapply %s history after the editor or seed changes',
    (projectContextMode) => {
      const seed = { teamName: 'copy', members: [], projectContextMode };
      expect(consumeTeamCopySeedOnce(seed)).toBe(true);
      seed.projectContextMode = projectContextMode === 'shared' ? 'per_project' : 'shared';
      expect(consumeTeamCopySeedOnce(seed)).toBe(false);
      expect(consumeTeamCopySeedOnce({ ...seed })).toBe(true);
    }
  );
});
