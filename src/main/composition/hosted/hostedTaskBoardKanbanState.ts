import { createHash } from 'node:crypto';

// eslint-disable-next-line no-restricted-imports -- Kanban mutation mechanics use the feature public contract.
import {
  HOSTED_TASK_BOARD_COLUMNS,
  type HostedTaskBoardColumn,
  type HostedTaskBoardSourceGeneration,
  type HostedTaskMutationCommand,
  type HostedTaskStatus,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { type MemberId, parseRevision, type Revision } from '@shared/contracts/hosted';

import type {
  HostedTaskBoardDirectoryDescriptor,
  HostedTaskBoardFileSnapshot,
} from './hostedTaskBoardDescriptorFs';

const MAX_TASKS = 512;

type JsonRecord = Record<string, unknown>;

export interface HostedTaskBoardKanbanState {
  readonly record: JsonRecord;
  readonly columns: ReadonlyMap<string, HostedTaskBoardColumn>;
  readonly orders: ReadonlyMap<string, number>;
  readonly movedAts: ReadonlyMap<string, string | null>;
}

export interface HostedTaskBoardKanbanPlacement {
  readonly rawTaskId: string;
  readonly column: HostedTaskBoardColumn;
  readonly movedAt: string | null;
}

export interface HostedTaskBoardMutationTaskDocument {
  readonly rawTaskId: string;
  readonly fileName: string;
  readonly taskId: TaskId;
  readonly serialized: string;
  readonly record: JsonRecord;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

export interface HostedTaskBoardMutationPostimages {
  readonly taskPostimages: ReadonlyMap<string, string>;
  readonly kanbanPostimage: string | undefined;
  readonly affectedTaskIds: readonly TaskId[];
}

export class HostedTaskBoardMutationStateConflictError extends Error {}
export class HostedTaskBoardMutationRelationshipConflictError extends Error {}
export class HostedTaskBoardMutationTaskNotFoundError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRawTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function taskRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new TypeError('hosted-task-board-kanban-task-invalid');
  return value;
}

export function defaultHostedTaskBoardColumn(status: HostedTaskStatus): HostedTaskBoardColumn {
  switch (status) {
    case 'pending':
      return 'todo';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'done';
  }
}

export function parseHostedTaskBoardKanbanRecord(serialized: string | null): JsonRecord {
  if (serialized === null) return {};
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== 1) ||
    (value.tasks !== undefined && !isRecord(value.tasks)) ||
    (value.columnOrder !== undefined && !isRecord(value.columnOrder)) ||
    (value.reviewers !== undefined && !Array.isArray(value.reviewers)) ||
    (value.teamName !== undefined && typeof value.teamName !== 'string')
  ) {
    throw new TypeError('hosted-task-board-kanban-invalid');
  }
  return value;
}

export function parseHostedTaskBoardKanbanState(
  serialized: string | null,
  knownTaskIds: ReadonlySet<string>
): HostedTaskBoardKanbanState {
  if (knownTaskIds.size > MAX_TASKS) throw new TypeError('hosted-task-board-kanban-task-budget');
  const record = parseHostedTaskBoardKanbanRecord(serialized);
  const columns = new Map<string, HostedTaskBoardColumn>();
  const orders = new Map<string, number>();
  const movedAts = new Map<string, string | null>();
  if (isRecord(record.tasks)) {
    for (const [rawTaskId, value] of Object.entries(record.tasks)) {
      if (!validRawTaskId(rawTaskId)) throw new TypeError('hosted-task-board-kanban-task-invalid');
      const task = taskRecord(value);
      if (
        !HOSTED_TASK_BOARD_COLUMNS.includes(task.column as HostedTaskBoardColumn) ||
        (task.movedAt !== undefined && !isCanonicalTimestamp(task.movedAt))
      ) {
        throw new TypeError('hosted-task-board-kanban-task-invalid');
      }
      if (knownTaskIds.has(rawTaskId)) {
        columns.set(rawTaskId, task.column as HostedTaskBoardColumn);
        movedAts.set(rawTaskId, typeof task.movedAt === 'string' ? task.movedAt : null);
      }
    }
  }
  if (isRecord(record.columnOrder)) {
    const seen = new Set<string>();
    for (const [column, value] of Object.entries(record.columnOrder)) {
      if (!HOSTED_TASK_BOARD_COLUMNS.includes(column as HostedTaskBoardColumn)) {
        throw new TypeError('hosted-task-board-kanban-order-invalid');
      }
      if (!Array.isArray(value) || value.length > MAX_TASKS) {
        throw new TypeError('hosted-task-board-kanban-order-invalid');
      }
      value.forEach((rawTaskId, index) => {
        if (!validRawTaskId(rawTaskId)) {
          throw new TypeError('hosted-task-board-kanban-order-invalid');
        }
        if (!knownTaskIds.has(rawTaskId)) return;
        if (seen.has(rawTaskId)) throw new TypeError('hosted-task-board-kanban-order-invalid');
        seen.add(rawTaskId);
        orders.set(`${column}\u0000${rawTaskId}`, index);
      });
    }
  }
  return Object.freeze({ record: cloneRecord(record), columns, orders, movedAts });
}

