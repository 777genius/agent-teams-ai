import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeConnectedCount, connectedProviderIds, parseProviderDirectory,
  validateConnectedSummary,
} from './provider-real-runtime-policy.ts';

const rows = [
  { providerId: 'OpenCode', state: 'connected' },
  { providerId: 'OpenRouter', state: 'connected' },
  { providerId: 'Other', state: 'available' },
];
const page = (filter: 'all' | 'connected', entries = rows, overrides = {}) =>
  JSON.stringify({ schemaVersion: 1, runtimeId: 'opencode', directory: {
    runtimeId: 'opencode', totalCount: entries.length, returnedCount: entries.length,
    query: null, filter, cursor: null, nextCursor: null,
    diagnostics: [], fetchedAt: new Date().toISOString(), entries, ...overrides,
  } });

test('real CLI envelope contract counts provider identities excluding OpenCode', () => {
  const all = parseProviderDirectory(page('all'), 'all');
  const connected = parseProviderDirectory(
    page('connected', rows.filter(x => x.state === 'connected')), 'connected');
  assert.deepEqual(connectedProviderIds(all.entries), ['openrouter']);
  assert.equal(completeConnectedCount(connected), 1);
  assert.equal(validateConnectedSummary(all, connected), 1);
});

test('a full catalog with 200 entries is not misread as a complete 100-entry page', () => {
  const first = Array.from({ length: 100 }, (_, i) => ({
    providerId: 'provider-' + i, state: i < 3 ? 'connected' : 'available',
  }));
  const all = parseProviderDirectory(page('all', first,
    { totalCount: 200, nextCursor: '100' }), 'all');
  const connected = parseProviderDirectory(page('connected', first.slice(0, 3)), 'connected');
  assert.equal(completeConnectedCount(all), null);
  assert.equal(validateConnectedSummary(all, connected), 3);
});

test('partial, inconsistent and misleading filtered responses fail closed', () => {
  const incomplete = parseProviderDirectory(
    page('connected', [rows[1]], { totalCount: 2, nextCursor: '1' }), 'connected');
  assert.equal(completeConnectedCount(incomplete), null);
  const cases: Array<[string, 'all' | 'connected']> = [
    [page('connected', [rows[1]], { returnedCount: 0 }), 'connected'],
    [page('connected', [rows[2]]), 'connected'],
    [page('all', rows, { diagnostics: ['OpenCode inventory probe timed out'] }), 'all'],
    [page('all', rows, { cursor: '100' }), 'all'],
  ];
  for (const [raw, filter] of cases) {
    assert.throws(() => parseProviderDirectory(raw, filter));
  }
});

test('never report duplicated ids, a response error, or malformed JSON', () => {
  assert.throws(() => parseProviderDirectory('not json', 'all'));
  assert.throws(() => parseProviderDirectory(
    JSON.stringify({ schemaVersion: 1, runtimeId: 'opencode',
      error: { code: 'runtime-unhealthy' } }), 'all'));
  assert.throws(() => parseProviderDirectory(
    page('all', [{ providerId: 'OPENROUTER', state: 'connected' },
      { providerId: 'openrouter', state: 'connected' }]), 'all'));
});
