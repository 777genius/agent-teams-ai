import { describe, expect, it } from 'vitest';

import {
  doesRuntimeFreshnessSnapshotExtendVisible,
  doesRuntimeFreshnessTimestampExtendVisible,
  parseRuntimeFreshnessTimestampMs,
} from '../../../../../src/features/team-provisioning/core/domain/teamRuntimeFreshnessPolicy';

import type { TeamAgentRuntimeSnapshot } from '@shared/types';

function runtimeSnapshot(
  updatedAt: string | undefined,
  runtimeLastSeenAt: string | undefined = updatedAt
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'sandbox-team',
    runId: 'run-1',
    updatedAt: updatedAt ?? '',
    members: {
      alice: {
        memberName: 'alice',
        alive: true,
        restartable: true,
        backendType: 'process',
        updatedAt: updatedAt ?? '',
        runtimeLastSeenAt,
      },
    },
  };
}

describe('teamRuntimeFreshnessPolicy', () => {
  it('parses valid timestamps and rejects missing or invalid values', () => {
    expect(parseRuntimeFreshnessTimestampMs(undefined)).toBeNull();
    expect(parseRuntimeFreshnessTimestampMs('not-a-date')).toBeNull();
    expect(parseRuntimeFreshnessTimestampMs('2026-07-24T10:00:00.000Z')).toBe(
      Date.parse('2026-07-24T10:00:00.000Z')
    );
  });

  it('allows only monotonic valid freshness timestamps', () => {
    expect(
      doesRuntimeFreshnessTimestampExtendVisible(
        '2026-07-24T10:00:00.000Z',
        '2026-07-24T10:00:01.000Z'
      )
    ).toBe(true);
    expect(
      doesRuntimeFreshnessTimestampExtendVisible(
        '2026-07-24T10:00:01.000Z',
        '2026-07-24T10:00:00.000Z'
      )
    ).toBe(false);
    expect(doesRuntimeFreshnessTimestampExtendVisible(undefined, undefined)).toBe(true);
    expect(doesRuntimeFreshnessTimestampExtendVisible('2026-07-24T10:00:00.000Z', undefined)).toBe(
      false
    );
  });

  it('requires exact equality when either timestamp is invalid', () => {
    expect(doesRuntimeFreshnessTimestampExtendVisible('unknown', 'unknown')).toBe(true);
    expect(doesRuntimeFreshnessTimestampExtendVisible('unknown', 'also-unknown')).toBe(false);
  });

  it('requires semantic equality and monotonic snapshot and member freshness', () => {
    const visible = runtimeSnapshot('2026-07-24T10:00:00.000Z');
    const cached = runtimeSnapshot('2026-07-24T10:00:01.000Z');

    expect(doesRuntimeFreshnessSnapshotExtendVisible(visible, cached, () => true)).toBe(true);
    expect(doesRuntimeFreshnessSnapshotExtendVisible(visible, cached, () => false)).toBe(false);
    expect(
      doesRuntimeFreshnessSnapshotExtendVisible(
        visible,
        runtimeSnapshot('2026-07-24T10:00:01.000Z', '2026-07-24T09:59:59.000Z'),
        () => true
      )
    ).toBe(false);
  });
});
