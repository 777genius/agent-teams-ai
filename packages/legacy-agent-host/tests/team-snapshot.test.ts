import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { pageOwnerSnapshot } from '../dist/team/pageOwnerSnapshot.js';

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



test('one task with large nested history retains all task parts, order and signed continuations', () => {
  const history = Array.from({ length: 90 }, (_, index) => ({
    id: 'comment-' + index,
    author: 'alice',
    type: 'regular',
    createdAt: '2026-01-01T00:00:00Z',
    text: 'history-' + index + '-' + 'x'.repeat(6000),
  }));
  const tasks = [
    { id: 'first', subject: 'First', status: 'pending', comments: [] },
    { id: 'large', subject: 'Large', status: 'pending', comments: history,
      historyEvents: [{ id: 'created', timestamp: '2026-01-01T00:00:00Z',
        type: 'task_created', status: 'pending' }] },
    { id: 'last', subject: 'Last', status: 'pending', comments: [] },
  ];
  const snapshot = {
    teamName: 'TEST-team', revision: 'a'.repeat(64), members: [],
    tasks, messages: [],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
  };
  const original = JSON.stringify(snapshot);
  for (const maxBytes of [128 * 1024, 384 * 1024]) {
    const groups = new Map<number, Map<number, Record<string, unknown>>>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = pageOwnerSnapshot({ principalId: 'human', key: 'TEST-key',
        snapshot, maxBytes, ...(cursor ? { cursor } : {}) }) as {
        tasks: Record<string, unknown>[];
        taskTotal: number;
        taskParts: { index: number; part: number; total: number }[];
        nextCursor: string | null;
      };
      assert.equal(page.taskTotal, tasks.length);
      assert.equal(page.taskParts.length, page.tasks.length);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      for (const [index, marker] of page.taskParts.entries()) {
        const group = groups.get(marker.index) ?? new Map();
        assert.equal(group.has(marker.part), false);
        group.set(marker.part, page.tasks[index]!);
        groups.set(marker.index, group);
      }
      if (pages === 0) {
        assert.ok(page.nextCursor);
        assert.throws(() => pageOwnerSnapshot({ principalId: 'different',
          key: 'TEST-key', snapshot, maxBytes, cursor: page.nextCursor! }));
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
      assert.ok(pages < 128, 'cursor must converge');
    } while (cursor);
    assert.equal(groups.size, tasks.length);
    const rebuilt = tasks.map((task, index) => {
      const pieces = groups.get(index)!;
      const base = { ...pieces.get(0)! };
      for (let part = 1; part < pieces.size; part++) {
        const row = pieces.get(part)!;
        for (const field of ['comments', 'historyEvents']) {
          if (Array.isArray(row[field]))
            (base as Record<string, unknown>)[field] = [
              ...((base as Record<string, unknown>)[field] as unknown[] ?? []),
              ...(row[field] as unknown[]),
            ];
        }
      }
      assert.equal(base.id, task.id);
      return base;
    });
    assert.deepEqual(rebuilt, tasks);
    assert.ok(pages > 1);
  }
  assert.equal(JSON.stringify(snapshot), original, 'paging does not mutate original data');
});

test('a 420 KiB Unicode message remains readable through signed Desktop and MCP pages', () => {
  const message = {
    messageId: 'TEST-oversized-message',
    from: 'alice',
    timestamp: '2026-01-01T00:00:00.000Z',
    text: '漢'.repeat(140_000),
    read: false,
    attachments: [{ id: 'TEST-attachment', filename: 'proof.txt' }],
  };
  const snapshot = {
    teamName: 'TEST-team', revision: 'a'.repeat(64), members: [],
    tasks: [], messages: [message],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(message)) > 384 * 1024);
  const original = JSON.stringify(snapshot);
  for (const maxBytes of [128 * 1024, 384 * 1024]) {
    const fragments = new Map<number, string>();
    let cursor: string | undefined, pages = 0;
    do {
      const page = pageOwnerSnapshot({
        principalId: 'human', key: 'TEST-key', snapshot, maxBytes,
        ...(cursor ? { cursor } : {}),
      }) as {
        messages: { text: string; attachments?: unknown[] }[];
        messageTotal: number;
        messageParts: { index: number; part: number; total: number }[];
        nextCursor: string | null;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      assert.equal(page.messageTotal, 1);
      assert.equal(page.messageParts.length, page.messages.length);
      for (const [position, marker] of page.messageParts.entries()) {
        assert.equal(marker.index, 0);
        assert.ok(!fragments.has(marker.part));
        fragments.set(marker.part, page.messages[position]!.text);
        if (marker.part > 0)
          assert.equal(page.messages[position]!.attachments, undefined);
      }
      if (pages === 0) {
        assert.ok(page.nextCursor);
        assert.throws(() => pageOwnerSnapshot({
          principalId: 'foreign', key: 'TEST-key', snapshot,
          maxBytes, cursor: page.nextCursor!,
        }));
      }
      cursor = page.nextCursor ?? undefined;
      assert.ok(++pages < 128);
    } while (cursor);
    assert.ok(pages > 1);
    assert.equal([...fragments.entries()].sort(([a], [b]) => a - b)
      .map(([, text]) => text).join(''), message.text);
  }
  assert.equal(JSON.stringify(snapshot), original);
});

