import { normalizeReviewState } from '@shared/utils/reviewState';
import { normalizeTaskHistoryEvents } from '@shared/utils/taskHistory';
import { resolveTaskSemantics } from 'agent-teams-controller/task-semantics';

export type TaskMutationWorkflowColumn = 'review' | 'approved';

export interface TaskMutationReviewSnapshot {
  status: string;
  reviewState?: unknown;
  historyEvents?: readonly unknown[];
  kanbanColumn?: unknown;
}

export function resolveTaskMutationWorkflowColumn(
  snapshot: TaskMutationReviewSnapshot
): TaskMutationWorkflowColumn | undefined {
  const status = snapshot.status;
  return (
    resolveTaskSemantics({
      key: '',
      status:
        status === 'in_progress' || status === 'completed' || status === 'deleted'
          ? status
          : 'pending',
      reviewState: normalizeReviewState(snapshot.reviewState),
      history: normalizeTaskHistoryEvents(snapshot.historyEvents),
      placement:
        snapshot.kanbanColumn === 'review' || snapshot.kanbanColumn === 'approved'
          ? { column: snapshot.kanbanColumn }
          : null,
    }).workflowColumn ?? undefined
  );
}
