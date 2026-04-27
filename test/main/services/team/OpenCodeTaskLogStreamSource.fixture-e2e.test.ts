// @vitest-environment node
import { readFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { OpenCodeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';
import { BoardTaskExactLogChunkBuilder } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';

import type { OpenCodeRuntimeTranscriptResponse } from '../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';
import type { ParsedMessage } from '../../../../src/main/types';
import type { BoardTaskLogStreamResponse, TeamTask } from '../../../../src/shared/types';

const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/opencode/relay-works-10-jack-projection-transcript.json'
);

const RELAY_WORKS_10_TASK: TeamTask = {
  id: '0b3a0624-5d66-4067-848e-5a74a1720c0d',
  displayId: '0b3a0624',
  subject: 'Define calculator arithmetic behavior',
  owner: 'jack',
  status: 'completed',
  createdAt: '2026-04-24T20:29:03.133Z',
  updatedAt: '2026-04-24T20:29:34.157Z',
  workIntervals: [
    {
      startedAt: '2026-04-24T20:29:03.133Z',
      completedAt: '2026-04-24T20:29:34.157Z',
    },
  ],
};

const RELAY_WORKS_10_COORDINATION_TASK: TeamTask = {
  id: 'b5534868-0901-4c9e-9296-2b6e2059a08f',
  displayId: 'b5534868',
  subject: 'Split calculator implementation work',
  owner: 'jack',
  status: 'in_progress',
  createdAt: '2026-04-24T20:28:58.000Z',
  updatedAt: '2026-04-24T20:31:21.876Z',
  workIntervals: [
    {
      startedAt: '2026-04-24T20:28:58.000Z',
    },
  ],
};

async function loadFixtureTranscript(): Promise<
  NonNullable<OpenCodeRuntimeTranscriptResponse['transcript']>
> {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as OpenCodeRuntimeTranscriptResponse;
  if (parsed.providerId !== 'opencode' || !parsed.transcript) {
    throw new Error('Invalid OpenCode transcript fixture');
  }
  return parsed.transcript;
}

function flattenRawMessages(response: BoardTaskLogStreamResponse): ParsedMessage[] {
  return response.segments.flatMap((segment) =>
    segment.chunks.flatMap((chunk) => chunk.rawMessages)
  );
}

function serializeContent(message: ParsedMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function serializeProjectedContent(
  transcript: NonNullable<OpenCodeRuntimeTranscriptResponse['transcript']>
): string {
  return JSON.stringify(transcript.logProjection?.messages ?? []);
}

function markerTaskIds(messages: ParsedMessage[], markerNames: Set<string>): Set<string> {
  const taskIds = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.toolCalls) {
      if (!markerNames.has(toolCall.name)) {
        continue;
      }
      const input = toolCall.input;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const taskId = (input as Record<string, unknown>).taskId;
        if (typeof taskId === 'string') {
          taskIds.add(taskId);
        }
      }
    }
  }
  return taskIds;
}

function createSource(params: {
  transcript: NonNullable<OpenCodeRuntimeTranscriptResponse['transcript']>;
  activeTasks?: TeamTask[];
  deletedTasks?: TeamTask[];
  attributionRecords?: OpenCodeTaskLogAttributionRecord[];
}) {
  const bridge = {
    getOpenCodeTranscript: vi.fn(async () => params.transcript),
  };
  const taskReader = {
    getTasks: vi.fn(async () => params.activeTasks ?? [RELAY_WORKS_10_TASK]),
    getDeletedTasks: vi.fn(async () => params.deletedTasks ?? []),
  };
  const attributionStore = {
    readTaskRecords: vi.fn(async () => params.attributionRecords ?? []),
  };
  const source = new OpenCodeTaskLogStreamSource(
    bridge as never,
    { resolve: async () => '/tmp/agent_teams_orchestrator' },
    taskReader as never,
    new BoardTaskExactLogChunkBuilder(),
    attributionStore
  );

  return { source, bridge, taskReader, attributionStore };
}

