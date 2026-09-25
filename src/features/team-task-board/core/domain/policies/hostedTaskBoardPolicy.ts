import {
  parseCursor,
  parseMemberId,
  parseRevision,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import {
  HOSTED_TASK_BOARD_COLUMNS,
  HOSTED_TASK_BOARD_DEGRADED_REASONS,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  HOSTED_TASK_RELATIONSHIP_KINDS,
  HOSTED_TASK_STATUSES,
  type HostedTaskBoardItem,
  type HostedTaskBoardPageRequest,
  type HostedTaskCommandId,
  type HostedTaskMutationCommand,
  type HostedTaskMutationReceipt,
  type HostedTaskRelationshipKind,
  type HostedTaskStatus,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
  type TaskId,
} from '../../../contracts/hosted';
import { HOSTED_TASK_BOARD_MAX_PAGE_ITEMS } from '../models/HostedTaskBoardBudget';

const SUBJECT_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 20_000;
const RELATIONSHIP_LIST_MAX_ITEMS = 100;
const KANBAN_ORDER_MAX = 1_000_000;

const PAGE_REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'teamId',
  'cursor',
  'expectedSourceGeneration',
  'limit',
] as const);
const ITEM_KEYS = Object.freeze([
  'teamId',
  'taskId',
  'subject',
  'description',
  'status',
  'ownerId',
  'column',
  'order',
  'blockedByTaskIds',
  'blocksTaskIds',
  'relatedTaskIds',
] as const);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'outcome',
  'commandId',
  'teamId',
  'sourceGeneration',
  'revision',
  'affectedTaskIds',
] as const);
const COMMON_COMMAND_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'commandId',
  'idempotencyKey',
  'teamId',
  'expectedSourceGeneration',
  'expectedRevision',
] as const);

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function failure(): ParseResult<never> {
  return Object.freeze({ ok: false });
}

function success<T>(value: T): ParseResult<T> {
  return Object.freeze({ ok: true, value });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasAllowedKeys(
  value: Record<PropertyKey, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.every((key) => typeof key === 'string' && allowed.has(key))
  );
}

function hasUnsafeControl(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && (!allowWhitespace || ![9, 10, 13].includes(code)))) {
      return true;
    }
  }
  return false;
}

function parseSubject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > SUBJECT_MAX_LENGTH ||
    value.trim() !== value ||
    hasUnsafeControl(value, false)
  ) {
    throw new TypeError('hosted-task-board-subject-invalid');
  }
  return value;
}

function parseDescription(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > DESCRIPTION_MAX_LENGTH ||
    hasUnsafeControl(value, true)
  ) {
    throw new TypeError('hosted-task-board-description-invalid');
  }
  return value;
}

function parseOrder(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > KANBAN_ORDER_MAX
  ) {
    throw new TypeError('hosted-task-board-order-invalid');
  }
  return value as number;
}

function parseTaskIdList(
  value: unknown,
  selfTaskId?: TaskId,
  preserveOrder = false
): readonly TaskId[] {
  if (
    !Array.isArray(value) ||
    value.length > RELATIONSHIP_LIST_MAX_ITEMS ||
    !Number.isSafeInteger(value.length)
  ) {
    throw new TypeError('hosted-task-board-task-id-list-invalid');
  }
  const parsed = value.map(parseHostedTaskId);
  if (new Set(parsed).size !== parsed.length || (selfTaskId && parsed.includes(selfTaskId))) {
    throw new TypeError('hosted-task-board-task-id-list-invalid');
  }
  if (!preserveOrder) {
    parsed.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  }
  return Object.freeze(parsed);
}

export function compareHostedTaskBoardItems(
  left: HostedTaskBoardItem,
  right: HostedTaskBoardItem
): number {
  const leftColumn = HOSTED_TASK_BOARD_COLUMNS.indexOf(left.column);
  const rightColumn = HOSTED_TASK_BOARD_COLUMNS.indexOf(right.column);
  if (leftColumn !== rightColumn) return leftColumn - rightColumn;
  if (left.order !== right.order) return left.order - right.order;
  if (left.taskId === right.taskId) return 0;
  return left.taskId < right.taskId ? -1 : 1;
}

