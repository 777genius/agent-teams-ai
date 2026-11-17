import { randomUUID } from 'node:crypto';

import type { BackendTeamSnapshot } from '../../../contracts/teamSnapshot';
import type { CapturedHostScheduleTarget } from '../../application/captureHostScheduleTarget';
import type { TeamTaskWithKanban } from '@shared/types/team';

/** Scheduling reads task state only. Full text/history keeps using the existing paged UI reader. */
export async function readHostScheduleState(target: CapturedHostScheduleTarget) {
  let first: BackendTeamSnapshot | undefined;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const tasks = new Map<string, TeamTaskWithKanban>();
  for (let page = 0; page < 128; page++) {
    const result = await target.invoke({ commandId: randomUUID(), operation: 'team.snapshot',
      payload: cursor ? { cursor } : {} });
    if (!result.ok || !result.value || !('kanbanState' in result.value))
      throw new Error('Scheduled team state is unavailable');
    const current = result.value;
    if (first && (current.revision !== first.revision || current.teamName !== first.teamName || current.taskTotal !== first.taskTotal ||
      current.feed.streamId !== first.feed.streamId || current.feed.sequence !== first.feed.sequence))
      throw new Error('Scheduled team changed during read');
    first ??= current;
    if (current.lifecycle?.deletedAt || current.lifecycle?.cleanupPending)
      throw new Error('Scheduled team is deleted or awaiting cleanup');
    for (const [index, task] of current.tasks.entries()) {
      if (current.taskParts?.[index]?.part) continue;
      const state: TeamTaskWithKanban = { id: task.id, subject: task.subject, status: task.status,
        ...(task.displayId === undefined ? {} : { displayId: task.displayId }),
        ...(task.owner === undefined ? {} : { owner: task.owner }),
        ...(task.reviewState === undefined ? {} : { reviewState: task.reviewState }),
        ...(task.kanbanColumn === undefined ? {} : { kanbanColumn: task.kanbanColumn }),
        ...(task.deletedAt === undefined ? {} : { deletedAt: task.deletedAt }) };
      const previous = tasks.get(task.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(state))
        throw new Error('Scheduled task state changed during read');
      tasks.set(task.id, state);
    }
    if (!current.nextCursor) {
      if (first.taskTotal !== undefined && tasks.size !== first.taskTotal)
        throw new Error('Scheduled task state is incomplete');
      return { first, tasks: [...tasks.values()] };
    }
    if (seen.has(current.nextCursor)) throw new Error('Invalid scheduled task continuation');
    seen.add(current.nextCursor);
    cursor = current.nextCursor;
  }
  throw new Error('Scheduled task read exceeded page budget');
}
