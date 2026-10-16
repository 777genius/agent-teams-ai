// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { electronTeamPort } from '../../../../scripts/e2e/opencode-native-team-port';
import {
  projectV1NativeTranscript,
  projectV1OfflineCaptureDiagnostic,
  V1_OFFLINE_TRANSCRIPT_SCRIPT,
} from '../../../../scripts/e2e/opencode-native-windows-full';
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
  it('preserves original offline constraint, reader reason and source frame without private errors or raw JSON', () => {
    const packet = projectV1OfflineCaptureDiagnostic({
      stage: 'history_complete',
      constraint: 'history_complete',
      checks: [
        { constraint: 'history_present', passed: true },
        { constraint: 'history_complete', passed: false },
        { constraint: 'raw-private', passed: false },
      ],
      counts: { messages: 3, rawMessages: 3, rawParts: 9, private: 'TEST-secret' },
      reader: {
        historyShape: 'supported',
        historyComplete: false,
        sessionPresent: true,
        unsupportedReasons: ['snapshot-project-worktree-mismatch', 'C:\\TEST-private'],
        diagnostics: [
          'OpenCode SQLite read failed - database is locked C:\\TEST-private\\opencode.db sk-123456789012345678901234567890',
        ],
      },
      error: {
        name: 'Error',
        code: 'SQLITE_BUSY',
        message:
          'database is locked C:\\TEST-private\\opencode.db sk-123456789012345678901234567890',
        stack:
          'Error: private\n at readSession (C:\\TEST-private\\OpenCodeOfflineSessionReader.ts:205:17)',
      },
      stderr: 'never-publish',
    });
    expect(packet).toMatchObject({
      stage: 'history_complete',
      constraint: 'history_complete',
      checks: [
        { constraint: 'history_present', passed: true },
        { constraint: 'history_complete', passed: false },
      ],
      counts: { messages: 3, rawMessages: 3, rawParts: 9 },
      reader: {
        historyComplete: false,
        unsupportedReasons: ['snapshot-project-worktree-mismatch'],
        diagnostics: [expect.stringContaining('database is locked')],
      },
      error: {
        code: 'SQLITE_BUSY',
        detail: expect.stringContaining('database is locked'),
        sourceFrame: { source: 'OpenCodeOfflineSessionReader', line: 205, column: 17 },
      },
    });
    expect(JSON.stringify(packet)).not.toMatch(
      /TEST-private|sk-123|never-publish|raw-private|TEST-secret/
    );
    expect(
      projectV1OfflineCaptureDiagnostic({
        error: {
          message: JSON.stringify({
            headers: { Authorization: 'never-publish' },
            error: { message: 'Original safe cause' },
          }),
        },
      }).error?.detail
    ).toBe('Original safe cause');
    expect(
      projectV1OfflineCaptureDiagnostic({
        error: { message: '{"headers":{"Authorization":"never-publish"}}' },
      }).error?.detail
    ).toBeNull();
    expect(
      projectV1OfflineCaptureDiagnostic({
        error: { code: 'raw-private-code', stack: 'private.ts:2:3' },
      }).error
    ).toMatchObject({ code: null, sourceFrame: null });
  });

  it.skipIf(
    !process.env.OPENCODE_NATIVE_DIAGNOSTIC_SDK_ROOT ||
      !process.env.OPENCODE_NATIVE_DIAGNOSTIC_BUN_PATH
  )(
    'reads native persistence through the actual SDK read-only reader and projector without preparing a profile',
    async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'TEST-native-offline-fixture-'))
      );
      const input = {
        sdkRoot: process.env.OPENCODE_NATIVE_DIAGNOSTIC_SDK_ROOT!,
        dataRoot: path.join(root, 'runtime-data'),
        projectPath: path.join(root, 'TEST-project'),
        teamName: 'test-opencode-native-fixture',
        member: 'alice',
        runId: 'TEST-owned-run',
        sessionId: 'ses_TEST_owned',
        taskId: '04e22e8f-7108-42cc-9e11-850da1036dff',
        output: path.join(root, 'native-private.json'),
      };
      const dbPath = path.join(
        input.dataRoot,
        'opencode/profiles/scope-TEST/data/opencode/opencode.db'
      );
      try {
        await mkdir(path.dirname(dbPath), { recursive: true });
        await mkdir(input.projectPath);
        const db = new DatabaseSync(dbPath);
        db.exec(
          'CREATE TABLE session(id TEXT,project_id TEXT,directory TEXT);CREATE TABLE project(id TEXT,worktree TEXT,vcs TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)'
        );
        db.prepare('INSERT INTO session VALUES(?,?,?)').run(
          input.sessionId,
          'TEST-project',
          input.projectPath
        );
        db.prepare('INSERT INTO project VALUES(?,?,?)').run(
          'TEST-project',
          input.projectPath,
          'git'
        );
        const message = (id: string, time: number, data: unknown) =>
          db
            .prepare('INSERT INTO message VALUES(?,?,?,?,?)')
            .run(id, input.sessionId, time, time, JSON.stringify(data));
        const part = (id: string, messageId: string, time: number, data: unknown) =>
          db
            .prepare('INSERT INTO part VALUES(?,?,?,?,?,?)')
            .run(id, messageId, input.sessionId, time, time, JSON.stringify(data));
        message('msg_user', 1000, { role: 'user', agent: 'teammate', time: { created: 1000 } });
        part('prt_user', 'msg_user', 1000, { type: 'text', text: `Do task ${input.taskId}` });
        message('msg_get', 1100, {
          role: 'assistant',
          agent: 'teammate',
          parentID: 'msg_user',
          finish: 'tool-calls',
          time: { created: 1100, completed: 1200 },
          tokens: { input: 2300, output: 40, reasoning: 12 },
        });
        part('prt_tool', 'msg_get', 1101, {
          type: 'tool',
          callID: 'call_TEST',
          tool: 'agent-teams_task_get',
          state: {
            status: 'error',
            error:
              'Original native task_get failure: permission denied C:\\TEST-private\\never-publish sk-123456789012345678901234567890',
            input: { teamName: input.teamName, taskId: input.taskId },
            time: { start: 1101, end: 1199 },
          },
        });
        message('msg_successor', 1300, {
          role: 'assistant',
          agent: 'teammate',
          parentID: 'msg_user',
          finish: 'error',
          time: { created: 1300, completed: 1400 },
          error: {
            name: 'APIError',
            data: {
              statusCode: 403,
              message:
                'Original provider message: Forbidden C:\\TEST-private\\never-publish sk-123456789012345678901234567890',
              isRetryable: false,
            },
          },
        });
        part('prt_assistant', 'msg_successor', 1300, {
          type: 'text',
          text: 'The tool returned an error and I cannot continue.',
        });
        db.close();
        const record = {
          teamId: input.teamName,
          memberName: input.member,
          laneId: 'primary',
          runId: input.runId,
          projectPath: input.projectPath,
          profileRootKey: 'scope-TEST',
          opencodeSessionId: input.sessionId,
        };
        await writeFile(
          path.join(input.dataRoot, 'opencode/session-store.json'),
          JSON.stringify({
            schemaVersion: 1,
            records: { [`${input.teamName}::primary::alice`]: record },
          })
        );
        const originalDb = await readFile(dbPath);
        const env = {
          ...process.env,
          CLAUDE_MULTIMODEL_DATA_HOME: input.dataRoot,
          OPENCODE_TEST_NATIVE_TRANSCRIPT_INPUT: JSON.stringify(input),
        };
        const config = path.join(root, 'empty-bunfig.toml');
        await writeFile(config, '');
        await promisify(execFile)(
          process.env.OPENCODE_NATIVE_DIAGNOSTIC_BUN_PATH!,
          ['--no-env-file', `--config=${config}`, '--eval', V1_OFFLINE_TRANSCRIPT_SCRIPT],
          { env, cwd: root, timeout: 20_000, maxBuffer: 16_384 }
        );
        expect(await readFile(dbPath)).toEqual(originalDb);
        const packet = projectV1NativeTranscript(
          JSON.parse(await readFile(input.output, 'utf8')),
          input
        );
        expect(packet.messages[0]).toMatchObject({ role: 'user', agent: 'teammate' });
        expect(packet.messages[1]).toMatchObject({
          finishReason: 'tool-calls',
          successorAssistantIndex: 2,
          tokens: { input: 2300, output: 40, reasoning: 12 },
          tools: [
            {
              status: 'errored',
              nativeStatus: 'error',
              error: {
                detail: expect.stringContaining(
                  'Original native task_get failure: permission denied'
                ),
              },
            },
          ],
        });
        expect(packet.messages[2]).toMatchObject({
          finishReason: 'error',
          completedAt: 1400,
          hasError: true,
          error: {
            name: 'APIError',
            httpStatus: 403,
            retryable: false,
            detail: expect.stringContaining('Original provider message: Forbidden'),
          },
        });
        expect(packet.messages[2]?.assistantText).toContain('cannot continue');
        expect(JSON.stringify(packet)).not.toMatch(/TEST-private|never-publish|sk-123/);
        const foreignOutput = path.join(root, 'foreign-private.json');
        await expect(
          promisify(execFile)(
            process.env.OPENCODE_NATIVE_DIAGNOSTIC_BUN_PATH!,
            ['--no-env-file', `--config=${config}`, '--eval', V1_OFFLINE_TRANSCRIPT_SCRIPT],
            {
              env: {
                ...env,
                OPENCODE_TEST_NATIVE_TRANSCRIPT_INPUT: JSON.stringify({
                  ...input,
                  runId: 'foreign-run',
                  output: foreignOutput,
                }),
              },
              cwd: root,
              timeout: 20_000,
              maxBuffer: 16_384,
            }
          )
        ).rejects.toThrow();
        const foreign = JSON.parse(await readFile(foreignOutput, 'utf8'));
        expect(foreign.transcript).toBeUndefined();
        expect(projectV1OfflineCaptureDiagnostic(foreign.captureDiagnostic)).toMatchObject({
          stage: 'store_binding',
          constraint: 'exact_record',
          counts: { session: 1, run: 0, project: 1, exact: 0 },
          error: { name: 'Error', detail: 'exact_record', sourceFrame: { source: 'helper' } },
        });
        const unsupportedDb = new DatabaseSync(dbPath);
        unsupportedDb.exec('DROP TABLE part');
        unsupportedDb.close();
        const unsupportedOutput = path.join(root, 'unsupported-private.json');
        await expect(
          promisify(execFile)(
            process.env.OPENCODE_NATIVE_DIAGNOSTIC_BUN_PATH!,
            ['--no-env-file', `--config=${config}`, '--eval', V1_OFFLINE_TRANSCRIPT_SCRIPT],
            {
              env: {
                ...env,
                OPENCODE_TEST_NATIVE_TRANSCRIPT_INPUT: JSON.stringify({
                  ...input,
                  output: unsupportedOutput,
                }),
              },
              cwd: root,
              timeout: 20_000,
              maxBuffer: 16_384,
            }
          )
        ).rejects.toThrow();
        const unsupported = projectV1OfflineCaptureDiagnostic(
          JSON.parse(await readFile(unsupportedOutput, 'utf8')).captureDiagnostic
        );
        expect(unsupported).toMatchObject({
          stage: 'history_supported',
          constraint: 'history_supported',
          reader: { historyShape: 'unsupported', historyComplete: null, sessionPresent: false },
          error: { name: 'Error', detail: 'history_supported' },
        });
        expect(unsupported.reader?.diagnostics).toContain(
          'unsupported-opencode-history-shape: OpenCode SQLite part.id missing'
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
  it('retains native task_get completion and the actual successor turn, without treating projected tool output as a final response', () => {
    // Canonical fields/statuses follow SDK's committed relay-works-10-jack
    // native transcript fixture, before its display projection adds tool rows.
    const expected = {
      sessionId: 'ses_TEST_owned',
      teamName: 'test-opencode-native-turn',
      taskId: '04e22e8f-7108-42cc-9e11-850da1036dff',
    };
    const native = {
      id: 'msg_TEST_user',
      parentId: null as string | null,
      role: 'user',
      agent: 'teammate',
      createdAt: 1000,
      completedAt: null,
      finishReason: null,
      text: `Work on ${expected.taskId}`,
      toolCalls: [],
      hasError: false,
      errorName: null as string | null,
      errorMessage: null as string | null,
    };
    const tool = {
      callId: 'call_TEST_get',
      toolName: 'agent-teams_task_get',
      status: 'completed',
      input: { teamName: expected.teamName, taskId: expected.taskId },
      startedAt: 1100,
      completedAt: 1200,
      isError: false,
      outputText: 'PRIVATE_TOOL_RESULT_NEVER_EMITTED',
    };
    const transcript = {
      schemaVersion: 1,
      providerId: 'opencode',
      transcript: {
        sessionId: expected.sessionId,
        durableState: 'idle',
        messages: [
          native,
          {
            ...native,
            id: 'msg_TEST_assistant',
            parentId: native.id,
            role: 'assistant',
            createdAt: 1050,
            completedAt: 1300,
            finishReason: 'tool-calls',
            text: 'I will read the assigned task first.',
            toolCalls: [tool],
          },
          {
            ...native,
            id: 'msg_TEST_successor',
            parentId: native.id,
            role: 'assistant',
            createdAt: 1301,
            completedAt: 1400,
            finishReason: 'stop',
            text: 'The task requires a native read tool; it is unavailable. C:\\TEST-private\\secret.txt /tmp/TEST-private/secret.txt sk-123456789012345678901234567890',
          },
        ],
      },
    };
    const packet = projectV1NativeTranscript(transcript, expected);
    expect(packet).toMatchObject({
      taskUserIndex: 0,
      previewPolicy: 'owned_task_get_or_no_tools',
      durableState: 'idle',
      messageCount: 3,
      sessionMatches: true,
    });
    expect(packet.messages[0]).toMatchObject({ agent: 'teammate', role: 'user' });
    expect(packet.messages[1]).toMatchObject({
      parentIndex: 0,
      finishReason: 'tool-calls',
      completedAt: 1300,
      successorAssistantIndex: 2,
      tools: [{ name: 'task_get', status: 'completed', isError: false, completedAt: 1200 }],
    });
    expect(packet.messages[2]).toMatchObject({ finishReason: 'stop', successorAssistantIndex: -1 });
    expect(packet.messages[2]?.assistantText).toContain('native read tool; it is unavailable');
    expect(JSON.stringify(packet)).not.toMatch(
      /PRIVATE_TOOL_RESULT|TEST-private|secret.txt|sk-123/
    );
    transcript.transcript.messages.pop();
    const unfinished = projectV1NativeTranscript(transcript, expected);
    expect(unfinished.messages[1]?.successorAssistantIndex).toBe(-1);
    expect(unfinished.messages[1]?.finishReason).toBe('tool-calls');
    transcript.transcript.messages[1]!.agent = 'teammate-bootstrap';
    expect(projectV1NativeTranscript(transcript, expected).messages[1]?.agent).toBe(
      'teammate-bootstrap'
    );
    tool.status = 'errored';
    tool.isError = true;
    tool.outputText = JSON.stringify({
      name: 'APIError',
      data: {
        statusCode: 402,
        code: 'insufficient_credits',
        isRetryable: false,
        message:
          'Requested up to 8192 tokens, can only afford 1200. sk-TEST-private-123456789012345678901234',
      },
    });
    expect(projectV1NativeTranscript(transcript, expected).messages[1]?.tools[0]).toMatchObject({
      status: 'errored',
      isError: true,
      error: {
        name: 'APIError',
        httpStatus: 402,
        providerCode: 'insufficient_credits',
        retryable: false,
        requestedTokens: 8192,
        affordableTokens: 1200,
      },
    });
    transcript.transcript.messages[1]!.hasError = true;
    transcript.transcript.messages[1]!.errorName = 'APIError';
    transcript.transcript.messages[1]!.errorMessage = tool.outputText;
    expect(projectV1NativeTranscript(transcript, expected).messages[1]?.error).toMatchObject({
      name: 'APIError',
      httpStatus: 402,
      requestedTokens: 8192,
    });
    expect(JSON.stringify(projectV1NativeTranscript(transcript, expected))).not.toContain(
      'sk-TEST-private'
    );
    expect(projectV1NativeTranscript(transcript, expected).messages[1]?.error.detail).toContain(
      'can only afford 1200'
    );
    transcript.transcript.messages.push(
      { ...native, id: 'msg_TEST_unrelated', text: 'Other user' },
      {
        ...native,
        id: 'msg_TEST_other_assistant',
        parentId: 'msg_TEST_unrelated',
        role: 'assistant',
        text: 'PRIVATE_UNRELATED_ASSISTANT',
        errorMessage: 'PRIVATE_OTHER_ERROR',
      }
    );
    expect(projectV1NativeTranscript(transcript, expected).messages[3]).toMatchObject({
      assistantText: null,
      error: { detail: null },
    });
    transcript.transcript.messages.splice(2);
    transcript.transcript.messages[1]!.parentId = 'foreign-user';
    expect(projectV1NativeTranscript(transcript, expected).messages[1]).toMatchObject({
      assistantText: null,
      error: { detail: null },
    });
    transcript.transcript.messages[1]!.parentId = native.id;
    tool.toolName = 'bash';
    expect(projectV1NativeTranscript(transcript, expected)).toMatchObject({
      previewPolicy: 'withheld_unproven_tool_context',
      messages: [{ assistantText: null }, { assistantText: null }],
    });
    tool.toolName = 'agent-teams_task_get';
    tool.input.taskId = 'foreign-task';
    expect(projectV1NativeTranscript(transcript, expected).messages[1]?.assistantText).toBeNull();
    expect(() =>
      projectV1NativeTranscript(transcript, { ...expected, sessionId: 'foreign' })
    ).toThrow();
    transcript.transcript.messages[0]!.text = 'Unrelated owned session message';
    expect(projectV1NativeTranscript(transcript, expected)).toMatchObject({
      taskUserIndex: -1,
      previewPolicy: 'withheld_unproven_tool_context',
    });
  });
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
    const unsupportedParameter =
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
    for (const value of [unsupportedParameter, JSON.stringify(unsupportedParameter)]) {
      reason = value;
      expect(
        (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
      ).toMatchObject({
        parameterFailure: {
          template: 'unsupported_max_tokens',
          parameter: 'max_tokens',
          replacement: 'max_completion_tokens',
        },
      });
    }
    reason = unsupportedParameter + ' sk-TEST-secret';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
        ?.parameterFailure
    ).toBeNull();
    reason = JSON.stringify(unsupportedParameter).padEnd(32768, ' ') + ' sk-TEST-secret';
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
        ?.parameterFailure
    ).toBeNull();
    reason = 'max_tokens'.padEnd(108, ' ');
    expect(
      (await port.getOpenCodeRuntimeDeliveryStatus('TEST-delivery'))?.nativeSessionFailure
        ?.parameterFailure
    ).toBeNull();
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
