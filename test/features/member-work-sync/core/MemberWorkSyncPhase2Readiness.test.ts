import { describe, expect, it } from 'vitest';

import { assessMemberWorkSyncPhase2Readiness } from '@features/member-work-sync/core/domain';
import type { MemberWorkSyncMetricEvent } from '@features/member-work-sync/contracts';

function event(
  index: number,
  kind: MemberWorkSyncMetricEvent['kind'],
  recordedAt: string
): MemberWorkSyncMetricEvent {
  return {
    id: `event-${index}-${kind}`,
    teamName: 'team-a',
    memberName: index % 2 === 0 ? 'bob' : 'alice',
    kind,
    state: 'needs_sync',
    agendaFingerprint: `agenda:v1:${index}`,
    recordedAt,
    actionableCount: 1,
  };
}

function statusEvents(count: number, start = Date.parse('2026-04-29T00:00:00.000Z')) {
  return Array.from({ length: count }, (_, index) =>
    event(index, 'status_evaluated', new Date(start + index * 6 * 60_000).toISOString())
  );
}

describe('assessMemberWorkSyncPhase2Readiness', () => {
  it('keeps Phase 2 collecting until enough shadow data exists', () => {
    const assessment = assessMemberWorkSyncPhase2Readiness({
      memberCount: 0,
      recentEvents: [],
    });

    expect(assessment.state).toBe('collecting_shadow_data');
    expect(assessment.reasons).toEqual([
      'insufficient_members',
      'insufficient_status_events',
      'insufficient_observation_window',
    ]);
  });

  it('reports shadow-ready only when sample size and rates are acceptable', () => {
    const assessment = assessMemberWorkSyncPhase2Readiness({
      memberCount: 2,
      recentEvents: statusEvents(24),
    });

    expect(assessment.state).toBe('shadow_ready');
    expect(assessment.reasons).toEqual([]);
    expect(assessment.rates.statusEventCount).toBe(24);
    expect(assessment.rates.observationHours).toBeGreaterThan(1);
  });

  it('blocks Phase 2 when would-nudge or fingerprint churn rates are too high', () => {
    const base = statusEvents(24);
    const noisyEvents = [
      ...base,
      ...base
        .slice(0, 8)
        .map((source, index) => event(100 + index, 'would_nudge', source.recordedAt)),
      ...base
        .slice(0, 5)
        .map((source, index) => event(200 + index, 'fingerprint_changed', source.recordedAt)),
    ];

    const assessment = assessMemberWorkSyncPhase2Readiness({
      memberCount: 1,
      recentEvents: noisyEvents,
    });

    expect(assessment.state).toBe('blocked');
    expect(assessment.reasons).toContain('would_nudge_rate_high');
    expect(assessment.reasons).toContain('fingerprint_churn_high');
  });
});
