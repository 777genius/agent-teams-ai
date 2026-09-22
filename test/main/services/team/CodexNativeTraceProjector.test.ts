import { describe, expect, it } from 'vitest';

import {
  CodexNativeTraceProjector,
  buildCodexNativeToolSignature,
} from '../../../../src/main/services/team/taskLogs/stream/CodexNativeTraceProjector';

import type {
  CodexNativeTraceEvent,
  CodexNativeTraceRun,
} from '../../../../src/main/services/team/taskLogs/stream/CodexNativeTraceReader';

function run(overrides: Partial<CodexNativeTraceRun> = {}): CodexNativeTraceRun {
  return {
    filePath: '/trace/run-1.jsonl',
    runId: 'run-1',
    teamName: 'vector-room-131313',
    taskId: '8421e1bb-2f3b-4656-9983-6e0fd4b15963',
    ownerName: 'atlas',
    cwd: '/repo',
    startedAt: '2026-05-01T17:10:07.799Z',
    mtimeMs: Date.parse('2026-05-01T17:10:07.799Z'),
    size: 100,
    partial: false,
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<CodexNativeTraceEvent>): CodexNativeTraceEvent {
  return {
    sourceOrder: 1,
    receivedAt: '2026-05-01T17:10:08.000Z',
    projection: null,
    ...overrides,
  };
}

describe('CodexNativeTraceProjector', () => {
  it('projects native command result-only traces into a complete synthetic tool pair', () => {
    const messages = new CodexNativeTraceProjector().project([
      run({
        events: [
          event({
            projection: {
              kind: 'tool_result',
              toolSource: 'native',
              rawItemType: 'command_execution',
              itemId: 'item_1',
              toolName: 'Bash',
              input: { command: 'pwd && ls' },
              result: {
                content: '/repo\nfile.txt\n',
                stdout: '/repo\nfile.txt\n',
                exitCode: 0,
              },
              isError: false,
            },
          }),
        ],
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'assistant',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'pwd && ls' },
        },
      ],
      agentName: 'atlas',
      cwd: '/repo',
    });
    expect(JSON.stringify(messages[0]?.content)).toContain(
      'codex-trace:vector-room-131313:8421e1bb-2f3b-4656-9983-6e0fd4b15963:run-1:item_1'
    );
    expect(messages[1]).toMatchObject({
      type: 'user',
      role: 'user',
      isMeta: true,
      sourceToolUseID:
        'codex-trace:vector-room-131313:8421e1bb-2f3b-4656-9983-6e0fd4b15963:run-1:item_1',
      toolUseResult: {
        content: '/repo\nfile.txt\n',
        stdout: '/repo\nfile.txt\n',
        exitCode: 0,
        toolName: 'Bash',
        isError: false,
      },
    });
  });

  it('deduplicates by native signature without leaving orphan start or result messages', () => {
    const projector = new CodexNativeTraceProjector();
    const traceRun = run({
      events: [
        event({
          sourceOrder: 1,
          projection: {
            kind: 'tool_start',
            toolSource: 'native',
            rawItemType: 'command_execution',
            itemId: 'item_1',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        }),
        event({
          sourceOrder: 2,
          receivedAt: '2026-05-01T17:10:09.000Z',
          projection: {
            kind: 'tool_result',
            toolSource: 'native',
            rawItemType: 'command_execution',
            itemId: 'item_1',
            toolName: 'Bash',
            input: { command: 'pwd' },
            result: { content: '/repo\n' },
          },
        }),
      ],
    });

    expect(projector.project([traceRun])).toHaveLength(2);
    expect(
      projector.project([traceRun], {
        excludeSignatures: new Set([buildCodexNativeToolSignature({ toolName: 'Bash', input: { command: 'pwd' } })!]),
      })
    ).toEqual([]);
  });

  it('qualifies synthetic ids by run id so local Codex item ids do not collide', () => {
    const messages = new CodexNativeTraceProjector().project([
      run({
        runId: 'run-a',
        events: [
          event({
            projection: {
              kind: 'tool_result',
              toolSource: 'native',
              itemId: 'item_1',
              toolName: 'Bash',
              input: { command: 'pwd' },
              result: { content: 'a' },
            },
          }),
        ],
      }),
      run({
        runId: 'run-b',
        events: [
          event({
            receivedAt: '2026-05-01T17:11:08.000Z',
            projection: {
              kind: 'tool_result',
              toolSource: 'native',
              itemId: 'item_1',
              toolName: 'Bash',
              input: { command: 'ls' },
              result: { content: 'b' },
            },
          }),
        ],
      }),
    ]);

    const toolUseIds = messages
      .filter((message) => message.type === 'assistant')
      .map((message) => String(JSON.stringify(message.content)));

    expect(toolUseIds[0]).toContain(':run-a:item_1');
    expect(toolUseIds[1]).toContain(':run-b:item_1');
    expect(new Set(toolUseIds).size).toBe(2);
  });
});
