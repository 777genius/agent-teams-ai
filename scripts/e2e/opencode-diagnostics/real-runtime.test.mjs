import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRealProviderCountResponse } from './real-runtime.mjs';

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
