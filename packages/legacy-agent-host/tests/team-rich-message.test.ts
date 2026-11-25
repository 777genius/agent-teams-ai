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
import { deliveryIdentity } from '../dist/team/DeliveryRecovery.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { publishNativeCommandOutput } from '../dist/composition/publishNativeCommandOutput.js';
import { assertNativeSessionCommand, nativeSessionCommandAuthorized } from '../dist/composition/nativeSessionCommandAdmission.js';
import { captureHostCostCommand } from '../dist/team/hostCostCommand.js';
import { parseNativeSessionCommand } from '../dist/team/nativeSessionCommand.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamCommand } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';
import type { MemberEntry } from '../dist/composition/MemberEntry.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { RuntimeActivitySnapshot } from '../dist/runtime/activityContracts.js';

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

test('explicit native command keeps raw bytes and original receipt while old rich slash remains wrapped', (t) => {
  for (const raw of ['/compact', '/compact\nTEST argument', '/' + 'a'.repeat(64) + '\u2003TEST',
    '/compact' + ' '.repeat(32_768) + 'TEST']) {
    assert.deepEqual(parseNativeSessionCommand(' ' + raw + ' '),
      { name: raw.slice(1).split(/\s/u)[0], raw });
  }
  for (const text of ['/', '/1bad', '/compact/other', '/' + 'a'.repeat(65) + ' TEST'])
    assert.equal(parseNativeSessionCommand(text), undefined);
  const f = fixture(t, false, 'lead');
  const command = { ...f.command, payload: { ...f.command.payload, text: ' /compact focus on TEST work ', nativeCommand: true as const } } as TeamCommand;
  const receipt = f.human.execute(command);
  const intent = f.human.pendingDeliveries()[0]!;
  assert.equal(intent.content, '/compact focus on TEST work');
  assert.equal(f.owner.authorizeDeliveryIntent(intent), true);
  assert.equal(f.human.lookup(command.commandId, command)?.fingerprint, receipt.fingerprint);
  assert.deepEqual(f.human.execute(command), receipt);
  assert.equal(f.inbox().length, 1);
  const { nativeCommand: _native, ...legacyPayload } = (command as Extract<TeamCommand, { operation: 'message.send' }>).payload;
  assert.match(formatTeamMessage(legacyPayload, 'user', command.commandId, 'lead'), /Message context:/u,
    'old rich messages are not reinterpreted as new native commands');
  assert.throws(() => f.owner.connect('native-alice').execute({ ...command, commandId: 'TEST-agent-command',
    payload: { ...(command as Extract<TeamCommand, { operation: 'message.send' }>).payload, messageId: 'TEST-agent-command' } } as TeamCommand),
  (error) => error instanceof TeamOwnerError && error.code === 'forbidden');
});

