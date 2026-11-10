import { describe, expect, it } from 'vitest';

import { processSessionContextWithPhases } from '@renderer/utils/contextTracker';

function aiReadGroup(id: string, turnIndex: number, filePath: string) {
  return {
    id,
    turnIndex,
    startTime: new Date(0),
    endTime: new Date(0),
    durationMs: 0,
    steps: [
      {
        type: 'tool_call',
        content: {
          toolName: 'Read',
          toolInput: { file_path: filePath },
        },
      },
    ],
    tokens: { input: 1000, output: 0, cached: 0 },
    summary: {
      toolCallCount: 1,
      outputMessageCount: 0,
      subagentCount: 0,
      totalDurationMs: 0,
      totalTokens: 1000,
      outputTokens: 0,
      cachedTokens: 0,
    },
    status: 'complete',
    processes: [],
    chunkId: id,
    metrics: {},
    responses: [],
    linkedTools: new Map(),
    displayItems: [],
  } as any;
}

describe('processSessionContextWithPhases Windows paths', () => {
  it('matches validated directory CLAUDE.md data across drive-case and separator differences', () => {
    const { statsMap } = processSessionContextWithPhases(
      [{ type: 'ai', group: aiReadGroup('ai-0', 0, 'c:/repo/src/file.ts') }],
      'C:\\Repo',
      undefined,
      undefined,
      {
        'C:\\Repo\\src\\CLAUDE.md': {
          path: 'C:\\Repo\\src\\CLAUDE.md',
          exists: true,
          charCount: 492,
          estimatedTokens: 123,
        },
      }
    );

    const directoryInjection = statsMap
      .get('ai-0')!
      .newInjections.find(
        (injection) => injection.category === 'claude-md' && injection.source === 'directory'
      );

    expect(directoryInjection?.estimatedTokens).toBe(123);
  });
});
