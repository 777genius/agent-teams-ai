import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner as createOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

import type { FilesystemTeamOwnerOptions as TeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { CommandReceipt, TeamCommand } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, storeFactory?: (root: string) => TeamOwnerStore) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-owner-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const options: TeamOwnerOptions = {
    root,
    binding,
    members: [
      { memberId: 'lead-id', name: 'lead', role: 'lead' },
      {
        memberId: 'alice-id',
        name: 'alice',
        role: 'member',
        delivery: {
          ...binding,
          runId: 'TEST-run',
          memberId: 'alice-id',
          generation: '1',
        },
      },
      { memberId: 'bob-id', name: 'bob', role: 'member' },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'alice-session',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
      {
        principalId: 'bob-session',
        memberName: 'bob',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
    ...(storeFactory ? { store: storeFactory(root) } : {}),
  };
  const owner = createOwner(options);
  return {
    root,
    options,
    owner,
    human: owner.connect('human'),
    alice: owner.connect('alice-session'),
  };
}

function create(commandId: string, subject = 'Meaningful task'): TeamCommand {
  return { commandId, operation: 'task.create', payload: { subject, owner: 'alice' } };
}

function expectCode(code: string) {
  return (error: unknown) => error instanceof TeamOwnerError && error.code === code;
}

function taskBytes(root: string, taskId: string): string {
  return readFileSync(join(root, 'tasks', 'test-team', `${taskId}.json`), 'utf8');
}

test('actual canonical Task create persists stable identity, conflict and completed replay after lost response', (t) => {
  const f = fixture(t);
  const command = create('create-A');
  const original = f.human.execute(command);
  assert.equal(original.phase, 'completed');
  const firstBytes = taskBytes(f.root, original.effects.taskId);
  assert.equal(f.human.listTasks().length, 1);
  // A new owner object is restart, not a fake in-memory task store.
  const restarted = createOwner(f.options).connect('human');
  assert.deepEqual(restarted.execute(command), original);
  assert.equal(taskBytes(f.root, original.effects.taskId), firstBytes);
  assert.throws(
    () => restarted.execute(create('create-A', 'Changed payload')),
    expectCode('conflict')
  );
  const independent = restarted.execute(create('create-B'));
  assert.notEqual(independent.effects.taskId, original.effects.taskId);
  assert.equal(
    restarted.listTasks().length,
    2,
    'distinct intents with identical text remain distinct'
  );
  const persisted = JSON.parse(firstBytes) as {
    creationCommand: { payloadHash: string; namespace: string };
  };
  assert.equal(persisted.creationCommand.namespace, 'legacy-agent-host');
  assert.equal(persisted.creationCommand.payloadHash, original.fingerprint);
});

test('current authority covers completed replay, lookup, execution and revoke across owner instances', (t) => {
  const f = fixture(t);
  const command = create('alice-create');
  const receipt = f.alice.execute(command);
  const before = taskBytes(f.root, receipt.effects.taskId);
  const readPosition = (f.alice.readSnapshot() as { feed: { cursor: string } }).feed;
  createOwner(f.options).connect('human').revoke('alice-session');
  for (const action of [
    () => f.alice.execute(command),
    () => f.alice.lookup(command.commandId),
    () => f.alice.execute(create('alice-new')),
    () => f.alice.listTasks(),
    () => f.alice.readSnapshot(),
    () => f.alice.readChanges(readPosition.cursor),
  ])
    assert.throws(action, expectCode('forbidden'));
  assert.equal(taskBytes(f.root, receipt.effects.taskId), before);
  // Bootstrap grants passed on restart cannot silently undo revocation.
  const again = createOwner(f.options).connect('alice-session');
  assert.throws(() => again.lookup(command.commandId), expectCode('forbidden'));
  assert.throws(() => again.readChanges(readPosition.cursor), expectCode('forbidden'));
  assert.throws(
    () => f.owner.connect('bob-session').lookup(command.commandId),
    expectCode('forbidden')
  );
});

test('real canonical lifecycle keeps work intervals/history and deleted tasks do not resurrect on old replay', (t) => {
  const f = fixture(t);
  const created = f.human.execute(create('life-create'));
  const taskId = created.effects.taskId;
  const run = (
    commandId: string,
    action: 'start' | 'complete' | 'delete' | 'restore' | 'pending'
  ) => f.alice.execute({ commandId, operation: 'task.lifecycle', payload: { taskId, action } });
  assert.equal(run('start', 'start').phase, 'completed');
  const comment: TeamCommand = {
    commandId: 'comment',
    operation: 'task.comment',
    payload: {
      taskId,
      text: 'Actual result with a structured ref',
      taskRefs: [{ taskId, displayId: 'abcd1234', teamName: 'test-team' }],
    },
  };
  const commented = f.alice.execute(comment);
  assert.equal(commented.phase, 'completed');
  f.alice.execute(comment);
  assert.equal(run('complete', 'complete').phase, 'completed');
  const task = f.human.getTask(taskId);
  assert.equal(task.status, 'completed');
  assert.equal((task.comments as unknown[]).length, 1);
  assert.ok((task.workIntervals as { completedAt?: string }[])[0]?.completedAt);
  assert.ok(
    (task.historyEvents as { type: string }[]).some((event) => event.type === 'status_changed')
  );
  // Read notification rows are retained by canonical delete, with no queued retraction.
  const inboxPath = join(f.root, 'teams', 'test-team', 'inboxes', 'alice.json');
  const inbox = JSON.parse(readFileSync(inboxPath, 'utf8')) as { read: boolean }[];
  inbox.forEach((row) => {
    row.read = true;
  });
  writeFileSync(inboxPath, JSON.stringify(inbox));
  assert.equal(run('delete', 'delete').phase, 'completed');
  const deletedBytes = taskBytes(f.root, taskId);
  f.human.execute(create('life-create'));
  f.alice.execute(comment);
  assert.equal(
    taskBytes(f.root, taskId),
    deletedBytes,
    'old completed receipts never recreate product data'
  );
  assert.equal(f.human.getTask(taskId).status, 'deleted');
  assert.equal(run('restore', 'restore').phase, 'completed');
  const restored = f.human.getTask(taskId);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.reviewState, 'none');
  const updated = f.human.execute({
    commandId: 'update',
    operation: 'task.update',
    payload: { taskId, subject: 'Updated through taskBoard' },
  });
  assert.equal(updated.phase, 'completed');
  assert.equal(f.human.getTask(taskId).subject, 'Updated through taskBoard');
});

