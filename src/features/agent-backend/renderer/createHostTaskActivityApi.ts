import { HostTeamOperationError } from './createHostTeamMutations';
import { readHostActivityLogs } from './readHostActivityLogs';

import type { HostActivityReadOptions } from './readHostActivityLogs';
import type {
  HostMemberActivityLog,
  HostTaskActivityView,
  HostTaskExactLogs,
  HostTaskLogDetailResult,
  HostTaskLogStream,
  HostTaskLogSummary,
} from '@shared/types/teamActivity';

async function inputLogs(logs: readonly HostMemberActivityLog[]) {
  const groups = logs.flatMap((log) => {
    if (log.generation === null) return [];
    const ids = [...new Set(log.events.flatMap((event) => (event.inputId ? [event.inputId] : [])))];
    return ids.map((inputId) => {
      const events = log.events.filter((event) => event.inputId === inputId);
      const text = events.filter((event) => event.data.kind === 'text');
      const selected: HostMemberActivityLog = {
        ...log,
        events,
        messageCount: new Set(
          text.map((event) => (event.data.kind === 'text' ? event.data.messageRef : ''))
        ).size,
      };
      delete selected.lastOutputPreview;
      const id = `${log.sessionId}/input/${encodeURIComponent(inputId)}`;
      const sourceGeneration = '';
      const summary: HostTaskLogSummary = {
        id,
        sourceGeneration,
        sessionId: log.sessionId,
        memberId: log.memberId,
        memberName: log.memberName,
        generation: log.generation!,
        inputId,
        eventCount: events.length,
        messageCount: selected.messageCount,
        gaps: [...log.gaps],
      };
      return { summary, log: selected };
    });
  });
  return Promise.all(
    groups.map(async (row) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          id: row.summary.id,
          generation: row.summary.generation,
          events: row.log.events,
          gaps: row.log.gaps,
        })
      );
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      row.summary.sourceGeneration = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      return row;
    })
  );
}
export function createHostTaskActivityApi(options: HostActivityReadOptions) {
  async function selected(key: string) {
    const current = options.captureScope(),
      scope = await options.resolve(key, current);
    scope.assertCurrent();
    return { backend: options.backend, handle: scope.handle, assertCurrent: scope.assertCurrent };
  }
  async function read(key: string, taskId: string) {
    const scope = await selected(key),
      logs = await readHostActivityLogs(scope, { taskId });
    const inputs = await inputLogs(logs);
    scope.assertCurrent();
    return { scope, logs, inputs, gaps: [...new Set(logs.flatMap((log) => log.gaps))] };
  }
  async function detail(
    key: string,
    taskId: string,
    id: string,
    expected?: string
  ): Promise<HostTaskLogDetailResult> {
    const value = await read(key, taskId);
    const row = value.inputs.find((row) => row.summary.id === id);
    if (!row) return { status: 'missing' };
    if (expected !== undefined && row.summary.sourceGeneration !== expected)
      return { status: 'stale' };
    return {
      status: 'ok',
      detail: {
        kind: 'host_task_log_detail',
        id,
        taskId,
        sourceGeneration: row.summary.sourceGeneration,
        log: row.log,
      },
    };
  }
  return {
    async getTaskActivity(key: string, taskId: string): Promise<HostTaskActivityView> {
      const value = await read(key, taskId);
      const task = await options.backend.invoke({
        handle: value.scope.handle,
        commandId: crypto.randomUUID(),
        operation: 'task.get',
        payload: { taskId },
      });
      value.scope.assertCurrent();
      if (!task.ok) throw new HostTeamOperationError(task.code, task.outcome);
      if (!task.value || !('id' in task.value) || task.value.id !== taskId)
        throw new HostTeamOperationError('invalid-result', 'unknown');
      return {
        kind: 'host_task_activity',
        taskId,
        items: value.inputs.map((row) => row.summary),
        ...(task.value.historyEvents === undefined
          ? {}
          : { historyEvents: task.value.historyEvents }),
        gaps: [
          ...value.gaps,
          ...(task.value.historyEvents === undefined
            ? ['Canonical task history is unavailable.']
            : []),
        ],
      };
    },
    getTaskActivityDetail: (key: string, taskId: string, id: string) => detail(key, taskId, id),
    async getTaskLogStreamSummary(key: string, taskId: string) {
      const value = await read(key, taskId);
      return { segmentCount: value.inputs.length };
    },
    async getTaskLogStream(key: string, taskId: string): Promise<HostTaskLogStream> {
      const value = await read(key, taskId);
      return { kind: 'host_task_log_stream', taskId, logs: value.logs, gaps: value.gaps };
    },
    async getTaskExactLogSummaries(key: string, taskId: string): Promise<HostTaskExactLogs> {
      const value = await read(key, taskId);
      return {
        kind: 'host_task_exact_logs',
        taskId,
        items: value.inputs.map((row) => row.summary),
        gaps: value.gaps,
      };
    },
    getTaskExactLogDetail: (key: string, taskId: string, id: string, expected: string) =>
      detail(key, taskId, id, expected),
    async setTaskLogStreamTracking(key: string, enabled: boolean): Promise<void> {
      if (typeof enabled !== 'boolean')
        throw new HostTeamOperationError('invalid-input', 'not-dispatched');
      const scope = await selected(key);
      // Host already retains the bounded feed. Validate current read authority; no transcript watcher is installed.
      const result = await options.backend.invoke({
        handle: scope.handle,
        commandId: crypto.randomUUID(),
        operation: 'team.roster.read',
        payload: {},
      });
      scope.assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    },
  };
}
