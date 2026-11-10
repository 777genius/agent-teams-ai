import { describe, expect, it } from 'vitest';

import {
  getTeamLoadingMemberSkeletonCount,
  teamLoadingMemberSkeletonAccents,
} from './teamLoadingMemberSkeleton';

describe('getTeamLoadingMemberSkeletonCount', () => {
  it('returns 0 when the team summary is unknown', () => {
    expect(getTeamLoadingMemberSkeletonCount(undefined)).toBe(0);
  });

  it('counts the lead plus teammates, matching the messages roster', () => {
    expect(
      getTeamLoadingMemberSkeletonCount({
        leadName: 'team-lead',
        memberCount: 3,
        members: [{ name: 'alice' }, { name: 'cody' }, { name: 'oscar' }],
      })
    ).toBe(4);
  });

  it('does not invent extra placeholder members beyond the known roster', () => {
    expect(
      getTeamLoadingMemberSkeletonCount({
        leadName: 'team-lead',
        memberCount: 3,
      })
    ).toBe(4);
    expect(teamLoadingMemberSkeletonAccents(4)).toEqual([
      '#46d93b',
      '#3b82f6',
      '#facc15',
      '#14b8a6',
    ]);
  });

  it('still shows a solo lead', () => {
    expect(getTeamLoadingMemberSkeletonCount({ leadName: 'team-lead', memberCount: 0 })).toBe(1);
  });
});