export function hostedTaskBoardColumnFor(
  state: HostedTaskBoardKanbanState,
  rawTaskId: string,
  status: HostedTaskStatus
): HostedTaskBoardColumn {
  return state.columns.get(rawTaskId) ?? defaultHostedTaskBoardColumn(status);
}

export function hostedTaskBoardOrderFor(
  state: HostedTaskBoardKanbanState,
  column: HostedTaskBoardColumn,
  rawTaskId: string,
  fallback: number
): number {
  return state.orders.get(`${column}\u0000${rawTaskId}`) ?? fallback;
}

/**
 * Serializes the board projection independently from task status. Task documents remain authoritative
 * for subject, owner, status, and relationships; every explicit board placement survives a reread.
 */
export function serializeHostedTaskBoardKanbanState(
  state: HostedTaskBoardKanbanState,
  knownTaskIds: ReadonlySet<string>,
  placements: ReadonlyMap<string, HostedTaskBoardKanbanPlacement>,
  orderedTaskIdsByColumn: ReadonlyMap<HostedTaskBoardColumn, readonly string[]>
): string {
  const record = cloneRecord(state.record);
  const previousTasks = isRecord(record.tasks) ? record.tasks : {};
  const tasks: JsonRecord = { ...previousTasks };
  for (const rawTaskId of knownTaskIds) {
    const placement = placements.get(rawTaskId);
    if (placement === undefined) {
      delete tasks[rawTaskId];
      continue;
    }
    const previous = isRecord(tasks[rawTaskId]) ? tasks[rawTaskId] : {};
    const next: JsonRecord = {
      ...previous,
      column: placement.column,
    };
    if (placement.movedAt === null) delete next.movedAt;
    else next.movedAt = placement.movedAt;
    tasks[rawTaskId] = next;
  }
  if (Object.keys(tasks).length === 0) {
    delete record.tasks;
  } else {
    record.tasks = tasks;
  }

  const columnOrder: JsonRecord = {};
  for (const column of HOSTED_TASK_BOARD_COLUMNS) {
    const ordered = orderedTaskIdsByColumn.get(column) ?? [];
    if (
      ordered.length > MAX_TASKS ||
      ordered.some((rawTaskId) => !knownTaskIds.has(rawTaskId)) ||
      new Set(ordered).size !== ordered.length
    ) {
      throw new TypeError('hosted-task-board-kanban-order-invalid');
    }
    columnOrder[column] = [...ordered];
  }
  record.version = 1;
  record.columnOrder = columnOrder;
  return `${JSON.stringify(record, null, 2)}\n`;
}

function serializeTask(record: JsonRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function cloneTaskRecord(record: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(record)) as JsonRecord;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validBoardFileName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  );
}

function parseRelationshipList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 128) {
      throw new TypeError('hosted-task-board-mutation-relationship-invalid');
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  return Object.freeze(entries);
}

function createdRawTaskId(command: HostedTaskMutationCommand): string {
  return `hosted-${createHash('sha256')
    .update(JSON.stringify({ commandId: command.commandId }), 'utf8')
    .digest('hex')
    .slice(0, 40)}`;
}