export function parseHostedTaskBoardPageRequest(
  value: unknown
): ParseResult<HostedTaskBoardPageRequest> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PAGE_REQUEST_KEYS)) return failure();
    const schemaVersion = value.schemaVersion;
    const cursor = value.cursor;
    const expectedSourceGeneration = value.expectedSourceGeneration;
    const limit = value.limit;
    if (
      schemaVersion !== HOSTED_TASK_BOARD_SCHEMA_VERSION ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > HOSTED_TASK_BOARD_MAX_PAGE_ITEMS
    ) {
      return failure();
    }
    const parsedCursor = cursor === null ? null : parseCursor(cursor);
    const parsedSourceGeneration =
      expectedSourceGeneration === null
        ? null
        : parseHostedTaskBoardSourceGeneration(expectedSourceGeneration);
    if ((parsedCursor === null) !== (parsedSourceGeneration === null)) return failure();
    return success(
      Object.freeze({
        schemaVersion,
        teamId: parseTeamId(value.teamId),
        cursor: parsedCursor,
        expectedSourceGeneration: parsedSourceGeneration,
        limit: limit as number,
      })
    );
  } catch {
    return failure();
  }
}

function parseHostedTaskBoardItem(value: unknown, expectedTeamId: TeamId): HostedTaskBoardItem {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
    throw new TypeError('hosted-task-board-item-invalid');
  }
  const teamId = parseTeamId(value.teamId);
  const taskId = parseHostedTaskId(value.taskId);
  const status = value.status;
  const column = value.column;
  const ownerId = value.ownerId;
  if (
    teamId !== expectedTeamId ||
    !HOSTED_TASK_STATUSES.includes(status as (typeof HOSTED_TASK_STATUSES)[number]) ||
    !HOSTED_TASK_BOARD_COLUMNS.includes(column as (typeof HOSTED_TASK_BOARD_COLUMNS)[number])
  ) {
    throw new TypeError('hosted-task-board-item-invalid');
  }

  const blockedByTaskIds = parseTaskIdList(value.blockedByTaskIds, taskId);
  const blocksTaskIds = parseTaskIdList(value.blocksTaskIds, taskId);
  const relatedTaskIds = parseTaskIdList(value.relatedTaskIds, taskId);
  if (
    blockedByTaskIds.some((relatedId) => blocksTaskIds.includes(relatedId)) ||
    relatedTaskIds.some(
      (relatedId) => blockedByTaskIds.includes(relatedId) || blocksTaskIds.includes(relatedId)
    )
  ) {
    throw new TypeError('hosted-task-board-item-invalid');
  }

  return Object.freeze({
    teamId,
    taskId,
    subject: parseSubject(value.subject),
    description: parseDescription(value.description),
    status: status as HostedTaskBoardItem['status'],
    ownerId: ownerId === null ? null : parseMemberId(ownerId),
    column: column as HostedTaskBoardItem['column'],
    order: parseOrder(value.order),
    blockedByTaskIds,
    blocksTaskIds,
    relatedTaskIds,
  });
}

export function normalizeAndOrderHostedTaskBoardItems(
  value: unknown,
  expectedTeamId: TeamId
): ParseResult<readonly HostedTaskBoardItem[]> {
  const normalized = normalizeHostedTaskBoardItems(value, expectedTeamId);
  if (!normalized.ok) return normalized;
  const items = [...normalized.value];
  items.sort(compareHostedTaskBoardItems);
  return success(Object.freeze(items));
}

