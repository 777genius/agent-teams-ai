import { isForbiddenTeamRole } from '@renderer/constants/teamRoles';
import { describe, expect, it } from 'vitest';

describe('isForbiddenTeamRole', () => {
  it('reserves canonical lead roles with normalized whitespace', () => {
    expect(isForbiddenTeamRole(' Team   Lead ')).toBe(true);
    expect(isForbiddenTeamRole('Lead Developer')).toBe(false);
  });
});
