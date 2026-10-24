import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { effectId } from '../dist/team/identity.js';
import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamCommand, CommandReceipt } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';

class InterruptedPlan extends TaskEffectPlan {
  fail: ((path: string) => boolean) | undefined;
  protected override afterPublish(_index: number, path: string): void {
    if (this.fail?.(path)) {
      this.fail = undefined;
      throw new Error('TEST interrupted product publication');
    }
  }
}

function fixture(t: TestContext, makeStore?: (root: string) => TeamOwnerStore) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const store = makeStore?.(root) ?? new TeamOwnerStore(root, binding.teamName);
  const plan = new InterruptedPlan(root, binding.teamName, store);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    taskMutations: plan,
    members: ['lead', 'alice', 'bob'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? 'lead' : 'member',
      delivery: { ...binding, runId: 'TEST-run', memberId: `${name}-id`, generation: '1' },
    })),
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      ...['lead', 'alice', 'bob'].map((name) => ({
        principalId: `${name}-session`,
        memberName: name,
        permissions: ['read', 'task.write', 'message.write'] as (
          | 'read'
          | 'task.write'
          | 'message.write'
        )[],
      })),
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  const taskPath = (id: string) => join(root, 'tasks', binding.teamName, `${id}.json`);
  const inboxPath = (name: string) =>
    join(root, 'teams', binding.teamName, 'inboxes', `${name}.json`);
  const create = (commandId: string, ownerName = 'alice', blockedBy?: string[]): TeamCommand => ({
    commandId,
    operation: 'task.create',
    payload: { subject: commandId, owner: ownerName, ...(blockedBy ? { blockedBy } : {}) },
  });
  const reopen = () => {
    const { taskMutations: _plan, ...reopened } = options;
    return createFilesystemTeamOwner(reopened);
  };
  return { root, store, plan, options, owner, human, create, taskPath, inboxPath, reopen };
}

const hold = (error: unknown) => error instanceof TeamOwnerError && error.code === 'hold';
const value = (receipt: CommandReceipt) =>
  receipt.result as { task: { id: string; status: string }; notifiedOwner: boolean };
const start = (
  taskId: string,
  commandId: string,
  notification: 'legacy' | 'user' = 'user'
): TeamCommand => ({ commandId, operation: 'task.start', payload: { taskId, notification } });
const inbox = (f: ReturnType<typeof fixture>, name: string) =>
  JSON.parse(readFileSync(f.inboxPath(name), 'utf8')) as Record<string, unknown>[];
const require = createRequire(import.meta.url);
const { protocols } = require('agent-teams-controller');

test('user task start commits exact owner inbox, stable outbox and truthful completed receipt', (t) => {
  const f = fixture(t);
  const created = f.human.execute(f.create('create-start'));
  const id = created.effects.taskId;
  const task = JSON.parse(readFileSync(f.taskPath(id), 'utf8'));
  task.prompt = '  Follow instructions  ';
  task.description = '  Task details  ';
  task.descriptionTaskRefs = [
    { taskId: id, displayId: task.displayId, teamName: f.options.binding.teamName },
  ];
  writeFileSync(f.taskPath(id), JSON.stringify(task));
  const command = start(id, 'start-owner');
  const receipt = f.human.execute(command);
  assert.equal(receipt.phase, 'completed');
  assert.equal(value(receipt).task.status, 'in_progress');
  assert.equal(value(receipt).notifiedOwner, true);
  const row = inbox(f, 'alice').find((row) => row.messageId === receipt.effects.messageId)!;
  const expected = protocols.buildTaskStartNotification(
    f.options.binding.teamName,
    task,
    `#${task.displayId}`,
    'user',
    undefined,
    'captured-team'
  );
  assert.deepEqual(row, {
    from: 'user',
    to: 'alice',
    text: expected.text,
    timestamp: receipt.createdAt,
    read: false,
    messageId: receipt.effects.messageId,
    summary: expected.summary,
    source: 'system_notification',
    taskRefs: task.descriptionTaskRefs,
  });
  const outbox = f.human
    .pendingDeliveries()
    .filter((entry) => entry.commandId === command.commandId);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.messageId, receipt.effects.messageId);
  assert.equal(outbox[0]!.content, expected.text);
  assert.match(outbox[0]!.content, /task_complete \{ taskId:/);
  assert.match(outbox[0]!.content, /commandId:/);
  assert.doesNotMatch(outbox[0]!.content, /actor:|teamName:/);
  assert.equal(outbox[0]!.binding.memberId, 'alice-id');
  assert.deepEqual(f.human.execute(command), receipt);
  assert.equal(
    inbox(f, 'alice').filter((row) => row.messageId === receipt.effects.messageId).length,
    1
  );
});

