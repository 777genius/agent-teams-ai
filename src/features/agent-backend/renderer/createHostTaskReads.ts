import { HostTeamOperationError } from './createHostTeamMutations';
import { assembleTaskParts } from './readHostPagedSnapshot';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { TeamsAPI } from '@shared/types/api';
import type { TeamTaskWithKanban } from '@shared/types/team';

interface CapturedTaskRead {
  connection: { handle: BackendHandle };
  snapshot: BackendTeamSnapshot;
  canonicalTeamName: string;
  assertCurrent(): void;
  remapTasks(tasks: TeamTaskWithKanban[]): TeamTaskWithKanban[];
}

/** Both reads share the original selected owner, product fence and reference bindings. */
export function createHostTaskReads(
  backend: AgentBackendApi,
  selected: (key: string) => Promise<CapturedTaskRead>
): Pick<TeamsAPI, 'getTask' | 'getDeletedTasks'> {
  /** A single captured Owner selection powers both Trash and deleted-task detail. */
  const readDeletedTasks = async (read: CapturedTaskRead): Promise<TeamTaskWithKanban[]> => {
    read.assertCurrent();
    const tasks: TeamTaskWithKanban[] = [];
    const parts = new Map<number, {
      total: number;
      values: Map<number, TeamTaskWithKanban>;
    }>();
    const seen = new Set<string>();
    let revision: string | undefined;
    let taskTotal: number | undefined;
    let fragmented: boolean | undefined;
    let cursor: string | undefined;
    let completed = false;

    // No partial Trash is published. Each continuation stays on the selected
    // Host and under the original read-order/context fence.
    for (let index = 0; index < 128; index++) {
      const result = await backend.invoke({
        handle: read.connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'tasks.list',
        payload: { deleted: true, ...(cursor ? { cursor } : {}) },
      });
      read.assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      const page = result.value;
      if (!page || !('kind' in page) || page.kind !== 'deleted-tasks' ||
          page.teamName !== read.canonicalTeamName ||
          page.tasks.some((task) => task.status !== 'deleted'))
        throw new HostTeamOperationError('invalid-result', 'unknown');

      if (index === 0) {
        revision = page.revision;
        taskTotal = page.taskTotal;
        fragmented = !!page.taskParts;
      } else if (!revision || page.revision !== revision ||
                 page.taskTotal !== taskTotal || !!page.taskParts !== fragmented) {
        throw new Error('Host deleted tasks changed during paged read');
      }
      if (page.taskParts) {
        if (page.taskParts.length !== page.tasks.length || taskTotal === undefined)
          throw new Error('Invalid Host deleted task fragments');
        for (const [position, task] of page.tasks.entries()) {
          const marker = page.taskParts[position];
          if (!marker || marker.index >= taskTotal || marker.part >= marker.total)
            throw new Error('Invalid Host deleted task part');
          let group = parts.get(marker.index);
          if (!group) {
            group = { total: marker.total, values: new Map() };
            parts.set(marker.index, group);
          }
          if (group.total !== marker.total || group.values.has(marker.part))
            throw new Error('Duplicate Host deleted task fragment');
          group.values.set(marker.part, task);
        }
      } else {
        tasks.push(...page.tasks);
      }
      if (page.nextCursor === undefined || page.nextCursor === null) {
        completed = true;
        break;
      }
      if (!page.revision || seen.has(page.nextCursor))
        throw new Error('Invalid Host deleted task continuation');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!completed) throw new Error('Host deleted tasks exceeded page budget');
    return read.remapTasks(fragmented
      ? assembleTaskParts(parts, taskTotal ?? 0)
      : tasks);
  };
  return {
    async getTask(key, taskId) {
      const read = await selected(key);
      read.assertCurrent();
      const active = read.snapshot.tasks.find((task) => task.id === taskId);
      if (active) return active;
      // No unpaged team.task.get: retained detail can exceed Host's 1 MiB frame.
      return (await readDeletedTasks(read)).find((task) => task.id === taskId) ?? null;
    },
    async getDeletedTasks(key) {
      return readDeletedTasks(await selected(key));
    },
  };
}
