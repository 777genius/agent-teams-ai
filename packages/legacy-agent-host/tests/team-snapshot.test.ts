import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

test('snapshot reads persisted authority/roster/tasks/kanban and only permitted inboxes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-snapshot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' as const }],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write'] as ('read' | 'admin' | 'task.write')[],
      },
      { principalId: 'alice', memberName: 'alice', permissions: ['read'] as 'read'[] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'actual task' },
  });
  mkdirSync(join(root, 'teams/test-team/inboxes'), { recursive: true });
  for (const name of ['alice', 'user'])
    writeFileSync(
      join(root, 'teams/test-team/inboxes', `${name}.json`),
      JSON.stringify([{ from: 'user', text: name, timestamp: '2026-01-01', read: false }])
    );
  const alice = owner.connect('alice');
  const own = alice.readSnapshot() as Record<string, unknown>;
  assert.equal((own.messages as { text: string }[]).length, 1);
  assert.equal((own.messages as { text: string }[])[0]!.text, 'alice');
  assert.equal(((human.readSnapshot() as Record<string, unknown>).messages as unknown[]).length, 2);
  assert.equal(((human.readSnapshot() as Record<string, unknown>).tasks as unknown[]).length, 1);
  const reopened = createFilesystemTeamOwner({ ...options, members: [] });
  assert.equal(
    ((reopened.connect('human').readSnapshot() as Record<string, unknown>).members as unknown[])
      .length,
    1
  );
  human.revoke('alice');
  assert.throws(
    () => alice.readSnapshot(),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
  assert.equal(JSON.stringify(human.readSnapshot()).includes('principalId'), false);
});


test('large legitimate inbox history preserves bounded authorized change feed, not full snapshot access', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-large-feed-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' }],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin'],
      },
      { principalId: 'alice', memberName: 'alice', permissions: ['read'] },
    ],
  });
  const reader = owner.connect('human');
  const other = owner.connect('alice');
  const inbox = join(root, 'teams/test-team/inboxes/user.json');
  mkdirSync(join(root, 'teams/test-team/inboxes'), { recursive: true });
  const messages = Array.from({ length: 120 }, (_, index) => ({
    messageId: `TEST-message-${index}`,
    from: 'alice',
    text: `retained-${index}-${'x'.repeat(6000)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
  }));
  writeFileSync(inbox, JSON.stringify(messages));
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024);
  assert.throws(
    () => reader.readSnapshot(),
    (error) => error instanceof TeamOwnerError && error.code === 'hold',
    'the full snapshot cap is never bypassed'
  );
  const initial = reader.readChanges() as {
    cursor: string;
    events: unknown[];
    gap?: { reason: string };
  };
  assert.equal(initial.gap?.reason, 'initial');
  assert.deepEqual(initial.events, []);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 512 * 1024);
  const repeat = reader.readChanges(initial.cursor) as { events: unknown[] };
  assert.deepEqual(repeat.events, []);
  messages.push({
    messageId: 'TEST-message-new',
    from: 'alice',
    text: 'new retained record',
    timestamp: '2026-01-02T00:00:00.000Z',
    read: false,
  });
  writeFileSync(inbox, JSON.stringify(messages));
  const changed = reader.readChanges(initial.cursor) as {
    events: { kind: string }[];
    gap?: { reason: string };
  };
  assert.equal(changed.gap, undefined);
  assert.equal(changed.events.length, 1, 'file-backed revision change invalidates the feed once');
  assert.equal(changed.events[0]?.kind, 'invalidate');
  assert.ok(Buffer.byteLength(JSON.stringify(changed)) < 512 * 1024);
  assert.equal(JSON.stringify(changed).includes('retained-0'), false, 'history never leaves change feed');
  assert.equal((other.readChanges(initial.cursor) as { gap?: { reason: string } }).gap?.reason, 'cursor');
  reader.revoke('alice');
  assert.throws(
    () => other.readChanges(),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
});


test('owner-side pages retain every message beyond 512 KiB under revision and principal fences', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-message-page-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] },
      { principalId: 'alice', memberName: 'alice', permissions: ['read'] },
    ],
  });
  const reader = owner.connect('human');
  const other = owner.connect('alice');
  const inbox = join(root, 'teams/test-team/inboxes/user.json');
  mkdirSync(join(root, 'teams/test-team/inboxes'), { recursive: true });
  const messages = Array.from({ length: 120 }, (_, index) => ({
    messageId: `TEST-message-${index}`,
    from: 'alice',
    text: `retained-${index}-${'x'.repeat(6000)}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    read: false,
  }));
  writeFileSync(inbox, JSON.stringify(messages));
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024);
  assert.throws(() => reader.readSnapshot(), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold');
  const first = reader.readMessagesPage({ limit: 20 }) as {
    revision: string; messages: typeof messages; nextCursor: string | null; hasMore: boolean;
  };
  assert.equal(first.messages.length, 20);
  assert.equal(first.messages.at(-1)?.messageId, 'TEST-message-119');
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 384 * 1024);
  assert.equal(JSON.stringify(first).includes('principalId'), false);
  const visited = first.messages.map((row) => row.messageId);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = reader.readMessagesPage({ cursor, limit: 20 }) as typeof first;
    assert.equal(page.revision, first.revision);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 384 * 1024);
    visited.push(...page.messages.map((row) => row.messageId));
    cursor = page.nextCursor;
  }
  assert.equal(visited.length, 120);
  assert.equal(new Set(visited).size, 120);
  assert.equal(visited[0], 'TEST-message-100');
  assert.equal(visited.at(-1), 'TEST-message-19');
  assert.throws(() => other.readMessagesPage({ cursor: first.nextCursor! }), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold');
  assert.deepEqual((other.readMessagesPage() as { messages: unknown[] }).messages, []);
  messages.push({ messageId: 'TEST-message-120', from: 'alice', text: 'new',
    timestamp: '2026-01-02T00:00:00.000Z', read: false });
  writeFileSync(inbox, JSON.stringify(messages));
  assert.throws(() => reader.readMessagesPage({ cursor: first.nextCursor! }), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold');
  reader.revoke('alice');
  assert.throws(() => other.readMessagesPage(), (error) =>
    error instanceof TeamOwnerError && error.code === 'forbidden');
});

