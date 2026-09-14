import {
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
} from '@features/team-task-board/contracts/hosted';
import {
  normalizeAndOrderHostedTaskBoardItems,
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskBoardPageRequest,
  parseHostedTaskMutationCommand,
} from '@features/team-task-board/core/domain/policies/hostedTaskBoardPolicy';
import { parseCursor, parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const memberId = parseMemberId(`member_${'b'.repeat(32)}`);
const revision = parseRevision(`revision_${'c'.repeat(64)}`);
const task1 = parseHostedTaskId(`task_${'1'.repeat(32)}`);
const task2 = parseHostedTaskId(`task_${'2'.repeat(32)}`);
const task3 = parseHostedTaskId(`task_${'3'.repeat(32)}`);
const commandId = parseHostedTaskCommandId('command_policy-1');
const sourceGeneration = parseHostedTaskBoardSourceGeneration('generation_policy-1');

const common = {
  schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
  commandId,
  idempotencyKey: 'policy-key-1',
  teamId,
  expectedSourceGeneration: sourceGeneration,
  expectedRevision: revision,
};

describe('hostedTaskBoardPolicy', () => {
  it('parses an exact bounded page request with opaque identities', () => {
    const cursor = parseCursor('cursor_policy-1');
    expect(
      parseHostedTaskBoardPageRequest({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        teamId,
        cursor,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      })
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        teamId,
        cursor,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      },
    });
    expect(
      parseHostedTaskBoardPageRequest({
        schemaVersion: 1,
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        limit: 25,
        projectPath: '/private/project',
      })
    ).toEqual({ ok: false });
    expect(
      parseHostedTaskBoardPageRequest({
        schemaVersion: 1,
        teamId,
        cursor,
        expectedSourceGeneration: null,
        limit: 25,
      })
    ).toEqual({ ok: false });
    expect(
      parseHostedTaskBoardPageRequest({
        schemaVersion: 1,
        teamId,
        cursor: null,
        expectedSourceGeneration: sourceGeneration,
        limit: 25,
      })
    ).toEqual({ ok: false });
  });

  it('normalizes relationship arrays and orders by column, order, then opaque task id', () => {
    const makeItem = (taskId: typeof task1, column: 'todo' | 'in_progress', order: number) => ({
      teamId,
      taskId,
      subject: `Task ${taskId}`,
      description: null,
      status: 'pending' as const,
      ownerId: memberId,
      column,
      order,
      blockedByTaskIds: taskId === task1 ? [task3, task2] : [],
      blocksTaskIds: [],
      relatedTaskIds: [],
    });
    const result = normalizeAndOrderHostedTaskBoardItems(
      [makeItem(task3, 'in_progress', 0), makeItem(task2, 'todo', 5), makeItem(task1, 'todo', 5)],
      teamId
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((item) => item.taskId)).toEqual([task1, task2, task3]);
    expect(result.value[0].blockedByTaskIds).toEqual([task2, task3]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value[0])).toBe(true);
  });

  it('rejects duplicate tasks, self relationships, overlapping relationships, and unsafe fields', () => {
    const item = {
      teamId,
      taskId: task1,
      subject: 'Task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
      blockedByTaskIds: [],
      blocksTaskIds: [],
      relatedTaskIds: [],
    };
    expect(normalizeAndOrderHostedTaskBoardItems([item, item], teamId)).toEqual({
      ok: false,
    });
    expect(
      normalizeAndOrderHostedTaskBoardItems([{ ...item, blockedByTaskIds: [task1] }], teamId)
    ).toEqual({ ok: false });
    expect(
      normalizeAndOrderHostedTaskBoardItems(
        [{ ...item, blockedByTaskIds: [task2], relatedTaskIds: [task2] }],
        teamId
      )
    ).toEqual({ ok: false });
    expect(
      normalizeAndOrderHostedTaskBoardItems([{ ...item, providerId: 'private-provider' }], teamId)
    ).toEqual({ ok: false });
  });

  it.each([
    {
      ...common,
      kind: 'create_task',
      subject: 'Created task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    },
    {
      ...common,
      kind: 'update_details',
      taskId: task1,
      subject: 'Updated subject',
      description: 'Updated description',
    },
    { ...common, kind: 'update_status', taskId: task1, status: 'in_progress' },
    { ...common, kind: 'update_owner', taskId: task1, ownerId: memberId },
    { ...common, kind: 'move_task', taskId: task1, column: 'review', order: 4 },
    {
      ...common,
      kind: 'reorder_column',
      column: 'todo',
      orderedTaskIds: [task3, task1, task2],
    },
    {
      ...common,
      kind: 'update_relationship',
      action: 'add',
      taskId: task1,
      otherTaskId: task2,
      relationship: 'blocks',
    },
  ])('accepts and freezes the $kind command variant', (value) => {
    const parsed = parseHostedTaskMutationCommand(value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe(value.kind);
    expect(Object.isFrozen(parsed.value)).toBe(true);
    if (parsed.value.kind === 'reorder_column') {
      expect(parsed.value.orderedTaskIds).toEqual([task3, task1, task2]);
    }
  });

  it.each([
    { ...common, kind: 'update_status', taskId: task1, status: 'running' },
    {
      ...common,
      kind: 'reorder_column',
      column: 'todo',
      orderedTaskIds: [task1, task1],
    },
    {
      ...common,
      kind: 'update_relationship',
      action: 'add',
      taskId: task1,
      otherTaskId: task1,
      relationship: 'related',
    },
    { ...common, kind: 'update_details', taskId: task1 },
    {
      ...common,
      kind: 'create_task',
      subject: 'x'.repeat(201),
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    },
    { ...common, kind: 'update_owner', taskId: task1, ownerId: memberId, rawError: 'secret' },
  ])('rejects invalid, duplicate, self-linked, oversized, or widened commands', (value) => {
    expect(parseHostedTaskMutationCommand(value)).toEqual({ ok: false });
  });

  it('normalizes only a matching typed receipt and sorts affected IDs', () => {
    const receipt = normalizeHostedTaskMutationReceipt(
      {
        schemaVersion: 1,
        outcome: 'committed',
        commandId,
        teamId,
        sourceGeneration: 'generation_policy-1',
        revision,
        affectedTaskIds: [task2, task1],
      },
      'committed',
      commandId,
      teamId,
      sourceGeneration
    );
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.value.affectedTaskIds).toEqual([task1, task2]);

    expect(
      normalizeHostedTaskMutationReceipt(
        {
          schemaVersion: 1,
          outcome: 'committed',
          commandId,
          teamId,
          sourceGeneration: 'generation_policy-1',
          revision,
          affectedTaskIds: [task1],
          path: '/private',
        },
        'committed',
        commandId,
        teamId,
        sourceGeneration
      )
    ).toEqual({ ok: false });
  });
});
