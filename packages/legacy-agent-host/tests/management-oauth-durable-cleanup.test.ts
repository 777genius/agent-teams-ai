import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../dist/management/OAuthOperationOwner.js';
import type { ManagementCommandStore } from '../src/management/commandRecords.ts';
import type { ProviderOAuthSnapshot } from '../src/management/contracts.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const input = {
  operationId: 'TEST-durable-oauth', profileId: 'TEST-profile',
  configRevision: 'TEST-config', providerId: 'TEST-provider', methodIndex: 0,
};
const original = {
  operationId: input.operationId, profileId: input.profileId,
  configRevision: input.configRevision,
};
async function until(check: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!check() && performance.now() < deadline)
    await new Promise<void>(done => setImmediate(done));
  assert.ok(check(), 'native operation reached expected phase');
}
function fixture(timeoutMs = 30_000, fault?: {
  phase: 'cancelling' | 'cancelled'; timing: 'before-commit' | 'after-commit';
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-oauth-durable-cleanup-')));
  const store = new FileManagementCommandStore(root);
  const file = () => join(root, 'management-commands',
    readdirSync(join(root, 'management-commands'))[0]!);
  const bytes = () => readFileSync(file(), 'utf8');
  const writePhases: string[] = [];
  let uncertainBytes: string | undefined;
  const publicationStore: ManagementCommandStore = fault ? {
    read: id => store.read(id),
    list: () => store.list(),
    write(record) {
      writePhases.push(record.phase);
      if (record.kind === 'oauth' && record.phase === fault.phase) {
        if (fault.timing === 'after-commit') store.write(record);
        uncertainBytes = bytes();
        throw new Error('TEST cleanup publication acknowledgement lost');
      }
      store.write(record);
    },
  } : store;
  const fence = new ManagementResourceFence(store.list());
  const events: ProviderOAuthSnapshot[] = [];
  const authorize = deferred<{
    authorizationUrl: string; instructions: string; completionMethod: 'code';
  }>();
  const complete = deferred<boolean>(), close = deferred<boolean>();
  let closeCalls = 0, completeCalls = 0;
  const owner = new OAuthOperationOwner({
    store: publicationStore, fence,
    assertWriter() {},
    select: () => ({
      profileId: input.profileId, configRevision: input.configRevision,
      selectionDigest: 'a'.repeat(64), resourceId: 'b'.repeat(64),
    }),
    prepare: () => ({
      timeoutMs,
      authorize: async () => authorize.promise,
      complete: async () => { completeCalls++; return complete.promise; },
      close: async () => { closeCalls++; return close.promise; },
    }),
    onProgress: snapshot => { events.push(structuredClone(snapshot)); },
  });
  return { owner, store, fence, events, authorize, complete, close, file, bytes,
    writePhases, uncertainBytes: () => uncertainBytes,
    get closeCalls() { return closeCalls; },
    get completeCalls() { return completeCalls; },
    async waiting() {
      owner.start(input);
      authorize.resolve({
        authorizationUrl: 'https://example.invalid/oauth',
        instructions: 'TEST', completionMethod: 'code',
      });
      await until(() => owner.read(original)?.phase === 'waiting-for-code');
    },
    async cleanup() {
      close.resolve(true);
      await owner.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('real OAuth expiry closes original native capture without resurrecting deleted or changed journal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const missing of [true, false]) {
    const f = fixture(); t.after(() => f.cleanup());
    await f.waiting();
    if (missing) unlinkSync(f.file());
    else f.store.write({ ...f.store.read(input.operationId)!, providerId: 'TEST-replacement' });
    const expected = missing ? null : f.bytes();
    t.mock.timers.tick(30_000); // Trigger the real registered expiry callback deterministically.
    await until(() => f.closeCalls === 1);
    f.close.resolve(true);
    await assert.rejects(f.owner.close(), { code: 'held' });
    assert.equal(missing ? null : f.bytes(), expected);
    assert.equal(f.store.read(input.operationId) === undefined, missing);
    assert.equal(f.completeCalls, 0);
  }
});

test('OAuth cancel cannot replace durable record changed while native close is pending', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.waiting();
  const cancelled = f.owner.cancel(original);
  await until(() => f.closeCalls === 1);
  f.store.write({ ...f.store.read(input.operationId)!, providerId: 'TEST-new-owner' });
  const bytes = f.bytes();
  f.close.resolve(true);
  assert.equal((await cancelled).phase, 'held');
  assert.equal(f.bytes(), bytes);
  await assert.rejects(f.owner.close(), { code: 'held' });
});

test('late native OAuth completion cannot overwrite an externally replaced receipt', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.waiting();
  await f.owner.complete({ ...original, commandId: 'TEST-complete', code: 'TEST-code' });
  await until(() => f.completeCalls === 1);
  f.store.write({ ...f.store.read(input.operationId)!, providerId: 'TEST-replaced-native' });
  const bytes = f.bytes();
  f.complete.resolve(true);
  await until(() => f.closeCalls === 1);
  f.close.resolve(true);
  await assert.rejects(f.owner.close(), { code: 'held' });
  assert.equal(f.bytes(), bytes);
});