test('canonical stale actor/dependency rejection changes no files and does not wedge the Team', (t) => {
  const f = fixture(t);
  const first = f.human.execute(create('blocker'));
  const blocked = f.human.execute({
    commandId: 'blocked',
    operation: 'task.create',
    payload: {
      subject: 'Blocked task',
      owner: 'alice',
      blockedBy: [first.effects.taskId],
    },
  });
  const taskId = blocked.effects.taskId;
  const before = taskBytes(f.root, taskId);
  const rejection = f.alice.execute({
    commandId: 'blocked-start',
    operation: 'task.lifecycle',
    payload: { taskId, action: 'start' },
  });
  assert.equal(rejection.phase, 'rejected');
  assert.equal(taskBytes(f.root, taskId), before);
  const wrongActor = f.owner.connect('bob-session').execute({
    commandId: 'wrong-actor',
    operation: 'task.lifecycle',
    payload: { taskId: first.effects.taskId, action: 'start' },
  });
  assert.equal(wrongActor.phase, 'rejected');
  assert.equal(f.human.execute(create('after-rejection')).phase, 'completed');
});

class FailOutboxOnce extends TeamOwnerStore {
  fail = true;
  override write(name: string, value: unknown): void {
    if (this.fail && name.startsWith('outbox/')) {
      this.fail = false;
      throw new Error('TEST partial-write failure');
    }
    super.write(name, value);
  }
}

test('partial Message inbox/outbox write recovers exact IDs after restart, even after UI read marking', (t) => {
  const f = fixture(t, (root) => new FailOutboxOnce(root, 'test-team'));
  const command: TeamCommand = {
    commandId: 'message',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Human prompt persisted once' },
  };
  assert.throws(() => f.human.execute(command), expectCode('hold'));
  const original = f.human.lookup(command.commandId)!;
  assert.equal(original.phase, 'held');
  const inboxPath = join(f.root, 'teams', 'test-team', 'inboxes', 'alice.json');
  const inbox = JSON.parse(readFileSync(inboxPath, 'utf8')) as {
    read: boolean;
    messageId: string;
  }[];
  assert.equal(inbox.length, 1);
  inbox[0]!.read = true;
  writeFileSync(inboxPath, JSON.stringify(inbox));
  const restarted = createOwner({
    ...f.options,
    store: new TeamOwnerStore(f.root, 'test-team'),
  }).connect('human');
  const receipt = restarted.execute(command);
  assert.equal(receipt.phase, 'completed');
  assert.equal(receipt.effects.messageId, original.effects.messageId);
  assert.equal((JSON.parse(readFileSync(inboxPath, 'utf8')) as unknown[]).length, 1);
  const deliveries = restarted.pendingDeliveries();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.inputId, receipt.effects.deliveryId);
  assert.equal(deliveries[0]?.binding.generation, '1');
  assert.equal(deliveries[0]?.phase, 'pending', 'business commit does not fake Runtime admission');
  assert.deepEqual(restarted.execute(command), receipt);
});

