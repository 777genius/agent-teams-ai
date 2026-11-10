import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeProviderManageDialog,
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
  // Fixture-only contract: positive native V2 auth is not claimed by this test.
  const one = { ...complete, directory: { ...complete.directory,
    entries: [{ providerId: 'example', state: 'connected' }],
    returnedCount: 1, totalCount: 1 } };
  assert.equal(verifyCompleteConnectedSourceSummary(one, 1), 1);
  assert.equal(hasExactVisibleOpenCodeCount('OpenCode · Providers: 1 connected', 1), true);
  const duplicated = { ...complete, directory: { ...complete.directory,
    entries: [{ providerId: 'example', state: 'connected' },
      { providerId: ' Example ', state: 'connected' }],
    returnedCount: 2, totalCount: 2 } };
  assert.throws(() => verifyCompleteConnectedSourceSummary(duplicated, 2),
    /Duplicate provider identity/);
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

test('provider Manage close retries a swallowed click only after renewed hit testing', async () => {
  let clicks = 0;
  let polls = 0;
  const evaluate = async (expression) => {
    assert.match(expression, /button\\.absolute\\.right-3\\.top-3/);
    polls++;
    if (clicks === 2) return 'closed';
    if (polls === 2) return 'blocked';
    return 'ready';
  };
  const click = async (selector) => {
    assert.match(selector, /button\\.absolute\\.right-3\\.top-3/);
    clicks++;
  };
  await closeProviderManageDialog(evaluate, click, 'opencode',
    { pollMs: 0, maxPolls: 8, retryAfterPolls: 2, maxClicks: 3 });
  assert.equal(clicks, 2, 'A transiently swallowed click should get exactly one safe retry');
});

test('provider Manage close never clicks a blocked or foreign dialog', async () => {
  for (const [state, message] of [
    ['blocked', /dialog close control obstructed/],
    ['wrong-provider', /changed dialog during close/],
  ]) {
    let clicks = 0;
    await assert.rejects(closeProviderManageDialog(
      async () => state,
      async () => { clicks++; },
      'opencode', { pollMs: 0, maxPolls: 3, retryAfterPolls: 1, maxClicks: 2 }
    ), message);
    assert.equal(clicks, 0);
  }
});

test('provider Manage close fails after bounded retries if the dialog stays open', async () => {
  let clicks = 0;
  await assert.rejects(closeProviderManageDialog(
    async () => 'ready',
    async () => { clicks++; },
    'opencode', { pollMs: 0, maxPolls: 6, retryAfterPolls: 2, maxClicks: 2 }
  ), /dialog did not close/);
  assert.equal(clicks, 2);
});
