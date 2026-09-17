import { describe, expect, it } from 'vitest';

import { nextTeamAliveFromLeadActivity } from './leadActivityTeamAlive';

describe('nextTeamAliveFromLeadActivity', () => {
  it('does not resurrect a stopped team from idle or active lead activity', () => {
    expect(nextTeamAliveFromLeadActivity(false, 'idle')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(false, 'active')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(undefined, 'idle')).toBeUndefined();
  });

  it('marks the team dead only when lead activity is offline', () => {
    expect(nextTeamAliveFromLeadActivity(true, 'offline')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(undefined, 'offline')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(true, 'idle')).toBe(true);
  });
});
