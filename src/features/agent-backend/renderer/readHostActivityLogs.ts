import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { HostMemberActivityLog } from '@shared/types/teamActivity';
export interface HostActivityReadOptions {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(
    key: string,
    current: () => boolean
  ): Promise<{ handle: BackendHandle; assertCurrent(): void }>;
}
export async function readHostActivityLogs(
  options: {
    backend: AgentBackendApi;
    handle: BackendHandle;
    assertCurrent(): void;
  },
  payload: { memberName: string } | { taskId: string }
): Promise<HostMemberActivityLog[]> {
  options.assertCurrent();
  const result = await options.backend.invoke({
    handle: options.handle,
    commandId: crypto.randomUUID(),
    operation: 'team.activity.logs.read',
    payload,
  });
  options.assertCurrent();
  if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
  if (
    !result.value ||
    !('kind' in result.value) ||
    result.value.kind !== 'team-activity-logs' ||
    result.value.logs.some((log) =>
      'memberName' in payload
        ? log.memberName !== payload.memberName
        : log.taskId !== payload.taskId
    )
  )
    throw new HostTeamOperationError('invalid-result', 'unknown');
  return result.value.logs;
}
