/**
 * Tests for ProcessLinker — deterministic parentTaskId-only linking.
 *
 * Verifies:
 * - Subagents with matching parentTaskId are linked to the chunk
 * - Subagents without parentTaskId are NOT linked (no timing fallback)
 * - Subagents with non-matching parentTaskId are NOT linked
 * - Multiple subagents linked and sorted by startTime
 * - Empty subagents array produces empty processes
 * - Empty chunk (no Task calls) links nothing
 * - Duplicate parentTaskId: both subagents linked
 * - Already-populated chunk.processes is appended to
 */

import { describe, expect, it } from 'vitest';

import { linkProcessesToAIChunk } from '../../../../src/main/services/analysis/ProcessLinker';

import type { EnhancedAIChunk, Process, SessionMetrics } from '../../../../src/main/types';

// =============================================================================
// Helpers
// =============================================================================

const baseMetrics: SessionMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  messageCount: 0,
  durationMs: 0,
};

function makeChunk(taskIds: string[]): EnhancedAIChunk {
  return {
    id: 'chunk-1',
    chunkType: 'ai',
    responses: [
      {
        uuid: 'resp-1',
        parentUuid: null,
        type: 'assistant',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        content: [{ type: 'text', text: 'response' }],
        isSidechain: false,
        isMeta: false,
        toolCalls: taskIds.map((id) => ({
          id,
          name: 'Task',
          input: { prompt: 'do stuff' },
          isTask: true,
          taskDescription: 'do stuff',
          taskSubagentType: 'general-purpose',
        })),
        toolResults: [],
      },
    ],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-01-01T00:01:00Z'),
    durationMs: 60_000,
    metrics: { ...baseMetrics },
  };
}

function makeSubagent(overrides: Partial<Process> & { id: string }): Process {
  return {
    filePath: `/path/${overrides.id}.jsonl`,
    parentTaskId: undefined,
    description: 'test',
    subagentType: 'general-purpose',
    isParallel: false,
    startTime: new Date('2026-01-01T00:00:10Z'),
    endTime: new Date('2026-01-01T00:00:50Z'),
    durationMs: 40_000,
    messages: [],
    metrics: { ...baseMetrics },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('linkProcessesToAIChunk', () => {
  it('links subagent with matching parentTaskId', () => {
    const chunk = makeChunk(['task-1']);
    const sub = makeSubagent({ id: 'agent-a', parentTaskId: 'task-1' });

    linkProcessesToAIChunk(chunk, [sub]);

    expect(chunk.processes).toHaveLength(1);
    expect(chunk.processes[0].id).toBe('agent-a');
  });

  it('does NOT link subagent without parentTaskId (no timing fallback)', () => {
    const chunk = makeChunk(['task-1']);
    const sub = makeSubagent({
      id: 'orphan',
      parentTaskId: undefined,
      startTime: new Date('2026-01-01T00:00:30Z'), // within chunk time range
    });

    linkProcessesToAIChunk(chunk, [sub]);

    expect(chunk.processes).toHaveLength(0);
  });

  it('does NOT link subagent with non-matching parentTaskId', () => {
    const chunk = makeChunk(['task-1']);
    const sub = makeSubagent({ id: 'agent-b', parentTaskId: 'task-999' });

    linkProcessesToAIChunk(chunk, [sub]);

    expect(chunk.processes).toHaveLength(0);
  });

  it('links multiple subagents sorted by startTime', () => {
    const chunk = makeChunk(['task-1', 'task-2']);
    const sub1 = makeSubagent({
      id: 'late',
      parentTaskId: 'task-1',
      startTime: new Date('2026-01-01T00:00:30Z'),
    });
    const sub2 = makeSubagent({
      id: 'early',
      parentTaskId: 'task-2',
      startTime: new Date('2026-01-01T00:00:10Z'),
    });

    linkProcessesToAIChunk(chunk, [sub1, sub2]);

    expect(chunk.processes).toHaveLength(2);
    expect(chunk.processes[0].id).toBe('early');
    expect(chunk.processes[1].id).toBe('late');
  });

  it('handles empty subagents array', () => {
    const chunk = makeChunk(['task-1']);

    linkProcessesToAIChunk(chunk, []);

    expect(chunk.processes).toHaveLength(0);
  });

  it('handles chunk with no Task calls', () => {
    const chunk = makeChunk([]);
    const sub = makeSubagent({ id: 'agent-a', parentTaskId: 'task-1' });

    linkProcessesToAIChunk(chunk, [sub]);

    expect(chunk.processes).toHaveLength(0);
  });

  it('links both subagents when they share the same parentTaskId', () => {
    const chunk = makeChunk(['task-1']);
    const sub1 = makeSubagent({
      id: 'a1',
      parentTaskId: 'task-1',
      startTime: new Date('2026-01-01T00:00:20Z'),
    });
    const sub2 = makeSubagent({
      id: 'a2',
      parentTaskId: 'task-1',
      startTime: new Date('2026-01-01T00:00:10Z'),
    });

    linkProcessesToAIChunk(chunk, [sub1, sub2]);

    expect(chunk.processes).toHaveLength(2);
    expect(chunk.processes[0].id).toBe('a2'); // earlier
    expect(chunk.processes[1].id).toBe('a1');
  });

  it('appends to existing chunk.processes', () => {
    const chunk = makeChunk(['task-1']);
    const existing = makeSubagent({ id: 'existing', parentTaskId: 'task-0' });
    chunk.processes.push(existing);

    const sub = makeSubagent({ id: 'new', parentTaskId: 'task-1' });
    linkProcessesToAIChunk(chunk, [sub]);

    // existing + new, sorted by time
    expect(chunk.processes).toHaveLength(2);
  });
});
