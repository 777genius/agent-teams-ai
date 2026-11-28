// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner';
import { createTeamController } from '../../../packages/legacy-agent-host/dist/adapters/team/ControllerAdapter';
import { boundProductCommandReceipt } from '../../../packages/legacy-agent-host/dist/team/boundProductCommandReceipt';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { CommandReceipt, TeamCommand } from '../../../packages/legacy-agent-host/dist/team/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const taskId = (index: number) =>
  '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-large-board-order-')));
  roots.push(root);
  const options: Parameters<typeof createFilesystemTeamOwner>[0] = {
    root,
    binding: {
      backendId: 'TEST-backend',
      teamId: 'TEST-board-owner',
      teamName: 'test-large-board',
    },
    members: [{ name: 'lead', memberId: 'lead-id', role: 'lead' }],
    grants: [
      {
        principalId: 'user',
        memberName: 'user',
        permissions: ['read', 'task.write', 'admin'],
      },
    ],
  };
  const connection = createFilesystemTeamOwner(options).connect('user');
  const tasksDir = createTeamController(root, options.binding.teamName).context.paths.tasksDir;
  if (!tasksDir) throw new Error('TEST task directory unavailable');
  const seed = (count: number) => {
    // Match the real task-file fixture in agent-teams-controller/test/taskStore.test.js.
    mkdirSync(tasksDir, { recursive: true });
    return Array.from({ length: count }, (_, index) => {
      const id = taskId(index);
      const createdAt = new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString();
      writeFileSync(
        join(tasksDir, id + '.json'),
        JSON.stringify({
          id,
          displayId: id,
          subject: 'TEST order task ' + index,
          description: 'TEST board order fixture',
          status: 'pending',
          createdAt,
          updatedAt: createdAt,
        }),
        'utf8'
      );
      return id;
    });
  };
  const boardBytes = () =>
    readFileSync(join(root, 'teams', options.binding.teamName, 'kanban-state.json'), 'utf8');
  return {
    connection,
    seed,
    boardBytes,
    reopen: () => createFilesystemTeamOwner(options).connect('user'),
  };
}

it('keeps all 1001 existing task IDs through Main, canonical Host storage and cold receipt replay', () => {
  const f = fixture();
  // Fill the real TEST task directory before executing the canonical board operation.
  const orderedTaskIds = f.seed(1001).reverse();
  const request = parseBackendOperation({
    handle: { handleId: 'TEST-board-handle' },
    commandId: 'TEST-large-board-1001',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds },
  });
  if (request.operation !== 'task.board.order') throw new Error('TEST wrong operation');
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(40 * 1024);
  const command: TeamCommand = {
    commandId: request.commandId,
    operation: request.operation,
    payload: request.payload,
  };
  const receipt = f.connection.execute(command);
  expect(receipt.phase).toBe('completed');
  const originalReceipt = JSON.stringify(receipt);
  const originalBoard = f.boardBytes();
  expect(JSON.parse(originalBoard)).toMatchObject({ columnOrder: { todo: orderedTaskIds } });
  const acknowledgement = boundProductCommandReceipt(receipt);
  expect(Buffer.byteLength(JSON.stringify({ ok: true, value: acknowledgement }))).toBeLessThanOrEqual(
    768 * 1024
  );
  expect(projectBackendResult(request, { ok: true, value: acknowledgement })).toEqual({
    ok: true,
    value: {
      commandId: command.commandId,
      operation: 'task.board.order',
      phase: 'completed',
    },
  });
  expect(JSON.stringify(receipt)).toBe(originalReceipt);
  const cold = f.reopen();
  expect(cold.execute(command)).toEqual(receipt);
  expect(f.boardBytes()).toBe(originalBoard);
  expect(() =>
    cold.execute({
      ...command,
      payload: { ...command.payload, orderedTaskIds: [...orderedTaskIds].reverse() },
    })
  ).toThrow();
  expect(f.boardBytes()).toBe(originalBoard);
  for (const invalid of [[orderedTaskIds[0]!, orderedTaskIds[0]!], ['../foreign']]) {
    expect(() =>
      cold.execute({
        ...command,
        commandId: 'TEST-invalid-order',
        payload: { ...command.payload, orderedTaskIds: invalid },
      })
    ).toThrow();
    expect(f.boardBytes()).toBe(originalBoard);
  }
  expect(cold.execute(command)).toEqual(receipt);
});

it('bounds a synthetic large board receipt without truncating its original command or result', () => {
  // This is a projection fixture, not execution of a 21000-task effect plan.
  const orderedTaskIds = Array.from({ length: 21000 }, (_, index) => taskId(index)).reverse();
  const request = parseBackendOperation({
    handle: { handleId: 'TEST-board-handle' },
    commandId: 'TEST-large-receipt',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds },
  });
  if (request.operation !== 'task.board.order') throw new Error('TEST wrong operation');
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(1024 * 1024);
  const receipt: CommandReceipt = {
    schemaVersion: 1,
    binding: { backendId: 'TEST-backend', teamId: 'TEST-board-owner', teamName: 'test-large-board' },
    commandId: request.commandId,
    principalId: 'user',
    fingerprint: 'a'.repeat(64),
    command: { commandId: request.commandId, operation: request.operation, payload: request.payload },
    effects: {
      taskId: 'TEST-effect-task',
      commentId: 'TEST-effect-comment',
      messageId: 'TEST-effect-message',
      deliveryId: 'TEST-effect-delivery',
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    phase: 'completed',
    result: {
      teamName: 'test-large-board',
      tasks: {},
      reviewers: [],
      columnOrder: { todo: orderedTaskIds },
    },
  };
  const original = JSON.stringify(receipt);
  expect(Buffer.byteLength(original)).toBeGreaterThan(768 * 1024);
  const acknowledgement = boundProductCommandReceipt(receipt);
  expect(Buffer.byteLength(JSON.stringify({ ok: true, value: acknowledgement }))).toBeLessThanOrEqual(
    768 * 1024
  );
  expect(acknowledgement).not.toHaveProperty('result');
  expect(acknowledgement).not.toHaveProperty('command.payload');
  expect(projectBackendResult(request, { ok: true, value: acknowledgement })).toEqual({
    ok: true,
    value: { commandId: request.commandId, operation: 'task.board.order', phase: 'completed' },
  });
  expect(JSON.stringify(receipt)).toBe(original);
});
