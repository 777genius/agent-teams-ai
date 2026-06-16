export interface TeamTaskStateLike {
  id?: string | null;
  displayId?: string | null;
  status: string;
  reviewState?: string | null;
  kanbanColumn?: string | null;
  deletedAt?: string | null;
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
  deleted: boolean;
  approved: boolean;
  workflowColumn: TeamTaskWorkflowColumn | undefined;
  needsFixActionable: boolean;
  finishedForDependency: boolean;
  terminalForActionableWork: boolean;
}

const teamTaskStateCache = new WeakMap<TeamTaskStateLike, CachedTeamTaskState>();

function getCachedTeamTaskState(task: TeamTaskStateLike): CachedTeamTaskState {
  const cached = teamTaskStateCache.get(task);
  if (
    cached &&
    cached.status === task.status &&
    cached.reviewState === task.reviewState &&
    cached.kanbanColumn === task.kanbanColumn &&
    cached.deletedAt === task.deletedAt
  ) {
    return cached;
  }

  const deleted = task.status === 'deleted' || Boolean(task.deletedAt);
  const workflowColumn = resolveTeamTaskWorkflowColumn(task, deleted);
  const approved =
    !deleted &&
    task.status !== 'pending' &&
    (task.kanbanColumn === 'approved' ||
      (task.kanbanColumn !== 'review' && task.reviewState === 'approved'));
  const needsFixActionable =
    task.reviewState === 'needsFix' && !deleted && workflowColumn === undefined;
  const finishedForDependency =
    workflowColumn === 'approved'
      ? true
      : workflowColumn === 'review' || needsFixActionable
        ? false
        : task.status === 'completed';
  const terminalForActionableWork =
    deleted ||
    workflowColumn === 'approved' ||
    (workflowColumn !== 'review' && !needsFixActionable && task.status === 'completed');
  const next: CachedTeamTaskState = {
    status: task.status,
    reviewState: task.reviewState,
    kanbanColumn: task.kanbanColumn,
    deletedAt: task.deletedAt,
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

function resolveTeamTaskWorkflowColumn(
  task: TeamTaskStateLike,
  deleted: boolean
): TeamTaskWorkflowColumn | undefined {
  if (deleted || task.status === 'pending') {
    return undefined;
  }

  if (task.kanbanColumn === 'approved') {
    return 'approved';
  }

  if (task.kanbanColumn === 'review') {
    return 'review';
  }

  if (task.reviewState === 'approved') {
    return 'approved';
  }

  if (task.reviewState === 'review') {
    return 'review';
  }

  return undefined;
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

  return blockedBy.some((taskId) => {
    const blocker = findTaskStateByReference(taskStateById, taskId);
    return !blocker || (!isTeamTaskFinishedForDependency(blocker) && !isTeamTaskDeleted(blocker));
  });
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
