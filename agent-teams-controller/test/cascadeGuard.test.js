const cascadeGuard = require('../src/internal/cascadeGuard.js');

describe('cascadeGuard', () => {
  beforeEach(() => {
    cascadeGuard.reset();
  });

  describe('rate limit', () => {
    it('allows up to 10 messages per minute', () => {
      for (let i = 0; i < 10; i++) {
        cascadeGuard.check('team-a', `team-${i}`, 0);
        cascadeGuard.record('team-a', `team-${i}`);
      }
      expect(() => cascadeGuard.check('team-a', 'team-x', 0)).toThrow('rate limit');
    });
  });

  describe('chain depth', () => {
    it('allows depth 0 through 4', () => {
      for (let d = 0; d < 5; d++) {
        expect(() => cascadeGuard.check('team-a', 'team-b', d)).not.toThrow();
      }
    });

    it('rejects depth >= 5', () => {
      expect(() => cascadeGuard.check('team-a', 'team-b', 5)).toThrow('chain depth');
    });
  });

  describe('pair cooldown', () => {
    it('rejects same pair within 3s', () => {
      cascadeGuard.check('team-a', 'team-b', 0);
      cascadeGuard.record('team-a', 'team-b');

      expect(() => cascadeGuard.check('team-a', 'team-b', 0)).toThrow('cooldown');
    });

    it('allows different pairs simultaneously', () => {
      cascadeGuard.check('team-a', 'team-b', 0);
      cascadeGuard.record('team-a', 'team-b');

      expect(() => cascadeGuard.check('team-a', 'team-c', 0)).not.toThrow();
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      for (let i = 0; i < 10; i++) {
        cascadeGuard.check('team-a', `team-${i}`, 0);
        cascadeGuard.record('team-a', `team-${i}`);
      }

      cascadeGuard.reset();

      expect(() => cascadeGuard.check('team-a', 'team-0', 0)).not.toThrow();
    });
  });
});
