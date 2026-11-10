import { HostTeamOperationError } from './createHostTeamMutations';
import { readHostActivityLogs } from './readHostActivityLogs';

import type { HostActivityReadOptions } from './readHostActivityLogs';
import type { MemberLogSummary, MemberStatsResult } from '@shared/types/team';

/** Existing Logs/Stats read APIs; every response stays on its original member/Team context. */
export function createHostLogStatsApi(options: HostActivityReadOptions) {
  async function logs(
    key: string,
    payload: { memberName: string } | { taskId: string }
  ): Promise<MemberLogSummary[]> {
    const current = options.captureScope(),
      selected = await options.resolve(key, current);
    selected.assertCurrent();
    return readHostActivityLogs(
      { backend: options.backend, handle: selected.handle, assertCurrent: selected.assertCurrent },
      payload
    );
  }
  return {
    getMemberLogs: (key: string, memberName: string) => logs(key, { memberName }),
    // Owner/status/time hints are legacy display filters; Host task attribution is persisted input cause only.
    getLogsForTask: (key: string, taskId: string, _options?: unknown) => logs(key, { taskId }),
    async getMemberStats(key: string, memberName: string): Promise<MemberStatsResult> {
      const current = options.captureScope(),
        selected = await options.resolve(key, current);
      selected.assertCurrent();
      const result = await options.backend.invoke({
        handle: selected.handle,
        commandId: crypto.randomUUID(),
        operation: 'team.activity.stats.read',
        payload: { memberName },
      });
      selected.assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      if (
        !result.value ||
        !('kind' in result.value) ||
        result.value.kind !== 'team-activity-stats' ||
        result.value.stats.memberName !== memberName
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      return result.value.stats;
    },
  };
}
