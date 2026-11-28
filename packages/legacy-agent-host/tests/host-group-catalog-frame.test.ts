import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { DEFAULT_HOST_LIMITS, hostMethodFrameLimit, hostProfileLimitCaps } from '../dist/contracts.js';
import { HostOutput } from '../dist/output.js';
import { pageGroupCatalog } from '../dist/group-chats/pageGroupCatalog.js';

const groups = Array.from({ length: 4000 }, (_, index) => ({
  id: index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
  name: 'TEST group ' + index + ' ' + 'x'.repeat(75),
  createdAt: '2026-11-28T00:00:00.000Z',
  membership: { kind: 'fixed', memberNames: ['alice', 'bob'] },
  archivedAt: index % 2 ? '2026-11-28T01:00:00.000Z' : null,
  memberNames: ['alice', 'bob'], availableRecipientNames: ['bob'], canSend: true,
}));
function transport() {
  const failures: string[] = [];
  const frames: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      frames.push(Buffer.from(chunk));
      callback();
    },
  });
  const output = new HostOutput(writable, hostProfileLimitCaps('review-v1'),
    reason => { failures.push(reason); });
  return { output, failures, frames };
}

test('Desktop group pages fit the actual HostOutput priority frame even in review-v1', () => {
  const max = hostMethodFrameLimit('team.group.list', 'review-v1');
  assert.equal(max, DEFAULT_HOST_LIMITS.maxFrameBytes);
  const whole = JSON.stringify({ jsonrpc: '2.0', id: 'TEST', result: { ok: true, value: groups } });
  assert.ok(Buffer.byteLength(whole) > max);

  const bounded = transport();
  let cursor: string | undefined, pages = 0;
  const received: unknown[] = [];
  do {
    const page = pageGroupCatalog({
      rows: groups, key: 'TEST-page-key', principalId: 'TEST-original',
      binding: 'TEST-team',
      ...(cursor === undefined ? {} : { cursor }),
    }) as { kind: string; groups: unknown[]; nextCursor: string | null };
    const message = { jsonrpc: '2.0' as const, id: 'TEST', result: { ok: true, value: page } };
    assert.ok(bounded.output.sendPriority(message, max));
    received.push(...page.groups);
    cursor = page.nextCursor ?? undefined;
    assert.ok(++pages < 128);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(received, groups);
  assert.deepEqual(bounded.failures, []);
  assert.equal(bounded.frames.length, pages);
  for (const frame of bounded.frames) assert.ok(frame.length <= max + 1);
  bounded.output.stop();

  const old = transport();
  assert.equal(old.output.sendPriority({
    jsonrpc: '2.0', id: 'TEST', result: { ok: true, value: groups },
  }, max), false, 'unpaged original would overflow the unchanged Host frame limit');
  assert.deepEqual(old.failures, ['priority_overflow']);
  old.output.stop();
});