test('removed teammate inbox remains readable for admin only after a persisted owner restart', (ctx) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-removed-inbox-')));
  ctx.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' as const }],
    removedMembers: [
      {
        memberId: 'bob',
        name: 'bob',
        role: 'member' as const,
        removedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] as ('read' | 'admin')[] },
      { principalId: 'alice', memberName: 'alice', permissions: ['read'] as 'read'[] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const directory = join(root, 'teams/test-team/inboxes');
  mkdirSync(directory, { recursive: true });
  for (const name of ['bob', 'alice']) {
    writeFileSync(
      join(directory, `${name}.json`),
      JSON.stringify([{
        messageId: `TEST-${name}-message`,
        from: 'user',
        text: `original-${name}-history`,
        timestamp: name === 'bob' ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
        read: false,
      }])
    );
  }

  const admin = owner.connect('human');
  const member = owner.connect('alice');
  const snapshot = admin.readSnapshot() as {
    members: { name: string }[];
    messages: { text: string }[];
  };
  assert.deepEqual(snapshot.members.map((row) => row.name), ['alice'], 'removed member stays absent from active roster');
  assert.deepEqual(
    snapshot.messages.map((row) => row.text).sort(),
    ['original-alice-history', 'original-bob-history']
  );
  const adminPage = admin.readMessagesPage({ limit: 10 }) as { messages: { text: string }[] };
  assert.deepEqual(
    adminPage.messages.map((row) => row.text).sort(),
    ['original-alice-history', 'original-bob-history']
  );
  const aliceSnapshot = member.readSnapshot() as { messages: { text: string }[] };
  assert.deepEqual(aliceSnapshot.messages.map((row) => row.text), ['original-alice-history']);
  const alicePage = member.readMessagesPage() as { messages: { text: string }[] };
  assert.deepEqual(alicePage.messages.map((row) => row.text), ['original-alice-history']);
  assert.throws(() => owner.connect('bob').readMessagesPage(), (error) =>
    error instanceof TeamOwnerError && error.code === 'forbidden'
  );

  const reopened = createFilesystemTeamOwner({ ...options, members: [], removedMembers: [] });
  const reopenedPage = reopened.connect('human').readMessagesPage() as {
    messages: { text: string }[];
  };
  assert.deepEqual(
    reopenedPage.messages.map((row) => row.text).sort(),
    ['original-alice-history', 'original-bob-history'],
    'persisted removed-member history must survive reopen'
  );
});
