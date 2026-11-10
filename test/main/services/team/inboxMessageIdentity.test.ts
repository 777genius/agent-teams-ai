import { describe, expect, it } from 'vitest';

import {
  buildLegacyInboxMessageId,
  getEffectiveInboxMessageId,
} from '../../../../src/main/services/team/inboxMessageIdentity';

describe('inboxMessageIdentity', () => {
  it('preserves explicit persisted messageId verbatim when present', () => {
    expect(
      getEffectiveInboxMessageId({
        messageId: '  explicit-id  ',
        from: 'alice',
        timestamp: '2026-04-08T12:00:00.000Z',
        text: 'hello',
      })
    ).toBe('  explicit-id  ');
  });

  it('builds legacy fallback identity from raw persisted fields only', () => {
    const row = {
      from: 'alice',
      timestamp: '2026-04-08T12:00:00.000Z',
      text: 'line 1\nline 2  ',
      summary: 'ignored',
      read: false,
      source: 'system_notification',
    };

    expect(getEffectiveInboxMessageId(row)).toBe(
      buildLegacyInboxMessageId(row.from, row.timestamp, row.text)
    );
  });

  it('preserves embedded newlines and whitespace in fallback-id inputs', () => {
    const base = {
      from: 'alice',
      timestamp: '2026-04-08T12:00:00.000Z',
      text: 'line 1\nline 2',
    };
    const padded = {
      ...base,
      text: 'line 1\nline 2 ',
    };

    expect(getEffectiveInboxMessageId(base)).not.toBe(getEffectiveInboxMessageId(padded));
  });

  it('returns null when persisted messageId is absent and raw identity inputs are incomplete', () => {
    expect(
      getEffectiveInboxMessageId({
        from: 'alice',
        text: 'missing timestamp',
      })
    ).toBeNull();
  });
});
