import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import type { TeamCommand } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';

class InterruptedBoard extends TaskEffectPlan {
  fail = false;
  protected override afterPublish(): void {
    if (this.fail) {
      this.fail = false;
      throw new Error('TEST task board publication interrupted');
    }
  }
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-board-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-board' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const plan = new InterruptedBoard(root, binding.teamName, store);
  const options = {
    root,
    binding,
    store,
    members: ['lead', 'alice', 'bob'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? ('lead' as const) : ('member' as const),
    })),
    grants: ['user', 'alice', 'bob'].map((name) => ({
      principalId: name,
      memberName: name,
      permissions: ['read', 'task.write', 'admin'] as ('read' | 'task.write' | 'admin')[],
    })),
  };
  const owner = createFilesystemTeamOwner({ ...options, taskMutations: plan });
  const human = owner.connect('user');
  const create = (name: string, member: string) =>
    human.execute({
      commandId: `TEST-create-${name}`,
      operation: 'task.create',
      payload: { subject: name, owner: member },
    }).effects.taskId;
  const a = create('First', 'alice'),
    b = create('Second', 'bob'),
    c = create('Third', 'bob');
  const bytes = (id: string) =>
    readFileSync(join(root, 'tasks', binding.teamName, `${id}.json`), 'utf8');
  const boardBytes = () =>
    readFileSync(join(root, 'teams', binding.teamName, 'kanban-state.json'), 'utf8');
  return {
    owner,
    human,
    plan,
    root,
    binding,
    a,
    b,
    c,
    bytes,
    boardBytes,
    reopen: () => createFilesystemTeamOwner(options),
  };
}

function columnOrder(connection: { readSnapshot(): unknown }) {
  return (connection.readSnapshot() as { kanbanState: { columnOrder?: Record<string, string[]> } })
    .kanbanState.columnOrder;
}

// Fails if ordering bypasses canonical persistence, replays after ACK loss or ignores an empty clear.
test('existing column order survives restart and response loss; changed intent conflicts', (t) => {
  const f = fixture(t);
  const command: TeamCommand = {
    commandId: 'TEST-order',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds: [f.b, f.a, f.c] },
  };
  assert.equal(f.human.execute(command).phase, 'completed');
  assert.deepEqual(columnOrder(f.human), { todo: [f.b, f.a, f.c] });
  const bytes = f.boardBytes();
  const reopened = f.reopen().connect('user');
  assert.equal(reopened.execute(command).phase, 'completed');
  assert.equal(f.boardBytes(), bytes);
  assert.throws(
    () => reopened.execute({ ...command, payload: { ...command.payload, orderedTaskIds: [f.a] } }),
    (error) => error instanceof TeamOwnerError && error.code === 'conflict'
  );
  assert.equal(
    reopened.execute({
      commandId: 'TEST-clear-order',
      operation: 'task.board.order',
      payload: { columnId: 'todo', orderedTaskIds: [] },
    }).phase,
    'completed'
  );
  assert.equal(columnOrder(reopened), undefined);
  assert.equal(reopened.execute(command).phase, 'completed');
  assert.equal(columnOrder(reopened), undefined);
});

