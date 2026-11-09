import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi, BackendTask } from '../contracts/operations';
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
      const retained = task as BackendTask;
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
        subject: retained.subject!,
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
      const result = await backend.invoke({
        handle: read.connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'tasks.list',
        payload: { deleted: true },
      });
      read.assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      if (
        !result.value ||
        !('kind' in result.value) ||
        result.value.kind !== 'deleted-tasks' ||
        result.value.teamName !== read.canonicalTeamName ||
        result.value.tasks.some((task) => task.status !== 'deleted')
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      return read.remapTasks(result.value.tasks);
    },
  };
}
