import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasOneVisibleOpenCodeConnection,
  hasExactVisibleOpenCodeCount,
  verifyCompleteConnectedSourceSummary,
  verifyRealProviderCountResponse,
} from './real-runtime.mjs';

function connected(overrides = {}) {
  return {
    runtimeId: 'opencode',
    filter: 'connected',
    query: null,
    cursor: null,
    nextCursor: null,
    totalCount: 1,
    returnedCount: 1,
    diagnostics: [],
    entries: [{ providerId: 'deepinfra', state: 'connected' }],
    ...overrides,
  };
}

test('one genuine connected provider qualifies the display-only IPC evidence', () => {
  assert.equal(verifyRealProviderCountResponse(connected()), 1);
});

test('misreported metadata, missing provider and partial responses fail closed', () => {
  for (const response of [
    connected({ filter: 'all' }),
    connected({ query: 'deepinfra' }),
    connected({ cursor: '100' }),
    connected({ nextCursor: '100' }),
    connected({ totalCount: 0 }),
    connected({ returnedCount: 0 }),
    connected({ diagnostics: ['Incomplete probe'] }),
    connected({ entries: [{ providerId: 'deepinfra', state: 'available' }] }),
    connected({ entries: [{ providerId: 'opencode', state: 'connected' }] }),
    connected({ entries: [{ providerId: 'deepinfra', state: 'connected' },
      { providerId: 'Deepinfra', state: 'connected' }], totalCount: 2, returnedCount: 2 }),
  ]) {
    assert.throws(() => verifyRealProviderCountResponse(response));
  }
});

test('real V2 zero count rejects unknown, pending, malformed and stale identities', () => {
  const complete = { schemaVersion: 1, runtimeId: 'opencode', directory: {
    runtimeId: 'opencode', filter: 'connected', query: null, cursor: null,
    nextCursor: null, totalCount: 0, returnedCount: 0,
    fetchedAt: new Date().toISOString(), diagnostics: ['capabilities_pending'], entries: [],
  }};
  assert.equal(verifyCompleteConnectedSourceSummary(complete, 0), 0);
  for (const label of ['OpenCode · 0 connected', 'OpenCode · Провайдеры: 0 подключено',
    'OpenCode · Fournisseurs: 0 connecté']) {
    assert.equal(hasExactVisibleOpenCodeCount(label, 0), true);
  }
  for (const label of ['OpenCode · Unknown', 'OpenCode · Checking...', 'OpenCode · 1 connected',
    'OpenCode · 00 connected', 'OpenCode · 0 / 1', 'Other · 0 connected', '', null]) {
    assert.equal(hasExactVisibleOpenCodeCount(label, 0), false);
  }
  for (const changed of [
    { error: { code: 'failed' } },
    { directory: { ...complete.directory, filter: 'all' } },
    { directory: { ...complete.directory, nextCursor: '100' } },
    { directory: { ...complete.directory, totalCount: 1 } },
    { directory: { ...complete.directory, diagnostics: ['incomplete'] } },
    { directory: { ...complete.directory, entries: [{ providerId: 'example', state: 'available' }],
      returnedCount: 1, totalCount: 1 } },
    { directory: { ...complete.directory, entries: [{ providerId: 'example', state: 'connected' }],
      returnedCount: 1, totalCount: 1 } },
    { directory: { ...complete.directory, entries: [{ providerId: 'opencode', state: 'connected' }],
      returnedCount: 1, totalCount: 1 } },
  ]) {
    assert.throws(() => verifyCompleteConnectedSourceSummary({ ...complete, ...changed }, 0));
  }
});

test('real Settings header proof is independent of localized labels', () => {
  for (const label of [
    'OpenCode · Providers: 1 connected',
    'OpenCode · Провайдеры: 1 подключён',
    'OpenCode · Fournisseurs : 1 connecté',
  ]) {
    assert.equal(hasOneVisibleOpenCodeConnection(label), true);
  }
  for (const label of [
    'OpenCode · unknown',
    'OpenCode · Providers: 0 connected',
    'OpenCode · Providers: 11 connected',
    'Other runtime · Providers: 1 connected',
  ]) {
    assert.equal(hasOneVisibleOpenCodeConnection(label), false);
  }
});
