import { groupMutationSchema } from '../dist/group-chats/operations.js';
import {
  groupReceiptFingerprint,
  validateGroupCommandReceipt,
} from '../dist/group-chats/groupCommandRecords.js';
import {
  readGroupList,
  readGroupReaction,
  readGroupCommand,
} from '../dist/group-chats/publicValues.js';
import { selectCurrentGroupEntry } from '../dist/composition/readGroupRuntime.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { OwnerBackupResourceAccess } from '../dist/adapters/lifecycle/OwnerBackupResourceAccess.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { digest } from '../dist/team/identity.js';
import { teamCommandPath, validateCommandEntry } from '../dist/team/commandEntries.js';
import type { GroupMutation } from '../dist/group-chats/operations.js';
import type { GroupCommandReceipt } from '../dist/group-chats/groupCommandRecords.js';
import type { GroupMessage } from '../dist/group-chats/message.js';
const id = '10000000-0000-4000-8000-000000000001';
const postId = '20000000-0000-4000-8000-000000000001';
const replyId = '30000000-0000-4000-8000-000000000001';
const guard = { before() {}, inside() {} };
function fixture(t: TestContext, memberNames: string[] = ['lead', 'alice']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-groups-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' };
  const members = memberNames.map((name, index) => ({
    memberId: name,
    name,
    role: index === 0 ? ('lead' as const) : ('member' as const),
    delivery: { ...binding, memberId: name, runId: 'TEST-run', generation: '1' },
  }));
  const options = {
    root,
    binding,
    members,
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'] as const,
      },
      ...members.map((member) => ({
        principalId: member.name,
        memberName: member.name,
        permissions: ['read', 'task.write', 'message.write'] as const,
      })),
    ].map((grant) => ({ ...grant, permissions: [...grant.permissions] })),
  };
  const owner = createFilesystemTeamOwner(options),
    store = new TeamOwnerStore(root, binding.teamName);
  const runtime = {
    async getRun(name: string) {
      const member = members.find((member) => member.name === name);
      return member
        ? {
            provider: 'host' as const,
            protocolVersion: 1 as const,
            groupReactionProtocolVersion: 1 as const,
            binding: member.delivery,
            runKey: 'TEST-original-' + name,
            isCurrent: async () => true,
          }
        : null;
    },
  };
  const human = owner.groupCommands('human', runtime),
    agent = owner.groupCommands('alice', runtime);
  const create: GroupMutation = {
    operation: 'create',
    id,
    name: 'Release',
    selectedMemberNames: ['lead', 'alice'],
    excludedMemberNames: [],
    autoIncludeNewMembers: false,
  };
  const send: GroupMutation = {
    operation: 'send',
    groupChatId: id,
    messageId: postId,
    text: 'Original human group post',
    summary: '  exact summary  ',
  };
  const inbox = (name: string) =>
    JSON.parse(
      readFileSync(join(root, 'teams', binding.teamName, 'inboxes', name + '.json'), 'utf8')
    ) as GroupMessage[];
  const outbox = () =>
    readdirSync(join(store.directory, 'outbox')).filter((name) => name.endsWith('.json'));
  return {
    root,
    binding,
    options,
    owner,
    store,
    runtime,
    human,
    agent,
    create,
    send,
    inbox,
    outbox,
  };
}
test('Host groups use original receipts/outboxes, exact physical envelopes and canonical replay without fanout', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  const first = await f.human.execute('TEST-send', f.send, guard);
  assert.equal(first.phase, 'completed');
  assert.equal(f.outbox().length, 2);
  const canonical = f.inbox('user');
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]!.groupMessageId, postId);
  assert.equal(canonical[0]!.source, 'user_sent');
  assert.equal(canonical[0]!.summary, '  exact summary  ');
  for (const name of ['lead', 'alice']) {
    const physical = f.inbox(name)[0]!;
    assert.notEqual(physical.messageId, postId);
    assert.equal(physical.groupMessageId, postId);
    assert.equal(physical.groupRunKey, 'TEST-original-' + name);
    assert.equal(physical.to, name);
    assert.equal(physical.summary, '  exact summary  ');
  }
  const before = f
    .outbox()
    .map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8'));
  assert.deepEqual(await f.human.execute('TEST-send', f.send, guard), first);
  await f.human.execute('TEST-transport-retry', f.send, guard);
  assert.equal(f.inbox('user').length, 1);
  assert.equal(f.inbox('alice').length, 1);
  assert.deepEqual(
    f.outbox().map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8')),
    before
  );
  const command = f.store.fenced(
    () => f.store.read<GroupCommandReceipt>(teamCommandPath('TEST-send'))!
  );
  assert.equal(validateCommandEntry(command).commandId, 'TEST-send');
  assert.equal(command.deliveries.length, 2);
  assert.ok(
    command.deliveries.every(
      (row) => !('message' in row) && /^[a-f0-9]{64}$/.test(row.messageDigest)
    )
  );
  const pending = f.owner.connect('human').pendingDeliveries();
  assert.equal(pending.length, 2);
  assert.ok(pending.every((row) => row.content.includes('group_chat_send')));
  await assert.rejects(
    f.human.execute('TEST-send', { ...f.send, text: 'Changed' }, guard),
    /conflict/
  );
});
test('newer completed group post prevents stale canonical inbox restore while the current snapshot remains restorable', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  const first = await f.human.execute('TEST-send', f.send, guard);
  assert.equal(first.phase, 'completed');
  const resource = new OwnerBackupResourceAccess(f.store, f.binding);
  const path = `teams/${f.binding.teamName}/inboxes/user.json`;
  const original = resource.capture(path);
  const reply = await f.agent.execute(
    'TEST-reply',
    {
      operation: 'send',
      groupChatId: id,
      messageId: replyId,
      text: 'Newer actual group reply',
      relayOfMessageId: f.inbox('alice')[0]!.messageId!,
    },
    guard
  );
  assert.equal(reply.phase, 'completed');
  assert.deepEqual(
    f.inbox('user').map((row) => row.groupMessageId),
    [postId, replyId]
  );
  const current = resource.capture(path);
  const originalReceipts = f.store.fenced(() => f.store.list('commands'));
  const originalDeliveries = f
    .outbox()
    .map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8'));
  const originalPeerInboxes = ['lead', 'alice'].map((name) => f.inbox(name));
  unlinkSync(join(f.root, path));
  assert.equal(resource.restoreMissing(path, original.bytes, original.proof), 'held');
  assert.equal(existsSync(join(f.root, path)), false);
  assert.notEqual(current.proof.ownerVersion, original.proof.ownerVersion);
  assert.equal(resource.restoreMissing(path, current.bytes, current.proof), 'restored');
  assert.deepEqual(readFileSync(join(f.root, path)), current.bytes);
  assert.deepEqual(
    f.store.fenced(() => f.store.list('commands')),
    originalReceipts
  );
  assert.deepEqual(
    f.outbox().map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8')),
    originalDeliveries
  );
  assert.deepEqual(
    ['lead', 'alice'].map((name) => f.inbox(name)),
    originalPeerInboxes
  );
  assert.deepEqual(f.human.lookup('TEST-send'), first);
  assert.deepEqual(f.agent.lookup('TEST-reply'), reply);
});