describe('OpenCodeTaskLogStreamSource real OpenCode fixture e2e', () => {
  it('builds a task log stream from real OpenCode MCP task markers without leaking unrelated tasks', async () => {
    const transcript = await loadFixtureTranscript();
    const { source, bridge } = createSource({ transcript });

    const response = await source.getTaskLogStream('relay-works-10', RELAY_WORKS_10_TASK.id);

    expect(response).not.toBeNull();
    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.runtimeProjection).toMatchObject({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 0,
      fallbackReason: 'task_tool_markers',
    });
    expect(response?.runtimeProjection?.projectedMessageCount).toBeGreaterThanOrEqual(10);
    expect(response?.runtimeProjection?.markerMatchCount).toBeGreaterThanOrEqual(4);
    expect(response?.runtimeProjection?.markerSpanCount).toBe(1);
    expect(response?.participants).toEqual([
      {
        key: 'member:jack',
        label: 'jack',
        role: 'member',
        isLead: false,
        isSidechain: true,
      },
    ]);
    expect(response?.segments).toHaveLength(1);

    const rawMessages = flattenRawMessages(response as BoardTaskLogStreamResponse);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );
    const serialized = rawMessages.map(serializeContent).join('\n');

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'agent-teams_task_start',
        'agent-teams_task_add_comment',
        'agent-teams_task_complete',
      ])
    );
    expect(toolNames).not.toContain('SendMessage');
    expect(serialized).toContain('Calculator behavior: digits 0-9 append to display');
    expect(serialized).toContain('Noted');
    expect(serialized).toContain('Confirmed');
    expect(serialized).not.toContain('Keyboard handlers added');
    expect(serialized).not.toContain('Logic smoke check');
    expect(serialized).not.toContain('#00000000');
    expect(
      markerTaskIds(
        rawMessages,
        new Set([
          'agent-teams_task_start',
          'agent-teams_task_add_comment',
          'agent-teams_task_complete',
        ])
      )
    ).toEqual(new Set([RELAY_WORKS_10_TASK.id]));
    expect(bridge.getOpenCodeTranscript).toHaveBeenCalledWith('/tmp/agent_teams_orchestrator', {
      teamId: 'relay-works-10',
      memberName: 'jack',
      limit: 200,
    });
  });

  it('includes real native OpenCode read/bash tools from a task-scoped runtime projection', async () => {
    const transcript = await loadFixtureTranscript();
    const { source } = createSource({
      transcript,
      activeTasks: [RELAY_WORKS_10_COORDINATION_TASK],
    });

    const response = await source.getTaskLogStream(
      'relay-works-10',
      RELAY_WORKS_10_COORDINATION_TASK.id
    );

    expect(response).not.toBeNull();
    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.runtimeProjection).toMatchObject({
      provider: 'opencode',
      mode: 'heuristic',
      fallbackReason: 'task_tool_markers',
    });
    expect(response?.runtimeProjection?.boardMcpToolCount).toBeGreaterThan(0);
    expect(response?.runtimeProjection?.nativeToolCount).toBeGreaterThanOrEqual(2);

    const rawMessages = flattenRawMessages(response as BoardTaskLogStreamResponse);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );
    const serialized = rawMessages.map(serializeContent).join('\n');

    expect(toolNames).toEqual(expect.arrayContaining(['read', 'bash']));
    expect(toolNames).toEqual(
      expect.arrayContaining(['agent-teams_task_start', 'agent-teams_task_add_comment'])
    );
    expect(serialized).toContain('package.json');
    expect(serialized).toContain('Разбил работу на мелкие задачи');
    expect(toolNames).not.toContain('SendMessage');
  });

  it('uses real attribution UUID bounds before heuristic fallback', async () => {
    const transcript = await loadFixtureTranscript();
    const { source, bridge, attributionStore } = createSource({
      transcript,
      attributionRecords: [
        {
          taskId: RELAY_WORKS_10_TASK.id,
          memberName: 'jack',
          scope: 'member_session_window',
          sessionId: 'ses_23edf9243ffeSNYPWObDloBJyQ',
          startMessageUuid: 'msg_dc12eb246001iUrCHiLxsvZ3mN',
          endMessageUuid: 'msg_dc12ed5ec001OIh5Bh9emN2Utj',
          source: 'launch_runtime',
        },
      ],
    });

    const response = await source.getTaskLogStream('relay-works-10', RELAY_WORKS_10_TASK.id);

    expect(response?.source).toBe('opencode_runtime_attribution');
    expect(response?.runtimeProjection).toEqual({
      provider: 'opencode',
      mode: 'attribution',
      attributionRecordCount: 1,
      projectedMessageCount: 10,
      boardMcpToolCount: 4,
      nativeToolCount: 0,
    });
    expect(response?.defaultFilter).toBe('member:jack');
    expect(response?.segments).toHaveLength(1);

    const rawMessages = flattenRawMessages(response as BoardTaskLogStreamResponse);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );
    const serialized = rawMessages.map(serializeContent).join('\n');

    expect(rawMessages.map((message) => message.uuid)).toEqual([
      'msg_dc12eb246001iUrCHiLxsvZ3mN',
      'msg_dc12eb261001b8MzfjP5WZGwA1',
      'msg_dc12eb261001b8MzfjP5WZGwA1::tool_results',
      'msg_dc12ebe27001UFPOASv4SiAr51',
      'msg_dc12ebe27001UFPOASv4SiAr51::tool_results',
      'msg_dc12ec768001m7G1qMVTexxl2s',
      'msg_dc12ec768001m7G1qMVTexxl2s::tool_results',
      'msg_dc12ece54001bDAaT7Rt1m6OmN',
      'msg_dc12ece54001bDAaT7Rt1m6OmN::tool_results',
      'msg_dc12ed5ec001OIh5Bh9emN2Utj',
    ]);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'agent-teams_task_start',
        'agent-teams_task_add_comment',
        'agent-teams_task_complete',
        'agent-teams_message_send',
      ])
    );
    expect(serialized).toContain('Calculator behavior: digits 0-9 append to display');
    expect(serialized).toContain('Задача #0b3a0624 завершена');
    expect(serialized).not.toContain('Noted');
    expect(serialized).not.toContain('Keyboard handlers added');
    expect(attributionStore.readTaskRecords).toHaveBeenCalledWith(
      'relay-works-10',
      RELAY_WORKS_10_TASK.id
    );
    expect(bridge.getOpenCodeTranscript).toHaveBeenCalledWith('/tmp/agent_teams_orchestrator', {
      teamId: 'relay-works-10',
      memberName: 'jack',
      limit: 500,
    });
  });

  it('can recover a deleted task stream from real OpenCode markers', async () => {
    const transcript = await loadFixtureTranscript();
    const deletedTask = {
      ...RELAY_WORKS_10_TASK,
      status: 'deleted',
    } satisfies TeamTask;
    const { source } = createSource({
      transcript,
      activeTasks: [],
      deletedTasks: [deletedTask],
    });

    const response = await source.getTaskLogStream('relay-works-10', deletedTask.id);

    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.participants[0]?.label).toBe('jack');
    expect(response?.runtimeProjection?.fallbackReason).toBe('task_tool_markers');
    expect(flattenRawMessages(response as BoardTaskLogStreamResponse).length).toBeGreaterThan(0);
  });

  it('does not leak a real OpenCode task stream across explicit team boundaries', async () => {
    const transcript = await loadFixtureTranscript();
    const { source, bridge } = createSource({ transcript });

    const response = await source.getTaskLogStream('other-team', RELAY_WORKS_10_TASK.id);

    expect(response).toBeNull();
    expect(bridge.getOpenCodeTranscript).toHaveBeenCalledWith('/tmp/agent_teams_orchestrator', {
      teamId: 'other-team',
      memberName: 'jack',
      limit: 200,
    });
  });

  it('falls back to real marker projection when stale attribution does not match the session', async () => {
    const transcript = await loadFixtureTranscript();
    const { source, bridge } = createSource({
      transcript,
      attributionRecords: [
        {
          taskId: RELAY_WORKS_10_TASK.id,
          memberName: 'jack',
          scope: 'task_session',
          sessionId: 'stale-session-id',
          startMessageUuid: 'msg_dc12eb246001iUrCHiLxsvZ3mN',
          endMessageUuid: 'msg_dc12ed5ec001OIh5Bh9emN2Utj',
          source: 'reconcile',
        },
      ],
    });

    const response = await source.getTaskLogStream('relay-works-10', RELAY_WORKS_10_TASK.id);

    expect(response?.source).toBe('opencode_runtime_fallback');
    expect(response?.runtimeProjection).toMatchObject({
      provider: 'opencode',
      mode: 'heuristic',
      attributionRecordCount: 1,
      fallbackReason: 'task_tool_markers',
    });
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(
      1,
      '/tmp/agent_teams_orchestrator',
      {
        teamId: 'relay-works-10',
        memberName: 'jack',
        limit: 500,
      }
    );
    expect(bridge.getOpenCodeTranscript).toHaveBeenNthCalledWith(
      2,
      '/tmp/agent_teams_orchestrator',
      {
        teamId: 'relay-works-10',
        memberName: 'jack',
        limit: 200,
      }
    );
  });

  it('captures the OpenCode runtime identity and MCP messaging contract from the real fixture', async () => {
    const transcript = await loadFixtureTranscript();
    const serialized = serializeProjectedContent(transcript);
    const toolNames = (transcript.logProjection?.messages ?? []).flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );

    expect(serialized).toContain('<opencode_runtime_identity>');
    expect(serialized).toContain('runtimeProvider');
    expect(serialized).toContain('opencode');
    expect(serialized).toContain('agent-teams_runtime_bootstrap_checkin');
    expect(serialized).toContain('agent-teams_member_briefing');
    expect(serialized).toContain('agent-teams_message_send');
    expect(serialized).toContain('Do not use SendMessage');
    expect(serialized).toContain('Do not use runtime_deliver_message for ordinary visible replies');
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'agent-teams_runtime_bootstrap_checkin',
        'agent-teams_member_briefing',
        'agent-teams_message_send',
      ])
    );
    expect(toolNames).not.toContain('SendMessage');
    expect(toolNames).not.toContain('runtime_deliver_message');
  });

  it('keeps real OpenCode projected tool results bounded and linked to assistant tool calls', async () => {
    const transcript = await loadFixtureTranscript();
    const projectedMessages = transcript.logProjection?.messages ?? [];
    const assistantToolIds = new Set(
      projectedMessages.flatMap((message) => message.toolCalls.map((toolCall) => toolCall.id))
    );
    const toolResultMessages = projectedMessages.filter(
      (message) => message.toolResults.length > 0
    );

    expect(projectedMessages).toHaveLength(101);
    expect(toolResultMessages.length).toBeGreaterThan(20);
    for (const message of toolResultMessages) {
      expect(message.isMeta).toBe(true);
      expect(message.sourceToolAssistantUUID).toBeTruthy();
      for (const toolResult of message.toolResults) {
        expect(assistantToolIds.has(toolResult.toolUseId)).toBe(true);
        const serializedContent =
          typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content);
        expect(serializedContent.length).toBeLessThanOrEqual(8_200);
      }
    }
  });
});
