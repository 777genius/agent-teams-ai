import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../dist/management/OAuthOperationOwner.js';

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
function fixture(timeoutMs = 30_000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-oauth-durable-cleanup-')));
  const store = new FileManagementCommandStore(root);
  const authorize = deferred<{
    authorizationUrl: string; instructions: string; completionMethod: 'code';
  }>();
  const complete = deferred<boolean>(), close = deferred<boolean>();
  let closeCalls = 0, completeCalls = 0;
  const owner = new OAuthOperationOwner({
    store, fence: new ManagementResourceFence(store.list()),
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
  });
  const file = () => join(root, 'management-commands',
    readdirSync(join(root, 'management-commands'))[0]!);
  const bytes = () => readFileSync(file(), 'utf8');
  return { owner, store, authorize, complete, close, file, bytes,
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
  for (const missing of [true, false]) {
    const f = fixture(500); t.after(() => f.cleanup());
    await f.waiting();
    if (missing) unlinkSync(f.file());
    else f.store.write({ ...f.store.read(input.operationId)!, providerId: 'TEST-replacement' });
    const expected = missing ? null : f.bytes();
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