function mutableBoardState(
  state: HostedTaskBoardKanbanState,
  documents: ReadonlyMap<TaskId, HostedTaskBoardMutationTaskDocument>
): {
  readonly placements: Map<string, HostedTaskBoardKanbanPlacement>;
  readonly orders: Map<HostedTaskBoardColumn, string[]>;
} {
  const active = [...documents.values()].filter((document) => document.status !== 'deleted');
  const fallbackOrders = new Map(
    [...active]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((document, index) => [document.rawTaskId, index] as const)
  );
  const byRawTaskId = new Map(active.map((document) => [document.rawTaskId, document]));
  const placements = new Map<string, HostedTaskBoardKanbanPlacement>();
  const orders = new Map<HostedTaskBoardColumn, string[]>(
    HOSTED_TASK_BOARD_COLUMNS.map((column) => [column, []] as const)
  );
  for (const document of active) {
    const column = hostedTaskBoardColumnFor(
      state,
      document.rawTaskId,
      document.status as HostedTaskStatus
    );
    placements.set(
      document.rawTaskId,
      Object.freeze({
        rawTaskId: document.rawTaskId,
        column,
        movedAt: state.movedAts.get(document.rawTaskId) ?? null,
      })
    );
    orders.get(column)!.push(document.rawTaskId);
  }
  for (const column of HOSTED_TASK_BOARD_COLUMNS) {
    orders.get(column)!.sort((left, right) => {
      const leftTask = byRawTaskId.get(left)!;
      const rightTask = byRawTaskId.get(right)!;
      const leftOrder = hostedTaskBoardOrderFor(state, column, left, fallbackOrders.get(left) ?? 0);
      const rightOrder = hostedTaskBoardOrderFor(
        state,
        column,
        right,
        fallbackOrders.get(right) ?? 0
      );
      return leftOrder === rightOrder
        ? leftTask.taskId.localeCompare(rightTask.taskId)
        : leftOrder - rightOrder;
    });
  }
  return Object.freeze({ placements, orders });
}

function removeFromOrders(
  orders: ReadonlyMap<HostedTaskBoardColumn, string[]>,
  rawTaskId: string
): void {
  for (const values of orders.values()) {
    const index = values.indexOf(rawTaskId);
    if (index >= 0) values.splice(index, 1);
  }
}

