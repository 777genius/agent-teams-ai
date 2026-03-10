import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CascadeGuard } from '@main/services/team/CascadeGuard';

describe('CascadeGuard', () => {
  let guard: CascadeGuard;

  beforeEach(() => {
    guard = new CascadeGuard();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rate limit', () => {
    it('allows up to 10 messages per minute', () => {
      for (let i = 0; i < 10; i++) {
        guard.check('team-a', `team-${i}`, 0);
        guard.record('team-a', `team-${i}`);
      }
      // 11th should fail
      expect(() => guard.check('team-a', 'team-x', 0)).toThrow('rate limit');
    });

    it('resets after window expires', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 10; i++) {
        guard.check('team-a', `team-${i}`, 0);
        guard.record('team-a', `team-${i}`);
      }

      // Advance 61 seconds
      vi.advanceTimersByTime(61_000);

      // Should succeed now
      expect(() => guard.check('team-a', 'team-new', 0)).not.toThrow();
      vi.useRealTimers();
    });
  });

  describe('chain depth', () => {
    it('allows depth 0 through 4', () => {
      for (let d = 0; d < 5; d++) {
        expect(() => guard.check('team-a', 'team-b', d)).not.toThrow();
      }
    });

    it('rejects depth >= 5', () => {
      expect(() => guard.check('team-a', 'team-b', 5)).toThrow('chain depth');
      expect(() => guard.check('team-a', 'team-b', 10)).toThrow('chain depth');
    });
  });

  describe('pair cooldown', () => {
    it('rejects same pair within 3s', () => {
      guard.check('team-a', 'team-b', 0);
      guard.record('team-a', 'team-b');

      expect(() => guard.check('team-a', 'team-b', 0)).toThrow('cooldown');
    });

    it('allows same pair after 3s', () => {
      vi.useFakeTimers();
      guard.check('team-a', 'team-b', 0);
      guard.record('team-a', 'team-b');

      vi.advanceTimersByTime(3_001);

      expect(() => guard.check('team-a', 'team-b', 0)).not.toThrow();
      vi.useRealTimers();
    });

    it('allows different pairs simultaneously', () => {
      guard.check('team-a', 'team-b', 0);
      guard.record('team-a', 'team-b');

      expect(() => guard.check('team-a', 'team-c', 0)).not.toThrow();
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      for (let i = 0; i < 10; i++) {
        guard.check('team-a', `team-${i}`, 0);
        guard.record('team-a', `team-${i}`);
      }

      guard.reset();

      expect(() => guard.check('team-a', 'team-0', 0)).not.toThrow();
    });
  });
});
