import { describe, expect, it, vi } from 'vitest';

import { BoardTaskExactLogChunkBuilder } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { filterMessagesForAttribution } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionProjection';
import { OpenCodeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';
import normalizedFixture from '../../../fixtures/opencode/v2-native-task-log.json';

import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';
import type { TeamTask } from '../../../../src/shared/types';

type Fixture = {
  sessionId: string;
  diagnostics: string[];
  logProjection: {
    sessionId: string;
    diagnostics: string[];
    messages: OpenCodeRuntimeTranscriptLogMessage[];
  };
};
// Synthetic native DTO passed through the SDK's real normalizer + log projector; no runtime evidence.
// Exact generator output SHA256: a99ea63ee9454f6dbdac8882bd02c374c04f2e068af6eda4ebfb34ceac2e9ff4.
function fixture(): Fixture {
  return structuredClone(normalizedFixture) as Fixture;
}
function record(): OpenCodeTaskLogAttributionRecord {
  return {
    taskId: 'task-a',
    memberName: 'alice',
    scope: 'member_session_window',
    laneId: 'primary',
    sessionId: fixture().sessionId,
    runId: 'TEST-original-run',
    source: 'delivery_ledger',
    startMessageUuid: 'msg_TESTinput',
  };
}
function project(messages = fixture().logProjection.messages, attribution = record()) {
  return filterMessagesForAttribution(messages, attribution, { nativeParentIdsUnavailable: true });
}
async function service(
  transcript: Fixture,
  attribution: OpenCodeTaskLogAttributionRecord | OpenCodeTaskLogAttributionRecord[] = record(),
  storedRecords: OpenCodeTaskLogAttributionRecord[] = []
) {
  const getOpenCodeTranscript = vi.fn(async (_binaryPath: string, request: { runId?: string }) => {
    if (storedRecords.length > 0 && !request.runId) throw new Error('TEST unbound legacy read');
    return transcript;
  });
  const task = { id: 'task-a', subject: 'TEST', owner: 'alice', status: 'in_progress' } as TeamTask;
  const source = new OpenCodeTaskLogStreamSource(
    { getOpenCodeTranscript } as never,
    { resolve: async () => '/TEST/cli' },
    { getTasks: async () => [task], getDeletedTasks: async () => [] } as never,
    new BoardTaskExactLogChunkBuilder(),
    { readTaskRecords: async () => storedRecords },
    { readTaskRecords: async () => (Array.isArray(attribution) ? attribution : [attribution]) }
  );
  return { response: await source.getTaskLogStream('TEST-team', 'task-a'), getOpenCodeTranscript };
}

describe('V2 native task-log attribution', () => {
  it('retains the actual original native tool/result pairing through mapper, filter, and real chunks', async () => {
    const input = fixture();
    const selected = project(input.logProjection.messages);
    expect(selected.map((message) => message.uuid)).toContain('msg_TESTinput');
    expect(selected.map((message) => message.uuid)).not.toContain('msg_TESTother');
    const calls = selected.flatMap((message) => message.toolCalls);
    const shell = calls.find((call) => call.name === 'shell');
    expect(shell?.input).toEqual({
      command: 'node C:\\TEST-project\\verify.cjs',
      workdir: 'C:\\TEST-project',
    });
    const resultMessage = selected.find((message) =>
      message.toolResults.some((result) => result.toolUseId === shell?.id)
    );
    expect(resultMessage?.sourceToolAssistantUUID).toBe(
      input.logProjection.messages.find((message) =>
        message.toolCalls.some((call) => call.id === shell?.id)
      )?.uuid
    );
    for (const message of selected)
      expect(message.parentUuid).toBe(
        input.logProjection.messages.find((original) => original.uuid === message.uuid)?.parentUuid
      );
    const { response, getOpenCodeTranscript } = await service(input);
    expect(response?.source).toBe('opencode_runtime_attribution');
    expect(response?.segments).toHaveLength(1);
    expect(response?.segments[0]?.actor.sessionId).toBe(input.sessionId);
    const chunks = response?.segments.flatMap((segment) => segment.chunks) ?? [];
    const executions = chunks.flatMap((chunk) =>
      'toolExecutions' in chunk ? chunk.toolExecutions : []
    );
    expect(
      executions.find((execution) => execution.toolCall.id === shell?.id)?.result?.toolUseId
    ).toBe(shell?.id);
    expect(getOpenCodeTranscript).toHaveBeenCalledExactlyOnceWith('/TEST/cli', {
      teamId: 'TEST-team',
      memberName: 'alice',
      laneId: 'primary',
      sessionId: input.sessionId,
      runId: 'TEST-original-run',
      limit: 500,
    });
  });

  it.each(['missing', 'duplicate', 'foreign', 'meta', 'wrong-type', 'order'] as const)(
    'rejects %s original input without a heuristic reread',
    async (failure) => {
      const input = fixture();
      const messages = input.logProjection.messages;
      const original = messages.find((message) => message.uuid === 'msg_TESTinput')!;
      if (failure === 'missing')
        input.logProjection.messages = messages.filter((message) => message !== original);
      if (failure === 'duplicate') messages.push(structuredClone(original));
      if (failure === 'foreign') original.sessionId = 'foreign-session';
      if (failure === 'meta') original.isMeta = true;
      if (failure === 'wrong-type') original.type = 'assistant';
      if (failure === 'order') original.timestamp = '2099-01-01T00:00:00.000Z';
      const { response, getOpenCodeTranscript } = await service(input);
      expect(response?.source).toBe('opencode_runtime_attribution');
      expect(response?.segments).toEqual([]);
      expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    'outer-session',
    'projection-session',
    'missing-record-session',
    'missing-start',
  ] as const)('rejects %s binding without fallback', async (failure) => {
    const input = fixture();
    const attribution = record();
    if (failure === 'outer-session') input.sessionId = 'foreign';
    if (failure === 'projection-session') input.logProjection.sessionId = 'foreign';
    if (failure === 'missing-record-session') delete attribution.sessionId;
    if (failure === 'missing-start') delete attribution.startMessageUuid;
    const { response, getOpenCodeTranscript } = await service(input, attribution);
    expect(response?.segments).toEqual([]);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'prefers the exact ledger over a stored unbound runtime check-in (missing input: %s)',
    async (missingInput) => {
      const input = fixture();
      if (missingInput)
        input.logProjection.messages = input.logProjection.messages.filter(
          (message) => message.uuid !== 'msg_TESTinput'
        );
      const stored: OpenCodeTaskLogAttributionRecord = {
        taskId: 'task-a',
        memberName: ' ALICE ',
        scope: 'member_session_window',
        sessionId: input.sessionId,
        source: 'launch_runtime',
        since: '1970-01-01T00:00:00.001Z',
      };
      const { response, getOpenCodeTranscript } = await service(input, record(), [stored]);
      expect(response?.source).toBe('opencode_runtime_attribution');
      expect(response?.segments).toHaveLength(missingInput ? 0 : 1);
      expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
      expect(getOpenCodeTranscript.mock.calls[0]?.[1].runId).toBe('TEST-original-run');
    }
  );

  it('keeps original runs distinct in attribution deduplication and transcript cache keys', async () => {
    const { response, getOpenCodeTranscript } = await service(fixture(), [
      record(),
      { ...record(), runId: 'TEST-other-run' },
    ]);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(2);
    expect(new Set(response?.segments.map((segment) => segment.id)).size).toBe(2);
    expect(getOpenCodeTranscript.mock.calls.map((call) => call[1].runId)).toEqual([
      'TEST-original-run',
      'TEST-other-run',
    ]);
  });

  it('does not turn an unavailable run-bound transcript into a latest-session read', async () => {
    const { response, getOpenCodeTranscript } = await service(null as never);
    expect(response?.segments).toEqual([]);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
  });

  it('clips at a later native protocol USER while retaining synthetic tool-result USER rows', () => {
    const messages = fixture().logProjection.messages;
    const boundary = messages.find((message) => message.uuid === 'msg_TESTother')!;
    boundary.isMeta = true;
    const selected = project(messages);
    expect(selected.some((message) => message.toolResults.length > 0)).toBe(true);
    expect(selected.some((message) => message.uuid === boundary.uuid)).toBe(false);
    expect(selected.every((message) => message.timestamp <= new Date(boundary.timestamp))).toBe(
      true
    );
  });

  it('retains existing time/end bounds and does not widen V1 parent-chain attribution', () => {
    const messages = fixture().logProjection.messages;
    const selected = project(messages);
    const original = messages.find((message) => message.uuid === 'msg_TESTinput')!;
    expect(
      project(messages, { ...record(), endMessageUuid: original.uuid }).map(
        (message) => message.uuid
      )
    ).toEqual([original.uuid]);
    expect(project(messages, { ...record(), since: '2000-01-01T00:00:00.000Z' })).toEqual([]);
    const legacy = filterMessagesForAttribution(messages, record());
    expect(legacy.filter((message) => !message.isMeta).map((message) => message.uuid)).toEqual([
      original.uuid,
    ]);
    expect(selected.length).toBeGreaterThan(legacy.length);
  });

  it.each(['outer', 'projection'] as const)(
    'requires the %s source marker before admitting parentless assistants',
    async (missing) => {
      const input = fixture();
      if (missing === 'outer') input.diagnostics = [];
      else input.logProjection.diagnostics = [];
      const { response } = await service(input);
      expect(response?.runtimeProjection?.projectedMessageCount).toBe(1);
    }
  );
});
