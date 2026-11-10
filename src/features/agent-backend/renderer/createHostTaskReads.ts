import { HostTeamOperationError } from './createHostTeamMutations';

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
  return {
    async getTask(key, taskId) {
      const read = await selected(key);
      read.assertCurrent();
      return read.snapshot.tasks.find((task) => task.id === taskId) ?? null;
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