export function normalizeHostedTaskBoardItems(
  value: unknown,
  expectedTeamId: TeamId
): ParseResult<readonly HostedTaskBoardItem[]> {
  try {
    if (!Array.isArray(value) || value.length > HOSTED_TASK_BOARD_MAX_PAGE_ITEMS + 1) {
      return failure();
    }
    const items = value.map((item) => parseHostedTaskBoardItem(item, expectedTeamId));
    if (new Set(items.map((item) => item.taskId)).size !== items.length) return failure();
    return success(Object.freeze(items));
  } catch {
    return failure();
  }
}

function parseCommonCommand(
  value: Record<PropertyKey, unknown>
): Pick<
  HostedTaskMutationCommand,
  | 'schemaVersion'
  | 'commandId'
  | 'idempotencyKey'
  | 'teamId'
  | 'expectedSourceGeneration'
  | 'expectedRevision'
> {
  if (value.schemaVersion !== HOSTED_TASK_BOARD_SCHEMA_VERSION) throw new TypeError();
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    commandId: parseHostedTaskCommandId(value.commandId),
    idempotencyKey: parseHostedTaskIdempotencyKey(value.idempotencyKey),
    teamId: parseTeamId(value.teamId),
    expectedSourceGeneration: parseHostedTaskBoardSourceGeneration(value.expectedSourceGeneration),
    expectedRevision: parseRevision(value.expectedRevision),
  });
}

function commandKeys(...keys: readonly string[]): readonly string[] {
  return [...COMMON_COMMAND_KEYS, ...keys];
}

function parseCommandRecord(value: Record<PropertyKey, unknown>): HostedTaskMutationCommand {
  const common = parseCommonCommand(value);
  switch (value.kind) {
    case 'create_task': {
      if (
        !hasExactKeys(
          value,
          commandKeys('subject', 'description', 'status', 'ownerId', 'column', 'order')
        ) ||
        !HOSTED_TASK_STATUSES.includes(value.status as (typeof HOSTED_TASK_STATUSES)[number]) ||
        !HOSTED_TASK_BOARD_COLUMNS.includes(
          value.column as (typeof HOSTED_TASK_BOARD_COLUMNS)[number]
        )
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        subject: parseSubject(value.subject),
        description: parseDescription(value.description),
        status: value.status as HostedTaskStatus,
        ownerId: value.ownerId === null ? null : parseMemberId(value.ownerId),
        column: value.column as HostedTaskBoardItem['column'],
        order: parseOrder(value.order),
      }) as HostedTaskMutationCommand;
    }
    case 'update_details': {
      if (
        !hasAllowedKeys(value, commandKeys('taskId'), ['subject', 'description']) ||
        (!Object.hasOwn(value, 'subject') && !Object.hasOwn(value, 'description'))
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        taskId: parseHostedTaskId(value.taskId),
        ...(Object.hasOwn(value, 'subject') ? { subject: parseSubject(value.subject) } : {}),
        ...(Object.hasOwn(value, 'description')
          ? { description: parseDescription(value.description) }
          : {}),
      });
    }
    case 'update_status': {
      if (
        !hasExactKeys(value, commandKeys('taskId', 'status')) ||
        !HOSTED_TASK_STATUSES.includes(value.status as (typeof HOSTED_TASK_STATUSES)[number])
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        taskId: parseHostedTaskId(value.taskId),
        status: value.status as HostedTaskBoardItem['status'],
      });
    }
    case 'update_owner': {
      if (!hasExactKeys(value, commandKeys('taskId', 'ownerId'))) throw new TypeError();
      return Object.freeze({
        ...common,
        kind: value.kind,
        taskId: parseHostedTaskId(value.taskId),
        ownerId: value.ownerId === null ? null : parseMemberId(value.ownerId),
      });
    }
    case 'move_task': {
      if (
        !hasExactKeys(value, commandKeys('taskId', 'column', 'order')) ||
        !HOSTED_TASK_BOARD_COLUMNS.includes(
          value.column as (typeof HOSTED_TASK_BOARD_COLUMNS)[number]
        )
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        taskId: parseHostedTaskId(value.taskId),
        column: value.column as HostedTaskBoardItem['column'],
        order: parseOrder(value.order),
      });
    }
    case 'reorder_column': {
      if (
        !hasExactKeys(value, commandKeys('column', 'orderedTaskIds')) ||
        !HOSTED_TASK_BOARD_COLUMNS.includes(
          value.column as (typeof HOSTED_TASK_BOARD_COLUMNS)[number]
        )
      ) {
        throw new TypeError();
      }
      const orderedTaskIds = parseTaskIdList(value.orderedTaskIds, undefined, true);
      if (orderedTaskIds.length === 0) throw new TypeError();
      return Object.freeze({
        ...common,
        kind: value.kind,
        column: value.column as HostedTaskBoardItem['column'],
        orderedTaskIds,
      });
    }
    case 'update_relationship': {
      if (
        !hasExactKeys(value, commandKeys('action', 'taskId', 'otherTaskId', 'relationship')) ||
        (value.action !== 'add' && value.action !== 'remove') ||
        !HOSTED_TASK_RELATIONSHIP_KINDS.includes(
          value.relationship as (typeof HOSTED_TASK_RELATIONSHIP_KINDS)[number]
        )
      ) {
        throw new TypeError();
      }
      const taskId = parseHostedTaskId(value.taskId);
      const otherTaskId = parseHostedTaskId(value.otherTaskId);
      if (taskId === otherTaskId) throw new TypeError();
      return Object.freeze({
        ...common,
        kind: value.kind,
        action: value.action,
        taskId,
        otherTaskId,
        relationship: value.relationship as HostedTaskRelationshipKind,
      });
    }
    default:
      throw new TypeError();
  }
}

