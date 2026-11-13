import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOpenCodeV2Snapshot } from '../dist/adapters/providers/OpenCodeV2ReadOnlySnapshot.js';

import type { OpenCodeV2ReadOnlyClient } from '../dist/adapters/providers/OpenCodeV2ReadOnlySnapshot.js';
import type { OpenCodeV2TransportConfig } from '@agent-teams/provider-implementations/opencode';

function fixture() {
  let current = true, fullReads = 0, requests = 0, unknownCleanup = 0;
  let onFullRead = (_count: number): void => undefined;
  const config: OpenCodeV2TransportConfig = {
    endpoint: 'http://127.0.0.1:43199', version: '2.1.4',
    directory: process.platform === 'win32' ? 'C:\\TEST\\readonly' : '/TEST/readonly',
    nativeSessionId: 'ses_TEST123', deadline: Date.now() + 10_000,
    readPassword: () => 'TEST-snapshot-password',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.method, 'GET');
      assert.equal(new URL(request.url).pathname, '/api/info');
      requests++;
      return Response.json({ pid: 1234, version: '2.1.4' });
    },
  };
  const authority = {
    assertCurrent: () => { if (!current) throw new Error('TEST-original-authority-revoked'); },
    assertCustody: async () => { onFullRead(++fullReads); },
    cleanupUnknown: () => { unknownCleanup++; },
  };
  return { config, authority, revoke: () => { current = false; },
    onFullRead: (callback: (count: number) => void) => { onFullRead = callback; },
    counts: () => ({ fullReads, requests, unknownCleanup }) };
}

test('V2 read snapshot fences every GET and closes borrowed methods after settlement', async () => {
  const original = fixture();
  const borrowed: { client?: OpenCodeV2ReadOnlyClient } = {};
  const observed = await readOpenCodeV2Snapshot(original.config, original.authority, async client => {
    borrowed.client = client;
    assert.equal(Object.isFrozen(client), true);
    assert.deepEqual(Object.keys(client).sort(), [
      'builtinPluginsOnly', 'identity', 'instructions', 'readCatalog',
      'readMcp', 'readSession', 'savedPermissionsEmpty',
    ]);
    return client.identity();
  });
  assert.deepEqual(observed, { pid: 1234, version: '2.1.4' });
  assert.deepEqual(original.counts(), { fullReads: 2, requests: 1, unknownCleanup: 0 });
  assert.ok(borrowed.client);
  await assert.rejects(borrowed.client.identity());
  assert.equal(original.counts().requests, 1, 'a retained function cannot issue another request');

  const revoked = fixture();
  await assert.rejects(readOpenCodeV2Snapshot(revoked.config, revoked.authority, async client => {
    await client.identity();
    revoked.revoke();
    return client.identity();
  }));
  assert.deepEqual(revoked.counts(), { fullReads: 1, requests: 1, unknownCleanup: 0 },
    'authority loss prevents the second native GET and no result is accepted');
});

test('V2 read snapshot refuses final custody/authority/deadline loss and lazy results', async context => {
  let clock = Date.now();
  context.mock.method(Date, 'now', () => clock);
  for (const loss of ['image', 'authority', 'deadline'] as const) {
    const original = fixture();
    original.onFullRead(count => {
      if (count !== 2) return;
      if (loss === 'image') throw new Error('TEST-original-image-mismatch');
      if (loss === 'authority') original.revoke();
      if (loss === 'deadline') clock = original.config.deadline;
    });
    await assert.rejects(readOpenCodeV2Snapshot(original.config, original.authority,
      client => client.identity()), 'no positive result after the last awaited custody read');
    assert.deepEqual(original.counts(), { fullReads: 2, requests: 1, unknownCleanup: 0 });
  }
  const lazy = fixture();
  await assert.rejects(readOpenCodeV2Snapshot(lazy.config, lazy.authority, async client =>
    ({ later: client.identity })));
  assert.deepEqual(lazy.counts(), { fullReads: 1, requests: 0, unknownCleanup: 0 });

  const pending = fixture();
  await assert.rejects(readOpenCodeV2Snapshot(pending.config, pending.authority, async client => {
    void client.identity();
    return { premature: true };
  }), 'an unfinished native method cannot escape inside a positive snapshot');
  assert.equal(pending.counts().fullReads, 1);
});
