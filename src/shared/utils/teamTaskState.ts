import { resolveBlockers, resolveTaskSemantics } from 'agent-teams-controller/task-semantics';

import { normalizeReviewState } from './reviewState';
import { normalizeTaskHistoryEvents } from './taskHistory';

import type { TaskSemanticSnapshot } from 'agent-teams-controller/task-semantics';

export interface TeamTaskStateLike {
  id?: string | null;
  displayId?: string | null;
  status: string;
  reviewState?: string | null;
  kanbanColumn?: string | null;
  deletedAt?: string | null;
  historyEvents?: readonly unknown[];
}

export interface TeamTaskBlockerLike {
  blockedBy?: string[] | null;
}

export type TeamTaskWorkflowColumn = 'review' | 'approved';

interface CachedTeamTaskState {
  status: TeamTaskStateLike['status'];
  reviewState: TeamTaskStateLike['reviewState'];
  kanbanColumn: TeamTaskStateLike['kanbanColumn'];
  deletedAt: TeamTaskStateLike['deletedAt'];
  historyEvents: TeamTaskStateLike['historyEvents'];
  historyLength: number;
  lastHistoryEvent: unknown;
  deleted: boolean;
  approved: boolean;
  workflowColumn: TeamTaskWorkflowColumn | undefined;
  needsFixActionable: boolean;
  finishedForDependency: boolean;
  terminalForActionableWork: boolean;
}

const teamTaskStateCache = new WeakMap<TeamTaskStateLike, CachedTeamTaskState>();

function toSemanticSnapshot(task: TeamTaskStateLike): TaskSemanticSnapshot {
  const status = task.deletedAt ? 'deleted' : task.status;
  return {
    key: task.id ?? '',
    status:
      status === 'in_progress' || status === 'completed' || status === 'deleted'
        ? status
        : 'pending',
    reviewState: normalizeReviewState(task.reviewState),
    history: normalizeTaskHistoryEvents(task.historyEvents),
    placement:
      task.kanbanColumn === 'review' || task.kanbanColumn === 'approved'
        ? { column: task.kanbanColumn }
        : null,
  };
}

function getCachedTeamTaskState(task: TeamTaskStateLike): CachedTeamTaskState {
  const cached = teamTaskStateCache.get(task);
  if (
    cached &&
    cached.status === task.status &&
    cached.reviewState === task.reviewState &&
    cached.kanbanColumn === task.kanbanColumn &&
    cached.deletedAt === task.deletedAt &&
    cached.historyEvents === task.historyEvents &&
    cached.historyLength === (task.historyEvents?.length ?? 0) &&
    cached.lastHistoryEvent === task.historyEvents?.at(-1)
  ) {
    return cached;
  }

  const semantics = resolveTaskSemantics(toSemanticSnapshot(task));
  const deleted = task.status === 'deleted' || Boolean(task.deletedAt);
  const workflowColumn = semantics.workflowColumn ?? undefined;
  const approved = workflowColumn === 'approved';
  const needsFixActionable = semantics.needsFixActionable;
  const finishedForDependency = semantics.finishedForDependency;
  const terminalForActionableWork = semantics.terminalForActionableWork;
  const next: CachedTeamTaskState = {
    status: task.status,
    reviewState: task.reviewState,
    kanbanColumn: task.kanbanColumn,
    deletedAt: task.deletedAt,
    historyEvents: task.historyEvents,
    historyLength: task.historyEvents?.length ?? 0,
    lastHistoryEvent: task.historyEvents?.at(-1),
    deleted,
    approved,
    workflowColumn,
    needsFixActionable,
    finishedForDependency,
    terminalForActionableWork,
  };
  teamTaskStateCache.set(task, next);
  return next;
}

export function isTeamTaskApproved(task: TeamTaskStateLike): boolean {
  return getCachedTeamTaskState(task).approved;
}

export function isTeamTaskDeleted(task: TeamTaskStateLike): boolean {
  return getCachedTeamTaskState(task).deleted;
}

export function isTeamTaskActivelyWorked(task: TeamTaskStateLike): boolean {
  const cached = getCachedTeamTaskState(task);
  return (
    task.status === 'in_progress' &&
    cached.workflowColumn !== 'review' &&
    !cached.approved &&
    !cached.deleted
  );
}

export function isTeamTaskNeedsFixActionable(task: TeamTaskStateLike): boolean {
  return getCachedTeamTaskState(task).needsFixActionable;
}

export function isTeamTaskFinishedForDependency(task: TeamTaskStateLike): boolean {
  return getCachedTeamTaskState(task).finishedForDependency;
}

function normalizeTaskReference(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
}

function findTaskStateByReference(
  taskStateById: ReadonlyMap<string, TeamTaskStateLike>,
  taskId: string
): TeamTaskStateLike | null {
  const normalized = normalizeTaskReference(taskId);
  if (!normalized) {
    return null;
  }

  const direct =
    taskStateById.get(taskId) ??
    taskStateById.get(normalized) ??
    taskStateById.get(`#${normalized}`);
  if (direct && (!direct.id || normalizeTaskReference(direct.id) === normalized)) {
    return direct;
  }

  let idMatched: TeamTaskStateLike | null = null;
  for (const task of taskStateById.values()) {
    if (normalizeTaskReference(task.id) === normalized) {
      if (idMatched && idMatched !== task) {
        return null;
      }
      idMatched = task;
    }
  }
  if (idMatched) {
    return idMatched;
  }

  let displayMatched: TeamTaskStateLike | null = null;
  for (const [key, task] of taskStateById) {
    if (
      normalizeTaskReference(key) === normalized ||
      normalizeTaskReference(task.displayId) === normalized
    ) {
      if (displayMatched && displayMatched !== task) {
        return null;
      }
      displayMatched = task;
    }
  }
  return displayMatched;
}

export function isTeamTaskBlockedByUnfinishedDependency(
  task: TeamTaskBlockerLike,
  taskStateById: ReadonlyMap<string, TeamTaskStateLike>
): boolean {
  const blockedBy =
    task.blockedBy?.map((taskId) => taskId.trim()).filter((taskId) => taskId.length > 0) ?? [];
  if (blockedBy.length === 0) {
    return false;
  }

  const blockers = blockedBy.map((taskId) => {
    const blocker = findTaskStateByReference(taskStateById, taskId);
    return blocker
      ? { kind: 'known_task' as const, key: taskId, task: toSemanticSnapshot(blocker) }
      : { kind: 'unknown' as const, key: taskId };
  });
  return !resolveBlockers(blockers).allowed;
}

export function isTeamTaskTerminalForActionableWork(task: TeamTaskStateLike): boolean {
  return getCachedTeamTaskState(task).terminalForActionableWork;
}

export function isTeamTaskFinalForCompletionNotification(task: TeamTaskStateLike): boolean {
  return isTeamTaskTerminalForActionableWork(task);
}

export function getTeamTaskWorkflowColumn(
  task: TeamTaskStateLike
): TeamTaskWorkflowColumn | undefined {
  return getCachedTeamTaskState(task).workflowColumn;
}