for (const phase of ['prepared', 'held'] as const) {
  test(`a ${phase} original group send holds canonical inbox backup and restore without replay`, async (t) => {
    const f = fixture(t);
    await f.human.execute('TEST-create', f.create, guard);
    await f.human.execute('TEST-send', f.send, guard);
    const resource = new OwnerBackupResourceAccess(f.store, f.binding);
    const path = `teams/${f.binding.teamName}/inboxes/user.json`;
    const original = resource.capture(path);
    let reached!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refuse = false;
    const commands = f.owner.groupCommands('human', {
      async getRun(name) {
        if (phase === 'prepared') {
          reached();
          await gate;
          throw new Error('TEST-original-runtime-unavailable');
        }
        return f.runtime.getRun(name);
      },
      afterDelivery() {
        refuse = true;
      },
    });
    const pending = commands.execute(
      'TEST-pending-send',
      { ...f.send, messageId: replyId, text: 'Original pending group post' },
      {
        inside() {},
        before() {
          if (refuse) throw new Error('TEST-original-input-lost');
        },
      }
    );
    const settled = assert.rejects(pending, /TEST-original-(runtime-unavailable|input-lost)/);
    try {
      if (phase === 'prepared') await paused;
      else await settled;
      assert.equal(commands.lookup('TEST-pending-send').phase, phase);
      const originalReceipts = f.store.fenced(() => f.store.list('commands'));
      const originalDeliveries = f
        .outbox()
        .map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8'));
      assert.throws(() => resource.capture(path), /hold/);
      unlinkSync(join(f.root, path));
      assert.equal(resource.restoreMissing(path, original.bytes, original.proof), 'held');
      assert.equal(existsSync(join(f.root, path)), false);
      assert.deepEqual(
        f.store.fenced(() => f.store.list('commands')),
        originalReceipts
      );
      assert.deepEqual(
        f.outbox().map((name) => readFileSync(join(f.store.directory, 'outbox', name), 'utf8')),
        originalDeliveries
      );
    } finally {
      release();
      await settled;
    }
  });
}

