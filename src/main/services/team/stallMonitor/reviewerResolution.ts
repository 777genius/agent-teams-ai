import { TeamKanbanManager } from '../TeamKanbanManager';

import type { ResolvedReviewer } from './TeamTaskStallTypes';
import type { TeamTask } from '@shared/types';

export function resolveReviewerFromHistory(task: TeamTask): ResolvedReviewer {
  if (!task.historyEvents?.length) {
    return { reviewer: null, source: 'none' };
  }

  for (let i = task.historyEvents.length - 1; i >= 0; i -= 1) {
    const event = task.historyEvents[i];
    if (event.type === 'review_approved' && event.actor) {
      return { reviewer: event.actor, source: 'history_review_approved_actor' };
    }
    if (event.type === 'review_started' && event.actor) {
      return { reviewer: event.actor, source: 'history_review_started_actor' };
    }
    if (event.type === 'review_requested' && event.reviewer) {
      return { reviewer: event.reviewer, source: 'history_review_requested_reviewer' };
    }
  }

  return { reviewer: null, source: 'none' };
}

export function buildResolvedReviewerIndex(
  tasks: TeamTask[],
  kanbanState: Awaited<ReturnType<TeamKanbanManager['getState']>>
): Map<string, ResolvedReviewer> {
  const resolved = new Map<string, ResolvedReviewer>();

  for (const task of tasks) {
    const kanbanReviewer = kanbanState.tasks[task.id]?.reviewer;
    if (typeof kanbanReviewer === 'string' && kanbanReviewer.trim().length > 0) {
      resolved.set(task.id, {
        reviewer: kanbanReviewer.trim(),
        source: 'kanban_state',
      });
      continue;
    }

    resolved.set(task.id, resolveReviewerFromHistory(task));
  }

  return resolved;
}
