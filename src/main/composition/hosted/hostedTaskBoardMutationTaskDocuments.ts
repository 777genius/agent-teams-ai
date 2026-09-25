import {
  type HostedTaskBoardSourceGeneration,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import { type Revision, type TeamId } from '@shared/contracts/hosted';

import { type HostedTaskBoardFileSnapshot } from './hostedTaskBoardDescriptorFs';
import {
  type HostedTaskBoardKanbanState,
  type HostedTaskBoardMutationTaskDocument,
  hostedTaskBoardTaskId,
} from './hostedTaskBoardKanbanState';
import { type HostedTaskBoardMutationLedger } from './hostedTaskBoardMutationLedger';
import { parseHostedTaskBoardMutationRelationships } from './hostedTaskBoardMutationRelationships';
import { type HostedTaskBoardRosterAuthority } from './hostedTaskBoardRosterAuthority';

type JsonRecord = Record<string, unknown>;

export interface TaskDocument extends HostedTaskBoardMutationTaskDocument {
  readonly snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly related: readonly string[];
}

export interface TaskFile {
  readonly rawTaskId: string;
  readonly fileName: string;
  readonly snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly document: TaskDocument | null;
}

export interface BoardSnapshot {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
  readonly taskDirectoryNames: readonly string[];
  readonly taskFiles: readonly TaskFile[];
  readonly documents: ReadonlyMap<TaskId, TaskDocument>;
  readonly kanban: HostedTaskBoardKanbanState;
  readonly kanbanSnapshot: HostedTaskBoardFileSnapshot;
  readonly roster: Awaited<ReturnType<HostedTaskBoardRosterAuthority['readActiveRoster']>>;
  readonly ledger: HostedTaskBoardMutationLedger<HostedTaskBoardFileSnapshot>;
  readonly ledgerSnapshot: HostedTaskBoardFileSnapshot;
  readonly snapshots: readonly HostedTaskBoardFileSnapshot[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTaskDocument(
  teamId: TeamId,
  rawTaskId: string,
  fileName: string,
  snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>
): TaskDocument | null {
  const value: unknown = JSON.parse(snapshot.text);
  if (!isRecord(value)) throw new TypeError('hosted-task-board-mutation-task-invalid');
  if (isRecord(value.metadata) && value.metadata._internal === true) return null;
  const parsedId =
    typeof value.id === 'number' && Number.isSafeInteger(value.id) ? String(value.id) : value.id;
  if (
    parsedId !== rawTaskId ||
    typeof value.subject !== 'string' ||
    value.subject.length < 1 ||
    value.subject.length > 200 ||
    value.subject.trim() !== value.subject ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 20_000)) ||
    !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string) ||
    (value.owner !== undefined &&
      (typeof value.owner !== 'string' || value.owner.length < 1 || value.owner.length > 128))
  ) {
    throw new TypeError('hosted-task-board-mutation-task-invalid');
  }
  return Object.freeze({
    rawTaskId,
    fileName,
    taskId: hostedTaskBoardTaskId(teamId, rawTaskId),
    serialized: snapshot.text,
    snapshot,
    record: value,
    status: value.status as TaskDocument['status'],
    blockedBy: parseHostedTaskBoardMutationRelationships(value.blockedBy ?? []),
    blocks: parseHostedTaskBoardMutationRelationships(value.blocks ?? []),
    related: parseHostedTaskBoardMutationRelationships(value.related ?? []),
  });
}
