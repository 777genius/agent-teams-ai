import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeTeamWatchScope,
  markTeamEngaged,
  notifyTeamWatchScopeChanged,
  resetTeamWatchScopeForTests,
  setAliveTeamsProvider,
  setTeamWatchScopeChangeListener,
} from '../../../../src/main/services/infrastructure/teamWatchScope';

const FIVE_MIN = 5 * 60_000;

afterEach(() => {
  resetTeamWatchScopeForTests();
});

describe('teamWatchScope', () => {
  it('includes alive teams from the provider', () => {
    setAliveTeamsProvider(() => ['t-alive']);
    expect([...computeTeamWatchScope(1000)]).toContain('t-alive');
  });

  it('includes engaged teams within TTL and prunes after expiry', () => {
    markTeamEngaged('t-eng', 0);
    expect(computeTeamWatchScope(FIVE_MIN).has('t-eng')).toBe(true);
    expect(computeTeamWatchScope(FIVE_MIN + 1).has('t-eng')).toBe(false);
    // pruning is sticky: it stays out without re-engaging
    expect(computeTeamWatchScope(FIVE_MIN + 2).has('t-eng')).toBe(false);
  });

  it('unions alive and engaged teams', () => {
    setAliveTeamsProvider(() => ['a']);
    markTeamEngaged('b', 0);
    const scope = computeTeamWatchScope(1000);
    expect(scope.has('a')).toBe(true);
    expect(scope.has('b')).toBe(true);
  });

  it('notifies the listener only when engagement newly adds to scope', () => {
    const listener = vi.fn();
    setTeamWatchScopeChangeListener(listener);
    markTeamEngaged('x', 0);
    expect(listener).toHaveBeenCalledTimes(1);
    markTeamEngaged('x', 1000); // already in scope -> no extra churn
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when engaging an already-alive (in-scope) team', () => {
    setAliveTeamsProvider(() => ['y']);
    const listener = vi.fn();
    setTeamWatchScopeChangeListener(listener);
    markTeamEngaged('y', 0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('can notify after alive team scope changes outside engagement', () => {
    const listener = vi.fn();
    setTeamWatchScopeChangeListener(listener);
    notifyTeamWatchScopeChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing alive provider (watcher falls back safely)', () => {
    setAliveTeamsProvider(() => {
      throw new Error('boom');
    });
    expect(() => computeTeamWatchScope(0)).not.toThrow();
    expect([...computeTeamWatchScope(0)]).toEqual([]);
  });

  it('ignores empty team names', () => {
    const listener = vi.fn();
    setTeamWatchScopeChangeListener(listener);
    markTeamEngaged('', 0);
    expect(listener).not.toHaveBeenCalled();
    expect(computeTeamWatchScope(0).size).toBe(0);
  });
});
