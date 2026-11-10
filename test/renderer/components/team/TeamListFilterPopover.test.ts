import {
  getTeamListFilterActiveCount,
  isTeamProjectPathSelected,
} from '@renderer/components/team/TeamListFilterPopover';
import { describe, expect, it } from 'vitest';

describe('TeamListFilterPopover helpers', () => {
  it('counts project priority as an active filter', () => {
    expect(
      getTeamListFilterActiveCount({ selectedStatuses: new Set() }, '/Users/test/project')
    ).toBe(1);
  });

  it('counts status and project priority independently', () => {
    expect(
      getTeamListFilterActiveCount(
        { selectedStatuses: new Set(['running']) },
        '/Users/test/project'
      )
    ).toBe(2);
  });

  it('compares selected project paths with path normalization', () => {
    expect(isTeamProjectPathSelected('/Users/test/project/', '/users/test/project')).toBe(true);
  });
});
