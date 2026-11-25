import { webcrypto } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTaskHistory } from '../../../src/features/agent-backend/main/adapters/output/projectTaskHistory';
import { createHostTaskActivityApi } from '../../../src/features/agent-backend/renderer/createHostTaskActivityApi';
import { HostTeamOperationError } from '../../../src/features/agent-backend/renderer/createHostTeamMutations';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { HostActivityContent, HostMemberActivityLog } from '../../../src/shared/types/teamActivity';
vi.stubGlobal('crypto', webcrypto);
const history = [
  {
    id: 'history-original',
    timestamp: '2026-10-23T01:00:00Z',
    actor: 'alice',
    type: 'status_changed',
    from: 'pending',
    to: 'in_progress',
  },
] as const;
function fixture() {
  let current = true;
  let logs: HostMemberActivityLog[] = [
    {
      kind: 'host_activity',
      sessionId: 'host-activity-original',
      memberId: 'alice-id',
      memberName: 'alice',
      generation: 'original-generation',
      taskId: 'task-original',
      description: 'Captured runtime activity',
      startTime: null,
      durationMs: null,
      messageCount: 1,
      isOngoing: false,
      gaps: [],
      events: [
        {
          eventId: 'source:2',
          sequence: 2,
          inputId: 'original-input',
          data: {
            kind: 'text',
            messageRef: 'message-original',
            block: 0,
            text: 'retained original output',
            phase: 'complete',
          },
        },
        {
          eventId: 'source:3',
          sequence: 3,
          inputId: 'original-input',
          data: { kind: 'tool-result', toolRef: 'tool-original', content: 'exit 7', isError: true },
        },
        {
          eventId: 'source:6',
          sequence: 6,
          inputId: 'another-original-input',
          data: { kind: 'gap', reason: 'storage' },
        },
      ],
    },
  ];
  const invoke = vi.fn<AgentBackendApi['invoke']>().mockImplementation(async (request) => {
    if (request.operation === 'team.activity.logs.read')
      return { ok: true, value: { kind: 'team-activity-logs', logs: structuredClone(logs) } };
    if (request.operation === 'team.roster.read')
      return { ok: true, value: { revision: 'roster-original', members: [], removedMembers: [] } };
    throw new Error('Unexpected effect dispatch');
  });
  const backend: AgentBackendApi = { invoke, getConnections: vi.fn() };
  const readTask = vi.fn<Parameters<typeof createHostTaskActivityApi>[0]['readTask']>()
    .mockImplementation(async (key, taskId, check, assertCurrent) => {
      expect(key).toBe('host-team:original');
      expect(taskId).toBe('task-original');
      expect(check()).toBe(true);
      assertCurrent();
      return {
        id: taskId, subject: 'Original task', status: 'in_progress', owner: 'bob',
        historyEvents: [...history],
      };
    });
  const api = createHostTaskActivityApi({
    backend,
    readTask,
    captureScope: () => () => current,
    async resolve(key, check) {
      expect(key).toBe('host-team:original');
      expect(check()).toBe(true);
      return {
        handle: { handleId: 'original' },
        assertCurrent() {
          if (!current) throw new Error('Context revoked');
        },
      };
    },
  });
  return {
    api,
    invoke,
    readTask,
    get logs() {
      return logs;
    },
    set logs(value) {
      logs = value;
    },
    revoke() {
      current = false;
    },
  };
}
describe('Host Task Activity original read scope', () => {
  it('serves all six original APIs from task-scoped facts after reassignment without fake transcript fields', async () => {
    const f = fixture();
    const activity = await f.api.getTaskActivity('host-team:original', 'task-original');
    expect(activity.historyEvents).toEqual(history);
    expect(activity.items).toHaveLength(2);
    const summary = activity.items[0]!;
    expect(summary.memberId).toBe('alice-id');
    expect(summary.memberName).toBe('alice');
    expect(summary.inputId).toBe('original-input');
    expect(summary.sourceGeneration).toMatch(/^[a-f0-9]{64}$/);
    const detail = await f.api.getTaskActivityDetail(
      'host-team:original',
      'task-original',
      summary.id
    );
    expect(detail.status).toBe('ok');
    if (detail.status !== 'ok') throw new Error('Expected original detail');
    expect(detail.detail.log.events.map((event) => event.eventId)).toEqual([
      'source:2',
      'source:3',
    ]);
    expect(detail.detail.log.startTime).toBeNull();
    expect(detail.detail.log.durationMs).toBeNull();
    expect(detail.detail.log.events[1]!.data).toMatchObject({ kind: 'tool-result', isError: true });
    expect(await f.api.getTaskLogStreamSummary('host-team:original', 'task-original')).toEqual({
      segmentCount: 2,
    });
    expect((await f.api.getTaskLogStream('host-team:original', 'task-original')).logs).toEqual(
      f.logs
    );
    const exact = await f.api.getTaskExactLogSummaries('host-team:original', 'task-original');
    expect(exact.items).toEqual(activity.items);
    expect(
      await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        summary.id,
        summary.sourceGeneration
      )
    ).toEqual(detail);
    await f.api.setTaskLogStreamTracking('host-team:original', true);
    for (const [request] of f.invoke.mock.calls) {
      expect(request.handle).toEqual({ handleId: 'original' });
      expect(['team.activity.logs.read', 'team.roster.read']).toContain(
        request.operation
      );
      if (request.operation !== 'team.roster.read')
        expect(request.payload).toEqual({ taskId: 'task-original' });
    }
    const bytes = JSON.stringify({ activity, detail, exact });
    for (const field of ['filePath', 'messageUuid', 'chunks', 'startTimestamp', 'endTimestamp'])
      expect(bytes).not.toContain(field);
  });
  it('counts thinking and output once per message within each original input and retains their exact bytes', async () => {
    const f = fixture(),
      log = f.logs[0]!;
    log.events.push(
      {
        eventId: 'source:7',
        sequence: 7,
        inputId: 'original-input',
        data: {
          kind: 'thinking',
          messageRef: 'message-original',
          block: 1,
          text: 'Retained thought',
          phase: 'snapshot',
        },
      },
      {
        eventId: 'source:8',
        sequence: 8,
        inputId: 'original-input',
        data: {
          kind: 'thinking',
          messageRef: 'message-original',
          block: 1,
          text: 'Retained final thought',
          phase: 'complete',
        },
      },
      {
        eventId: 'source:9',
        sequence: 9,
        inputId: 'original-input',
        data: {
          kind: 'thinking',
          messageRef: 'thinking-only',
          block: 0,
          text: 'Another message',
          phase: 'complete',
        },
      },
      {
        eventId: 'source:10',
        sequence: 10,
        inputId: 'another-original-input',
        data: {
          kind: 'thinking',
          messageRef: 'message-original',
          block: 0,
          text: 'Other input thought',
          phase: 'complete',
        },
      }
    );
    const exact = await f.api.getTaskExactLogSummaries('host-team:original', 'task-original');
    expect(exact.items.map((row) => [row.inputId, row.messageCount])).toEqual([
      ['original-input', 2],
      ['another-original-input', 1],
    ]);
    const original = exact.items[0]!;
    const detail = await f.api.getTaskExactLogDetail(
      'host-team:original',
      'task-original',
      original.id,
      original.sourceGeneration
    );
    expect(detail.status).toBe('ok');
    if (detail.status !== 'ok') throw new Error('Expected original detail');
    expect(detail.detail.log.events).toEqual(
      log.events.filter((event) => event.inputId === 'original-input')
    );
    const thought = log.events.find((event) => event.eventId === 'source:8')!.data;
    if (thought.kind !== 'thinking') throw new Error('Expected thinking');
    thought.text = 'Changed retained thought';
    expect(
      await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        original.id,
        original.sourceGeneration
      )
    ).toEqual({ status: 'stale' });
  });
  it('does not attribute member-only stderr to exact task input details or message counts', async () => {
    const f = fixture();
    const before = await f.api.getTaskExactLogSummaries('host-team:original', 'task-original');
    f.logs[0]!.events.push({
      eventId: 'source:7',
      sequence: 7,
      data: { kind: 'process-output', stream: 'stderr', text: 'TEST member-only stderr' },
    });
    const after = await f.api.getTaskExactLogSummaries('host-team:original', 'task-original');
    expect(after).toEqual(before);
    for (const summary of after.items) {
      const detail = await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        summary.id,
        summary.sourceGeneration
      );
      expect(detail.status).toBe('ok');
      expect(JSON.stringify(detail)).not.toContain('TEST member-only stderr');
    }
    expect(
      f.invoke.mock.calls.every(([request]) => request.operation === 'team.activity.logs.read')
    ).toBe(true);
  });

  it('counts output and thinking once per original input while preserving child facts and exact byte freshness', async () => {
    const f = fixture();
    const thinking: Extract<HostActivityContent, { kind: 'thinking' }> = {
      kind: 'thinking', messageRef: 'message-original', block: 1, text: 'Observed thought', phase: 'complete',
    };
    const child: HostMemberActivityLog['events'][number]['data'] = {
      kind: 'subagent', phase: 'fact', childId: 'child-' + 'a'.repeat(64),
      parentToolRef: 'tool-' + 'b'.repeat(64), fact: thinking,
    };
    f.logs[0]!.events.push(
      { eventId: 'source:7', sequence: 7, inputId: 'original-input', data: thinking },
      { eventId: 'source:8', sequence: 8, inputId: 'original-input',
        data: { ...thinking, messageRef: 'thinking-only' } },
      { eventId: 'source:9', sequence: 9, inputId: 'another-original-input', data: thinking },
      { eventId: 'source:10', sequence: 10, inputId: 'original-input', data: child }
    );
    const exact = await f.api.getTaskExactLogSummaries('host-team:original', 'task-original');
    expect(exact.items.map((item) => [item.inputId, item.messageCount])).toEqual([
      ['original-input', 2], ['another-original-input', 1],
    ]);
    const summary = exact.items[0]!;
    const detail = await f.api.getTaskExactLogDetail(
      'host-team:original', 'task-original', summary.id, summary.sourceGeneration
    );
    expect(detail.status).toBe('ok');
    if (detail.status !== 'ok') throw new Error('Expected original detail');
    expect(detail.detail.log.events.map((event) => event.data.kind)).toEqual([
      'text', 'tool-result', 'thinking', 'thinking', 'subagent',
    ]);
    expect(detail.detail.log.events.at(-1)!.data).toEqual(child);
    expect(detail.detail.log.lastOutputPreview).toBeUndefined();
    thinking.text = 'Changed retained thought';
    expect(await f.api.getTaskExactLogDetail(
      'host-team:original', 'task-original', summary.id, summary.sourceGeneration
    )).toEqual({ status: 'stale' });
    expect(f.invoke.mock.calls.every(([request]) => request.operation === 'team.activity.logs.read')).toBe(true);
  });

  it('accepts member stderr but refuses the same anonymous fact before a Task stream accepts it', async () => {
    const f = fixture();
    const stderr: HostMemberActivityLog['events'][number] = {
      sequence: 7,
      eventId: 'source:7',
      data: { kind: 'process-output', stream: 'stderr', text: 'TEST member diagnostic' },
    };
    f.logs[0]!.events.push(stderr);
    const memberLogs = structuredClone(f.logs);
    delete memberLogs[0]!.taskId;
    const request = {
      handle: { handleId: 'original' },
      commandId: 'read',
      operation: 'team.activity.logs.read' as const,
      payload: { memberName: 'alice' },
    };
    expect(
      projectBackendResult(request, {
        ok: true,
        value: { kind: 'team-activity-logs', logs: memberLogs },
      })
    ).toMatchObject({
      ok: true,
      value: { logs: [{ events: expect.arrayContaining([stderr]) }] },
    });
    expect(() =>
      projectBackendResult(
        { ...request, payload: { taskId: 'task-original' } },
        { ok: true, value: { kind: 'team-activity-logs', logs: f.logs } }
      )
    ).toThrow('Unattributed process output in task logs');
    f.invoke.mockImplementation(async (selected) =>
      projectBackendResult(selected, {
        ok: true,
        value: { kind: 'team-activity-logs', logs: f.logs },
      })
    );
    await expect(f.api.getTaskLogStream('host-team:original', 'task-original')).rejects.toThrow(
      'Unattributed process output in task logs'
    );
    await expect(
      f.api.getTaskExactLogSummaries('host-team:original', 'task-original')
    ).rejects.toThrow('Unattributed process output in task logs');
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(
      f.invoke.mock.calls.every(([selected]) => selected.operation === 'team.activity.logs.read')
    ).toBe(true);
  });

  it('refuses exact detail after retention/content change, never selects foreign or missing input', async () => {
    const f = fixture();
    const original = (await f.api.getTaskExactLogSummaries('host-team:original', 'task-original'))
      .items[0]!;
    f.logs[0]!.events[0]!.data = {
      kind: 'text',
      messageRef: 'message-original',
      block: 0,
      text: 'changed retained bytes',
      phase: 'complete',
    };
    expect(
      await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        original.id,
        original.sourceGeneration
      )
    ).toEqual({ status: 'stale' });
    f.logs[0]!.events.shift();
    f.logs[0]!.gaps = ['retention'];
    expect(
      await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        original.id,
        original.sourceGeneration
      )
    ).toEqual({ status: 'stale' });
    expect(
      await f.api.getTaskActivityDetail('host-team:original', 'task-original', 'foreign-source')
    ).toEqual({ status: 'missing' });
    f.logs[0]!.events = [];
    expect(
      await f.api.getTaskExactLogDetail(
        'host-team:original',
        'task-original',
        original.id,
        original.sourceGeneration
      )
    ).toEqual({ status: 'missing' });
    f.logs[0]!.taskId = 'foreign-task';
    await expect(f.api.getTaskLogStream('host-team:original', 'task-original')).rejects.toThrow();
  });
  it('rejects delayed read and tracking after original scope revocation with no fallback/effect', async () => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => {
      f.revoke();
      return { ok: true, value: { kind: 'team-activity-logs', logs: f.logs } };
    });
    await expect(f.api.getTaskActivity('host-team:original', 'task-original')).rejects.toThrow(
      'Context revoked'
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const tracking = fixture();
    tracking.invoke.mockImplementationOnce(async () => {
      tracking.revoke();
      return { ok: true, value: { revision: 'old', members: [], removedMembers: [] } };
    });
    await expect(
      tracking.api.setTaskLogStreamTracking('host-team:original', false)
    ).rejects.toThrow('Context revoked');
    expect(tracking.invoke).toHaveBeenCalledTimes(1);
    const task = fixture();
    task.invoke.mockImplementationOnce(async () => ({
      ok: true,
      value: { kind: 'team-activity-logs', logs: task.logs },
    }));
    task.readTask.mockImplementationOnce(async () => {
      task.revoke();
      return { id: 'task-original', subject: 'Original task', status: 'completed' };
    });
    await expect(task.api.getTaskActivity('host-team:original', 'task-original')).rejects.toThrow(
      'Context revoked'
    );
    expect(task.invoke).toHaveBeenCalledTimes(1);
    expect(task.readTask).toHaveBeenCalledTimes(1);
  });
  it.each([null, { id: 'foreign-task', subject: 'Foreign task', status: 'pending' as const }])(
    'refuses missing or foreign paged task history instead of publishing an empty success', async (task) => {
      const f = fixture();
      f.readTask.mockResolvedValueOnce(task);
      await expect(f.api.getTaskActivity('host-team:original', 'task-original')).rejects.toMatchObject({
        code: 'invalid-result', outcome: 'unknown',
      });
    }
  );
  it('preserves paged task refusal and distinguishes absent canonical history from empty history', async () => {
    const f = fixture();
    f.readTask.mockRejectedValueOnce(new HostTeamOperationError('forbidden', 'not-dispatched'));
    await expect(f.api.getTaskActivity('host-team:original', 'task-original')).rejects.toMatchObject({
      code: 'forbidden', outcome: 'not-dispatched',
    });
    f.readTask.mockResolvedValueOnce({ id: 'task-original', subject: 'Original task', status: 'pending' });
    const activity = await f.api.getTaskActivity('host-team:original', 'task-original');
    expect(activity).not.toHaveProperty('historyEvents');
    expect(activity.gaps).toContain('Canonical task history is unavailable.');
  });
  it('revalidates original scope after the source-generation hash await', async () => {
    const f = fixture();
    let release!: (bytes: ArrayBuffer) => void;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        })
    );
    try {
      const pending = f.api.getTaskLogStream('host-team:original', 'task-original');
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      f.revoke();
      release(new ArrayBuffer(32));
      await expect(pending).rejects.toThrow('Context revoked');
      expect(f.invoke).toHaveBeenCalledTimes(1);
    } finally {
      digest.mockRestore();
    }
  });
  it('projects only canonical known history and refuses unsupported/duplicate/invalid clock records', () => {
    expect(projectTaskHistory([{ ...history[0], privateNative: 'SECRET' }])).toEqual(history);
    const request = {
      handle: { handleId: 'original' },
      commandId: 'read',
      operation: 'task.get' as const,
      payload: { taskId: 'task-original' },
    };
    const projected = projectBackendResult(request, {
      ok: true,
      value: {
        id: 'task-original',
        status: 'in_progress',
        historyEvents: [{ ...history[0], privateNative: 'SECRET' }],
      },
    });
    expect(projected).toMatchObject({ ok: true, value: { historyEvents: history } });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(() => projectTaskHistory([{ ...history[0], type: 'unknown' }])).toThrow();
    expect(() => projectTaskHistory([history[0], history[0]])).toThrow();
    expect(() =>
      projectTaskHistory([{ ...history[0], timestamp: 'invented native clock' }])
    ).toThrow();
    expect(() => projectTaskHistory([{ ...history[0], from: 'unknown' }])).toThrow();
  });
});
