import type { TaskRef } from './teamBoardTask';
import type { ReviewFlow } from '@features/review-flow';

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export interface KanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  reviewer?: string | null;
  errorDescription?: string;
  movedAt: string;
}
export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
  /**
   * This team's own review flow. Missing means the team follows the default for all teams
   * (see @features/review-flow); it is NOT the effective flow on its own.
   */
  reviewFlow?: ReviewFlow;
  /** Owner instructions that belong to the team override; only present together with `reviewFlow`. */
  reviewFlowPrompt?: string;
  /** Порядок id задач по колонкам для отображения на канбан-доске (drag-and-drop). */
  columnOrder?: Partial<Record<KanbanColumnId, string[]>>;
}

export type UpdateKanbanPatch =
  | { op: 'set_column'; column: Extract<KanbanColumnId, 'review' | 'approved'> }
  | { op: 'remove' }
  | { op: 'disapprove' }
  | { op: 'request_changes'; comment?: string; taskRefs?: TaskRef[] };
