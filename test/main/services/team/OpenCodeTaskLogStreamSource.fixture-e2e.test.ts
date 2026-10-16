// @vitest-environment node
import { readFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { electronTeamPort } from '../../../../scripts/e2e/opencode-native-team-port';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { assertOpenCodeRuntimeStopEffective } from '../../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeStopOutcome';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { BoardTaskExactLogChunkBuilder } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { mapOpenCodeRuntimeTranscriptLogMessageToParsedMessage } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper';
import { OpenCodeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';

import type { OpenCodeRuntimeTranscriptResponse } from '../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';
import type { ParsedMessage } from '../../../../src/main/types';
import type {
  BoardTaskLogStreamResponse,
  TeamProvisioningProgress,
  TeamTask,
} from '../../../../src/shared/types';

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
  it('preserves finite native session-error and same-run Stop facts when the production task chunks drop error metadata', async () => {
    const teamName = 'test-opencode-v1-native-error',
      projectPath = 'C:\\TEST-run\\TEST-project';
    const task = { ...RELAY_WORKS_10_COORDINATION_TASK, owner: 'alice' };
    const transcript = await loadFixtureTranscript();
    const originalUser = transcript.logProjection!.messages!.find(
      (message) => message.type === 'user' && !message.isMeta
    )!;
    const nativeReason = JSON.stringify({
      name: 'APIError',
      data: {
        statusCode: 402,
        code: 'insufficient_credits',
        isRetryable: false,
        message:
          'This request requires more credits. You requested up to 8192 tokens, but can only afford 1200. sk-TEST-secret',
        responseHeaders: { authorization: 'Bearer sk-TEST-secret' },
        url: 'https://TEST-private.invalid/never-publish',
      },
    });
    transcript.logProjection!.messages = [
      {
        ...originalUser,
        uuid: 'TEST-delivered-user',
        agentName: 'alice',
        timestamp: '2026-04-24T20:29:01.000Z',
        content: `Work on task ${task.id}`,
        toolCalls: [],
        toolResults: [],
      },
      {
        ...originalUser,
        uuid: 'TEST-native-assistant::error',
        parentUuid: 'TEST-delivered-user',
        type: 'system',
        timestamp: '2026-04-24T20:29:02.000Z',
        agentName: 'alice',
        isMeta: true,
        level: 'error',
        subtype: 'informational',
        toolCalls: [],
        toolResults: [],
        content: `OpenCode runtime error - APIError: ${nativeReason}`,
      },
    ];
    const { source } = createSource({ transcript, activeTasks: [task] });
    const response = await source.getTaskLogStream(teamName, task.id);
    // SDK emits a native error as a system/meta message. Production chunks drop
    // it as noise, while the delivery ledger still retains its original reason.
    expect(response?.runtimeProjection?.projectedMessageCount).toBe(2);
    expect(flattenRawMessages(response!).map((message) => message.uuid)).toEqual([
      'TEST-delivered-user',
    ]);
    let reason = nativeReason;
    let responseState = 'session_error';
    let emitProgress: (value: TeamProvisioningProgress) => void = () => {};
    const api = {
      config: { addCustomProjectPath: async () => {} },
      teams: {
        onProvisioningProgress: (
          listener: (_event: unknown, value: TeamProvisioningProgress) => void
        ) => {
          emitProgress = (value) => listener(null, value);
          return () => {};
        },
        createTeam: async () => ({ runId: 'TEST-owned-run' }),
        getTask: async () => task,
        getData: async () => ({ tasks: [task], members: [] }),
        getTaskLogStream: async () => response,
        getMessagesPage: async () => ({
          messages: [
            { messageId: 'TEST-delivery', to: 'alice', taskRefs: [{ teamName, taskId: task.id }] },
          ],
          nextCursor: null,
        }),
        getOpenCodeRuntimeDeliveryStatus: async () => ({
          responseState,
          reason,
          attempted: true,
          accepted: true,
          delivered: true,
          responsePending: true,
          ledgerStatus: 'accepted',
          diagnostics: [],
        }),
      },
    };
    const port = electronTeamPort(api as never, teamName, projectPath);
    await port.createTeam({ teamName, cwd: projectPath, providerId: 'opencode', members: [] });
    await port.getData();
    const snapshot = await port.getSafeTaskFailureSnapshot(task.id, 'alice');
    expect(snapshot.log?.turn).toMatchObject({
      observedMessageCount: 1,
      observedTools: [],
      assistantHasToolCalls: null,
    });
    expect(snapshot.deliveries[0]?.nativeSessionFailure).toMatchObject({
      source: 'native_session_error_ledger_reason',
      present: true,
      reportedErrorName: 'APIError',
      providerCode: 'insufficient_credits',
      httpStatus: 402,
      retryable: false,
      signals: ['credits_or_quota'],
      requestedTokens: 8192,
      affordableTokens: 1200,
      maximumContextTokens: null,
      nativeStatusAndUsage: 'not_exposed_by_delivery_ledger',
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /sk-TEST-secret|TEST-private|never-publish|authorization/
    );
    reason =
      'ContextOverflowError: maximum context length is 32000 tokens; requested 40896 tokens. C:\\TEST-private\\never-publish';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
    ).toMatchObject({
      reportedErrorName: 'ContextOverflowError',
      httpStatus: null,
      signals: ['context_limit'],
      maximumContextTokens: 32000,
      resultingTokens: 40896,
    });
    reason = 'private provider reason with arbitrary status 403 and secret sk-TEST-secret';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
    ).toMatchObject({ reportedErrorName: null, httpStatus: null, signals: [] });
    reason = 'x'.repeat(40_000) + ' sk-TEST-secret';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
    ).toMatchObject({ inspectedCharacters: 32768, truncated: true, httpStatus: null });
    responseState = 'responded_plain_text';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
    ).toBeNull();
    const stopFailureMessage = async (message: string) => {
      // Exercise the real three production wrappers, not a copied format string.
      const stopData = await OpenCodeReadinessBridge.prototype.stopOpenCodeTeam.call(
        {
          options: {},
          executeStateChangingCommand: async () => ({
            ok: false,
            error: { kind: 'provider_error', message },
            diagnostics: [],
          }),
        } as never,
        {
          runId: 'TEST-owned-run',
          laneId: 'primary',
          teamId: teamName,
          teamName,
          projectPath,
          expectedCapabilitySnapshotId: null,
          reason: 'user_requested',
        }
      );
      const result = await OpenCodeTeamRuntimeAdapter.prototype.stop.call(
        {
          bridge: { stopOpenCodeTeam: async () => stopData },
          lastProjectPathByTeamName: new Map(),
          providerId: 'opencode',
        } as never,
        {
          runId: 'TEST-owned-run',
          laneId: 'primary',
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          previousLaunchState: null,
          reason: 'user_requested',
          force: true,
        }
      );
      try {
        assertOpenCodeRuntimeStopEffective({
          result,
          laneId: 'primary',
          previousLaunchState: null,
          message: 'OpenCode team did not confirm stop',
          logWarning: () => {},
          isRuntimeProcessAlive: () => false,
        });
      } catch (error) {
        if (error instanceof Error) return error.message;
        throw error;
      }
      throw new Error('Unconfirmed Stop unexpectedly passed');
    };
    const stopProgress: TeamProvisioningProgress = {
      teamName,
      runId: 'TEST-owned-run',
      state: 'failed',
      message: 'OpenCode team stop failed',
      startedAt: '2026-04-24T20:30:00.000Z',
      updatedAt: '2026-04-24T20:30:01.000Z',
      error: await stopFailureMessage(`OpenCode bridge command failed ${nativeReason}`),
    };
    emitProgress({ ...stopProgress, runId: 'foreign-run' });
    emitProgress({ ...stopProgress, message: 'OpenCode launch failed' });
    expect(await port.getSafeStopFailure()).toMatchObject({
      observed: false,
      failure: null,
      diagnosticCodes: [],
      guard: null,
      bridgeFailure: 'unknown',
    });
    emitProgress(stopProgress);
    const stopped = await port.getSafeStopFailure();
    expect(stopped).toMatchObject({
      observation: 'same_run_stop_progress_only',
      observed: true,
      guard: 'stop_not_confirmed',
      diagnosticCodes: ['provider_error'],
      originalStopReasons: ['stop_not_confirmed'],
      bridgeFailure: 'reports_command_failed_message',
      failure: {
        reportedErrorName: 'APIError',
        providerCode: 'insufficient_credits',
        httpStatus: 402,
        affordableTokens: 1200,
      },
    });
    expect(JSON.stringify(stopped)).not.toMatch(
      /sk-TEST-secret|TEST-private|never-publish|authorization/
    );
    emitProgress({ ...stopProgress, error: await stopFailureMessage('SDK failure') });
    expect(await port.getSafeStopFailure()).toMatchObject({
      diagnosticCodes: ['provider_error'],
      bridgeFailure: 'reports_stop_failure_wrapper',
    });
    for (const [message, expected] of [
      [
        'OpenCode lifecycle selected run authority is unavailable',
        'selected_run_authority_unavailable',
      ],
      [
        'OpenCode lifecycle existing lane requires a capability snapshot',
        'existing_capability_required',
      ],
      ['OpenCode Stop inflight; query stopOutcome/reconcileStop', 'stop_contract_inflight'],
      ['OpenCode cleanup host ownership is unavailable', 'cleanup_host_ownership_unavailable'],
      ['OpenCode cleanup endpoint is invalid', 'cleanup_endpoint_invalid'],
      [
        'OpenCode cleanup host process ownership is unavailable',
        'cleanup_process_ownership_unavailable',
      ],
    ]) {
      emitProgress({ ...stopProgress, error: await stopFailureMessage(message!) });
      expect((await port.getSafeStopFailure()).originalStopReasons).toEqual([
        expected,
        'stop_not_confirmed',
      ]);
    }
    port.dispose();
  });

  it('keeps the TEST failure packet distinct for task_get failure and a model stop after a successful task_get', async () => {
    // Retag only the sanitized fixture member for the existing TEST harness.
    const teamName = 'test-opencode-v1-task-diagnostic';
    const transcript = JSON.parse(
      JSON.stringify(await loadFixtureTranscript())
        .replace(/\bjack\b/g, 'alice')
        .replaceAll('relay-works-10', teamName)
    ) as Awaited<ReturnType<typeof loadFixtureTranscript>>;
    const task = { ...RELAY_WORKS_10_COORDINATION_TASK, owner: 'alice' };
    const { source } = createSource({ transcript, activeTasks: [task] });
    const response = await source.getTaskLogStream(teamName, task.id);
    expect(response).not.toBeNull();
    const messages = (transcript.logProjection?.messages ?? [])
      .map(mapOpenCodeRuntimeTranscriptLogMessageToParsedMessage)
      .filter((message): message is ParsedMessage => message !== null);
    const call = messages.find((message) =>
      message.toolCalls.some(
        (tool) => tool.name === 'agent-teams_task_get' && tool.input.taskId === task.id
      )
    );
    const failedCall = messages.find((message) =>
      message.toolCalls.some(
        (tool) =>
          tool.name === 'agent-teams_task_get' &&
          tool.input.taskId === '211e430b-0901-4c9e-9296-2b6e2059a08f'
      )
    );
    expect(call).toBeDefined();
    expect(failedCall).toBeDefined();
    const resultFor = (message: ParsedMessage) =>
      messages.find((candidate) =>
        candidate.toolResults.some((result) => result.toolUseId === message.toolCalls[0]!.id)
      )!;
    const success = resultFor(call!),
      failed = resultFor(failedCall!);
    // The real fixture encodes this MCP execution failure with isError=false.
    expect(failed.toolResults[0]!.isError).toBe(false);
    const baseSegment = response!.segments[0]!,
      baseChunk = baseSegment.chunks[0]!;
    const finalAssistant: ParsedMessage = {
      ...call!,
      uuid: 'TEST-final-assistant',
      toolCalls: [],
      toolResults: [],
      content: 'The task was fetched. sk-TEST-private-secret C:\\TEST-private\\never-publish.txt',
    };
    let rawMessages = [call!, success, finalAssistant];
    const api = {
      teams: {
        onProvisioningProgress: () => () => {},
        getTask: async () => task,
        getData: async () => ({ tasks: [task], members: [] }),
        getTaskLogStream: async () => ({
          ...response!,
          segments: [{ ...baseSegment, chunks: [{ ...baseChunk, rawMessages }] }],
        }),
        getMessagesPage: async () => ({ messages: [], nextCursor: null }),
      },
    };
    const port = electronTeamPort(api as never, teamName, 'C:\\TEST-run\\TEST-project');
    await port.getData(); // Read-only registration of the existing owned task.
    const succeeded = await port.getSafeTaskFailureSnapshot(task.id, 'alice');
    expect(succeeded.log?.turn.observedTools).toEqual([
      expect.objectContaining({
        name: 'task_get',
        state: 'returned',
        resultKind: 'task',
        inputTeamMatches: true,
        inputTaskMatches: true,
        resultErrorFlag: false,
        task: expect.objectContaining({
          idMatches: true,
          ownerMatches: true,
          status: 'in_progress',
        }),
      }),
    ]);
    expect(succeeded.log?.turn.assistantHasToolCalls).toBe(false);
    expect(succeeded.log?.turn.assistantTextClass).toBe('other_text');
    expect(succeeded.log?.turn.nativeFinishAndUsage).toBe('not_exposed_by_task_log');
    expect(JSON.stringify(succeeded)).not.toContain('sk-TEST-private-secret');
    expect(JSON.stringify(succeeded)).not.toContain('never-publish');
    rawMessages = [
      failedCall!,
      failed,
      {
        ...finalAssistant,
        content: 'Task not found. sk-TEST-private-secret C:\\TEST-private\\never-publish.txt',
      },
    ];
    const failure = await port.getSafeTaskFailureSnapshot(task.id, 'alice');
    expect(failure.log?.turn.observedTools).toEqual([
      expect.objectContaining({
        name: 'task_get',
        state: 'reported_error',
        resultKind: 'reported_error_text',
        resultTextClass: 'reports_task_missing',
        inputTaskMatches: false,
        resultErrorFlag: false,
        task: null,
      }),
    ]);
    expect(failure.log?.turn.assistantTextClass).toBe('reports_task_missing');
    expect(JSON.stringify(failure)).not.toContain('sk-TEST-private-secret');
    expect(JSON.stringify(failure)).not.toContain('never-publish');
    rawMessages = [
      call!,
      {
        ...success,
        toolResults: [
          {
            ...success.toolResults[0]!,
            content: JSON.stringify({
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: {
                      code: -32602,
                      message:
                        'Unknown team "TEST-private" requires config.json. sk-TEST-private-secret',
                    },
                  }),
                },
              ],
            }),
          },
        ],
      },
      finalAssistant,
    ];
    const nestedError = await port.getSafeTaskFailureSnapshot(task.id, 'alice');
    expect(nestedError.log?.turn.observedTools).toEqual([
      expect.objectContaining({
        state: 'error',
        resultErrorFlag: false,
        resultKind: 'error_object',
        resultTextClass: 'reports_unknown_team',
        rpcErrorCode: -32602,
        task: null,
      }),
    ]);
    expect(JSON.stringify(nestedError)).not.toContain('sk-TEST-private-secret');
    port.dispose();
  });

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
      sessionId: 'ses_23edf9243ffeSNYPWObDloBJyQ',
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
        sessionId: 'stale-session-id',
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
