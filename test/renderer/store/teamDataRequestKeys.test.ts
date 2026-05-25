import { describe, expect, it } from 'vitest';

import {
  getFullTeamDataRequestKey,
  getTeamDataRequestKey,
  getTeamDataRequestLabel,
  getTeamDataSnapshotMode,
  getThinTeamDataRequestKey,
  isTeamDataRequestKeyForTeam,
  normalizeTeamGetDataOptions,
  shouldIncludeMemberBranches,
} from '../../../src/renderer/store/team/teamDataRequestKeys';

describe('teamDataRequestKeys', () => {
  it('normalizes only the thin snapshot option and treats all other inputs as full snapshots', () => {
    expect(normalizeTeamGetDataOptions()).toBeUndefined();
    expect(normalizeTeamGetDataOptions({})).toBeUndefined();
    expect(normalizeTeamGetDataOptions({ includeMemberBranches: true })).toBeUndefined();
    expect(normalizeTeamGetDataOptions({ includeMemberBranches: false })).toEqual({
      includeMemberBranches: false,
    });

    expect(shouldIncludeMemberBranches()).toBe(true);
    expect(shouldIncludeMemberBranches({ includeMemberBranches: true })).toBe(true);
    expect(shouldIncludeMemberBranches({ includeMemberBranches: false })).toBe(false);
  });

  it('maps normalized request options to stable full and thin snapshot modes', () => {
    expect(getTeamDataSnapshotMode()).toBe('full');
    expect(getTeamDataSnapshotMode({ includeMemberBranches: true })).toBe('full');
    expect(getTeamDataSnapshotMode({ includeMemberBranches: false })).toBe('thin');
  });

  it('builds request keys that preserve the existing null-separated team/mode contract', () => {
    expect(getTeamDataRequestKey('my-team')).toBe('my-team\u0000mode:full');
    expect(getTeamDataRequestKey('my-team', { includeMemberBranches: true })).toBe(
      'my-team\u0000mode:full'
    );
    expect(getTeamDataRequestKey('my-team', { includeMemberBranches: false })).toBe(
      'my-team\u0000mode:thin'
    );
    expect(getFullTeamDataRequestKey('my-team')).toBe('my-team\u0000mode:full');
    expect(getThinTeamDataRequestKey('my-team')).toBe('my-team\u0000mode:thin');
  });

  it('builds timeout/debug labels from the same normalized mode policy', () => {
    expect(getTeamDataRequestLabel('my-team')).toBe('team:getData(my-team,mode=full)');
    expect(getTeamDataRequestLabel('my-team', { includeMemberBranches: false })).toBe(
      'team:getData(my-team,mode=thin)'
    );
  });

  it('matches request keys only for the exact team prefix boundary', () => {
    expect(isTeamDataRequestKeyForTeam('my-team\u0000mode:full', 'my-team')).toBe(true);
    expect(isTeamDataRequestKeyForTeam('my-team-extra\u0000mode:full', 'my-team')).toBe(false);
    expect(isTeamDataRequestKeyForTeam('my-team', 'my-team')).toBe(false);
  });
});