test('human first-ID creation, archived replay and agent physical acknowledgement retain original semantics', async (t) => {
  const f = fixture(t);
  const created = await f.human.execute('TEST-create', f.create, guard);
  const replayed = await f.human.execute(
    'TEST-other-create',
    { ...f.create, name: 'Changed' },
    guard
  );
  assert.equal(created.phase, 'completed');
  assert.equal(replayed.phase, 'completed');
  assert.ok('result' in created && 'result' in replayed);
  assert.deepEqual(replayed.result, created.result);
  await f.human.execute('TEST-send', f.send, guard);
  const physical = f.inbox('alice')[0]!;
  const acknowledged = await f.agent.execute(
    'TEST-ack',
    { operation: 'reaction.ack', groupChatId: id, relayOfMessageId: physical.messageId! },
    guard
  );
  assert.equal(acknowledged.phase, 'completed');
  assert.deepEqual(
    await f.human.read('reaction.read', { groupChatId: id, messageId: postId }, guard),
    {
      groupChatId: id,
      messageId: postId,
      actorNames: ['alice'],
      hasUserReacted: false,
      canReact: true,
    }
  );
  await f.agent.execute(
    'TEST-reply',
    {
      operation: 'send',
      groupChatId: id,
      messageId: replyId,
      text: 'Actual group reply',
      relayOfMessageId: physical.messageId!,
    },
    guard
  );
  assert.equal(f.inbox('user').length, 2);
  assert.equal(f.inbox('lead').length, 2);
  assert.equal(f.inbox('alice').length, 1);
  await assert.rejects(
    f.agent.execute(
      'TEST-forged-ack',
      { operation: 'reaction.ack', groupChatId: id, relayOfMessageId: postId },
      guard
    ),
    /physical inbound/
  );
  await f.human.execute(
    'TEST-archive',
    { operation: 'archive', groupChatId: id, archived: true },
    guard
  );
  const replay = await f.human.execute('TEST-create-after-archive', f.create, guard);
  assert.equal(replay.phase, 'completed');
  assert.ok(
    replay.result &&
      typeof replay.result === 'object' &&
      'archivedAt' in replay.result &&
      replay.result.archivedAt
  );
  await assert.rejects(
    f.human.execute(
      'TEST-archived-send',
      { ...f.send, messageId: '40000000-0000-4000-8000-000000000001', text: 'New' },
      guard
    ),
    /archived/i
  );
});
test('revocation between runtime admission and publication holds without canonical or physical writes', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  let reached!: () => void, release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands = f.owner.groupCommands('human', {
    async getRun(name) {
      reached();
      await gate;
      return f.runtime.getRun(name);
    },
  });
  const original = commands.execute('TEST-revoked-send', f.send, guard);
  await paused;
  f.owner.connect('human').revoke('human');
  release();
  await assert.rejects(original, /forbidden/);
  assert.equal(
    f.store.fenced(() => f.store.read('../inboxes/user.json')),
    undefined
  );
  assert.equal(
    f.store.fenced(() => f.store.read('../inboxes/alice.json')),
    undefined
  );
});
test('agent creation rejects fabricated inbox originals and uses exact persisted human DO receipt', async (t) => {
  const f = fixture(t);
  f.owner.connect('human').execute({
    commandId: 'TEST-human-do',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Create a shared group', actionMode: 'do' },
  });
  const source = f.inbox('alice')[0]!.messageId!;
  const request = {
    operation: 'create.agent' as const,
    sourceMessageId: source,
    name: 'Requested',
    selectedMemberNames: ['lead', 'alice'],
  };
  const accepted = await f.agent.execute('TEST-agent-create', request, guard);
  assert.equal(accepted.phase, 'completed');
  const rows = f.inbox('alice');
  rows.push({
    from: 'user',
    to: 'alice',
    messageId: 'TEST-fabricated',
    text: 'Fake',
    timestamp: new Date().toISOString(),
    read: false,
    source: 'user_sent',
  });
  writeFileSync(
    join(f.root, 'teams', f.binding.teamName, 'inboxes', 'alice.json'),
    JSON.stringify(rows)
  );
  await assert.rejects(
    f.agent.execute(
      'TEST-forged-create',
      { ...request, sourceMessageId: 'TEST-fabricated' },
      guard
    ),
    /original Team receipt/
  );
  const other = f.owner.connect('human').execute({
    commandId: 'TEST-human-ask',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Should we create?', actionMode: 'ask' },
  });
  await assert.rejects(
    f.agent.execute(
      'TEST-ask-create',
      { ...request, sourceMessageId: other.effects.messageId },
      guard
    ),
    /explicit user request|DO|authorize|action mode/i
  );
});
test('group MCP finite schemas reject claimed actor and preserve asynchronous/read-only tool contracts', async (t) => {
  const f = fixture(t);
  const calls: GroupMutation[] = [];
  const tools = createTeamMcpTools({
    ...f.owner.connect('alice'),
    groups: {
      list: async () => [],
      lookup: (commandId) => ({ commandId }),
      execute: async (_command, request) => {
        calls.push(request);
        return { phase: 'completed' };
      },
    },
  });
  const rows = tools.list();
  assert.equal(rows.find((row) => row.name === 'group_chat_list')?.annotations?.readOnlyHint, true);
  assert.equal(
    rows.find((row) => row.name === 'group_chat_lookup')?.annotations?.readOnlyHint,
    true
  );
  assert.throws(() => tools.call('group_chat_send', {}), /unsupported/);
  await assert.rejects(
    tools.callAsync('group_chat_send', {
      commandId: 'TEST-wire',
      groupChatId: id,
      messageId: replyId,
      text: 'Reply',
      from: 'lead',
    }),
    /invalid/
  );
  await tools.callAsync('group_chat_send', {
    commandId: 'TEST-wire',
    groupChatId: id,
    messageId: replyId,
    text: 'Reply',
  });
  assert.equal(calls.length, 1);
  assert.equal(
    digest(calls[0]),
    digest({ operation: 'send', groupChatId: id, messageId: replyId, text: 'Reply' })
  );
});

