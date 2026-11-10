import { afterEach, describe, expect, it } from 'vitest';

import {
  captureTeamLocalStateEpoch,
  clearAllTeamLocalStateEpochs,
  clearTeamLocalStateEpoch,
  hasTeamLocalStateEpoch,
  invalidateTeamLocalStateEpoch,
  isTeamLocalStateEpochCurrent,
} from '../../../src/renderer/store/team/teamLocalStateEpoch';

afterEach(() => {
  clearAllTeamLocalStateEpochs();
});

describe('teamLocalStateEpoch', () => {
  it('starts missing teams at epoch zero without materializing an entry', () => {
    expect(captureTeamLocalStateEpoch('my-team')).toBe(0);
    expect(isTeamLocalStateEpochCurrent('my-team', 0)).toBe(true);
    expect(hasTeamLocalStateEpoch('my-team')).toBe(false);
  });

  it('increments epochs independently per team', () => {
    invalidateTeamLocalStateEpoch('my-team');
    invalidateTeamLocalStateEpoch('my-team');
    invalidateTeamLocalStateEpoch('other-team');

    expect(captureTeamLocalStateEpoch('my-team')).toBe(2);
    expect(captureTeamLocalStateEpoch('other-team')).toBe(1);
    expect(isTeamLocalStateEpochCurrent('my-team', 1)).toBe(false);
    expect(isTeamLocalStateEpochCurrent('my-team', 2)).toBe(true);
  });

  it('clears one team epoch without touching other teams', () => {
    invalidateTeamLocalStateEpoch('my-team');
    invalidateTeamLocalStateEpoch('other-team');

    clearTeamLocalStateEpoch('my-team');

    expect(captureTeamLocalStateEpoch('my-team')).toBe(0);
    expect(hasTeamLocalStateEpoch('my-team')).toBe(false);
    expect(captureTeamLocalStateEpoch('other-team')).toBe(1);
    expect(hasTeamLocalStateEpoch('other-team')).toBe(true);
  });

  it('clears all materialized epochs', () => {
    invalidateTeamLocalStateEpoch('my-team');
    invalidateTeamLocalStateEpoch('other-team');

    clearAllTeamLocalStateEpochs();

    expect(hasTeamLocalStateEpoch('my-team')).toBe(false);
    expect(hasTeamLocalStateEpoch('other-team')).toBe(false);
    expect(captureTeamLocalStateEpoch('my-team')).toBe(0);
    expect(captureTeamLocalStateEpoch('other-team')).toBe(0);
  });
});
