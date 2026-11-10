import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createTeamPolicy } from '../dist/adapters/team/ControllerAdapter.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { DEFAULT_TEAM_GROUP_CHAT_ID } from '../dist/group-chats/contracts.js';
import { TeamOwner } from '../dist/team/TeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { teamCommandPath } from '../dist/team/commandEntries.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamCommand } from '../dist/team/contracts.js';
import type { GroupChat } from '../dist/group-chats/model.js';
import type { TestContext } from 'node:test';

const groupId = '10000000-0000-4000-8000-000000000001';
const foreignId = '20000000-0000-4000-8000-000000000001';
const guard = { before() {}, inside() {} };
const code = (expected: string) => (error: unknown) =>
  error instanceof TeamOwnerError && error.code === expected;

class InterruptedStore extends TeamOwnerStore {
  failPrepared = false;
  override write(name: string, value: unknown): void {
    super.write(name, value);
    if (this.failPrepared && (value as { phase?: string })?.phase === 'prepared') {
      this.failPrepared = false;
      throw new Error('TEST interrupted after prepared receipt');
    }
  }
}
class InterruptedPlan extends TaskEffectPlan {
  failPublish = false;
  protected override afterPublish(): void {
    if (this.failPublish) {
      this.failPublish = false;
      throw new Error('TEST interrupted after canonical publication');
    }
  }
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-group-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const store = new InterruptedStore(root, binding.teamName);
  const plan = new InterruptedPlan(root, binding.teamName, store);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    taskMutations: plan,
    members: [
      { memberId: 'lead', name: 'lead', role: 'lead' },
      { memberId: 'alice', name: 'alice', role: 'member' },
    ],
    grants: [
      { principalId: 'admin', memberName: 'user', permissions: ['read', 'message.write', 'admin'] },
      { principalId: 'writer', memberName: 'user', permissions: ['read', 'task.write'] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const writer = owner.connect('writer');
  const groups = owner.groupCommands('admin', { getRun: async () => null });
  const registry = join(root, 'teams', binding.teamName, 'group-chats.json');
  const create = (
    commandId: string,
    groupChatId?: string
  ): Extract<TeamCommand, { operation: 'task.create' }> => ({
    commandId,
    operation: 'task.create',
    payload: {
      subject: 'TEST task from group',
      ...(groupChatId === undefined ? {} : { groupChatId }),
    },
  });
  const addGroup = () =>
    groups.execute(
      'TEST-group-create',
      {
        operation: 'create',
        id: groupId,
        name: 'TEST group',
        selectedMemberNames: ['lead', 'alice'],
        excludedMemberNames: [],
        autoIncludeNewMembers: false,
      },
      guard
    );
  const archive = () =>
    groups.execute(
      'TEST-group-archive',
      {
        operation: 'archive',
        groupChatId: groupId,
        archived: true,
      },
      guard
    );
  const persisted = (taskId: string) =>
    JSON.parse(readFileSync(join(root, 'tasks', binding.teamName, `${taskId}.json`), 'utf8')) as {
      groupChatId?: string;
    };
  const assertAbsent = (commandId: string) => {
    assert.equal(
      store.read(teamCommandPath(commandId)),
      undefined,
      'No receipt admits a rejected link'
    );
    assert.equal(writer.listTasks().length, 0, 'No canonical Task is created on rejection');
  };
  return {
    root,
    binding,
    store,
    plan,
    options,
    owner,
    writer,
    groups,
    registry,
    create,
    addGroup,
    archive,
    persisted,
    assertAbsent,
  };
}

test('same-Team group link survives canonical create, receipt, lookup, snapshot and restart without message grants', async (t) => {
  const f = fixture(t);
  await f.addGroup();
  const command = f.create('TEST-linked', groupId);
  const receipt = f.writer.execute(command);
  assert.equal(receipt.phase, 'completed');
  assert.equal((receipt.result as { groupChatId?: string }).groupChatId, groupId);
  assert.equal(f.persisted(receipt.effects.taskId).groupChatId, groupId);
  assert.equal(f.writer.getTask(receipt.effects.taskId).groupChatId, groupId);
  assert.deepEqual(f.writer.lookup(command.commandId), receipt);
  const snapshot = f.writer.readSnapshot() as { tasks: { groupChatId?: string }[] };
  assert.equal(snapshot.tasks[0]?.groupChatId, groupId);
  const reopened = createFilesystemTeamOwner(f.options).connect('writer');
  assert.deepEqual(reopened.execute(command), receipt);
  assert.equal(reopened.getTask(receipt.effects.taskId).groupChatId, groupId);
});

test('missing, foreign and unmaterialized default groups reject before prepared receipt', (t) => {
  const f = fixture(t);
  const foreignDirectory = join(f.root, 'teams', 'foreign-team');
  mkdirSync(foreignDirectory);
  const foreign: GroupChat = {
    id: foreignId,
    name: 'Foreign group',
    createdAt: '2026-10-27T00:00:00.000Z',
    archivedAt: null,
    membership: { kind: 'auto', excludedMemberNames: [] },
  };
  writeFileSync(
    join(foreignDirectory, 'group-chats.json'),
    JSON.stringify({ version: 1, groups: [foreign] })
  );
  for (const [index, target] of [groupId, foreignId, DEFAULT_TEAM_GROUP_CHAT_ID].entries()) {
    const command = f.create(`TEST-missing-${index}`, target);
    assert.throws(() => f.writer.execute(command), code('invalid'));
    f.assertAbsent(command.commandId);
  }
});

test('archived groups reject a new association while the persisted active default remains eligible', async (t) => {
  const f = fixture(t);
  await f.addGroup();
  await f.archive();
  const command = f.create('TEST-archived', groupId);
  assert.throws(() => f.writer.execute(command), code('invalid'));
  f.assertAbsent(command.commandId);
  // Default is already persisted by the original group workflow; Task create does not materialize it.
  const standard: GroupChat = {
    id: DEFAULT_TEAM_GROUP_CHAT_ID,
    name: 'All agents',
    createdAt: '2026-10-27T00:00:00.000Z',
    archivedAt: null,
    membership: { kind: 'auto', excludedMemberNames: [] },
  };
  writeFileSync(f.registry, JSON.stringify({ version: 1, groups: [standard] }));
  const receipt = f.writer.execute(f.create('TEST-standard', standard.id));
  assert.equal(f.persisted(receipt.effects.taskId).groupChatId, standard.id);
});

test('malformed association values reject before receipt and unreadable registry holds without effects', (t) => {
  const f = fixture(t);
  for (const [index, value] of ['', '../other', null, 1, {}, 'not-a-uuid'].entries()) {
    const command = f.create(`TEST-invalid-${index}`);
    Object.assign(command.payload, { groupChatId: value });
    assert.throws(() => f.writer.execute(command), code('invalid'));
    f.assertAbsent(command.commandId);
  }
  for (const [index, bytes] of [
    '{',
    '{"version":2,"groups":[]}',
    '{"version":1,"groups":[{}]}',
  ].entries()) {
    writeFileSync(f.registry, bytes);
    const command = f.create(`TEST-corrupt-${index}`, groupId);
    assert.throws(() => f.writer.execute(command), code('hold'));
    f.assertAbsent(command.commandId);
  }
});

test('missing synchronous group capability holds only linked creates; existing unlinked paths stay valid', (t) => {
  const f = fixture(t);
  const owner = new TeamOwner({
    ...f.options,
    store: f.store,
    policy: createTeamPolicy(f.root, f.binding.teamName),
    taskMutations: f.plan,
  });
  const writer = owner.connect('writer');
  const command = f.create('TEST-unavailable', groupId);
  assert.throws(() => writer.execute(command), code('hold'));
  f.assertAbsent(command.commandId);
  const receipt = writer.execute(f.create('TEST-unlinked'));
  assert.equal(receipt.phase, 'completed');
  assert.equal(Object.hasOwn(f.persisted(receipt.effects.taskId), 'groupChatId'), false);
});

test('completed replay retains original group admission after archive without reading corrupt registry', async (t) => {
  const f = fixture(t);
  await f.addGroup();
  const command = f.create('TEST-replay', groupId);
  const original = f.writer.execute(command);
  await f.archive();
  writeFileSync(f.registry, '{');
  const before = f.persisted(original.effects.taskId);
  assert.deepEqual(f.writer.execute(command), original);
  assert.deepEqual(f.persisted(original.effects.taskId), before);
  assert.equal(f.writer.listTasks().length, 1);
  // A changed payload still conflicts before any attempt to read group storage.
  assert.throws(
    () => f.writer.execute({ ...command, payload: { ...command.payload, groupChatId: foreignId } }),
    code('conflict')
  );
});

test('prepared and held continuations retain admitted association after archive', async (t) => {
  for (const phase of ['prepared', 'held'] as const) {
    const f = fixture(t);
    await f.addGroup();
    const command = f.create(`TEST-continue-${phase}`, groupId);
    if (phase === 'prepared') f.store.failPrepared = true;
    else f.plan.failPublish = true;
    assert.throws(() => f.writer.execute(command));
    assert.equal(f.writer.lookup(command.commandId)?.phase, phase);
    await f.archive();
    const completed = f.writer.execute(command);
    assert.equal(completed.phase, 'completed');
    assert.equal(f.persisted(completed.effects.taskId).groupChatId, groupId);
    assert.equal(f.writer.listTasks().length, 1);
  }
});

test('revoked current task grant rejects new commands and completed replay before corrupt catalog is read', async (t) => {
  const f = fixture(t);
  await f.addGroup();
  const original = f.create('TEST-before-revoke', groupId);
  f.writer.execute(original);
  f.owner.connect('admin').revoke('writer');
  writeFileSync(f.registry, '{');
  for (const command of [original, f.create('TEST-after-revoke', groupId)])
    assert.throws(() => f.writer.execute(command), code('forbidden'));
});
