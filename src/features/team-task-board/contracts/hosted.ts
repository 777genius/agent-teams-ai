import {
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  type MemberId,
  type Revision,
  type SafeAppError,
  type TeamId,
} from '@shared/contracts/hosted';

declare const hostedTaskBoardBrand: unique symbol;

export type TaskId = string & { readonly [hostedTaskBoardBrand]: 'TaskId' };
export type HostedTaskBoardSourceGeneration = string & {
  readonly [hostedTaskBoardBrand]: 'HostedTaskBoardSourceGeneration';
};
export type HostedTaskCommandId = string & {
  readonly [hostedTaskBoardBrand]: 'HostedTaskCommandId';
};
export type HostedTaskIdempotencyKey = string & {
  readonly [hostedTaskBoardBrand]: 'HostedTaskIdempotencyKey';
};

export const HOSTED_TASK_BOARD_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_TASK_BOARD_PAGE_ROUTE = '/api/hosted/v1/team-task-board/page' as const;
export const HOSTED_TASK_BOARD_MUTATION_ROUTE = '/api/hosted/v1/team-task-board/mutations' as const;

const CANONICAL_TASK_ID = /^task_[0-9a-f]{32}$/;
const SOURCE_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;
const COMMAND_ID = /^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseHostedTaskId(value: unknown): TaskId {
  if (typeof value !== 'string' || !CANONICAL_TASK_ID.test(value)) {
    throw new TypeError('hosted-task-board-task-id-invalid');
  }
  return value as TaskId;
}

export function parseHostedTaskBoardSourceGeneration(
  value: unknown
): HostedTaskBoardSourceGeneration {
  if (typeof value !== 'string' || !SOURCE_GENERATION.test(value)) {
    throw new TypeError('hosted-task-board-source-generation-invalid');
  }
  return value as HostedTaskBoardSourceGeneration;
}

export function parseHostedTaskCommandId(value: unknown): HostedTaskCommandId {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) {
    throw new TypeError('hosted-task-board-command-id-invalid');
  }
  return value as HostedTaskCommandId;
}

export function parseHostedTaskIdempotencyKey(value: unknown): HostedTaskIdempotencyKey {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new TypeError('hosted-task-board-idempotency-key-invalid');
  }
  return value as HostedTaskIdempotencyKey;
}

export const HOSTED_TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed'] as const);
export type HostedTaskStatus = (typeof HOSTED_TASK_STATUSES)[number];

export const HOSTED_TASK_BOARD_COLUMNS = Object.freeze([
  'todo',
  'in_progress',
  'review',
  'approved',
  'done',
] as const);
export type HostedTaskBoardColumn = (typeof HOSTED_TASK_BOARD_COLUMNS)[number];

export const HOSTED_TASK_RELATIONSHIP_KINDS = Object.freeze(['blocks', 'related'] as const);
export type HostedTaskRelationshipKind = (typeof HOSTED_TASK_RELATIONSHIP_KINDS)[number];

export interface HostedTaskBoardPageRequest {
  readonly schemaVersion: typeof HOSTED_TASK_BOARD_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedTaskBoardSourceGeneration | null;
  readonly limit: number;
}

export interface HostedTaskBoardItem {
  readonly teamId: TeamId;
  readonly taskId: TaskId;
  readonly subject: string;
  readonly description: string | null;
  readonly status: HostedTaskStatus;
  readonly ownerId: MemberId | null;
  readonly column: HostedTaskBoardColumn;
  readonly order: number;
  readonly blockedByTaskIds: readonly TaskId[];
  readonly blocksTaskIds: readonly TaskId[];
  readonly relatedTaskIds: readonly TaskId[];
}

export const HOSTED_TASK_BOARD_TRUNCATION_REASONS = Object.freeze([
  'item_budget',
  'byte_budget',
  'time_budget',
  'source_budget',
] as const);
export type HostedTaskBoardTruncationReason = (typeof HOSTED_TASK_BOARD_TRUNCATION_REASONS)[number];

export const HOSTED_TASK_BOARD_DEGRADED_REASONS = Object.freeze([
  'source_partial',
  'source_reconciling',
  'source_stale',
  'budget_exhausted',
] as const);
export type HostedTaskBoardDegradedReason = (typeof HOSTED_TASK_BOARD_DEGRADED_REASONS)[number];

export interface HostedTaskBoardBudgetMetadata {
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly timeLimitMs: number;
  readonly usedItems: number;
  readonly usedBytes: number;
  readonly elapsedMs: number;
}

export interface HostedTaskBoardDegradedMetadata {
  readonly active: boolean;
  readonly reasons: readonly HostedTaskBoardDegradedReason[];
}

