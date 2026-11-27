import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageGroupCatalog } from '../dist/group-chats/pageGroupCatalog.js';
import { createGroupMcpTools } from '../dist/mcp/groupChatTools.js';

const options = { key: 'TEST-private-key', principalId: 'TEST-member', binding: 'TEST-bound-team' };
const groups = Array.from({ length: 1100 }, (_, index) => ({
  groupChatId: 'TEST-group-' + index,
  name: 'TEST-group-' + index,
  memberNames: ['alice', 'bob'],
  recipientNames: ['alice', 'bob'],
  description: 'x'.repeat(240),
  archived: index % 2 === 0,
}));

test('large catalog reconstructs every group in original order within native MCP byte budget', () => {
  assert.ok(Buffer.byteLength(JSON.stringify(groups)) > 256 * 1024);
  const received: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = pageGroupCatalog({ ...options, rows: groups, ...(cursor ? { cursor } : {}) }) as {
      kind: string; groups: unknown[]; revision: string; nextCursor: string | null;
    };
    assert.equal(page.kind, 'group-catalog-page');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 240 * 1024);
    assert.ok(page.groups.length > 0);
    assert.match(page.revision, /^[a-f0-9]{64}$/);
    received.push(...page.groups);
    if (pages === 0) {
      assert.ok(page.nextCursor);
      assert.throws(() => pageGroupCatalog({ ...options, rows: groups,
        principalId: 'TEST-stranger', cursor: page.nextCursor! }), { code: 'hold' });
      assert.throws(() => pageGroupCatalog({ ...options, rows: groups.slice(0, -1),
        cursor: page.nextCursor! }), { code: 'hold' });
    }
    cursor = page.nextCursor ?? undefined;
    assert.ok(++pages < 128);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(received, groups);
});

test('small and empty group lists preserve legacy array shape', () => {
  assert.deepEqual(pageGroupCatalog({ ...options, rows: [] }), []);
  assert.deepEqual(pageGroupCatalog({ ...options, rows: groups.slice(0, 3) }), groups.slice(0, 3));
});

test('tampered, repeated-offset, and oversized single-row continuations fail closed', () => {
  const first = pageGroupCatalog({ ...options, rows: groups }) as { nextCursor: string };
  assert.ok(first.nextCursor);
  assert.throws(() => pageGroupCatalog({ ...options, rows: groups,
    cursor: '1.' + '0'.repeat(64) }), { code: 'hold' });
  assert.throws(() => pageGroupCatalog({ ...options, rows: groups, cursor: 'broken' }),
    { code: 'invalid' });
  const large = [{ groupChatId: 'TEST-large', description: 'x'.repeat(260_000) }];
  assert.throws(() => pageGroupCatalog({ ...options, rows: large }), { code: 'hold' });
});

test('native MCP catalog port accepts continuation without adding selectors or mutations', async () => {
  const calls: (string | undefined)[] = [];
  const port = { list: async (cursor?: string) => {
    calls.push(cursor);
    return pageGroupCatalog({ ...options, rows: groups, ...(cursor ? { cursor } : {}) });
  }, execute: async () => { throw new Error('No effect'); }, lookup: () => undefined };
  const tool = createGroupMcpTools(port).find(row => row.definition.name === 'group_chat_list');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.definition.inputSchema.shape), ['cursor']);
  const first = await tool.handler({}) as { nextCursor: string };
  assert.ok(first.nextCursor);
  await tool.handler({ cursor: first.nextCursor });
  assert.deepEqual(calls, [undefined, first.nextCursor]);
});