export function parseHostedTaskMutationCommand(
  value: unknown
): ParseResult<HostedTaskMutationCommand> {
  try {
    if (!isRecord(value)) return failure();
    return success(parseCommandRecord(value));
  } catch {
    return failure();
  }
}

export function normalizeHostedTaskMutationReceipt(
  value: unknown,
  expectedOutcome: HostedTaskMutationReceipt['outcome'],
  expectedCommandId: HostedTaskCommandId,
  expectedTeamId: TeamId,
  expectedSourceGeneration: HostedTaskMutationCommand['expectedSourceGeneration']
): ParseResult<HostedTaskMutationReceipt> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return failure();
    const outcome = value.outcome;
    if (
      value.schemaVersion !== HOSTED_TASK_BOARD_SCHEMA_VERSION ||
      outcome !== expectedOutcome ||
      parseHostedTaskCommandId(value.commandId) !== expectedCommandId ||
      parseTeamId(value.teamId) !== expectedTeamId ||
      parseHostedTaskBoardSourceGeneration(value.sourceGeneration) !== expectedSourceGeneration
    ) {
      return failure();
    }
    const affectedTaskIds = parseTaskIdList(value.affectedTaskIds);
    if (affectedTaskIds.length === 0) return failure();
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        outcome,
        commandId: expectedCommandId,
        teamId: expectedTeamId,
        sourceGeneration: expectedSourceGeneration,
        revision: parseRevision(value.revision),
        affectedTaskIds,
      }) as HostedTaskMutationReceipt
    );
  } catch {
    return failure();
  }
}

export function isHostedTaskBoardDegradedReasons(
  value: unknown
): value is readonly (typeof HOSTED_TASK_BOARD_DEGRADED_REASONS)[number][] {
  return (
    Array.isArray(value) &&
    value.length <= HOSTED_TASK_BOARD_DEGRADED_REASONS.length &&
    value.every((reason) =>
      HOSTED_TASK_BOARD_DEGRADED_REASONS.includes(
        reason as (typeof HOSTED_TASK_BOARD_DEGRADED_REASONS)[number]
      )
    ) &&
    new Set(value).size === value.length
  );
}
