// eslint-disable-next-line no-restricted-imports -- Kanban state parsing uses the feature public contract.
import {
  HOSTED_TASK_BOARD_COLUMNS,
  type HostedTaskBoardColumn,
  type HostedTaskBoardSourceGeneration,
  type HostedTaskStatus,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { parseRevision, type Revision } from '@shared/contracts/hosted';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { HostedTaskBoardDirectoryDescriptor } from './hostedTaskBoardDescriptorFs';

const {
  hostedBoardDigest: digest,
  hostedTaskBoardRevision,
  hostedTaskBoardSourceGeneration: controllerHostedTaskBoardSourceGeneration,
  hostedTaskBoardTaskId: controllerHostedTaskBoardTaskId,
} = agentTeamsControllerModule.hostedBoardIdentity;

const MAX_TASKS = 512;

type JsonRecord = Record<string, unknown>;

export interface HostedTaskBoardKanbanState {
  readonly record: JsonRecord;
  readonly columns: ReadonlyMap<string, HostedTaskBoardColumn>;
  readonly orders: ReadonlyMap<string, number>;
  readonly movedAts: ReadonlyMap<string, string | null>;
}

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
  return parseHostedTaskId(controllerHostedTaskBoardTaskId(teamId, rawTaskId));
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
    controllerHostedTaskBoardSourceGeneration({
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
    })
  );
}

export function hostedTaskBoardRevisionForContents(input: {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly taskFiles: readonly { readonly name: string; readonly text: string | null }[];
  readonly kanbanText: string | null;
  readonly rosterFiles?: readonly { readonly name: string; readonly text: string | null }[];
}): Revision {
  if (input.taskFiles.some((task) => task.text === null)) {
    throw new TypeError('hosted-task-board-revision-input-invalid');
  }
  return parseRevision(
    hostedTaskBoardRevision({
      sourceGeneration: input.sourceGeneration,
      taskFiles: input.taskFiles as readonly { readonly name: string; readonly text: string }[],
      kanbanText: input.kanbanText,
      rosterFiles: input.rosterFiles ?? [],
    })
  );
}
