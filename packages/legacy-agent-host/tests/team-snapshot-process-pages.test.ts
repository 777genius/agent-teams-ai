import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageOwnerSnapshot } from '../dist/team/pageOwnerSnapshot.js';
test('retained processes page by serialized bytes without losing or repeating history', () => {
  const processes = Array.from({ length: 100 }, (_, index) => ({
    id: 'TEST-process-' + index,
    pid: 1000 + index,
    label: 'TEST-process',
    registeredAt: '2026-11-28T00:00:00.000Z',
    processRef: 'p1:TEST:' + index.toString(16).padStart(64, '0'),
    observation: 'metadata-stopped',
    canTerminate: false,
    command: 'x'.repeat(4_096),
  }));
  const snapshot = {
    teamName: 'TEST-team', revision: 'a'.repeat(64), members: [],
    tasks: [], messages: [], processes,
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
  };
  const before = JSON.stringify(snapshot);
  for (const maxBytes of [128 * 1024, 384 * 1024]) {
    const assembled: typeof processes = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = pageOwnerSnapshot({ principalId: 'human', key: 'TEST-key',
        snapshot, maxBytes, ...(cursor ? { cursor } : {}) }) as {
          processTotal: number;
          processes: typeof processes;
          nextCursor: string | null;
        };
      assert.equal(page.processTotal, processes.length);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      assembled.push(...page.processes);
      if (pages === 0) {
        assert.ok(page.nextCursor);
        assert.throws(() => pageOwnerSnapshot({ principalId: 'other', key: 'TEST-key',
          snapshot, maxBytes, cursor: page.nextCursor! }), { code: 'hold' });
        assert.throws(() => pageOwnerSnapshot({ principalId: 'human', key: 'TEST-key',
          snapshot: { ...snapshot, revision: 'b'.repeat(64) }, maxBytes,
          cursor: page.nextCursor! }), { code: 'hold' });
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
      assert.ok(pages < 128);
    } while (cursor);
    assert.ok(pages > 1);
    assert.deepEqual(assembled, processes);
  }
  assert.equal(JSON.stringify(snapshot), before);
  const empty = pageOwnerSnapshot({ principalId: 'human', key: 'TEST-key',
    snapshot: { ...snapshot, processes: [] } }) as { processTotal: number; processes: unknown[] };
  assert.equal(empty.processTotal, 0);
  assert.deepEqual(empty.processes, []);
});
