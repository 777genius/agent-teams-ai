import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';
import { describe, expect, it } from 'vitest';

import { resolveTaskMutationWorkflowColumn } from './taskMutationReviewPolicy';

import type { TeamTask } from '@shared/types';

interface LegacyMutationReviewSnapshot {
  status: TeamTask['status'];
  reviewState?: TeamTask['reviewState'];
  historyEvents?: TeamTask['historyEvents'];
  kanbanColumn?: 'review' | 'approved';
}

function resolveLegacyMutationWorkflowColumn(
  snapshot: LegacyMutationReviewSnapshot
): 'review' | 'approved' | undefined {
  const kanbanWorkflowColumn = snapshot.kanbanColumn
    ? getTeamTaskWorkflowColumn({
        status: snapshot.status,
        reviewState: 'none',
        kanbanColumn: snapshot.kanbanColumn,
      })
    : undefined;
  if (kanbanWorkflowColumn) {
    return kanbanWorkflowColumn;
  }

  const reviewState = getReviewStateFromTask(snapshot);
  return getTeamTaskWorkflowColumn({
    status: snapshot.status,
    reviewState,
    ...(snapshot.kanbanColumn ? { kanbanColumn: snapshot.kanbanColumn } : {}),
  });
}

describe('task mutation review policy', () => {
  it.each<{
    name: string;
    snapshot: LegacyMutationReviewSnapshot;
  }>([
    {
      name: 'completed task without review state',
      snapshot: { status: 'completed', reviewState: 'none' },
    },
    {
      name: 'completed task in the review Kanban column',
      snapshot: { status: 'completed', reviewState: 'none', kanbanColumn: 'review' },
    },
    {
      name: 'completed task in the approved Kanban column',
      snapshot: { status: 'completed', reviewState: 'review', kanbanColumn: 'approved' },
    },
    {
      name: 'completed task with explicit review state',
      snapshot: { status: 'completed', reviewState: 'review' },
    },
    {
      name: 'completed task with explicit approved state',
      snapshot: { status: 'completed', reviewState: 'approved' },
    },
    {
      name: 'completed task with a review history event',
      snapshot: {
        status: 'completed',
        reviewState: 'none',
        historyEvents: [
          {
            id: 'event-1',
            type: 'review_started',
            from: 'none',
            to: 'review',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
      },
    },
    {
      name: 'completed task with an approval history event',
      snapshot: {
        status: 'completed',
        reviewState: 'none',
        historyEvents: [
          {
            id: 'event-1',
            type: 'review_approved',
            from: 'review',
            to: 'approved',
            timestamp: '2026-07-30T10:00:00.000Z',
          },
        ],
      },
    },
    {
      name: 'pending task with stale review state',
      snapshot: { status: 'pending', reviewState: 'review', kanbanColumn: 'review' },
    },
    {
      name: 'pending task returned for fixes',
      snapshot: { status: 'pending', reviewState: 'needsFix' },
    },
    {
      name: 'in-progress task with stale approval state',
      snapshot: { status: 'in_progress', reviewState: 'approved' },
    },
    {
      name: 'deleted task with stale approved column',
      snapshot: { status: 'deleted', reviewState: 'approved', kanbanColumn: 'approved' },
    },
  ])('matches the legacy TeamDataService decision for $name', ({ snapshot }) => {
    expect(resolveTaskMutationWorkflowColumn(snapshot)).toBe(
      resolveLegacyMutationWorkflowColumn(snapshot)
    );
  });
});
