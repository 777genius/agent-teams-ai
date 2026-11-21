import { createRequire } from 'node:module';

import { getCurrentReviewStage } from '@shared/utils/taskHistory';
import { describe, expect, it } from 'vitest';

import type { TaskHistoryEvent } from '@shared/types';

const controller = createRequire(import.meta.url)(
  '../../agent-teams-controller/src/internal/reviewState.js'
) as { getCurrentReviewStage: (task: { historyEvents: unknown[] }) => string | null };

const at = (n: number): string => new Date(Date.UTC(2026, 10, 17, 0, n)).toISOString();
const requested = (n: number, extra: Partial<TaskHistoryEvent> = {}): TaskHistoryEvent =>
  ({
    id: `r${n}`,
    type: 'review_requested',
    from: 'none',
    to: 'review',
    timestamp: at(n),
    ...extra,
  }) as TaskHistoryEvent;

describe('getCurrentReviewStage', () => {
  it('tells the lead sign-off cycle apart from a regular reviewer cycle', () => {
    expect(getCurrentReviewStage({ historyEvents: [requested(1)] })).toBe('reviewer');
    expect(
      getCurrentReviewStage({
        historyEvents: [requested(1), requested(2, { stage: 'lead_signoff' } as never)],
      })
    ).toBe('lead_signoff');
  });

  it('reports no open cycle once the cycle is decided or the work restarts', () => {
    const signoff = requested(2, { stage: 'lead_signoff' } as never);
    const completed = {
      id: 'c3',
      type: 'review_completed',
      from: 'review',
      to: 'reviewed',
      reviewRequestId: 'r2',
      timestamp: at(3),
    } as TaskHistoryEvent;
    const restarted = {
      id: 's4',
      type: 'status_changed',
      from: 'completed',
      to: 'in_progress',
      timestamp: at(4),
    } as TaskHistoryEvent;
    expect(getCurrentReviewStage({ historyEvents: [signoff, completed] })).toBeNull();
    expect(getCurrentReviewStage({ historyEvents: [signoff, restarted] })).toBeNull();
    expect(getCurrentReviewStage({ historyEvents: [] })).toBeNull();
  });
});

describe('getCurrentReviewStage parity with the controller', () => {
  it('answers the same for every history shape', () => {
    const lead = requested(2, { stage: 'lead_signoff' } as never);
    const decided = (type: string, to: string): TaskHistoryEvent =>
      ({ id: `d-${type}`, type, from: 'review', to, timestamp: at(3) }) as TaskHistoryEvent;
    const status = (to: string): TaskHistoryEvent =>
      ({ id: `s-${to}`, type: 'status_changed', from: 'completed', to, timestamp: at(4) }) as TaskHistoryEvent;
    const shapes: TaskHistoryEvent[][] = [
      [],
      [requested(1)],
      [requested(1), lead],
      [lead, decided('review_completed', 'reviewed')],
      [lead, decided('review_changes_requested', 'needsFix')],
      [lead, decided('human_approved', 'approved')],
      [lead, status('in_progress')],
      [lead, status('pending')],
      [lead, status('deleted')],
      [requested(1), lead, requested(5)],
    ];
    for (const historyEvents of shapes) {
      expect(getCurrentReviewStage({ historyEvents })).toBe(
        controller.getCurrentReviewStage({ historyEvents })
      );
    }
  });
});