// Fails if a link only updates one side, allows cycles, or no longer blocks actual task start.
test('canonical task relationships preserve reciprocal links, cycle refusal and completion notifications', (t) => {
  const f = fixture(t);
  const link = (
    id: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related',
    action: 'add' | 'remove' = 'add'
  ) =>
    f.human.execute({
      commandId: id,
      operation: 'task.relationship',
      payload: { taskId, targetId, type, action },
    });
  assert.equal(link('TEST-dependency', f.a, f.b, 'blocks').phase, 'completed');
  assert.deepEqual(f.human.getTask(f.a).blocks, [f.b]);
  assert.deepEqual(f.human.getTask(f.b).blockedBy, [f.a]);
  const before = [f.bytes(f.a), f.bytes(f.b)];
  assert.equal(link('TEST-cycle', f.a, f.b, 'blockedBy').phase, 'rejected');
  assert.equal(link('TEST-self', f.a, f.a, 'related').phase, 'rejected');
  assert.deepEqual([f.bytes(f.a), f.bytes(f.b)], before);
  assert.equal(
    f.owner.connect('bob').execute({
      commandId: 'TEST-blocked-start',
      operation: 'task.lifecycle',
      payload: { taskId: f.b, action: 'start' },
    }).phase,
    'rejected'
  );
  const complete: TeamCommand = {
    commandId: 'TEST-resolve',
    operation: 'task.lifecycle',
    payload: { taskId: f.a, action: 'complete' },
  };
  assert.equal(f.owner.connect('alice').execute(complete).phase, 'completed');
  const notices = f.human.getTask(f.b).comments as { id: string; text: string }[];
  assert.equal(notices.filter((row) => row.id === `dep-resolved-${f.a}-${f.b}`).length, 1);
  assert.match(
    notices.find((row) => row.id === `dep-resolved-${f.a}-${f.b}`)!.text,
    /ready to start/
  );
  const completedBytes = f.bytes(f.b);
  assert.equal(f.owner.connect('alice').execute(complete).phase, 'completed');
  assert.equal(f.bytes(f.b), completedBytes);
  assert.equal(
    f.owner.connect('bob').execute({
      commandId: 'TEST-unblocked-start',
      operation: 'task.lifecycle',
      payload: { taskId: f.b, action: 'start' },
    }).phase,
    'completed'
  );
  assert.equal(link('TEST-related', f.b, f.c, 'related').phase, 'completed');
  assert.deepEqual(f.human.getTask(f.c).related, [f.b]);
  assert.equal(link('TEST-related-remove', f.c, f.b, 'related', 'remove').phase, 'completed');
  assert.deepEqual(f.human.getTask(f.b).related, []);
  assert.deepEqual(f.human.getTask(f.c).related, []);
  assert.equal(link('TEST-unlink', f.b, f.a, 'blockedBy', 'remove').phase, 'completed');
  assert.deepEqual(f.human.getTask(f.a).blocks, []);
  assert.deepEqual(f.human.getTask(f.b).blockedBy, []);
});

