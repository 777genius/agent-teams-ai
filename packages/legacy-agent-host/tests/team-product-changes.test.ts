import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamProductChanges } from '../dist/team/TeamProductChanges.js';

test('snapshot cursor replays only later invalidations, with stable IDs and explicit restart/retention gaps', () => {
  const source = new TeamProductChanges(2);
  const snapshot = source.snapshot('reader', 'a'.repeat(64));
  source.invalidate();
  source.invalidate();
  const later = source.read('reader', 'b'.repeat(64), snapshot.cursor);
  assert.equal(later.streamId, snapshot.streamId);
  assert.equal(later.sequence, 2);
  assert.deepEqual(
    later.events.map((e) => e.sequence),
    [1, 2]
  );
  assert.deepEqual(
    source.read('reader', 'b'.repeat(64), snapshot.cursor),
    later,
    'replay IDs/cursor stable'
  );
  assert.deepEqual(source.read('reader', 'b'.repeat(64), later.cursor).events, []);
  source.invalidate();
  source.invalidate();
  source.invalidate();
  assert.equal(source.read('reader', 'c'.repeat(64), later.cursor).gap?.reason, 'retention');
  const restarted = new TeamProductChanges();
  const gap = restarted.read('reader', 'c'.repeat(64), later.cursor);
  assert.equal(gap.gap?.reason, 'cursor');
  assert.notEqual(gap.streamId, later.streamId);
  assert.equal(source.read('other-reader', 'c'.repeat(64), snapshot.cursor).gap?.reason, 'cursor');
});

test('a recovery publication observed before its completion hook is still ordered under the snapshot fence', () => {
  const source = new TeamProductChanges();
  const before = source.snapshot('reader', 'a'.repeat(64));
  const during = source.snapshot('reader', 'b'.repeat(64));
  assert.equal(during.sequence, before.sequence + 1);
  assert.equal(source.read('reader', 'b'.repeat(64), before.cursor).events.length, 1);
  assert.deepEqual(source.snapshot('reader', 'b'.repeat(64)), during);
});
