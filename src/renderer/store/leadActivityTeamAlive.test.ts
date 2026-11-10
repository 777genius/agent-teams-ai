import { describe, expect, it } from 'vitest';

import { nextTeamAliveFromLeadActivity } from './leadActivityTeamAlive';

describe('nextTeamAliveFromLeadActivity', () => {
  it('does not resurrect a stopped team from leftover idle lead activity', () => {
    expect(nextTeamAliveFromLeadActivity(false, 'idle')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(undefined, 'idle')).toBeUndefined();
  });

  it('heals a stale dead snapshot when lead is actively running', () => {
    expect(nextTeamAliveFromLeadActivity(false, 'active')).toBe(true);
    expect(nextTeamAliveFromLeadActivity(undefined, 'active')).toBe(true);
  });

  it('marks the team dead only when lead activity is offline', () => {
    expect(nextTeamAliveFromLeadActivity(true, 'offline')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(undefined, 'offline')).toBe(false);
    expect(nextTeamAliveFromLeadActivity(true, 'idle')).toBe(true);
  });
});