function affectedTaskIds(
  command: HostedTaskMutationCommand,
  taskIdFor: (rawTaskId: string) => TaskId
): readonly TaskId[] {
  const values =
    command.kind === 'reorder_column'
      ? command.orderedTaskIds
      : command.kind === 'update_relationship'
        ? [command.taskId, command.otherTaskId]
        : command.kind === 'create_task'
          ? [taskIdFor(createdRawTaskId(command))]
          : [command.taskId];
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

/** Calculates deterministic task and board postimages without observing the filesystem again. */
export function calculateHostedTaskBoardMutationPostimages(input: {
  readonly command: HostedTaskMutationCommand;
  readonly kanban: HostedTaskBoardKanbanState;
  readonly documents: ReadonlyMap<TaskId, HostedTaskBoardMutationTaskDocument>;
  readonly taskFileNames: ReadonlySet<string>;
  readonly timestamp: string;
  readonly taskIdFor: (rawTaskId: string) => TaskId;
  readonly resolveOwner: (ownerId: MemberId) => string | null;
}): HostedTaskBoardMutationPostimages {
  const taskPostimages = new Map<string, string>();
  const { placements, orders } = mutableBoardState(input.kanban, input.documents);
  let writeKanban = false;
  const requireTask = (taskId: TaskId): HostedTaskBoardMutationTaskDocument => {
    const document = input.documents.get(taskId);
    if (document === undefined || document.status === 'deleted') {
      throw new HostedTaskBoardMutationTaskNotFoundError();
    }
    return document;
  };
  const writeTask = (document: HostedTaskBoardMutationTaskDocument, record: JsonRecord): void => {
    taskPostimages.set(document.fileName, serializeTask(record));
  };
  const ownerName = (ownerId: MemberId): string => {
    const owner = input.resolveOwner(ownerId);
    if (owner === null) throw new HostedTaskBoardMutationStateConflictError();
    return owner;
  };
  const setPlacement = (
    rawTaskId: string,
    column: HostedTaskBoardColumn,
    movedAt: string | null
  ): void => {
    removeFromOrders(orders, rawTaskId);
    placements.set(rawTaskId, Object.freeze({ rawTaskId, column, movedAt }));
  };
  switch (input.command.kind) {
    case 'create_task': {
      const rawTaskId = createdRawTaskId(input.command);
      const fileName = `${rawTaskId}.json`;
      if (input.documents.has(input.taskIdFor(rawTaskId)) || input.taskFileNames.has(fileName)) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      const owner = input.command.ownerId === null ? null : ownerName(input.command.ownerId);
      taskPostimages.set(
        fileName,
        serializeTask({
          id: rawTaskId,
          subject: input.command.subject,
          ...(input.command.description === null ? {} : { description: input.command.description }),
          status: input.command.status,
          ...(owner === null ? {} : { owner }),
          blockedBy: [],
          blocks: [],
          related: [],
          createdAt: input.timestamp,
        })
      );
      placements.set(
        rawTaskId,
        Object.freeze({
          rawTaskId,
          column: input.command.column,
          movedAt:
            input.command.column === 'review' || input.command.column === 'approved'
              ? input.timestamp
              : null,
        })
      );
      orders
        .get(input.command.column)!
        .splice(
          Math.min(input.command.order, orders.get(input.command.column)!.length),
          0,
          rawTaskId
        );
      writeKanban = true;
      break;
    }
    case 'update_details': {
      const document = requireTask(input.command.taskId);
      const record = cloneTaskRecord(document.record);
      if (input.command.subject !== undefined) record.subject = input.command.subject;
      if (Object.hasOwn(input.command, 'description')) {
        if (input.command.description === null) delete record.description;
        else record.description = input.command.description;
      }
      if (serializeTask(record) === document.serialized) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      writeTask(document, record);
      break;
    }
    case 'update_status': {
      const document = requireTask(input.command.taskId);
      if (document.status === input.command.status)
        throw new HostedTaskBoardMutationStateConflictError();
      writeTask(document, { ...cloneTaskRecord(document.record), status: input.command.status });
      // Freeze the currently projected placement into kanban state before changing status. Legacy
      // boards may derive a missing placement from status, but a status mutation must never move a
      // card as a side effect; subsequent reads use this explicit independent placement.
      writeKanban = true;
      break;
    }
    case 'update_owner': {
      const document = requireTask(input.command.taskId);
      const owner = input.command.ownerId === null ? null : ownerName(input.command.ownerId);
      const record = cloneTaskRecord(document.record);
      if ((typeof record.owner === 'string' ? record.owner : null) === owner) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      if (owner === null) delete record.owner;
      else record.owner = owner;
      writeTask(document, record);
      break;
    }
    case 'move_task': {
      const document = requireTask(input.command.taskId);
      const previous = placements.get(document.rawTaskId);
      if (previous === undefined) throw new HostedTaskBoardMutationStateConflictError();
      const next = [...orders.get(input.command.column)!].filter(
        (value) => value !== document.rawTaskId
      );
      next.splice(Math.min(input.command.order, next.length), 0, document.rawTaskId);
      if (
        previous.column === input.command.column &&
        orders.get(input.command.column)!.length === next.length &&
        orders.get(input.command.column)!.every((value, index) => value === next[index])
      ) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      setPlacement(
        document.rawTaskId,
        input.command.column,
        input.command.column === 'review' || input.command.column === 'approved'
          ? input.timestamp
          : null
      );
      orders.set(input.command.column, next);
      writeKanban = true;
      break;
    }
    case 'reorder_column': {
      const column = input.command.column;
      const ordered = input.command.orderedTaskIds.map(requireTask);
      const current = orders.get(column)!;
      if (
        ordered.some((document) => placements.get(document.rawTaskId)?.column !== column) ||
        ordered.length !== current.length ||
        new Set(ordered.map((document) => document.rawTaskId)).size !== current.length
      ) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      const next = ordered.map((document) => document.rawTaskId);
      if (next.every((rawTaskId, index) => rawTaskId === current[index])) {
        throw new HostedTaskBoardMutationStateConflictError();
      }
      orders.set(column, next);
      writeKanban = true;
      break;
    }
    case 'update_relationship': {
      const task = requireTask(input.command.taskId);
      const other = requireTask(input.command.otherTaskId);
      const [taskField, otherField] =
        input.command.relationship === 'blocks'
          ? (['blocks', 'blockedBy'] as const)
          : (['related', 'related'] as const);
      const taskRecord = cloneTaskRecord(task.record);
      const otherRecord = cloneTaskRecord(other.record);
      const taskValues = parseRelationshipList(taskRecord[taskField] ?? []);
      const otherValues = parseRelationshipList(otherRecord[otherField] ?? []);
      const present = taskValues.includes(other.rawTaskId) && otherValues.includes(task.rawTaskId);
      if (
        (input.command.action === 'add' && present) ||
        (input.command.action === 'remove' && !present)
      ) {
        throw new HostedTaskBoardMutationRelationshipConflictError();
      }
      taskRecord[taskField] =
        input.command.action === 'add'
          ? [...taskValues, other.rawTaskId]
          : taskValues.filter((value) => value !== other.rawTaskId);
      otherRecord[otherField] =
        input.command.action === 'add'
          ? [...otherValues, task.rawTaskId]
          : otherValues.filter((value) => value !== task.rawTaskId);
      writeTask(task, taskRecord);
      writeTask(other, otherRecord);
      break;
    }
  }
  if (taskPostimages.size === 0 && !writeKanban) {
    throw new HostedTaskBoardMutationStateConflictError();
  }
  return Object.freeze({
    taskPostimages,
    kanbanPostimage: writeKanban
      ? serializeHostedTaskBoardKanbanState(
          input.kanban,
          new Set(placements.keys()),
          placements,
          orders
        )
      : undefined,
    affectedTaskIds: affectedTaskIds(input.command, input.taskIdFor),
  });
}

export function hostedTaskBoardDirectoryFingerprint(input: {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}): string {
  return digest({
    schemaVersion: 1,
    canonicalPath: input.canonicalPath,
    device: input.device.toString(),
    inode: input.inode.toString(),
  });
}

export function hostedTaskBoardTaskId(teamId: string, rawTaskId: string): TaskId {
  return parseHostedTaskId(
    `task_${digest({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }).slice(0, 32)}`
  );
}

export function hostedTaskBoardSourceGeneration(input: {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly teamId: string;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
}): HostedTaskBoardSourceGeneration {
  return parseHostedTaskBoardSourceGeneration(
    `generation_${digest({
      domain: 'hosted-task-board-source/v2',
      deploymentId: input.deploymentId,
      bootId: input.bootId,
      workspaceId: input.workspaceId,
      mountGeneration: input.mountGeneration,
      teamId: input.teamId,
      teamDirectory: [
        input.teamDirectory.identity.device.toString(),
        input.teamDirectory.identity.inode.toString(),
      ],
      tasksDirectory: [
        input.tasksDirectory.identity.device.toString(),
        input.tasksDirectory.identity.inode.toString(),
      ],
    })}`
  );
}

export function hostedTaskBoardRevision(input: {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly taskFiles: readonly {
    readonly name: string;
    readonly snapshot: HostedTaskBoardFileSnapshot;
  }[];
  readonly kanban: HostedTaskBoardFileSnapshot;
  readonly roster?: readonly HostedTaskBoardFileSnapshot[];
}): Revision {
  return hostedTaskBoardRevisionForContents({
    sourceGeneration: input.sourceGeneration,
    taskFiles: input.taskFiles.map(({ name, snapshot }) => ({
      name,
      text: snapshot.exists ? snapshot.text : null,
    })),
    kanbanText: input.kanban.exists ? input.kanban.text : null,
    rosterFiles: (input.roster ?? []).map((snapshot) => ({
      name: snapshot.name,
      text: snapshot.exists ? snapshot.text : null,
    })),
  });
}

export function hostedTaskBoardRevisionForContents(input: {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly taskFiles: readonly { readonly name: string; readonly text: string | null }[];
  readonly kanbanText: string | null;
  readonly rosterFiles?: readonly { readonly name: string; readonly text: string | null }[];
}): Revision {
  const taskNames = new Set<string>();
  for (const task of input.taskFiles) {
    if (!validBoardFileName(task.name) || task.text === null || taskNames.has(task.name)) {
      throw new TypeError('hosted-task-board-revision-input-invalid');
    }
    taskNames.add(task.name);
  }
  const rosterNames = new Set<string>();
  for (const file of input.rosterFiles ?? []) {
    if (!validBoardFileName(file.name) || rosterNames.has(file.name)) {
      throw new TypeError('hosted-task-board-revision-input-invalid');
    }
    rosterNames.add(file.name);
  }
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  return parseRevision(
    `revision_${digest({
      domain: 'hosted-task-board-revision/v3',
      sourceGeneration: input.sourceGeneration,
      taskFiles: [...input.taskFiles]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, text }) => [name, hash(text!)]),
      kanban: input.kanbanText === null ? null : hash(input.kanbanText),
      roster: [...(input.rosterFiles ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, text }) => [name, text === null ? null : hash(text)]),
    })}`
  );
}
