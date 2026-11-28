import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageProcessCatalog } from '../dist/process/pageProcessCatalog.js';
import { createProcessMcpTools } from '../dist/mcp/processTools.js';
import { formatToolResult } from '../dist/mcp/toolDefinition.js';

const rows = Array.from({ length: 100 }, (_, index) => ({
  id: 'TEST-process-' + index,
  pid: index + 1000,
  label: 'TEST registered service',
  registeredAt: '2026-11-28T00:00:00.000Z',
  processRef: 'p1:TEST:' + index.toString(16).padStart(64, '0'),
  command: 'x'.repeat(4096),
  observation: 'metadata-stopped' as const,
  canTerminate: false,
}));
const key = 'TEST-original-native-port';

test('the native process inventory reconstructs all 100 original 4KiB records within MCP byte budget', () => {
  const originalBytes = JSON.stringify(rows);
  assert.ok(Buffer.byteLength(originalBytes) > 256 * 1024);
  const seen: typeof rows = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = pageProcessCatalog({ rows, key, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(!Array.isArray(page));
    assert.equal(page.kind, 'process-catalog-page');
    assert.equal(page.total, rows.length);
    assert.ok(page.processes.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 240 * 1024);
    const formatted = formatToolResult(page, false);
    assert.equal(formatted.content[0]?.type, 'text');
    seen.push(...page.processes as typeof rows);
    if (pages === 0) {
      assert.ok(page.nextCursor);
      assert.throws(() => pageProcessCatalog({ rows, key: 'TEST-other-port',
        cursor: page.nextCursor! }), { code: 'hold' });
      assert.throws(() => pageProcessCatalog({ rows: rows.slice(1), key,
        cursor: page.nextCursor! }), { code: 'hold' });
    }
    cursor = page.nextCursor ?? undefined;
    assert.ok(++pages < 128);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(seen, rows);
  assert.equal(JSON.stringify(rows), originalBytes);
});

test('small, empty, malformed and single-oversize process responses preserve strict behavior', () => {
  assert.deepEqual(pageProcessCatalog({ rows: [], key }), []);
  assert.deepEqual(pageProcessCatalog({ rows: rows.slice(0, 2), key }), rows.slice(0, 2));
  assert.throws(() => pageProcessCatalog({ rows, key, cursor: 'invalid' }), { code: 'invalid' });
  assert.throws(() => pageProcessCatalog({ rows, key, cursor: '1.' + '0'.repeat(64) }),
    { code: 'hold' });
  assert.throws(() => pageProcessCatalog({ rows: [{ ...rows[0]!, command: 'x'.repeat(260_000) }],
    key }), { code: 'hold' });
});

test('native MCP process_list cursor is passed only to its original read port', async () => {
  let reads = 0;
  const port = {
    list: () => { reads++; return rows; },
    register: async () => { throw new Error('TEST must not register'); },
    metadata: async () => { throw new Error('TEST must not mutate'); },
    lookup: async () => null,
  };
  const tool = createProcessMcpTools(port).find(x => x.definition.name === 'process_list');
  assert.ok(tool);
  assert.equal(tool.mutation, false);
  const first = await tool.invoke({}) as ReturnType<typeof pageProcessCatalog>;
  assert.ok(!Array.isArray(first));
  assert.ok(first.nextCursor);
  const second = await tool.invoke({ cursor: first.nextCursor });
  assert.ok(second);
  assert.equal(reads, 2, 'each page rechecks the exact native Owner read port');
  assert.throws(() => tool.invoke({ cursor: 'not-a-cursor' }), /invalid/);
  assert.equal(reads, 2, 'malformed cursors cannot read the owner');
});
