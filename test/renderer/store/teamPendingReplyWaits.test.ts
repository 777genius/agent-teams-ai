import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAllPendingReplyRefreshWaits,
  clearPendingReplyRefreshWaits,
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
  setPendingReplyRefreshEnabled,
} from '../../../src/renderer/store/team/teamPendingReplyWaits';

afterEach(() => {
  clearAllPendingReplyRefreshWaits();
});

describe('teamPendingReplyWaits', () => {
  it('tracks active teams with at least one enabled source', () => {
    expect(setPendingReplyRefreshEnabled('my-team', 'tab-a', true)).toBe(true);
    expect(setPendingReplyRefreshEnabled('other-team', 'tab-b', true)).toBe(true);

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(true);
    expect(hasActiveTeamPendingReplyWait('other-team')).toBe(true);
    expect(getActiveTeamPendingReplyWaits()).toEqual(new Set(['my-team', 'other-team']));
  });

  it('keeps a team active until the last source is disabled', () => {
    setPendingReplyRefreshEnabled('my-team', 'tab-a', true);
    setPendingReplyRefreshEnabled('my-team', 'tab-b', true);

    expect(setPendingReplyRefreshEnabled('my-team', 'tab-b', false)).toBe(true);
    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(true);
    expect(getActiveTeamPendingReplyWaits()).toEqual(new Set(['my-team']));

    expect(setPendingReplyRefreshEnabled('my-team', 'tab-a', false)).toBe(false);
    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(false);
    expect(getActiveTeamPendingReplyWaits().size).toBe(0);
  });

  it('is idempotent for repeated enables from the same source', () => {
    setPendingReplyRefreshEnabled('my-team', 'tab-a', true);
    setPendingReplyRefreshEnabled('my-team', 'tab-a', true);

    expect(setPendingReplyRefreshEnabled('my-team', 'tab-a', false)).toBe(false);
    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(false);
  });

  it('returns false when disabling a source that has no active wait', () => {
    expect(setPendingReplyRefreshEnabled('missing-team', 'tab-a', false)).toBe(false);
    expect(getActiveTeamPendingReplyWaits().size).toBe(0);
  });

  it('clears waits by team or globally', () => {
    setPendingReplyRefreshEnabled('my-team', 'tab-a', true);
    setPendingReplyRefreshEnabled('other-team', 'tab-b', true);

    clearPendingReplyRefreshWaits('my-team');

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(false);
    expect(getActiveTeamPendingReplyWaits()).toEqual(new Set(['other-team']));

    clearAllPendingReplyRefreshWaits();

    expect(hasActiveTeamPendingReplyWait('other-team')).toBe(false);
    expect(getActiveTeamPendingReplyWaits().size).toBe(0);
  });
});
