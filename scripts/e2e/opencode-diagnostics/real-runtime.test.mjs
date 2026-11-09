import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasOneVisibleOpenCodeConnection,
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