class FailCompletedOnce extends TeamOwnerStore {
  fail = true;
  override write(name: string, value: unknown): void {
    if (
      this.fail &&
      name.startsWith('commands/') &&
      (value as CommandReceipt).phase === 'completed'
    ) {
      this.fail = false;
      throw new Error('TEST lost completion write');
    }
    super.write(name, value);
  }
}

test('lost Task receipt recovers prepared exact effects without rerunning canonical notifications', (t) => {
  const f = fixture(t, (root) => new FailCompletedOnce(root, 'test-team'));
  const command = create('unknown-task');
  assert.throws(() => f.human.execute(command), expectCode('hold'));
  const receipt = f.human.lookup(command.commandId)!;
  const taskBefore = taskBytes(f.root, receipt.effects.taskId);
  const inboxPath = join(f.root, 'teams', 'test-team', 'inboxes', 'alice.json');
  const inboxBefore = readFileSync(inboxPath, 'utf8');
  const restarted = createOwner(f.options).connect('human');
  assert.equal(restarted.execute(command).phase, 'completed');
  assert.equal(taskBytes(f.root, receipt.effects.taskId), taskBefore);
  assert.equal(readFileSync(inboxPath, 'utf8'), inboxBefore);
});

test('binding and payload spoofing reject before product effects', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      createOwner({ ...f.options, binding: { ...f.options.binding, backendId: 'other-backend' } }),
    expectCode('conflict')
  );
  const forged = {
    ...create('forged'),
    payload: { subject: 'spoof', owner: 'alice', from: 'lead' },
  };
  assert.throws(() => f.alice.execute(forged as TeamCommand), expectCode('invalid'));
  assert.equal(f.human.listTasks().length, 0);
});

test('member reply to human persists once with captured sender and no native outbox', (t) => {
  const f = fixture(t);
  const command: TeamCommand = {
    commandId: 'reply',
    operation: 'message.send',
    payload: { to: 'user', text: 'Result from Alice' },
  };
  const receipt = f.alice.execute(command);
  assert.equal(receipt.phase, 'completed');
  assert.deepEqual(f.alice.execute(command), receipt);
  const inbox = JSON.parse(
    readFileSync(join(f.root, 'teams', 'test-team', 'inboxes', 'user.json'), 'utf8')
  ) as { from: string; messageId: string }[];
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.from, 'alice');
  assert.deepEqual(f.alice.pendingDeliveries(), []);
});

test('symlinked tasks namespace is refused before canonical policy can write outside its root', (t) => {
  const f = fixture(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'sentinel.txt'), 'unchanged');
  mkdirSync(join(f.root, 'tasks'));
  symlinkSync(outside, join(f.root, 'tasks', 'test-team'), 'dir');
  assert.throws(() => f.human.execute(create('escape')), expectCode('hold'));
  assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'unchanged');
});

test('replaced task-file and inbox paths are revalidated on each owner read/mutation', (t) => {
  const f = fixture(t);
  const receipt = f.human.execute(create('before-swap'));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const taskPath = join(f.root, 'tasks', 'test-team', `${receipt.effects.taskId}.json`);
  const detachedTask = join(outside, 'task.json');
  renameSync(taskPath, detachedTask);
  symlinkSync(detachedTask, taskPath);
  const before = readFileSync(detachedTask, 'utf8');
  assert.throws(() => f.human.getTask(receipt.effects.taskId), expectCode('hold'));
  assert.throws(
    () =>
      f.human.execute({
        commandId: 'after-swap',
        operation: 'task.update',
        payload: { taskId: receipt.effects.taskId, subject: 'must not escape' },
      }),
    expectCode('hold')
  );
  assert.equal(readFileSync(detachedTask, 'utf8'), before);
  rmSync(taskPath);
  renameSync(detachedTask, taskPath);
  const inboxPath = join(f.root, 'teams', 'test-team', 'inboxes');
  const detachedInbox = join(outside, 'inboxes');
  renameSync(inboxPath, detachedInbox);
  symlinkSync(detachedInbox, inboxPath, 'dir');
  const inboxBefore = readFileSync(join(detachedInbox, 'alice.json'), 'utf8');
  assert.throws(
    () =>
      f.human.execute({
        commandId: 'inbox-escape',
        operation: 'message.send',
        payload: { to: 'alice', text: 'must not escape' },
      }),
    expectCode('hold')
  );
  assert.equal(readFileSync(join(detachedInbox, 'alice.json'), 'utf8'), inboxBefore);
});
