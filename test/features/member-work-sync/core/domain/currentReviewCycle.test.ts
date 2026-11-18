import { resolveCurrentReviewCycle } from '@features/member-work-sync/core/domain/currentReviewCycle';
import { describe, expect, it } from 'vitest';

describe('current review cycle terminal events', () => {
  const first = { id: 'request-1', type: 'review_requested', to: 'review',
    reviewer: 'alice', timestamp: '2026-11-16T00:00:00.000Z' };
  const started = { id: 'started-1', type: 'review_started', to: 'review',
    actor: 'alice', timestamp: '2026-11-16T00:01:00.000Z' };

  it.each(['review_completed', 'human_approved'] as const)(
    'closes reviewer obligations on %s even if a stale task projection still says review',
    (type) => {
      expect(resolveCurrentReviewCycle({
        reviewState: 'review',
        historyEvents: [first, started, {
          id: 'terminal-1', type, to: type === 'review_completed' ? 'reviewed' : 'approved',
          timestamp: '2026-11-16T00:02:00.000Z',
        }],
      })).toBeNull();
    }
  );

  it('admits a new review request after a completed cycle without reusing stale IDs', () => {
    const cycle = resolveCurrentReviewCycle({
      reviewState: 'review',
      historyEvents: [
        first,
        started,
        { id: 'completed-1', type: 'review_completed', to: 'reviewed',
          timestamp: '2026-11-16T00:02:00.000Z' },
        { id: 'request-2', type: 'review_requested', to: 'review', reviewer: 'alice',
          timestamp: '2026-11-16T00:03:00.000Z' },
      ],
    });
    expect(cycle?.reviewRequestEventId).toBe('request-2');
    expect(cycle?.historyEventIds).toEqual(['request-2']);
  });
});