test('native source projection reads the human-owned receipt only through the exact original Team input proof', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  await f.human.execute('TEST-send', f.send, guard);
  const raw = f.owner
    .connect('human')
    .pendingDeliveries()
    .find((row) => row.binding.memberId === 'alice')!;
  const proof = f.owner.captureNativeMcpAuthority('alice', raw.binding, raw, false);
  assert.ok('messageCommandId' in proof.cause);
  if (!('messageCommandId' in proof.cause)) throw new Error('Missing original message cause');
  const messageCommandId = proof.cause.messageCommandId;
  assert.throws(() => f.owner.connect('alice').lookup(messageCommandId), /forbidden/);
  assert.deepEqual(f.owner.groupInputSource('alice', proof), {
    sourceMessageId: postId,
    groupChatId: id,
    physicalMessageId: raw.messageId,
  });
  assert.throws(
    () =>
      f.owner.groupInputSource('alice', {
        ...proof,
        original: { ...proof.original, messageId: 'TEST-forged' },
      }),
    /forbidden/
  );
});
test('held archive after publication never overwrites a newer opposite user action', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  let refuse = true;
  const afterSave = {
    inside() {},
    before() {
      const registry = f.store.fenced(() =>
        f.store.read<{ groups: { archivedAt: string | null }[] }>('../group-chats.json')
      );
      if (refuse && registry?.groups[0]?.archivedAt) throw new Error('TEST-observation-lost');
    },
  };
  const archive = { operation: 'archive' as const, groupChatId: id, archived: true };
  await assert.rejects(
    f.human.execute('TEST-original-archive', archive, afterSave),
    /TEST-observation-lost/
  );
  const original = f.store.fenced(
    () => f.store.read<GroupCommandReceipt>(teamCommandPath('TEST-original-archive'))!
  );
  assert.equal(original.phase, 'held');
  assert.equal(original.publication, 'requested');
  refuse = false;
  await f.human.execute('TEST-new-unarchive', { ...archive, archived: false }, guard);
  assert.equal((await f.human.execute('TEST-original-archive', archive, guard)).phase, 'held');
  const groups = await f.human.read('list', {}, guard);
  assert.ok(Array.isArray(groups));
  assert.equal(groups[0]?.archivedAt, null);
});
test('partial physical fanout remains original and held retry never dispatches another recipient', async (t) => {
  const f = fixture(t);
  await f.human.execute('TEST-create', f.create, guard);
  let refuse = false,
    deliveries = 0;
  const originalGuard = {
    inside() {},
    before() {
      if (refuse) throw new Error('TEST-original-input-lost');
    },
  };
  const commands = f.owner.groupCommands('human', {
    ...f.runtime,
    afterDelivery() {
      deliveries++;
      refuse = true;
    },
  });
  await assert.rejects(
    commands.execute('TEST-partial-send', f.send, originalGuard),
    /TEST-original-input-lost/
  );
  assert.equal(deliveries, 1);
  assert.equal(f.inbox('user').length, 1);
  assert.equal(f.outbox().length, 1);
  refuse = false;
  assert.equal((await commands.execute('TEST-partial-send', f.send, originalGuard)).phase, 'held');
  assert.equal(deliveries, 1);
  assert.equal(f.outbox().length, 1);
});

