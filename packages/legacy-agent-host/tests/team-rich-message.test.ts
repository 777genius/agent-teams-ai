import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { formatTeamMessage } from '../dist/team/formatTeamMessage.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamCommand } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const portable = require('agent-teams-controller') as {
  agentBlocks: { stripAgentBlocks(text: string): string };
  protocols: { buildActionModeAgentBlock(mode: string): string };
};

function fixture(t: TestContext, fail = false, role: 'lead' | 'member' = 'member') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-rich-message-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' };
  class FailOnce extends TeamOwnerStore {
    override write(name: string, value: unknown) {
      if (fail && name.startsWith('outbox/')) {
        fail = false;
        throw new Error('TEST lost publication');
      }
      super.write(name, value);
    }
  }
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    members: [
      {
        memberId: 'alice',
        name: 'alice',
        role,
        delivery: { ...binding, memberId: 'alice', runId: 'TEST-run', generation: '1' },
      },
    ],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'admin'] },
      { principalId: 'native-alice', memberName: 'alice', permissions: ['read', 'message.write'] },
    ],
    store: new FailOnce(root, 'test-team'),
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  const inboxPath = join(root, 'teams/test-team/inboxes/alice.json');
  const inbox = () => JSON.parse(readFileSync(inboxPath, 'utf8')) as Record<string, unknown>[];
  const command: TeamCommand = {
    commandId: 'TEST-prepared-id',
    operation: 'message.send',
    payload: {
      to: 'alice',
      text: 'Read only and answer',
      messageId: 'TEST-prepared-id',
      summary: 'Read-only summary',
      actionMode: 'ask',
      taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'test-team' }],
    },
  };
  return { root, options, owner, human, command, inbox, inboxPath };
}

test('prepared Composer identity and metadata survive product echo and native content', (t) => {
  const f = fixture(t);
  const receipt = f.human.execute(f.command);
  assert.equal(receipt.effects.messageId, f.command.commandId);
  assert.equal((receipt.result as { messageId: string }).messageId, f.command.commandId);
  assert.deepEqual(f.inbox(), [
    {
      from: 'user',
      to: 'alice',
      text: 'Read only and answer',
      messageId: f.command.commandId,
      timestamp: receipt.createdAt,
      read: false,
      summary: 'Read-only summary',
      actionMode: 'ask',
      taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'test-team' }],
    },
  ]);
  const intent = f.human.pendingDeliveries()[0]!;
  assert.match(intent.content, /TURN ACTION MODE: ASK/);
  assert.match(intent.content, /must not change code\/files\/tasks\/state/);
  assert.match(intent.content, /Read-only summary/);
  assert.match(intent.content, /TEST-task/);
  assert.equal(f.owner.authorizeDeliveryIntent(intent), true);
  const tampered = { ...intent, content: intent.content.replace('ASK', 'DO') };
  assert.equal(f.owner.authorizeDeliveryIntent(tampered), false);
  assert.deepEqual(f.human.execute(f.command), receipt);
  assert.equal(f.inbox().length, 1);
  assert.throws(
    () =>
      f.human.execute({
        ...f.command,
        payload: { ...f.command.payload, text: 'changed' },
      } as TeamCommand),
    (error) => error instanceof TeamOwnerError && error.code === 'conflict'
  );
});

