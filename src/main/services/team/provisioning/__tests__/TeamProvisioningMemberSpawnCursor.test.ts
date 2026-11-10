import { describe, expect, it } from 'vitest';

import {
  compareMemberSpawnInboxCursor,
  isMemberSpawnHeartbeatTimestampNewer,
  maxMemberSpawnInboxCursor,
  toMemberSpawnInboxCursor,
} from '../TeamProvisioningMemberSpawnCursor';

const iso = (value: string): string => value;

describe('TeamProvisioningMemberSpawnCursor', () => {
  describe('compareMemberSpawnInboxCursor', () => {
    it('orders by timestamp when both are valid and differ', () => {
      const earlier = { timestamp: iso('2026-01-01T00:00:00.000Z'), messageId: 'b' };
      const later = { timestamp: iso('2026-01-01T00:00:01.000Z'), messageId: 'a' };
      expect(compareMemberSpawnInboxCursor(earlier, later)).toBeLessThan(0);
      expect(compareMemberSpawnInboxCursor(later, earlier)).toBeGreaterThan(0);
    });

    it('falls back to messageId when timestamps are equal', () => {
      const a = { timestamp: iso('2026-01-01T00:00:00.000Z'), messageId: 'a' };
      const b = { timestamp: iso('2026-01-01T00:00:00.000Z'), messageId: 'b' };
      expect(compareMemberSpawnInboxCursor(a, b)).toBeLessThan(0);
      expect(compareMemberSpawnInboxCursor(b, a)).toBeGreaterThan(0);
      expect(compareMemberSpawnInboxCursor(a, { ...a })).toBe(0);
    });

    it('treats a valid timestamp as ordering before an invalid one', () => {
      const valid = { timestamp: iso('2026-01-01T00:00:00.000Z'), messageId: 'a' };
      const invalid = { timestamp: 'not-a-date', messageId: 'a' };
      expect(compareMemberSpawnInboxCursor(valid, invalid)).toBeLessThan(0);
      expect(compareMemberSpawnInboxCursor(invalid, valid)).toBeGreaterThan(0);
    });

    it('falls back to messageId when both timestamps are invalid', () => {
      const a = { timestamp: 'x', messageId: 'a' };
      const b = { timestamp: 'y', messageId: 'b' };
      expect(compareMemberSpawnInboxCursor(a, b)).toBeLessThan(0);
    });
  });

  describe('toMemberSpawnInboxCursor', () => {
    it('builds a cursor from a message with a messageId', () => {
      expect(
        toMemberSpawnInboxCursor({ timestamp: '2026-01-01T00:00:00.000Z', messageId: '  m1  ' })
      ).toEqual({ timestamp: '2026-01-01T00:00:00.000Z', messageId: 'm1' });
    });

    it('returns null when the messageId is missing or blank', () => {
      expect(toMemberSpawnInboxCursor({ timestamp: 't', messageId: '' })).toBeNull();
      expect(toMemberSpawnInboxCursor({ timestamp: 't', messageId: '   ' })).toBeNull();
      expect(
        toMemberSpawnInboxCursor({ timestamp: 't', messageId: undefined as unknown as string })
      ).toBeNull();
    });
  });

  describe('maxMemberSpawnInboxCursor', () => {
    it('returns the incoming cursor when no previous cursor exists', () => {
      const right = { timestamp: '2026-01-01T00:00:00.000Z', messageId: 'a' };
      expect(maxMemberSpawnInboxCursor(undefined, right)).toBe(right);
    });

    it('keeps the greater of the two cursors', () => {
      const older = { timestamp: '2026-01-01T00:00:00.000Z', messageId: 'a' };
      const newer = { timestamp: '2026-01-01T00:00:05.000Z', messageId: 'a' };
      expect(maxMemberSpawnInboxCursor(older, newer)).toBe(newer);
      expect(maxMemberSpawnInboxCursor(newer, older)).toBe(newer);
    });

    it('prefers the existing cursor on an exact tie', () => {
      const left = { timestamp: '2026-01-01T00:00:00.000Z', messageId: 'a' };
      const right = { timestamp: '2026-01-01T00:00:00.000Z', messageId: 'a' };
      expect(maxMemberSpawnInboxCursor(left, right)).toBe(left);
    });
  });

  describe('isMemberSpawnHeartbeatTimestampNewer', () => {
    it('returns false when the incoming timestamp is missing or blank', () => {
      expect(isMemberSpawnHeartbeatTimestampNewer('2026-01-01T00:00:00.000Z', undefined)).toBe(
        false
      );
      expect(isMemberSpawnHeartbeatTimestampNewer('2026-01-01T00:00:00.000Z', '   ')).toBe(false);
    });

    it('returns true when there is no previous timestamp but an incoming one', () => {
      expect(isMemberSpawnHeartbeatTimestampNewer(undefined, '2026-01-01T00:00:00.000Z')).toBe(
        true
      );
      expect(isMemberSpawnHeartbeatTimestampNewer('  ', '2026-01-01T00:00:00.000Z')).toBe(true);
    });

    it('compares numerically when both timestamps are valid dates', () => {
      expect(
        isMemberSpawnHeartbeatTimestampNewer('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
      ).toBe(true);
      expect(
        isMemberSpawnHeartbeatTimestampNewer('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z')
      ).toBe(false);
      expect(
        isMemberSpawnHeartbeatTimestampNewer('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      ).toBe(false);
    });

    it('falls back to string comparison when timestamps are not valid dates', () => {
      expect(isMemberSpawnHeartbeatTimestampNewer('aaa', 'bbb')).toBe(true);
      expect(isMemberSpawnHeartbeatTimestampNewer('bbb', 'aaa')).toBe(false);
    });
  });
});
