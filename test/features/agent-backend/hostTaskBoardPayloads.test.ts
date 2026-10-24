import { expect, it, vi } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

const request = (operation: string, payload: unknown) => ({
  handle: { handleId: 'TEST-owner' },
  commandId: 'TEST-command',
  operation,
  payload,
});

it('admits exact existing board order, relationship and clarification controls including explicit clears', () => {
  for (const columnId of ['todo', 'in_progress', 'done', 'review', 'approved']) {
    for (const orderedTaskIds of [[], ['TEST-task-2', 'TEST-task-1']]) {
      const value = request('task.board.order', { columnId, orderedTaskIds });
      expect(parseBackendOperation(value)).toEqual(value);
    }
  }
  for (const type of ['blockedBy', 'blocks', 'related'])
    for (const action of ['add', 'remove']) {
      const value = request('task.relationship', {
        taskId: 'TEST-task-1',
        targetId: 'TEST-task-2',
        type,
        action,
      });
      expect(parseBackendOperation(value)).toEqual(value);
    }
  for (const value of ['lead', 'user', null]) {
    const input = request('task.clarification', { taskId: 'TEST-task-1', value });
    expect(parseBackendOperation(input)).toEqual(input);
  }
});

it('refuses duplicate/oversized orders, unknown choices, authority extras and coercible objects', () => {
  const coercion = vi.fn(() => 'todo');
  for (const [operation, payload] of [
    ['task.board.order', { columnId: 'todo', orderedTaskIds: ['TEST-a', 'TEST-a'] }],
    [
      'task.board.order',
      {
        columnId: 'todo',
        orderedTaskIds: Array.from({ length: 1001 }, (_, index) => `TEST-${index}`),
      },
    ],
    ['task.board.order', { columnId: { toString: coercion }, orderedTaskIds: [] }],
    ['task.board.order', { columnId: 'deleted', orderedTaskIds: [] }],
    [
      'task.relationship',
      { taskId: 'TEST-a', targetId: 'TEST-b', type: 'blocked-by', action: 'add' },
    ],
    [
      'task.relationship',
      { taskId: 'TEST-a', targetId: 'TEST-b', type: 'related', action: 'replace' },
    ],
    ['task.clarification', { taskId: 'TEST-a', value: 'agent' }],
    ['task.clarification', { taskId: 'TEST-a', value: null, principalId: 'TEST-other' }],
  ] as const)
    expect(() => parseBackendOperation(request(operation, payload))).toThrow();
  expect(coercion).not.toHaveBeenCalled();
});

it('projects an existing board receipt without fabricating a task and retains clarification on task receipts', () => {
  const order = parseBackendOperation(
    request('task.board.order', { columnId: 'todo', orderedTaskIds: [] })
  );
  expect(
    projectBackendResult(order, {
      ok: true,
      value: {
        commandId: 'TEST-command',
        phase: 'completed',
        command: { operation: 'task.board.order' },
        result: { teamName: 'TEST-team', tasks: {}, reviewers: [], columnOrder: { todo: [] } },
      },
    })
  ).toEqual({
    ok: true,
    value: { commandId: 'TEST-command', phase: 'completed', operation: 'task.board.order' },
  });
  const clarification = parseBackendOperation(
    request('task.clarification', { taskId: 'TEST-task', value: 'user' })
  );
  expect(
    projectBackendResult(clarification, {
      ok: true,
      value: {
        commandId: 'TEST-command',
        phase: 'completed',
        command: { operation: 'task.clarification' },
        result: { id: 'TEST-task', status: 'pending', needsClarification: 'user' },
      },
    })
  ).toMatchObject({ ok: true, value: { task: { id: 'TEST-task', needsClarification: 'user' } } });
});

it('admits only taskId for direct clear and projects its task receipt without inventing status changes', () => {
  const value = request('task.board.clear', { taskId: 'TEST-task' });
  const parsed = parseBackendOperation(value);
  expect(parsed).toEqual(value);
  for (const payload of [
    {},
    { taskId: 1 },
    { taskId: 'TEST-task', transition: 'status_reset' },
    { taskId: 'TEST-task', actor: 'lead' },
  ])
    expect(() => parseBackendOperation(request('task.board.clear', payload))).toThrow();
  expect(
    projectBackendResult(parsed, {
      ok: true,
      value: {
        commandId: 'TEST-command',
        phase: 'completed',
        command: { operation: 'task.board.clear' },
        result: { id: 'TEST-task', status: 'pending' },
      },
    })
  ).toMatchObject({
    ok: true,
    value: { operation: 'task.board.clear', task: { id: 'TEST-task', status: 'pending' } },
  });
});
