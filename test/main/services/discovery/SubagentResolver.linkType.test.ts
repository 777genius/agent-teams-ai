/**
 * Tests for SubagentResolver linkType assignment.
 *
 * Verifies:
 * - Phase 1: agentId match → linkType 'agent-id'
 * - Phase 2: teammate_id match → linkType 'team-member-id'
 * - Unmatched subagents → linkType 'unlinked'
 * - No positional fallback (Phase 3 removed)
 * - propagateTeamMetadata → linkType 'parent-chain'
 * - Different description but same teammate_id still matches
 */

import { SubagentResolver } from '@main/services/discovery/SubagentResolver';
import { describe, expect, it } from 'vitest';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { ParsedMessage, Process, ToolCall } from '@main/types';

// =============================================================================
// Helpers
// =============================================================================

function msg(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 9)}`,
    parentUuid: null,
    type: 'user',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    content: '',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function subagent(overrides: Partial<Process> & { id: string }): Process {
  return {
    filePath: `/path/${overrides.id}.jsonl`,
    parentTaskId: undefined,
    isParallel: false,
    startTime: new Date('2026-01-01T00:00:05Z'),
    endTime: new Date('2026-01-01T00:00:55Z'),
    durationMs: 50_000,
    messages: [],
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      messageCount: 0,
      durationMs: 0,
    },
    ...overrides,
  };
}

function extractTaskCalls(messages: ParsedMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls) {
      if (tc.isTask) calls.push(tc);
    }
  }
  return calls;
}

type LinkToTaskCalls = (
  subagents: Process[],
  taskCalls: ToolCall[],
  messages: ParsedMessage[]
) => void;
type IsWarmupSubagent = (messages: ParsedMessage[]) => boolean;
type PropagateTeamMetadata = (subagents: Process[]) => void;

// =============================================================================
// Tests
// =============================================================================

describe('SubagentResolver.linkType', () => {
  const resolver = new SubagentResolver({} as ProjectScanner);

  // Access private method via prototype for testing
  const linkToTaskCalls = (
    resolver as unknown as { linkToTaskCalls: LinkToTaskCalls }
  ).linkToTaskCalls.bind(resolver);
  const isWarmupSubagent = (
    resolver as unknown as { isWarmupSubagent: IsWarmupSubagent }
  ).isWarmupSubagent.bind(resolver);

  describe('warmup detection', () => {
    it('detects real warmup subagents from the first authored user message', () => {
      expect(
        isWarmupSubagent([
          msg({
            type: 'user',
            content: 'Warmup',
          }),
        ])
      ).toBe(true);
    });

    it('ignores synthetic replay rows when detecting warmup subagents', () => {
      expect(
        isWarmupSubagent([
          msg({
            type: 'user',
            content: 'Warmup',
            isMeta: true,
            isReplay: true,
            isSynthetic: true,
          }),
          msg({
            type: 'user',
            content: 'Real subagent prompt',
          }),
        ])
      ).toBe(false);
    });
  });

  describe('Phase 1: agent-id matching', () => {
    it('sets linkType to agent-id when agentId matches subagent id', () => {
      const subagentId = 'abc-123-def';
      const taskCallId = 'task-call-1';

      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            { type: 'text', text: 'spawning' },
            { type: 'tool_use', id: taskCallId, name: 'Task', input: { prompt: 'explore' } },
          ],
          toolCalls: [
            {
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'explore' },
              isTask: true,
              taskDescription: 'explore',
              taskSubagentType: 'Explore',
            },
          ],
        }),
        // Tool result with agentId linking back to subagent
        msg({
          type: 'user',
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: taskCallId, content: 'done' }],
          toolResults: [{ toolUseId: taskCallId, content: 'done', isError: false }],
          sourceToolUseID: taskCallId,
          toolUseResult: { agentId: subagentId },
        }),
      ];

      const sub = subagent({ id: subagentId });
      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('agent-id');
      expect(sub.parentTaskId).toBe(taskCallId);
    });
  });

  describe('Phase 2: team-member-id matching', () => {
    it('sets linkType to team-member-id when teammate_id matches input.name', () => {
      const taskCallId = 'task-call-2';
      const memberName = 'researcher';

      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'research', team_name: 'my-team', name: memberName },
            },
          ],
          toolCalls: [
            {
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'research', team_name: 'my-team', name: memberName },
              isTask: true,
              taskDescription: 'research stuff',
              taskSubagentType: 'general-purpose',
            },
          ],
        }),
      ];

      const sub = subagent({
        id: 'team-file-xyz',
        messages: [
          msg({
            type: 'user',
            protocolKind: 'teammate-message',
            content: `<teammate-message teammate_id="${memberName}" color="#ff0000" summary="do research">Hello</teammate-message>`,
          }),
        ],
      });

      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('team-member-id');
      expect(sub.parentTaskId).toBe(taskCallId);
    });

    it('matches by teammate_id even when descriptions differ', () => {
      const taskCallId = 'task-call-3';
      const memberName = 'coder';

      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'write code', team_name: 'team-x', name: memberName },
            },
          ],
          toolCalls: [
            {
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'write code', team_name: 'team-x', name: memberName },
              isTask: true,
              taskDescription: 'COMPLETELY DIFFERENT description',
              taskSubagentType: 'general-purpose',
            },
          ],
        }),
      ];

      const sub = subagent({
        id: 'team-file-abc',
        messages: [
          msg({
            type: 'user',
            content: `<teammate-message teammate_id="${memberName}" color="#00ff00" summary="some other summary">Content</teammate-message>`,
          }),
        ],
      });

      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('team-member-id');
      expect(sub.parentTaskId).toBe(taskCallId);
    });

    it('ignores synthetic replay rows before teammate_id matching', () => {
      const taskCallId = 'task-call-synthetic-prefix';
      const memberName = 'reviewer';

      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'review', team_name: 'team-x', name: memberName },
            },
          ],
          toolCalls: [
            {
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'review', team_name: 'team-x', name: memberName },
              isTask: true,
              taskDescription: 'review',
              taskSubagentType: 'general-purpose',
            },
          ],
        }),
      ];

      const sub = subagent({
        id: 'team-file-with-synthetic-replay',
        messages: [
          msg({
            type: 'user',
            content: 'Human: I tested the feature looks good',
            isMeta: true,
            isReplay: true,
            isSynthetic: true,
          }),
          msg({
            type: 'user',
            content: `Human: <teammate-message teammate_id="${memberName}" color="#00ff00">Review this</teammate-message>`,
          }),
        ],
      });

      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('team-member-id');
      expect(sub.parentTaskId).toBe(taskCallId);
    });

    it('still matches ordinary human replay rows by teammate_id', () => {
      const taskCallId = 'task-call-human-replay';
      const memberName = 'qa';

      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'test', team_name: 'team-x', name: memberName },
            },
          ],
          toolCalls: [
            {
              id: taskCallId,
              name: 'Task',
              input: { prompt: 'test', team_name: 'team-x', name: memberName },
              isTask: true,
              taskDescription: 'test',
              taskSubagentType: 'general-purpose',
            },
          ],
        }),
      ];

      const sub = subagent({
        id: 'team-file-human-replay',
        messages: [
          msg({
            type: 'user',
            isReplay: true,
            content: `<teammate-message teammate_id="${memberName}" color="#00ff00">Test this</teammate-message>`,
          }),
        ],
      });

      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('team-member-id');
      expect(sub.parentTaskId).toBe(taskCallId);
    });
  });

  describe('unlinked subagents', () => {
    it('sets linkType to unlinked when no match found', () => {
      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'task-call-x',
              name: 'Task',
              input: { prompt: 'something' },
            },
          ],
          toolCalls: [
            {
              id: 'task-call-x',
              name: 'Task',
              input: { prompt: 'something' },
              isTask: true,
              taskDescription: 'something',
              taskSubagentType: 'Explore',
            },
          ],
        }),
      ];

      // Subagent with no matching agentId and no teammate_id
      const sub = subagent({
        id: 'orphan-agent',
        messages: [msg({ type: 'user', content: 'plain message without teammate tag' })],
      });

      linkToTaskCalls([sub], extractTaskCalls(messages), messages);

      expect(sub.linkType).toBe('unlinked');
      expect(sub.parentTaskId).toBeUndefined();
    });

    it('does NOT use positional fallback (Phase 3 removed)', () => {
      const messages: ParsedMessage[] = [
        msg({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'task-1',
              name: 'Task',
              input: { prompt: 'first task' },
            },
            {
              type: 'tool_use',
              id: 'task-2',
              name: 'Task',
              input: { prompt: 'second task' },
            },
          ],
          toolCalls: [
            {
              id: 'task-1',
              name: 'Task',
              input: { prompt: 'first task' },
              isTask: true,
              taskDescription: 'first',
              taskSubagentType: 'Explore',
            },
            {
              id: 'task-2',
              name: 'Task',
              input: { prompt: 'second task' },
              isTask: true,
              taskDescription: 'second',
              taskSubagentType: 'Plan',
            },
          ],
        }),
      ];

      // Two subagents, neither has agentId match or teammate_id
      const sub1 = subagent({
        id: 'sub-1',
        startTime: new Date('2026-01-01T00:00:10Z'),
      });
      const sub2 = subagent({
        id: 'sub-2',
        startTime: new Date('2026-01-01T00:00:20Z'),
      });

      linkToTaskCalls([sub1, sub2], extractTaskCalls(messages), messages);

      // In the old code, sub1 would get task-1 and sub2 would get task-2 by position.
      // Now both should be unlinked.
      expect(sub1.linkType).toBe('unlinked');
      expect(sub2.linkType).toBe('unlinked');
      expect(sub1.parentTaskId).toBeUndefined();
      expect(sub2.parentTaskId).toBeUndefined();
    });
  });

  describe('propagateTeamMetadata linkType', () => {
    it('propagates parent-chain linkType from ancestor', () => {
      // Access private method
      const propagate = (
        resolver as unknown as { propagateTeamMetadata: PropagateTeamMetadata }
      ).propagateTeamMetadata.bind(resolver);

      const parentId = 'parent-last-uuid';

      const parent = subagent({
        id: 'parent-agent',
        parentTaskId: 'task-parent',
        linkType: 'team-member-id',
        messages: [
          msg({
            uuid: parentId,
            type: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          }),
        ],
      });
      parent.team = { teamName: 'my-team', memberName: 'worker', memberColor: '#ff0' };

      const child = subagent({
        id: 'child-agent',
        messages: [
          msg({
            type: 'user',
            parentUuid: parentId,
            content: 'continuation',
          }),
        ],
      });

      propagate([parent, child]);

      expect(child.team).toEqual(parent.team);
      expect(child.linkType).toBe('parent-chain');
      expect(child.parentTaskId).toBe('task-parent');
    });
  });
});
