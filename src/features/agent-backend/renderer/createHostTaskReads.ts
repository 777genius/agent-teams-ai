import { HostTeamOperationError } from './createHostTeamMutations';
import { assembleTaskParts } from './readHostPagedSnapshot';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { TeamsAPI } from '@shared/types/api';
import type { TaskComment, TeamTaskWithKanban } from '@shared/types/team';

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
  return {
    async getTask(key, taskId) {
      const read = await selected(key);
      read.assertCurrent();
      const active = read.snapshot.tasks.find((task) => task.id === taskId);
      if (active) return active;

      // Deleted tasks are retained by the original Owner but not its active snapshot.
      const result = await backend.invoke({
        handle: read.connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'task.get',
        payload: { taskId },
      });
      read.assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      const task = result.value;
      if (
        !task ||
        typeof task !== 'object' ||
        Array.isArray(task) ||
        !('id' in task) ||
        !('status' in task) ||
        !('subject' in task) ||
        task.id !== taskId ||
        task.status !== 'deleted' ||
        typeof task.subject !== 'string'
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      const retained = task;
      const subject = retained.subject;
      if (typeof subject !== 'string')
        throw new HostTeamOperationError('invalid-result', 'unknown');
      const comments = retained.comments?.map((comment) => {
        if (
          typeof comment.id !== 'string' ||
          typeof comment.author !== 'string' ||
          typeof comment.text !== 'string' ||
          typeof comment.createdAt !== 'string' ||
          !['regular', 'review_request', 'review_approved'].includes(comment.type ?? '')
        )
          throw new HostTeamOperationError('invalid-result', 'unknown');
        return {
          ...comment,
          author: comment.author,
          text: comment.text,
          createdAt: comment.createdAt,
          type: comment.type as TaskComment['type'],
          ...(comment.attachments === undefined
            ? {}
            : { attachments: comment.attachments as TaskComment['attachments'] }),
        };
      });
      // Only the Main-projected product allowlist is exposed; no Host internals.
      const restored: TeamTaskWithKanban = {
        id: retained.id,
        subject,
        status: 'deleted',
        ...(retained.displayId === undefined ? {} : { displayId: retained.displayId }),
        ...(retained.description === undefined ? {} : { description: retained.description }),
        ...(retained.prompt === undefined ? {} : { prompt: retained.prompt }),
        ...(retained.owner === undefined ? {} : { owner: retained.owner }),
        ...(retained.groupChatId === undefined ? {} : { groupChatId: retained.groupChatId }),
        ...(retained.reviewState === undefined ? {} : { reviewState: retained.reviewState }),
        ...(retained.needsClarification === undefined
          ? {}
          : { needsClarification: retained.needsClarification }),
        ...(retained.blocks === undefined ? {} : { blocks: retained.blocks }),
        ...(retained.blockedBy === undefined ? {} : { blockedBy: retained.blockedBy }),
        ...(retained.related === undefined ? {} : { related: retained.related }),
        ...(retained.historyEvents === undefined
          ? {}
          : { historyEvents: retained.historyEvents }),
        ...(retained.descriptionTaskRefs === undefined
          ? {}
          : { descriptionTaskRefs: retained.descriptionTaskRefs }),
        ...(retained.promptTaskRefs === undefined
          ? {}
          : { promptTaskRefs: retained.promptTaskRefs }),
        ...(retained.attachments === undefined
          ? {}
          : { attachments: retained.attachments as TeamTaskWithKanban['attachments'] }),
        ...(comments === undefined ? {} : { comments }),
      };
      return read.remapTasks([restored])[0] ?? null;
    },
    async getDeletedTasks(key) {
      const read = await selected(key);
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
    },
  };
}
