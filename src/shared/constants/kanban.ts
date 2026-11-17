import type { KanbanColumnId, KanbanState, ReviewFlow } from '@shared/types';

export const KANBAN_COLUMN_IDS: KanbanColumnId[] = [
  'todo',
  'in_progress',
  'done',
  'review',
  'approved',
];

/** Review flow values are owned by agent-teams-controller (kanbanStore.js); a parity test keeps them equal. */
export const REVIEW_FLOWS: readonly ReviewFlow[] = ['agent_approval', 'human_approval'];
export const DEFAULT_REVIEW_FLOW: ReviewFlow = 'agent_approval';
export const MAX_REVIEW_FLOW_PROMPT_LENGTH = 1000;

export function isReviewFlow(value: unknown): value is ReviewFlow {
  return REVIEW_FLOWS.includes(value as ReviewFlow);
}

export function isHumanApprovalFlow(state: Pick<KanbanState, 'reviewFlow'> | null | undefined): boolean {
  return state?.reviewFlow === 'human_approval';
}
