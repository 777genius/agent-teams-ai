import test from 'node:test';
import assert from 'node:assert/strict';
import { extendOwnedHistory, remainingOwned } from './teams-create-page-owned-processes.mjs';
const row = (pid, parent, birth) => ({ pid, parent, birth: new Date(birth).toISOString() });

test('retains exact descendants when a verified parent exits', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  const pnpm = row(101, 100, '2026-01-01T00:00:01Z');
  const electron = row(102, 101, '2026-01-01T00:00:02Z');
  const history = extendOwnedHistory([root], [pnpm, electron]);
  assert.deepEqual(history, [root, pnpm, electron]);
  assert.deepEqual(remainingOwned(history, [electron]), [electron]);
  assert.deepEqual(remainingOwned(history, []), []);
});

test('never adopts children of a reused parent PID', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  const reused = row(100, 1, '2026-01-01T01:00:00Z');
  const foreign = row(222, 100, '2026-01-01T01:00:01Z');
  assert.deepEqual(extendOwnedHistory([root], [reused, foreign]), [root]);
  assert.deepEqual(remainingOwned([root], [reused]), []);
});

test('refuses older child identity and an unknown owner history', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  assert.deepEqual(extendOwnedHistory([root], [row(101, 100, '2025-12-31T23:59:59Z')]), [root]);
  assert.throws(() => extendOwnedHistory([], []), /history is unavailable/);
});
