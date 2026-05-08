import { isTeamTaskActivelyWorked } from '@shared/utils/teamTaskState';

import type { TeamTaskWithKanban } from '@shared/types';

export {
  getTeamTaskWorkflowColumn,
  isTeamTaskActivelyWorked,
  isTeamTaskFinalForCompletionNotification,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
  isTeamTaskTerminalForActionableWork,
} from '@shared/utils/teamTaskState';

function parseIsoTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getActiveWorkStartedAt(task: TeamTaskWithKanban): number {
  const workIntervals = task.workIntervals ?? [];
  for (let index = workIntervals.length - 1; index >= 0; index--) {
    const interval = workIntervals[index];
    if (interval && interval.completedAt === undefined) {
      const startedAt = parseIsoTime(interval.startedAt);
      if (startedAt > 0) {
        return startedAt;
      }
    }
  }

  const historyEvents = task.historyEvents ?? [];
  for (let index = historyEvents.length - 1; index >= 0; index--) {
    const event = historyEvents[index];
    if (event?.type === 'status_changed' && event.to === 'in_progress') {
      const startedAt = parseIsoTime(event.timestamp);
      if (startedAt > 0) {
        return startedAt;
      }
    }
  }

  return Math.max(parseIsoTime(task.updatedAt), parseIsoTime(task.createdAt));
}

function compareCurrentActiveTasks(left: TeamTaskWithKanban, right: TeamTaskWithKanban): number {
  const byStartedAt = getActiveWorkStartedAt(right) - getActiveWorkStartedAt(left);
  if (byStartedAt !== 0) return byStartedAt;

  const byUpdatedAt = parseIsoTime(right.updatedAt) - parseIsoTime(left.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;

  const byCreatedAt = parseIsoTime(right.createdAt) - parseIsoTime(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;

  const leftLabel = left.displayId ?? left.id;
  const rightLabel = right.displayId ?? right.id;
  return leftLabel.localeCompare(rightLabel, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function selectCurrentActiveTeamTask<T extends TeamTaskWithKanban>(
  tasks: readonly T[]
): T | null {
  const activeTasks = tasks.filter(isTeamTaskActivelyWorked);
  if (activeTasks.length === 0) return null;
  return [...activeTasks].sort(compareCurrentActiveTasks)[0] ?? null;
}
