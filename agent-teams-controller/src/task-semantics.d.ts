/** Parsed, append-ordered facts. The adapter rejects invalid raw values. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type ReviewState = 'none' | 'review' | 'needsFix' | 'approved';
export type BoardColumn = 'todo' | 'in_progress' | 'review' | 'approved' | 'done';

export type NormalizedTaskHistoryEvent =
  | { kind: 'task_created' }
  | { kind: 'status_changed'; to: TaskStatus }
  | { kind: 'review_requested' | 'review_started' | 'review_changes_requested' | 'review_approved' }
  | { kind: 'review_reset' }
  | { kind: 'other' };

export interface NormalizedTaskPlacement {
  column: BoardColumn;
}

export interface TaskSemanticSnapshot {
  key: string;
  status: TaskStatus;
  reviewState: ReviewState;
  history: readonly NormalizedTaskHistoryEvent[];
  placement: NormalizedTaskPlacement | null;
}

export type BlockerFact =
  | { kind: 'known_task'; key: string; task: TaskSemanticSnapshot }
  | { kind: 'known_absent'; key: string }
  | { kind: 'unknown'; key: string };

export interface ReviewDecision {
  state: ReviewState;
  source: string;
}

export interface TaskSemantics {
  review: ReviewDecision;
  workflowColumn: 'review' | 'approved' | null;
  visibleColumn: BoardColumn | null;
  needsFixActionable: boolean;
  finishedForDependency: boolean;
  terminalForActionableWork: boolean;
}

export type DeniedDecision = {
  allowed: false;
  reason: 'blocked_open_dependency' | 'insufficient_knowledge' | 'state_conflict';
};
export type AllowedDependencyDecision = { allowed: true; reason: 'allowed' };
export type DependencyDecision = DeniedDecision | AllowedDependencyDecision;

export type ColumnTransition =
  | { kind: 'none' }
  | { kind: 'set_status'; status: TaskStatus; clearPlacement: boolean; resetReview: boolean }
  | { kind: 'request_review' }
  | { kind: 'approve_review' }
  | { kind: 'manual_approve' };

export type ColumnTransitionDecision =
  | DeniedDecision
  | { allowed: true; reason: 'allowed'; transition: ColumnTransition };

export function resolveReview(snapshot: TaskSemanticSnapshot): ReviewDecision;
export function resolveTaskSemantics(snapshot: TaskSemanticSnapshot): TaskSemantics;
export function resolveBlockers(blockers: readonly BlockerFact[]): DependencyDecision;
export function planColumnTransition(input: {
  task: TaskSemanticSnapshot;
  targetColumn: BoardColumn;
  blockers: readonly BlockerFact[];
}): ColumnTransitionDecision;

export type ColumnOrderDecision =
  | DeniedDecision
  | { allowed: true; reason: 'allowed'; orderedKeys: string[] };

/** Both revisions identify the same complete source generation/snapshot. */
export function resolveColumnOrder(input: {
  canonicalKeys: readonly string[];
  explicitKeys: readonly string[];
  canonicalColumnComplete: boolean;
  sourceRevision: string;
  explicitOrderRevision: string;
}): ColumnOrderDecision;