test('no owner and legacy lead-self skip return false; user lead-self really notifies', (t) => {
  const f = fixture(t);
  const unowned = f.human.execute({
    commandId: 'unowned',
    operation: 'task.create',
    payload: { subject: 'Unowned' },
  });
  assert.equal(
    value(f.human.execute(start(unowned.effects.taskId, 'start-unowned'))).notifiedOwner,
    false
  );
  const lead = f.human.execute(f.create('lead-task', 'lead'));
  assert.equal(
    value(f.human.execute(start(lead.effects.taskId, 'start-lead-legacy', 'legacy'))).notifiedOwner,
    false
  );
  const leadUser = f.human.execute(f.create('lead-user-task', 'lead'));
  const receipt = f.human.execute(start(leadUser.effects.taskId, 'start-lead-user'));
  assert.equal(value(receipt).notifiedOwner, true);
  assert.equal(
    inbox(f, 'lead').find((row) => row.messageId === receipt.effects.messageId)?.from,
    'user'
  );
  const member = f.human.execute(f.create('legacy-member-task'));
  const legacy = f.human.execute(start(member.effects.taskId, 'start-member-legacy', 'legacy'));
  const row = inbox(f, 'alice').find((row) => row.messageId === legacy.effects.messageId)!;
  assert.equal(row.from, 'lead');
  assert.match(String(row.text), /Update task status using the board MCP tools/);
  assert.doesNotMatch(String(row.text), /Instructions:/);
});

test('partial publication resumes exact plan once without auto native replay', (t) => {
  const f = fixture(t);
  const created = f.human.execute(f.create('recover-task'));
  const command = start(created.effects.taskId, 'start-interrupted');
  f.plan.fail = (path) => path.startsWith('tasks/');
  assert.throws(() => f.human.execute(command), hold);
  const interrupted = f.human.lookup(command.commandId)!;
  assert.equal(
    inbox(f, 'alice').some((row) => row.messageId === interrupted.effects.messageId),
    false
  );
  const resumed = f.reopen().connect('human').execute(command);
  assert.equal(resumed.phase, 'completed');
  assert.equal(value(resumed).notifiedOwner, true);
  assert.equal(
    inbox(f, 'alice').filter((row) => row.messageId === interrupted.effects.messageId).length,
    1
  );
  assert.equal(
    f.human.pendingDeliveries().filter((entry) => entry.commandId === command.commandId).length,
    1
  );
});

test('notification collision, unresolved dependencies and non-human admission never silently start', (t) => {
  const f = fixture(t);
  const created = f.human.execute(f.create('collision-task'));
  const command = start(created.effects.taskId, 'start-collision');
  const id = effectId(
    'message',
    f.options.binding.backendId,
    f.options.binding.teamId,
    command.commandId
  );
  const beforeInbox = inbox(f, 'alice');
  beforeInbox.push({
    messageId: id,
    text: 'Foreign row',
    from: 'user',
    timestamp: '2026-01-01',
    read: false,
  });
  writeFileSync(f.inboxPath('alice'), JSON.stringify(beforeInbox));
  const before = readFileSync(f.taskPath(created.effects.taskId), 'utf8');
  const rejected = f.human.execute(command);
  assert.equal(rejected.phase, 'rejected');
  assert.equal(readFileSync(f.taskPath(created.effects.taskId), 'utf8'), before);
  assert.deepEqual(inbox(f, 'alice'), beforeInbox);
  assert.throws(
    () => f.owner.connect('alice-session').execute(start(created.effects.taskId, 'agent-start')),
    (error: unknown) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
  assert.equal(f.human.lookup('agent-start'), undefined);
  const blocker = f.human.execute(f.create('blocker'));
  const blocked = f.human.execute(f.create('blocked', 'alice', [blocker.effects.taskId]));
  assert.equal(f.human.execute(start(blocked.effects.taskId, 'start-blocked')).phase, 'rejected');
  assert.equal(
    JSON.parse(readFileSync(f.taskPath(blocked.effects.taskId), 'utf8')).status,
    'pending'
  );
});

test('retained recovery refuses a changed lead or task owner without new notification', (t) => {
  for (const change of ['lead', 'owner'] as const) {
    const f = fixture(t);
    const created = f.human.execute(f.create(`authority-${change}`));
    const command = start(created.effects.taskId, `start-${change}`, 'legacy');
    f.plan.fail = (path) => path.startsWith('tasks/');
    assert.throws(() => f.human.execute(command), hold);
    const receipt = f.human.lookup(command.commandId)!;
    if (change === 'lead') {
      const state = f.store.read<{ members: { role: string; name: string }[] }>('state.json')!;
      for (const member of state.members) member.role = member.name === 'bob' ? 'lead' : 'member';
      f.store.write('state.json', state);
    } else {
      const task = JSON.parse(readFileSync(f.taskPath(created.effects.taskId), 'utf8'));
      task.owner = 'bob';
      writeFileSync(f.taskPath(created.effects.taskId), JSON.stringify(task));
    }
    assert.throws(() => f.human.execute(command), hold);
    assert.equal(
      inbox(f, 'alice').some((row) => row.messageId === receipt.effects.messageId),
      false
    );
    assert.equal(
      f.human.pendingDeliveries().some((entry) => entry.commandId === command.commandId),
      false
    );
  }
});

test('saved owner receives only durable product notification with no invented native target', (t) => {
  const f = fixture(t);
  const state = f.store.read<{ members: { name: string; delivery?: unknown }[] }>('state.json')!;
  delete state.members.find((member) => member.name === 'alice')!.delivery;
  f.store.write('state.json', state);
  const created = f.human.execute(f.create('offline-task'));
  const command = start(created.effects.taskId, 'start-offline');
  const receipt = f.human.execute(command);
  assert.equal(value(receipt).notifiedOwner, true);
  assert.equal(
    inbox(f, 'alice').some((row) => row.messageId === receipt.effects.messageId),
    true
  );
  assert.equal(
    f.human.pendingDeliveries().some((entry) => entry.commandId === command.commandId),
    false
  );
});
