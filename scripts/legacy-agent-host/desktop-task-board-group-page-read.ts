import assert from 'node:assert/strict';

import { desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const MAX_PAGES = 32;
const CURSOR = /^[1-9][0-9]{0,8}\.[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Read every original Owner-signed page and prove the complete task ID set.
 * The original Electron renderer tests reconstruction of nested comment text;
 * this TEST-only oracle validates all fragment indexes without copying that
 * 600 KiB comment into the E2E receipt.
 */
export async function readDesktopTaskBoardGroupSnapshot(
  cdp: UiCdpPort,
  options: {
    handleId: string;
    teamName: string;
    groupChatId: string;
    phase: string;
    taskIds: string[];
    assertOwnedRenderer(): void;
  }
): Promise<Record<string, unknown>> {
  let cursor: string | undefined;
  let revision: string | undefined;
  let feed: Record<string, unknown> | undefined;
  let total: number | undefined;
  let fragmented: boolean | undefined;
  const seenCursors = new Set<string>();
  const parts = new Map<number, {
    count: number; seen: Set<number>; base?: Record<string, unknown>;
  }>();
  const wholeTasks: Record<string, unknown>[] = [];
  let pageCount = 0;
  let finished = false;

  for (; pageCount < MAX_PAGES; pageCount++) {
    options.assertOwnedRenderer();
    const query = {
      handle: { handleId: options.handleId },
      commandId: 'TEST-task-board-group-snapshot-' + options.phase + '-' + pageCount,
      operation: 'team.snapshot',
      payload: cursor ? { cursor } : {},
    };
    const response = record(await cdp.evaluate(
      `window.electronAPI.agentBackend.invoke(${desktopJsLiteral(query)})`
    ));
    options.assertOwnedRenderer();
    assert.equal(response.ok, true);
    const page = record(response.value);
    assert.equal(page.teamName, options.teamName);
    assert.ok(typeof page.revision === 'string' && /^[a-f0-9]{64}$/.test(page.revision));
    const position = record(page.feed);
    const hasParts = page.taskParts !== undefined;
    if (revision === undefined) {
      revision = page.revision;
      feed = position;
      fragmented = hasParts;
      if (hasParts) {
        assert.ok(typeof page.taskTotal === 'number' && Number.isSafeInteger(page.taskTotal));
        total = page.taskTotal;
        assert.equal(total, options.taskIds.length);
      }
    } else {
      assert.equal(page.revision, revision, 'revision-stable signed Owner pages');
      assert.deepEqual(position, feed, 'feed-stable signed Owner pages');
      assert.equal(hasParts, fragmented);
      assert.equal(page.taskTotal, total);
    }
    assert.ok(Array.isArray(page.tasks));
    if (fragmented) {
      assert.ok(Array.isArray(page.taskParts));
      assert.equal(page.taskParts.length, page.tasks.length);
      for (const [i, raw] of page.tasks.entries()) {
        const task = record(raw);
        const marker = record(page.taskParts[i]);
        const index = marker.index, part = marker.part, count = marker.total;
        assert.ok(typeof index === 'number' && Number.isSafeInteger(index) &&
          index >= 0 && total !== undefined && index < total);
        assert.ok(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0);
        assert.ok(typeof count === 'number' && Number.isSafeInteger(count) &&
          count >= 1 && count <= MAX_PAGES && part < count);
        let current = parts.get(index);
        if (!current) {
          current = { count, seen: new Set<number>() };
          parts.set(index, current);
        }
        assert.equal(current.count, count);
        assert.ok(!current.seen.has(part), 'no duplicate Owner task part');
        current.seen.add(part);
        if (part === 0) {
          assert.equal(current.base, undefined);
          current.base = task;
        } else {
          assert.ok(current.base, 'part zero must precede retained fragments');
          assert.equal(task.id, current.base.id);
          assert.equal(task.subject, current.base.subject);
          assert.equal(task.status, current.base.status);
        }
      }
    } else {
      wholeTasks.push(...page.tasks.map(record));
    }

    if (page.nextCursor === null || page.nextCursor === undefined) {
      finished = true;
      pageCount++;
      break;
    }
    assert.ok(typeof page.nextCursor === 'string' && CURSOR.test(page.nextCursor));
    assert.ok(!seenCursors.has(page.nextCursor), 'no repeated signed Owner cursor');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.ok(finished && revision && feed, 'complete signed Owner pages within bounded budget');
  const tasks = fragmented ? Array.from({ length: total ?? 0 }, (_, index) => {
    const item = parts.get(index);
    assert.ok(item?.base && item.seen.size === item.count, 'complete task fragments');
    return item.base;
  }) : wholeTasks;
  const ids = tasks.map((task) => {
    assert.ok(typeof task.id === 'string');
    assert.equal(task.groupChatId, options.groupChatId);
    return task.id;
  });
  assert.deepEqual(ids.sort(), [...options.taskIds].sort(), 'exact distinct original tasks');
  return { phase: options.phase, revision, feed, pageCount, taskIds: ids,
    groupChatId: options.groupChatId, originalOwnerPagesComplete: true };
}