test('current Team delivery selects the new launch entry even when a stopped historical entry was inserted first', () => {
  const binding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    teamName: 'test-team',
    runId: 'TEST-old-run',
    memberId: 'alice',
    generation: '1',
  };
  const old = { delivery: binding, state: 'stopped' },
    current = { delivery: { ...binding, runId: 'TEST-new-run', generation: '2' }, state: 'owned' };
  const entries = new Map([
    ['old', old],
    ['new', current],
  ]);
  assert.equal(selectCurrentGroupEntry(entries.values(), current.delivery), current);
  assert.equal(selectCurrentGroupEntry([old], current.delivery), undefined);
  assert.equal(selectCurrentGroupEntry([old, current], undefined), undefined);
  assert.equal(selectCurrentGroupEntry([current, { ...current }], current.delivery), undefined);
});

test('group projection admits the full Team roster and one human reaction without widening creation selection', async (t) => {
  const members = Array.from({ length: 256 }, (_, index) => `member-${index}`);
  const group = {
    id,
    name: 'Full roster',
    createdAt: new Date().toISOString(),
    membership: { kind: 'auto', excludedMemberNames: [] },
    archivedAt: null,
    memberNames: members,
    availableRecipientNames: members,
    canSend: true,
  };
  const roster = ['lead', 'alice', ...members.slice(2)];
  const f = fixture(t, roster);
  await f.human.execute('TEST-full-create', { ...f.create, autoIncludeNewMembers: true }, guard);
  await f.human.execute('TEST-full-send', f.send, guard);
  assert.equal(f.outbox().length, 256);
  const registryPath = join(f.root, 'teams', f.binding.teamName, 'group-chats.json');
  const beforeCreation = readFileSync(registryPath);
  await assert.rejects(
    f.agent.execute(
      'TEST-oversize-metadata',
      {
        operation: 'create.agent',
        sourceMessageId: postId,
        name: 'Refused original audience',
        selectedMemberNames: ['lead', 'alice'],
        autoIncludeNewMembers: false,
      },
      guard
    ),
    /creation metadata/
  );
  assert.deepEqual(readFileSync(registryPath), beforeCreation);
  const readable = await f.human.read('list', {}, guard);
  assert.ok(Array.isArray(readable));
  assert.equal(readable.find((value) => value.id === id)?.memberNames.length, 256);
  assert.equal(readGroupList([group])[0]!.memberNames.length, 256);
  assert.throws(() => readGroupList([{ ...group, memberNames: [...members, 'overflow'] }]));
  const reaction = {
    groupChatId: id,
    messageId: postId,
    actorNames: [...members, 'user'],
    hasUserReacted: true,
    canReact: true,
  };
  assert.equal(readGroupReaction(reaction).actorNames.length, 257);
  assert.throws(() =>
    readGroupReaction({ ...reaction, actorNames: [...reaction.actorNames, 'overflow'] })
  );
  const sent = {
    kind: 'group-chat-command',
    commandId: 'TEST-full-roster',
    phase: 'completed',
    operation: 'send',
    result: {
      saved: true,
      groupChatId: id,
      messageId: postId,
      statusPersisted: true,
      deliverySummary: {
        recordedAt: group.createdAt,
        recipients: members.map((memberName) => ({
          memberName,
          physicalMessageId: postId + ':g:' + memberName,
          status: 'accepted',
        })),
      },
    },
  };
  assert.equal(
    groupMutationSchema.safeParse({
      operation: 'create',
      id,
      name: 'Bounded selection',
      selectedMemberNames: members.slice(0, 201),
      excludedMemberNames: [],
      autoIncludeNewMembers: false,
    }).success,
    false
  );
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' };
  const draft: Omit<GroupCommandReceipt, 'fingerprint'> = {
    schemaVersion: 1,
    family: 'group-chat',
    binding,
    commandId: 'TEST-full-roster',
    principalId: 'human',
    actor: 'user',
    authorityRevision: 1,
    request: { operation: 'send', groupChatId: id, messageId: postId, text: 'Full roster' },
    createdAt: group.createdAt,
    phase: 'prepared',
    publication: 'not-requested',
    deliveries: members.map((name) => ({
      recipient: {
        name,
        physicalMessageId: postId + ':g:' + name,
        commandId: postId + ':g:' + name,
        binding: { ...binding, memberId: name, runId: 'TEST-run', generation: '1' },
      },
      messageDigest: 'a'.repeat(64),
    })),
  };
  const receipt = { ...draft, fingerprint: groupReceiptFingerprint(draft) };
  assert.equal(validateGroupCommandReceipt(receipt).deliveries.length, 256);
  assert.throws(
    () =>
      validateGroupCommandReceipt({
        ...receipt,
        deliveries: [
          ...receipt.deliveries,
          {
            ...receipt.deliveries[0]!,
            recipient: { ...receipt.deliveries[0]!.recipient, name: 'overflow' },
          },
        ],
      }),
    /hold/
  );
  assert.equal(readGroupCommand(sent, sent.commandId).phase, 'completed');
  assert.throws(() =>
    readGroupCommand(
      {
        ...sent,
        result: {
          ...sent.result,
          deliverySummary: {
            ...sent.result.deliverySummary,
            recipients: [
              ...sent.result.deliverySummary.recipients,
              { memberName: 'overflow', physicalMessageId: postId, status: 'accepted' },
            ],
          },
        },
      },
      sent.commandId
    )
  );
});