test('OAuth cancel closes its original native capture when its durable receipt disappeared', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.waiting();
  unlinkSync(f.file());
  await assert.rejects(f.owner.cancel(original), { code: 'conflict' });
  await until(() => f.closeCalls === 1);
  f.close.resolve(true);
  await assert.rejects(f.owner.close(), { code: 'held' });
  assert.equal(f.store.read(input.operationId), undefined);
  assert.equal(f.completeCalls, 0);
});

test('OAuth final cleanup does not resurrect a receipt removed while native close is pending', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.waiting();
  const cancelled = f.owner.cancel(original);
  await until(() => f.closeCalls === 1);
  unlinkSync(f.file());
  f.close.resolve(true);
  assert.equal((await cancelled).phase, 'held');
  await assert.rejects(f.owner.close(), { code: 'held' });
  assert.equal(f.store.read(input.operationId), undefined);
});

for (const phase of ['cancelling', 'cancelled'] as const)
  for (const timing of ['before-commit', 'after-commit'] as const)
    test('OAuth cleanup progress remains ordered after unknown ' + phase + ' publication ' + timing, async t => {
      const f = fixture(30_000, { phase, timing }); t.after(() => f.cleanup());
      await f.waiting();
      const cancelled = f.owner.cancel(original);
      await until(() => f.closeCalls === 1);
      assert.equal(f.owner.read(original)?.phase, 'cancelling', 'live cleanup remains pending until native close');
      assert.deepEqual(f.events.map(event => [event.phase, event.sequence]), [
        ['authorizing', 1], ['waiting-for-code', 2], ['cancelling', 3],
      ]);
      assert.throws(() => f.fence.assertAvailable('b'.repeat(64)), { code: 'busy' });
      f.close.resolve(true);
      const final = await cancelled;
      assert.equal(final.phase, 'held');
      assert.equal(final.sequence, 4);
      assert.deepEqual(f.events.map(event => [event.phase, event.sequence]), [
        ['authorizing', 1], ['waiting-for-code', 2], ['cancelling', 3], ['held', 4],
      ]);
      const retained = f.uncertainBytes();
      assert.notEqual(retained, undefined);
      assert.equal(f.bytes(), retained, 'unknown publication bytes are never overwritten by cleanup');
      assert.deepEqual(f.writePhases, phase === 'cancelling'
        ? ['authorizing', 'waiting-for-code', 'cancelling']
        : ['authorizing', 'waiting-for-code', 'cancelling', 'cancelled']);
      assert.equal(f.closeCalls, 1);
      assert.equal(f.completeCalls, 0);
      assert.throws(() => f.fence.assertAvailable('b'.repeat(64)), { code: 'held' });
      const coldFence = new ManagementResourceFence(f.store.list());
      // A committed final receipt follows successful native close; only its live acknowledgement is unknown.
      if (phase === 'cancelled' && timing === 'after-commit')
        assert.doesNotThrow(() => coldFence.assertAvailable('b'.repeat(64)));
      else assert.throws(() => coldFence.assertAvailable('b'.repeat(64)), { code: 'held' });
      await assert.rejects(f.owner.close(), { code: 'held' });
      assert.equal(f.bytes(), retained);
    });