export interface HostedTaskBoardPage {
  readonly schemaVersion: typeof HOSTED_TASK_BOARD_SCHEMA_VERSION;
  readonly kind: 'task_board_page';
  readonly teamId: TeamId;
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
  readonly items: readonly HostedTaskBoardItem[];
  readonly nextCursor: Cursor | null;
  readonly truncated: boolean;
  readonly truncationReasons: readonly HostedTaskBoardTruncationReason[];
  readonly degraded: HostedTaskBoardDegradedMetadata;
  readonly budget: HostedTaskBoardBudgetMetadata;
}

interface HostedTaskMutationBase {
  readonly schemaVersion: typeof HOSTED_TASK_BOARD_SCHEMA_VERSION;
  readonly commandId: HostedTaskCommandId;
  readonly idempotencyKey: HostedTaskIdempotencyKey;
  readonly teamId: TeamId;
  readonly expectedSourceGeneration: HostedTaskBoardSourceGeneration;
  readonly expectedRevision: Revision;
}

export type HostedTaskMutationCommand = HostedTaskMutationBase &
  (
    | {
        readonly kind: 'create_task';
        readonly subject: string;
        readonly description: string | null;
        readonly status: HostedTaskStatus;
        readonly ownerId: MemberId | null;
        readonly column: HostedTaskBoardColumn;
        readonly order: number;
      }
    | {
        readonly kind: 'update_details';
        readonly taskId: TaskId;
        readonly subject?: string;
        readonly description?: string | null;
      }
    | {
        readonly kind: 'update_status';
        readonly taskId: TaskId;
        readonly status: HostedTaskStatus;
      }
    | {
        readonly kind: 'update_owner';
        readonly taskId: TaskId;
        readonly ownerId: MemberId | null;
      }
    | {
        readonly kind: 'move_task';
        readonly taskId: TaskId;
        readonly column: HostedTaskBoardColumn;
        readonly order: number;
      }
    | {
        readonly kind: 'reorder_column';
        readonly column: HostedTaskBoardColumn;
        readonly orderedTaskIds: readonly TaskId[];
      }
    | {
        readonly kind: 'update_relationship';
        readonly action: 'add' | 'remove';
        readonly taskId: TaskId;
        readonly otherTaskId: TaskId;
        readonly relationship: HostedTaskRelationshipKind;
      }
  );

/**
 * The hosted Core v1 browser surface intentionally exposes only task creation and status changes.
 * Other parsed command variants remain available to their internal and desktop callers.
 */
export type HostedTaskBoardCoreV1MutationCommand = Extract<
  HostedTaskMutationCommand,
  { readonly kind: 'create_task' | 'update_status' }
>;

export function isHostedTaskBoardCoreV1MutationCommand(
  command: HostedTaskMutationCommand
): command is HostedTaskBoardCoreV1MutationCommand {
  return command.kind === 'create_task' || command.kind === 'update_status';
}

interface HostedTaskMutationReceiptBase {
  readonly schemaVersion: typeof HOSTED_TASK_BOARD_SCHEMA_VERSION;
  readonly commandId: HostedTaskCommandId;
  readonly teamId: TeamId;
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
  readonly affectedTaskIds: readonly TaskId[];
}

export interface HostedTaskMutationCommittedReceipt extends HostedTaskMutationReceiptBase {
  readonly outcome: 'committed';
}

export interface HostedTaskMutationReplayReceipt extends HostedTaskMutationReceiptBase {
  readonly outcome: 'idempotent_replay';
}

export type HostedTaskMutationReceipt =
  | HostedTaskMutationCommittedReceipt
  | HostedTaskMutationReplayReceipt;

export type HostedTaskMutationConflictReason =
  | 'idempotency_mismatch'
  | 'relationship_conflict'
  | 'state_conflict';

export type GetHostedTaskBoardPageResult =
  | { readonly kind: 'success'; readonly page: HostedTaskBoardPage }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedTaskBoardSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export type ExecuteHostedTaskMutationResult =
  | { readonly kind: 'committed'; readonly receipt: HostedTaskMutationCommittedReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedTaskMutationReplayReceipt }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedTaskBoardSourceGeneration;
    }
  | { readonly kind: 'stale_revision'; readonly currentRevision: Revision }
  | {
      readonly kind: 'conflict';
      readonly reason: 'idempotency_mismatch';
      readonly currentRevision?: never;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: 'relationship_conflict';
      readonly currentRevision?: Revision;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: 'state_conflict';
      readonly currentRevision: Revision;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unsafe_active' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTaskBoardErrorEnvelope {
  readonly schemaVersion: typeof HOSTED_TASK_BOARD_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError;
  readonly retryable: boolean;
  readonly currentSourceGeneration?: HostedTaskBoardSourceGeneration;
  readonly currentRevision?: Revision;
}