test('raw native syntax cannot target a teammate or bypass the explicit format marker', (t) => {
  const f = fixture(t);
  assert.throws(() => f.human.execute({ ...f.command, payload: { ...f.command.payload, text: '/cost', nativeCommand: true } } as TeamCommand),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden');
  assert.throws(() => f.human.execute({ ...f.command, payload: { ...f.command.payload, text: 'ordinary text', nativeCommand: true } } as TeamCommand),
    (error) => error instanceof TeamOwnerError && error.code === 'invalid');
  assert.equal(f.human.pendingDeliveries().length, 0);
});

test('native local output uses original input and the existing reply ledger across lost ACK and restart', (t) => {
  const f = fixture(t, false, 'lead');
  const command = { ...f.command, payload: { ...f.command.payload, text: '/cost', nativeCommand: true as const } } as TeamCommand;
  f.human.execute(command);
  const intent = deliveryIdentity(f.human.pendingDeliveries()[0]!);
  const record: RuntimeSessionRecord = { schemaVersion: 1, binding: intent.binding,
    profileId: 'TEST-profile', config: null, openFingerprint: null, hostIncarnation: 'TEST-host',
    phase: 'allocated', sealed: false, custody: 'owned', nativeReady: true, sessionRef: 'TEST-session',
    inputs: [{ intent, fingerprint: deliveryFingerprint(intent), operationRef: 'TEST-operation', phase: 'consumed' }], interactions: [] };
  const activity: RuntimeActivitySnapshot = { binding: intent.binding,
    cursor: { resource: 'a'.repeat(64), hostIncarnation: 'TEST-host', sequence: 1 }, retainedFrom: 1,
    events: [], hasMore: false, state: null, latest: { text: [{ sequence: 1, eventId: 'TEST-local-output',
      inputId: intent.inputId, operationRef: 'TEST-operation', data: { kind: 'text', messageRef: 'local-command:TEST-result',
        block: 0, phase: 'complete', text: 'TEST actual subscription usage' } }], tools: [], usage: [], compaction: null, subagents: [], interactions: [] } };
  const runtime = { readCapturedSession: () => ({ record, attached: true }), readActivitySnapshot: () => activity };
  const entry = { binding: intent.binding, profile: { provider: 'claude', principalId: 'native-alice', memberId: 'alice', limits: { inputBytes: 8192 } },
    team: { definition: { binding: f.options.binding }, owner: f.owner, connection: f.human },
    provider: { isReady: () => true, sessionCommands: () => [{ name: 'cost', description: 'TEST cost' }] } } as unknown as MemberEntry;
  assert.doesNotThrow(() => assertNativeSessionCommand({ team: entry.team, entries: [entry], runtime, isCurrent: () => true }, command));
  const codex = { ...entry, profile: { ...entry.profile, provider: 'codex' } } as MemberEntry;
  assert.doesNotThrow(() => assertNativeSessionCommand({ team: entry.team,
    entries: [codex], runtime, isCurrent: () => true }, command));
  assert.equal(nativeSessionCommandAuthorized(codex, intent), false,
    'a retained native outbox cannot be reclassified as a local Codex report');
  const userInbox = () => {
    try { return JSON.parse(readFileSync(join(f.root, 'teams/test-team/inboxes/user.json'), 'utf8')) as { text: string; summary: string }[]; }
    catch { return []; }
  };
  publishNativeCommandOutput(entry, runtime);
  assert.equal(userInbox().length, 0, 'text without a matching terminal is not a completed command');
  record.inputs[0]!.phase = 'terminal'; record.inputs[0]!.terminal = 'succeeded';
  activity.latest.text[0]!.operationRef = 'foreign-operation';
  publishNativeCommandOutput(entry, runtime);
  assert.equal(userInbox().length, 0, 'foreign operation cannot supply this command output');
  activity.latest.text[0]!.operationRef = 'TEST-operation';
  const connect = f.owner.connect.bind(f.owner); let loseAck = true;
  f.owner.connect = (principal) => {
    const connected = connect(principal);
    return { ...connected, execute: (reply) => { const result = connected.execute(reply);
      if (principal === 'native-alice' && loseAck) { loseAck = false; throw new Error('TEST reply ACK lost'); }
      return result; } };
  };
  publishNativeCommandOutput(entry, runtime);
  assert.equal(userInbox().length, 1);
  const restarted = createFilesystemTeamOwner({ ...f.options, store: new TeamOwnerStore(f.root, 'test-team') });
  entry.team.owner = restarted; entry.team.connection = restarted.connect('human');
  publishNativeCommandOutput(entry, runtime);
  assert.deepEqual(userInbox().map(({ text, summary }) => ({ text, summary })), [{ text: 'TEST actual subscription usage', summary: '/cost' }]);
  assert.equal(entry.team.connection.pendingDeliveries().length, 1, 'reply recovery never submits another native command');
});


test('prepared Host cost recovers the original partial reply after a fault without recapture or native outbox', async (t) => {
  const f = fixture(t, false, 'lead');
  const { teamName: _teamName, ...binding } = f.options.members[0]!.delivery!;
  const command: Extract<TeamCommand, { operation: 'message.send' }> = {
    commandId: f.command.commandId, operation: 'message.send',
    payload: { to: 'alice', text: '/cost', messageId: f.command.commandId, nativeCommand: true },
  };
  let captures = 0, inputTokens = 11, now = 10_000;
  const prepare = () => {
    captures++;
    return captureHostCostCommand({ binding,
      stats: { inputTokens, outputTokens: 7, gaps: ['earlier activity is not retained'] },
      launch: { launchId: binding.runId, startedAtMs: 1000 }, now });
  };
  assert.throws(() => f.owner.connect('native-alice').execute(command, prepare), { code: 'forbidden' });
  assert.equal(captures, 0, 'actor authorization precedes capture');
  assert.throws(() => f.human.execute({ ...command, commandId: 'TEST-foreign-cost',
    payload: { ...command.payload, messageId: 'TEST-foreign-cost' } },
    () => captureHostCostCommand({ binding: { ...binding, generation: 'foreign' },
      stats: { inputTokens: 900, outputTokens: 800, gaps: [] }, now })), { code: 'hold' });
  assert.equal(f.human.lookup('TEST-foreign-cost'), undefined);
  const store = f.options.store!, originalRead = store.read.bind(store);
  let loseReply = true;
  t.mock.method(store, 'read', <T>(name: string): T | undefined => {
    if (loseReply && name.startsWith('outbox/')) {
      loseReply = false;
      throw new Error('TEST fault after command row and before derived reply');
    }
    return originalRead<T>(name);
  });
  assert.throws(() => f.human.execute(command, prepare), { code: 'hold' });
  assert.equal(f.inbox().length, 1, 'original command row was durably written before the fault');
  const saved = f.human.lookup(command.commandId, command)!;
  assert.equal(saved.phase, 'held');
  assert.equal(captures, 1);
  assert.match(saved.hostCommand!.text, /Input tokens reported: 11/u);
  assert.match(saved.hostCommand!.text, /Elapsed since this launch: 9s/u);
  assert.match(saved.hostCommand!.text, /not a full session total/u);
  inputTokens = 999; now = 99_000;
  const restartedOwner = createFilesystemTeamOwner({ ...f.options,
    store: new TeamOwnerStore(f.root, 'test-team') });
  await restartedOwner.resumeTaskCommands();
  const restarted = restartedOwner.connect('human');
  const completed = restarted.lookup(command.commandId, command)!;
  assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.hostCommand, saved.hostCommand);
  const userPath = join(f.root, 'teams/test-team/inboxes/user.json');
  const bytes = readFileSync(userPath, 'utf8');
  const rows = JSON.parse(bytes) as { text: string; messageId: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, saved.hostCommand!.text);
  assert.deepEqual(restarted.execute(command, prepare), completed);
  await restartedOwner.resumeTaskCommands();
  assert.equal(captures, 1, 'replay and automatic recovery do not reread newer usage or time');
  assert.equal(readFileSync(userPath, 'utf8'), bytes);
  assert.equal(f.inbox().length, 1);
  assert.deepEqual(restarted.pendingDeliveries(), []);
  const next: TeamCommand = { ...command, commandId: 'TEST-new-cost',
    payload: { ...command.payload, messageId: 'TEST-new-cost' } };
  const fresh = restarted.execute(next, prepare);
  assert.equal(captures, 2, 'a new explicit UUID captures current usage');
  assert.match(fresh.hostCommand!.text, /Input tokens reported: 999/u);
  const after = JSON.parse(readFileSync(userPath, 'utf8')) as { messageId: string }[];
  assert.equal(after.length, 2);
  assert.notEqual(after[0]!.messageId, after[1]!.messageId);
  assert.deepEqual(restarted.pendingDeliveries(), []);
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