// Fails if interrupted bilateral/board publication reruns policy or overwrites a stale preimage.
test('board and relationship recovery publish exact prepared bytes', async (t) => {
  const f = fixture(t);
  const relationship: TeamCommand = {
    commandId: 'TEST-link-crash',
    operation: 'task.relationship',
    payload: { taskId: f.b, targetId: f.c, type: 'related', action: 'add' },
  };
  f.plan.fail = true;
  assert.throws(
    () => f.human.execute(relationship),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  const reopened = f.reopen();
  assert.deepEqual(await reopened.resumeTaskCommands(), [
    { commandId: relationship.commandId, outcome: 'completed' },
  ]);
  assert.deepEqual(reopened.connect('user').getTask(f.b).related, [f.c]);
  assert.deepEqual(reopened.connect('user').getTask(f.c).related, [f.b]);
  const order: TeamCommand = {
    commandId: 'TEST-order-crash',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds: [f.c, f.b, f.a] },
  };
  f.plan.fail = true;
  assert.throws(
    () => f.human.execute(order),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  const board = f.boardBytes();
  const again = f.reopen();
  assert.deepEqual(await again.resumeTaskCommands(), [
    { commandId: order.commandId, outcome: 'completed' },
  ]);
  assert.equal(f.boardBytes(), board);
  assert.deepEqual(columnOrder(again.connect('user')), { todo: [f.c, f.b, f.a] });
});

// Fails if clarification is lost on restart/clearing, deleted tasks are mutable or extra authority fields cross the boundary.
test('clarification remains durable until explicit clear, with strict DTO and current grants', (t) => {
  const f = fixture(t);
  const tools = createTeamMcpTools(f.human);
  for (const value of ['lead', 'user', null] as const) {
    const command: TeamCommand = {
      commandId: `TEST-clarify-${value}`,
      operation: 'task.clarification',
      payload: { taskId: f.a, value },
    };
    assert.notEqual(
      tools.call('task_set_clarification', {
        commandId: command.commandId,
        taskId: f.a,
        value: value ?? 'clear',
      }).isError,
      true
    );
    assert.equal(f.reopen().connect('user').getTask(f.a).needsClarification, value ?? undefined);
    const bytes = f.bytes(f.a);
    assert.equal(f.human.execute(command).phase, 'completed');
    assert.equal(f.bytes(f.a), bytes);
  }
  assert.notEqual(
    tools.call('task_link', {
      commandId: 'TEST-mcp-link',
      taskId: f.b,
      targetId: f.c,
      relationship: 'blocked-by',
    }).isError,
    true
  );
  assert.deepEqual(f.human.getTask(f.b).blockedBy, [f.c]);
  assert.notEqual(
    tools.call('task_unlink', {
      commandId: 'TEST-mcp-unlink',
      taskId: f.b,
      targetId: f.c,
      relationship: 'blocked-by',
    }).isError,
    true
  );
  assert.deepEqual(f.human.getTask(f.c).blocks, []);
  assert.throws(() =>
    tools.call('task_set_clarification', {
      commandId: 'TEST-mcp-forged',
      taskId: f.a,
      value: 'user',
      from: 'lead',
    })
  );
  for (const command of [
    { operation: 'task.clarification', payload: { taskId: f.a, value: 'clear' } },
    { operation: 'task.clarification', payload: { taskId: f.a, value: 'user', actor: 'lead' } },
    {
      operation: 'task.relationship',
      payload: { taskId: f.a, targetId: '../foreign', type: 'related', action: 'add' },
    },
    { operation: 'task.board.order', payload: { columnId: 'unknown', orderedTaskIds: [] } },
    { operation: 'task.board.order', payload: { columnId: 'todo', orderedTaskIds: [f.a, f.a] } },
  ])
    assert.throws(
      () => f.human.execute({ commandId: 'TEST-invalid', ...command } as TeamCommand),
      (error) => error instanceof TeamOwnerError && error.code === 'invalid'
    );
  f.human.execute({
    commandId: 'TEST-delete',
    operation: 'task.lifecycle',
    payload: { taskId: f.a, action: 'delete' },
  });
  assert.equal(
    f.human.execute({
      commandId: 'TEST-deleted-clarify',
      operation: 'task.clarification',
      payload: { taskId: f.a, value: 'user' },
    }).phase,
    'rejected'
  );
  f.human.revoke('bob');
  assert.throws(
    () =>
      f.owner.connect('bob').execute({
        commandId: 'TEST-revoked-order',
        operation: 'task.board.order',
        payload: { columnId: 'todo', orderedTaskIds: [] },
      }),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
});

// Fails if resume overwrites foreign bytes after an interrupted canonical order publication.
test('interrupted order recovery holds a changed product preimage without overwriting it', async (t) => {
  const f = fixture(t);
  f.plan.fail = true;
  const command: TeamCommand = {
    commandId: 'TEST-stale-order',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds: [f.b, f.a] },
  };
  assert.throws(
    () => f.human.execute(command),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  const path = join(f.root, 'teams', f.binding.teamName, 'kanban-state.json');
  const foreignBytes = JSON.stringify({
    ...JSON.parse(f.boardBytes()),
    columnOrder: { todo: [f.c] },
  });
  writeFileSync(path, foreignBytes);
  assert.deepEqual(await f.reopen().resumeTaskCommands(), [
    { commandId: command.commandId, outcome: 'held' },
  ]);
  assert.equal(f.boardBytes(), foreignBytes);
});

// Fails if direct clear changes lifecycle/history, replays policy, or loses canonical column-order removal.
test('direct board clear preserves task lifecycle/history and survives response loss', (t) => {
  const f = fixture(t);
  assert.equal(
    f.human.execute({
      commandId: 'TEST-before-clear-order',
      operation: 'task.board.order',
      payload: { columnId: 'todo', orderedTaskIds: [f.a, f.b] },
    }).phase,
    'completed'
  );
  const { updatedAt: beforeUpdatedAt, ...beforeTask } = JSON.parse(f.bytes(f.a));
  assert.equal(typeof beforeUpdatedAt, 'string');
  const command = {
    commandId: 'TEST-direct-clear',
    operation: 'task.board.clear',
    payload: { taskId: f.a },
  } as TeamCommand;
  const receipt = f.human.execute(command);
  assert.equal(receipt.phase, 'completed');
  assert.deepEqual(columnOrder(f.human), { todo: [f.b] });
  const task = f.bytes(f.a);
  const { updatedAt, ...afterTask } = JSON.parse(task);
  assert.equal(typeof updatedAt, 'string');
  assert.deepEqual(afterTask, beforeTask);
  const board = f.boardBytes();
  const reopened = f.reopen().connect('user');
  assert.deepEqual(reopened.execute(command), receipt);
  assert.equal(f.boardBytes(), board);
  assert.equal(f.bytes(f.a), task);
  assert.equal(reopened.execute({ ...command, commandId: 'TEST-clear-again' }).phase, 'completed');
  assert.equal(f.boardBytes(), board);
  assert.equal(f.bytes(f.a), task);
});

// Fails if clearing bypasses canonical review policy or accepts an internal transition/forged actor.
test('direct clear preserves canonical review and approved refusal, exact payload and current grants', (t) => {
  const f = fixture(t);
  assert.equal(
    f.owner.connect('alice').execute({
      commandId: 'TEST-clear-complete',
      operation: 'task.lifecycle',
      payload: { taskId: f.a, action: 'complete' },
    }).phase,
    'completed'
  );
  assert.equal(
    f.human.execute({
      commandId: 'TEST-request-before-clear',
      operation: 'task.review',
      payload: { taskId: f.a, action: 'request' },
    }).phase,
    'completed'
  );
  for (const state of ['review', 'approved']) {
    if (state === 'approved')
      assert.equal(
        f.human.execute({
          commandId: 'TEST-clear-approve',
          operation: 'task.review',
          payload: { taskId: f.a, action: 'approve' },
        }).phase,
        'completed'
      );
    const before = [f.bytes(f.a), f.boardBytes(), f.bytes(f.b), f.bytes(f.c)];
    assert.equal(
      f.human.execute({
        commandId: `TEST-clear-${state}`,
        operation: 'task.board.clear',
        payload: { taskId: f.a },
      } as TeamCommand).phase,
      'rejected'
    );
    assert.deepEqual([f.bytes(f.a), f.boardBytes(), f.bytes(f.b), f.bytes(f.c)], before);
  }
  for (const payload of [
    { taskId: f.a, transition: 'status_reset' },
    { taskId: f.a, actor: 'lead' },
    { taskId: '../foreign' },
  ])
    assert.throws(
      () =>
        f.human.execute({
          commandId: 'TEST-clear-forged',
          operation: 'task.board.clear',
          payload,
        } as TeamCommand),
      (error) => error instanceof TeamOwnerError && error.code === 'invalid'
    );
  f.human.revoke('bob');
  assert.throws(
    () =>
      f.owner.connect('bob').execute({
        commandId: 'TEST-clear-revoked',
        operation: 'task.board.clear',
        payload: { taskId: f.b },
      } as TeamCommand),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
});

// Fails if recovery reruns the direct policy after publication instead of resuming prepared bytes.
test('interrupted direct clear resumes exact prepared board bytes', async (t) => {
  const f = fixture(t);
  f.human.execute({
    commandId: 'TEST-clear-recover-order',
    operation: 'task.board.order',
    payload: { columnId: 'todo', orderedTaskIds: [f.a, f.b] },
  });
  const command = {
    commandId: 'TEST-clear-interrupted',
    operation: 'task.board.clear',
    payload: { taskId: f.a },
  } as TeamCommand;
  f.plan.fail = true;
  assert.throws(
    () => f.human.execute(command),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  const task = f.bytes(f.a); // Canonical task update was the first published write.
  const reopened = f.reopen();
  assert.deepEqual(await reopened.resumeTaskCommands(), [
    { commandId: command.commandId, outcome: 'completed' },
  ]);
  assert.equal(f.bytes(f.a), task);
  assert.deepEqual(columnOrder(reopened.connect('user')), { todo: [f.b] });
  const board = f.boardBytes();
  assert.equal(reopened.connect('user').execute(command).phase, 'completed');
  assert.equal(f.boardBytes(), board);
  assert.equal(f.bytes(f.a), task);
});