test('large retained task inventory stays readable through all bounded original Owner pages', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-large-tasks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' }],
    grants: [{ principalId: 'human', memberName: 'user',
      permissions: ['read', 'admin', 'task.write'] }],
  });
  const reader = owner.connect('human');
  const expected = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const commandId = `TEST-task-${index}`;
    const subject = `TEST inventory task ${index}`;
    reader.execute({
      commandId,
      operation: 'task.create',
      payload: { subject, description: `description-${index}-${'x'.repeat(6000)}` },
    });
    expected.add(subject);
  }
  const first = reader.readSnapshot() as {
    tasks: { subject: string; description: string }[];
    revision: string;
    nextCursor: string | null;
  };
  assert.ok(first.nextCursor, 'large persisted task history must cross more than one page');
  const observed = [...first.tasks];
  let cursor: string | null = first.nextCursor;
  let pages = 1;
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 384 * 1024);
  while (cursor) {
    const page = reader.readSnapshot({ cursor }) as typeof first;
    assert.equal(page.revision, first.revision);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 384 * 1024);
    observed.push(...page.tasks);
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages <= 128, 'continuation must terminate within bounded page limit');
  }
  assert.equal(observed.length, expected.size);
  assert.equal(new Set(observed.map((row) => row.subject)).size, expected.size);
  assert.deepEqual(new Set(observed.map((row) => row.subject)), expected);
  assert.ok(observed.every((row) => row.description.length > 6000));
  assert.equal(reader.readChanges() !== undefined, true);
});

test('Kanban entries and column ordering survive both Desktop and MCP page budgets', () => {
  const ids = Array.from({ length: 6000 }, (_, index) => `TEST-task-${index}`);
  const positions = Object.fromEntries(ids.map((id, index) => [id, {
    column: index < 3000 ? 'review' : 'approved',
    movedAt: '2026-01-01T00:00:00Z',
  }]));
  const board = {
    teamName: 'TEST-team',
    reviewers: ['alice'],
    tasks: positions,
    columnOrder: { review: ids.slice(0, 3000), approved: ids.slice(3000) },
  };
  const snapshot = {
    teamName: 'TEST-team',
    revision: 'a'.repeat(64),
    members: [],
    tasks: [],
    messages: [],
    kanbanState: board,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(board)) > 384 * 1024);
  const originalBytes = JSON.stringify(snapshot);
  for (const maxBytes of [128 * 1024, 384 * 1024]) {
    let cursor: string | undefined;
    const entries: Record<string, unknown> = {};
    const reviewers: string[] = [];
    const order = { review: [] as string[], approved: [] as string[] };
    let pages = 0;
    do {
      const page = pageOwnerSnapshot({
        principalId: 'TEST-authorized',
        key: 'TEST-owned-cursor-key',
        snapshot,
        maxBytes,
        ...(cursor ? { cursor } : {}),
      }) as {
        kanbanState: {
          reviewers: string[];
          tasks: Record<string, unknown>;
          columnOrder: { review: string[]; approved: string[] };
        };
        nextCursor: string | null;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      for (const [key, value] of Object.entries(page.kanbanState.tasks)) {
        assert.equal(Object.hasOwn(entries, key), false);
        entries[key] = value;
      }
      reviewers.push(...page.kanbanState.reviewers);
      order.review.push(...page.kanbanState.columnOrder.review);
      order.approved.push(...page.kanbanState.columnOrder.approved);
      cursor = page.nextCursor ?? undefined;
      pages++;
      assert.ok(pages <= 128);
    } while (cursor);
    assert.ok(pages > 1);
    assert.deepEqual(entries, positions);
    assert.deepEqual(reviewers, board.reviewers);
    assert.deepEqual(order, board.columnOrder);
  }
  assert.equal(JSON.stringify(snapshot), originalBytes);
});

test('large legitimate inbox history preserves bounded snapshots and authorized change feed', (t) => {
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
  const firstSnapshot = reader.readSnapshot() as {
    revision: string;
    messages: typeof messages;
    nextCursor: string | null;
  };
  assert.ok(firstSnapshot.nextCursor, 'bounded initial page must offer continuation');
  const collected = [...firstSnapshot.messages.map((row) => row.messageId)];
  let continuation: string | null = firstSnapshot.nextCursor;
  let pageCount = 1;
  assert.ok(Buffer.byteLength(JSON.stringify(firstSnapshot)) < 384 * 1024);
  while (continuation) {
    const page = reader.readSnapshot({ cursor: continuation }) as typeof firstSnapshot;
    assert.equal(page.revision, firstSnapshot.revision);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 384 * 1024);
    collected.push(...page.messages.map((row) => row.messageId));
    continuation = page.nextCursor;
    pageCount++;
  }
  assert.ok(pageCount > 1);
  assert.equal(collected.length, messages.length);
  assert.equal(new Set(collected).size, messages.length);
  assert.throws(() => other.readSnapshot({ cursor: firstSnapshot.nextCursor! }), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold');
  assert.throws(() => reader.readSnapshot({ cursor: '1.' + '0'.repeat(64) }), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold');
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
  assert.throws(() => reader.readSnapshot({ cursor: firstSnapshot.nextCursor! }), (error) =>
    error instanceof TeamOwnerError && error.code === 'hold', 'stale cursor is rejected');
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
  const snapshotPage = reader.readSnapshot() as { messages: unknown[]; nextCursor: string | null };
  assert.ok(snapshotPage.nextCursor);
  assert.ok(snapshotPage.messages.length < messages.length);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshotPage)) < 384 * 1024);
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