test('lost inbox/outbox response recovers exact prepared ID once and keeps current actor authorization', (t) => {
  const f = fixture(t, true);
  assert.throws(
    () => f.human.execute(f.command),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  assert.equal(
    f.inbox()[0]!.messageId,
    f.command.commandId,
    'canonical echo can reconcile prepared ID even with no response'
  );
  const rows = f.inbox();
  rows[0]!.read = true;
  writeFileSync(f.inboxPath, JSON.stringify(rows));
  const restartedOwner = createFilesystemTeamOwner({
    ...f.options,
    store: new TeamOwnerStore(f.root, 'test-team'),
  });
  const restarted = restartedOwner.connect('human');
  assert.equal(restarted.execute(f.command).phase, 'completed');
  assert.equal(f.inbox().length, 1);
  assert.equal(restarted.pendingDeliveries()[0]!.messageId, f.command.commandId);
  assert.equal(restartedOwner.authorizeDeliveryIntent(restarted.pendingDeliveries()[0]!), true);
  restarted.revoke('human');
  assert.throws(
    () => restarted.execute(f.command),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
});

test('canonical message ID collision holds without overwriting existing bytes', (t) => {
  const f = fixture(t);
  f.human.execute({
    commandId: 'TEST-seed',
    operation: 'message.send',
    payload: { to: 'alice', text: 'existing' },
  });
  const rows = f.inbox();
  rows[0]!.messageId = f.command.commandId;
  writeFileSync(f.inboxPath, JSON.stringify(rows));
  const before = readFileSync(f.inboxPath, 'utf8');
  assert.throws(
    () => f.human.execute(f.command),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  assert.equal(readFileSync(f.inboxPath, 'utf8'), before);
});

test('native content keeps old plain deliveries exact and makes DELEGATE restrictive', () => {
  assert.equal(
    formatTeamMessage({ to: 'alice', text: 'old bytes' }, 'user', 'old-id'),
    'old bytes'
  );
  const content = formatTeamMessage(
    { to: 'alice', text: 'Delegate this', actionMode: 'delegate' },
    'user',
    'id'
  );
  assert.match(content, /TURN ACTION MODE: DELEGATE/);
  assert.match(content, /Do not implement yourself/);
  assert.equal(portable.agentBlocks.stripAgentBlocks(content), 'Delegate this');
  assert.ok(content.includes(portable.protocols.buildActionModeAgentBlock('delegate')));
});

test('rich human messages require a canonical visible reply with the current MCP schema', () => {
  for (const role of ['lead', 'member'] as const) {
    const content = formatTeamMessage(
      { to: 'alice', text: 'Reply hello', messageId: 'incoming-id', actionMode: 'ask' },
      'user',
      'incoming-id',
      role
    );
    assert.match(content, /message_send/);
    assert.match(content, /to="user"/);
    assert.match(content, /commandId and text/);
    assert.match(content, /new stable commandId for each distinct reply/);
    assert.match(content, /Do not reuse the incoming messageId as a reply commandId/);
    assert.match(content, /Normal assistant text alone does not appear in the UI message thread/);
    assert.equal(portable.agentBlocks.stripAgentBlocks(content), 'Reply hello');
  }
  const agentMessage = formatTeamMessage(
    { to: 'alice', text: 'Internal update', messageId: 'agent-id' },
    'bob',
    'agent-id'
  );
  assert.doesNotMatch(agentMessage, /to="user"/);
});

test('mismatched prepared identity and caller actor overrides reject before a receipt or inbox write', (t) => {
  const f = fixture(t);
  for (const payload of [
    { to: 'alice', text: 'x', messageId: 'other-id' },
    { to: 'alice', text: 'x', from: 'user' },
    { to: 'alice', text: 'x', actionMode: 'execute' },
  ]) {
    const command = {
      commandId: 'TEST-invalid',
      operation: 'message.send',
      payload,
    } as TeamCommand;
    assert.throws(
      () => f.human.execute(command),
      (error) => error instanceof TeamOwnerError && error.code === 'invalid'
    );
    assert.equal(f.human.lookup(command.commandId), undefined);
  }
  assert.throws(
    () => formatTeamMessage({ to: 'alice', text: 'x', messageId: 'prepared' }, 'user', 'tampered'),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
});

test('human DELEGATE refuses a member before receipts/effects but preserves agent delegation policy', (t) => {
  const f = fixture(t);
  const command = {
    ...f.command,
    payload: { ...f.command.payload, actionMode: 'delegate' },
  } as TeamCommand;
  assert.throws(
    () => f.human.execute(command),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
  assert.equal(f.human.lookup(command.commandId), undefined);
  assert.equal(f.human.pendingDeliveries().length, 0);
  const agent = f.owner.connect('native-alice');
  assert.equal(agent.execute(command).phase, 'completed');
  assert.equal(f.inbox()[0]!.from, 'alice');
});

test('lead rich content uses exact portable lead/mode rules and changed recipient role holds recovery', (t) => {
  const f = fixture(t, false, 'lead');
  const command = {
    ...f.command,
    payload: { ...f.command.payload, actionMode: 'delegate' },
  } as TeamCommand;
  const receipt = f.human.execute(command);
  assert.equal(receipt.messageRecipientRole, 'lead');
  const intent = f.human.pendingDeliveries()[0]!;
  assert.match(intent.content, /Strict orchestration mode for leads/);
  assert.doesNotMatch(intent.content, /Pass the task with full context/);
  assert.equal(f.owner.authorizeDeliveryIntent(intent), true);
  const statePath = join(f.root, 'teams/test-team/.host-owner/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { members: { role: string }[] };
  state.members[0]!.role = 'member';
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(f.owner.authorizeDeliveryIntent(intent), false);
  assert.throws(
    () => f.human.execute(command),
    (error) => error instanceof TeamOwnerError && ['hold', 'forbidden'].includes(error.code)
  );
});
