import { describe, expect, it, vi } from 'vitest';

import { OpenCodeTaskStallEvidenceSource } from '../../../../../src/main/services/team/stallMonitor/OpenCodeTaskStallEvidenceSource';

import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { TeamTask } from '../../../../../src/shared/types';

function createMessage(
  overrides: Partial<OpenCodeRuntimeTranscriptLogMessage>
): OpenCodeRuntimeTranscriptLogMessage {
  return {
    uuid: 'msg-1',
    parentUuid: null,
    type: 'assistant',
    timestamp: '2026-04-19T12:00:00.000Z',
    content: '',
    isMeta: false,
    sessionId: 'session-open',
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('OpenCodeTaskStallEvidenceSource', () => {
  it('projects OpenCode task marker tools into stall records and exact rows', async () => {
    const task: TeamTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'bob',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-04-19T11:55:00.000Z' }],
    };
    const runtimeBridge = {
      getOpenCodeTranscript: vi.fn(async () => ({
        sessionId: 'session-open',
        logProjection: {
          messages: [
            createMessage({
              uuid: 'msg-native',
              timestamp: '2026-04-19T11:59:00.000Z',
              toolCalls: [
                {
                  id: 'tool-read',
                  name: 'read',
                  input: { filePath: '/tmp/a.ts' },
                  isTask: false,
                },
              ],
            }),
            createMessage({
              uuid: 'msg-start',
              timestamp: '2026-04-19T12:00:00.000Z',
              toolCalls: [
                {
                  id: 'tool-start',
                  name: 'agent-teams_task_start',
                  input: { teamName: 'demo', taskId: 'task-a' },
                  isTask: false,
                },
              ],
            }),
            createMessage({
              uuid: 'msg-foreign',
              timestamp: '2026-04-19T12:01:00.000Z',
              toolCalls: [
                {
                  id: 'tool-foreign',
                  name: 'agent-teams_task_start',
                  input: { teamName: 'other-team', taskId: 'task-a' },
                  isTask: false,
                },
              ],
            }),
          ],
        },
      })),
    };
    const source = new OpenCodeTaskStallEvidenceSource(
      runtimeBridge as never,
      { resolve: vi.fn(async () => '/tmp/orchestrator-cli') }
    );

    const evidence = await source.readEvidence({
      teamName: 'demo',
      tasks: [task],
      providerByMemberName: new Map([['bob', 'opencode']]),
    });

    expect(runtimeBridge.getOpenCodeTranscript).toHaveBeenCalledWith('/tmp/orchestrator-cli', {
      teamId: 'demo',
      memberName: 'bob',
      limit: 500,
    });
    expect(evidence.recordsByTaskId.get('task-a')).toHaveLength(1);
    expect(evidence.recordsByTaskId.get('task-a')?.[0]).toMatchObject({
      timestamp: '2026-04-19T12:00:00.000Z',
      actor: {
        memberName: 'bob',
        role: 'member',
        sessionId: 'session-open',
      },
      action: {
        canonicalToolName: 'task_start',
        toolUseId: 'tool-start',
      },
    });
    const exactRows = [...evidence.exactRowsByFilePath.values()][0] ?? [];
    expect(exactRows.map((row) => row.messageUuid)).toEqual([
      'msg-native',
      'msg-start',
      'msg-foreign',
    ]);
    expect(exactRows[0]?.toolUseIds).toEqual(['tool-read']);
  });

  it('does not call OpenCode when no task owner is an OpenCode member', async () => {
    const runtimeBridge = {
      getOpenCodeTranscript: vi.fn(),
    };
    const binaryResolver = {
      resolve: vi.fn(async () => '/tmp/orchestrator-cli'),
    };
    const source = new OpenCodeTaskStallEvidenceSource(
      runtimeBridge as never,
      binaryResolver
    );

    const evidence = await source.readEvidence({
      teamName: 'demo',
      tasks: [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          subject: 'Task A',
          owner: 'alice',
          status: 'in_progress',
        },
      ],
      providerByMemberName: new Map([['alice', 'codex']]),
    });

    expect(binaryResolver.resolve).not.toHaveBeenCalled();
    expect(runtimeBridge.getOpenCodeTranscript).not.toHaveBeenCalled();
    expect(evidence.recordsByTaskId.size).toBe(0);
  });
});
