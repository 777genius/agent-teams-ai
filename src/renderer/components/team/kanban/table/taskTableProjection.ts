import { isTeamTaskBlockedByUnfinishedDependency, isTeamTaskNeedsFixActionable } from '@shared/utils/teamTaskState';

import { getTaskColumn } from '../teamTaskProjection';

import type { KanbanColumnId, KanbanState, TeamTask } from '@shared/types';

export interface TaskTableRow {
  task: TeamTask;
  subject: string;
  status: KanbanColumnId;
  owner: string;
  blockedByCount: number;
  blocked: boolean;
  needsFix: boolean;
  updatedAt: number;
  commentCount: number;
}

function timestamp(task: TeamTask): number {
  for (const value of [task.updatedAt, task.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Pure UI projection. The complete team snapshot is needed for dependency checks:
 * a blocker hidden by search or filters is not the same as a missing task.
 */
export function buildTaskTableRows(
  visibleTasks: readonly TeamTask[],
  allTeamTasks: readonly TeamTask[],
  kanbanState: KanbanState,
  visibleColumns: ReadonlySet<KanbanColumnId>
): TaskTableRow[] {
  const taskStateById = new Map(allTeamTasks.map((task) => [task.id, task]));
  const rows: TaskTableRow[] = [];

  for (const task of visibleTasks) {
    const status = getTaskColumn(task, kanbanState);
    if (!status || (visibleColumns.size > 0 && !visibleColumns.has(status))) continue;

    rows.push({
      task,
      subject: task.subject,
      status,
      owner: task.owner ?? '',
      blockedByCount: task.blockedBy?.filter((id) => id.trim().length > 0).length ?? 0,
      blocked: isTeamTaskBlockedByUnfinishedDependency(task, taskStateById),
      needsFix: isTeamTaskNeedsFixActionable(task),
      updatedAt: timestamp(task),
      commentCount: task.comments?.length ?? 0,
    });
  }

  return rows;
}
