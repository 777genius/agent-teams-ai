import type { TaskRef } from './teamBoardTask';

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export interface KanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  reviewer?: string | null;
  errorDescription?: string;
  movedAt: string;
}
/**
 * Who gives final acceptance after AI review.
 * - agent_approval: the reviewer approves; the task goes to Approved.
 * - human_approval: the reviewer completes review (Done, reviewed); only the user approves.
 */
export type ReviewFlow = 'agent_approval' | 'human_approval';

/** Partial update from the desktop settings UI; omitted keys keep their persisted value. */
export interface ReviewFlowSettings {
  reviewFlow?: ReviewFlow;
  /** Free-text owner instructions for agents; empty text clears them. */
  reviewFlowPrompt?: string;
}

export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
  /** Missing means agent_approval. */
  reviewFlow?: ReviewFlow;
  /** Optional owner instructions for agents; never changes permissions. */
  reviewFlowPrompt?: string;
  /** Порядок id задач по колонкам для отображения на канбан-доске (drag-and-drop). */
  columnOrder?: Partial<Record<KanbanColumnId, string[]>>;
}

export type UpdateKanbanPatch =
  | { op: 'set_column'; column: Extract<KanbanColumnId, 'review' | 'approved'> }
  | { op: 'remove' }
  | { op: 'request_changes'; comment?: string; taskRefs?: TaskRef[] };
