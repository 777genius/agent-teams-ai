import { randomUUID } from 'node:crypto';

import {
  assembleHostTaskSubject,
  type HostTaskSubjectFragment,
} from '../../../core/application/assembleHostTaskSubject';

import type { BackendTeamSnapshot } from '../../../contracts/teamSnapshot';
import type { CapturedHostScheduleTarget } from '../../application/captureHostScheduleTarget';
import type { TeamTaskWithKanban } from '@shared/types/team';

/** Scheduling reads task state only. Full text/history keeps using the existing paged UI reader. */
export async function readHostScheduleState(target: CapturedHostScheduleTarget) {
  let first: BackendTeamSnapshot | undefined;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const tasks = new Map<string, TeamTaskWithKanban>();
  const subjects = new Map<string, Map<number, HostTaskSubjectFragment>>();
  for (let page = 0; page < 128; page++) {
    const result = await target.invoke({
      commandId: randomUUID(),
      operation: 'team.snapshot',
      payload: cursor ? { cursor } : {},
    });
    if (!result.ok || !result.value || !('kanbanState' in result.value))
      throw new Error('Scheduled team state is unavailable');
    const current = result.value;
    if (
      first &&
      (current.revision !== first.revision ||
        current.teamName !== first.teamName ||
        current.taskTotal !== first.taskTotal ||
        current.feed.streamId !== first.feed.streamId ||
        current.feed.sequence !== first.feed.sequence)
    )
      throw new Error('Scheduled team changed during read');
    first ??= current;
    if (current.lifecycle?.deletedAt || current.lifecycle?.cleanupPending)
      throw new Error('Scheduled team is deleted or awaiting cleanup');
    for (const [index, task] of current.tasks.entries()) {
      const marker = current.taskParts?.[index];
      if (marker?.subjectPart) {
        const base = tasks.get(task.id);
        if (!base || base.subject !== '' || task.status !== base.status)
          throw new Error('Scheduled task subject identity changed');
        let parts = subjects.get(task.id);
        if (!parts) {
          parts = new Map();
          subjects.set(task.id, parts);
        }
        if (parts.has(marker.subjectPart.part) || marker.subjectPart.part !== parts.size)
          throw new Error('Invalid scheduled task subject continuation');
        parts.set(marker.subjectPart.part, {
          subject: task.subject,
          total: marker.subjectPart.total,
        });
        continue;
      }
      if (marker?.part) {
        const base = tasks.get(task.id);
        if (!base || task.subject !== base.subject || task.status !== base.status)
          throw new Error('Scheduled task fragment identity changed');
        continue;
      }
      const state: TeamTaskWithKanban = {
        id: task.id,
        subject: task.subject,
        status: task.status,
        ...(task.displayId === undefined ? {} : { displayId: task.displayId }),
        ...(task.owner === undefined ? {} : { owner: task.owner }),
        ...(task.reviewState === undefined ? {} : { reviewState: task.reviewState }),
        ...(task.kanbanColumn === undefined ? {} : { kanbanColumn: task.kanbanColumn }),
        ...(task.deletedAt === undefined ? {} : { deletedAt: task.deletedAt }),
      };
      const previous = tasks.get(task.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(state))
        throw new Error('Scheduled task state changed during read');
      tasks.set(task.id, state);
    }
    if (!current.nextCursor) {
      if (first.taskTotal !== undefined && tasks.size !== first.taskTotal)
        throw new Error('Scheduled task state is incomplete');
      for (const [taskId, parts] of subjects)
        tasks.get(taskId)!.subject = assembleHostTaskSubject(parts);
      return { first, tasks: [...tasks.values()] };
    }
    if (seen.has(current.nextCursor)) throw new Error('Invalid scheduled task continuation');
    seen.add(current.nextCursor);
    cursor = current.nextCursor;
  }
  throw new Error('Scheduled task read exceeded page budget');
}
