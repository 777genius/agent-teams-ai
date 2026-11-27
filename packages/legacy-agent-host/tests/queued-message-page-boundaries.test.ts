import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageQueuedUserMessages } from '../dist/team/pageQueuedUserMessages.js';
import { digest } from '../dist/team/identity.js';

const message = (index: number, suffix = '') => ({ messageId: 'TEST-' + index + suffix,
  text: 'TEST original body ' + index, timestamp: '2026-11-27T00:00:00.000Z' });
const options = (count: number, suffix = '') => ({ key: 'TEST-private-composition-key',
  authorityFingerprint: digest({ handle: 'TEST-handle', member: 'alice', revision: 1 }),
  snapshot: { member: 'alice', messages: Array.from({ length: count }, (_, index) => message(index, suffix)) } });

test('whole identities with long Unicode and JSON escaping are byte-bounded and assembled without text loss at source', () => {
  const input = options(700, '☃"\\\u0001'.repeat(50)), original = structuredClone(input.snapshot);
  const expected = input.snapshot.messages.map(({ messageId }) => ({ messageId }));
  const received: { messageId: string }[] = [];
  let cursor: string | undefined, pages = 0;
  for (;;) {
    const page = pageQueuedUserMessages({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 240 * 1024);
    assert.ok(page.messages.length > 0 && page.messages.length <= 512);
    assert.equal(page.revision, digest(input.snapshot));
    for (const value of page.messages) assert.deepEqual(Object.keys(value), ['messageId']);
    received.push(...page.messages); pages++;
    if (page.nextCursor === null) break;
    assert.equal(Number(page.nextCursor!.split('.')[0]), received.length);
    assert.notEqual(page.nextCursor, cursor); cursor = page.nextCursor;
  }
  assert.ok(pages > 1); assert.deepEqual(received, expected); assert.deepEqual(input.snapshot, original);
});

test('empty and exactly 512 small identities keep the plain inventory; the next identity requires paging', () => {
  for (const count of [0, 512]) {
    const input = options(count), page = pageQueuedUserMessages(input);
    assert.deepEqual(page, { kind: 'queued_user_messages', member: 'alice',
      messages: input.snapshot.messages.map(({ messageId }) => ({ messageId })) });
  }
  const input = options(513), first = pageQueuedUserMessages(input);
  assert.equal(first.messages.length, 512); assert.ok(first.nextCursor);
  const last = pageQueuedUserMessages({ ...input, cursor: first.nextCursor });
  assert.deepEqual(last.messages, [{ messageId: 'TEST-512' }]); assert.equal(last.nextCursor, null);
  assert.throws(() => pageQueuedUserMessages(options(4097)), /hold/);
});

test('cursor binds the full original snapshot, current authority and original composition key', () => {
  const input = options(513), cursor = pageQueuedUserMessages(input).nextCursor!;
  for (const field of ['text', 'timestamp'] as const) {
    const snapshot = structuredClone(input.snapshot); snapshot.messages[0]![field] += ' changed';
    assert.throws(() => pageQueuedUserMessages({ ...input, snapshot, cursor }), /hold/);
  }
  const reversed = { ...input.snapshot, messages: [...input.snapshot.messages].reverse() };
  assert.throws(() => pageQueuedUserMessages({ ...input, snapshot: reversed, cursor }), /hold/);
  assert.throws(() => pageQueuedUserMessages({ ...input, key: 'TEST-next-incarnation', cursor }), /hold/);
  assert.throws(() => pageQueuedUserMessages({ ...input, authorityFingerprint: digest('TEST-new-authority'), cursor }), /hold/);
  const tampered = cursor.slice(0, -1) + (cursor.endsWith('a') ? 'b' : 'a');
  assert.throws(() => pageQueuedUserMessages({ ...input, cursor: tampered }), /hold/);
  assert.throws(() => pageQueuedUserMessages({ ...input, cursor: '0.' + 'a'.repeat(64) }), /invalid/);
});

test('duplicate, oversized and invalid source identities are refused without fabricating a display row', () => {
  const input = options(2);
  for (const value of [input.snapshot.messages[0]!.messageId, '', ' ', 'x'.repeat(257), 'TEST-\0-id']) {
    const snapshot = structuredClone(input.snapshot); snapshot.messages[1]!.messageId = value;
    assert.throws(() => pageQueuedUserMessages({ ...input, snapshot }), /hold/);
  }
});
