import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import type { ManagementCommandStore } from '../src/management/commandRecords.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const start = {
  commandId: 'TEST-model-probe',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  modelId: 'TEST-provider/TEST-model',
};
const lookup = {
  commandId: start.commandId,
  profileId: start.profileId,
  configRevision: start.configRevision,
};

test('a Team model probe binds its context and cannot publish a result after its captured authority is revoked', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.throws(() => f.owner.start({ ...start, context: 'd'.repeat(64) }, () => false), {
    code: 'held',
  });
  assert.equal(f.runs(), 0);
  assert.equal(Array.from(f.base.list()).length, 0);
  let current = true;
  f.owner.start(
    { ...start, context: 'd'.repeat(64), effort: 'medium', modelContext: 'model-default' },
    () => current
  );
  assert.equal(f.owner.read(lookup)?.context, 'd'.repeat(64));
  current = false;
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  assert.equal(f.base.read(start.commandId)?.resourceHeld, false);
  assert.throws(() => f.make().start({ ...start, context: 'e'.repeat(64) }), { code: 'conflict' });
  assert.equal(f.runs(), 1);
});
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise<void>((done) => setImmediate(done));
  assert.ok(check());
}
function fixture(
  options: {
    timeoutMs?: number;
    cleanupFails?: boolean;
    failRun?: boolean;
    blockClose?: boolean;
    store?: (base: ManagementCommandStore) => ManagementCommandStore;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-probe-')));
  const base = new FileManagementCommandStore(root),
    store = options.store?.(base) ?? base;
  const target = {
    profileId: start.profileId,
    configRevision: start.configRevision,
    selectionDigest: 'a'.repeat(64),
    resourceId: 'b'.repeat(64),
  };
  let current = true,
    runs = 0,
    closes = 0;
  const result = deferred<boolean>(),
    close = deferred<boolean>();
  const fence = new ManagementResourceFence(store.list());
  const writer = () => {
    if (!current) throw new Error('TEST revoked');
  };
  const make = () =>
    new ModelProbeOwner({
      store,
      fence,
      assertWriter: writer,
      select: () => ({ ...target }),
      prepare: () => ({
        timeoutMs: options.timeoutMs ?? 10000,
        async run() {
          assert.equal(base.read(start.commandId)?.phase, 'running');
          runs++;
          if (options.failRun) throw new Error('TEST native observation unavailable');
          return result.promise;
        },
        async close() {
          closes++;
          return options.blockClose ? close.promise : !options.cleanupFails;
        },
      }),
    });
  const owner = make();
  const credentials = new CredentialCommandOwner({
    store,
    fence,
    assertCurrent: writer,
    select: () => ({ ...target }),
    perform: async () => ({ ok: true, settled: true }),
  });
  return {
    root,
    base,
    owner,
    make,
    credentials,
    result,
    close,
    runs: () => runs,
    closes: () => closes,
    revoke: () => {
      current = false;
    },
    changeTarget: () => {
      target.selectionDigest = 'c'.repeat(64);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('model probe claims before native work and returns original result without a second model request on replay', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(f.owner.start(start).phase, 'running');
  assert.equal(f.runs(), 1);
  assert.equal(f.owner.start(start).phase, 'running');
  assert.equal(f.runs(), 1);
  assert.throws(() => f.owner.start({ ...start, modelId: 'TEST-other' }), { code: 'conflict' });
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'busy' }
  );
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.equal(f.owner.read(lookup)?.ok, true);
  assert.equal(f.closes(), 1);
  assert.equal(f.make().start(start).ok, true);
  assert.equal(f.runs(), 1);
  const journal = readdirSync(join(f.root, 'management-commands'))
    .map((name) => readFileSync(join(f.root, 'management-commands', name), 'utf8'))
    .join('');
  assert.equal(journal.includes('sessionID'), false);
  await f.owner.close();
});

test('cancel retains auth namespace until physical close and a late model response cannot publish success', async (t) => {
  const f = fixture({ blockClose: true });
  t.after(f.cleanup);
  f.owner.start(start);
  const cancel = f.owner.cancel(lookup);
  f.result.resolve(true);
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'busy' }
  );
  f.close.resolve(true);
  assert.equal((await cancel).phase, 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  assert.equal(f.closes(), 1);
  assert.equal(
    (
      await f.credentials.execute({
        ...lookup,
        providerId: start.providerId,
        kind: 'credential.forget',
        commandId: 'TEST-forget',
      })
    ).phase,
    'completed'
  );
});

test('cold pending probe is held and never reruns inference; unknown physical cleanup holds the account', async (t) => {
  const f = fixture({ cleanupFails: true });
  t.after(f.cleanup);
  f.owner.start(start);
  const cold = f.make();
  assert.equal(cold.start(start).phase, 'held');
  assert.equal(f.runs(), 1);
  assert.equal((await f.owner.cancel(lookup)).phase, 'held');
  await assert.rejects(
    f.credentials.execute({
      ...lookup,
      providerId: start.providerId,
      kind: 'credential.forget',
      commandId: 'TEST-forget',
    }),
    { code: 'held' }
  );
  await assert.rejects(f.owner.close(), { code: 'held' });
});

test('explicit cancellation settles held observations only after native custody is released', async (t) => {
  const f = fixture({ failRun: true });
  t.after(f.cleanup);
  f.owner.start(start);
  await until(() => f.owner.read(lookup)?.phase === 'held');
  assert.equal(f.base.read(start.commandId)?.resourceHeld, false);
  assert.equal((await f.owner.cancel(lookup)).phase, 'cancelled');
  assert.equal(f.owner.read(lookup)?.ok, false);
  const cold = f.make();
  assert.equal(cold.start(start).phase, 'cancelled');
  assert.equal((await cold.cancel(lookup)).phase, 'cancelled');
  assert.equal(f.runs(), 1);
  assert.equal(f.closes(), 1);
});

test('expiry and orderly shutdown cancel only their original probe', async (t) => {
  const f = fixture({ timeoutMs: 10 });
  t.after(f.cleanup);
  f.owner.start(start);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.closes(), 1);
  const second = fixture();
  t.after(second.cleanup);
  second.owner.start(start);
  await second.owner.close();
  assert.equal(second.base.read(start.commandId)?.phase, 'cancelled');
});

test('failed initial claim allocates nothing; writer revocation or target change cannot publish a completed model proof', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write() {
        throw new Error('TEST publication refused');
      },
    }),
  });
  t.after(f.cleanup);
  assert.throws(() => f.owner.start(start));
  assert.equal(f.runs(), 0);
  const revoked = fixture();
  t.after(revoked.cleanup);
  revoked.owner.start(start);
  revoked.revoke();
  revoked.result.resolve(true);
  await until(() => revoked.closes() === 1);
  assert.equal(revoked.base.read(start.commandId)?.phase, 'running');
  const changed = fixture();
  t.after(changed.cleanup);
  changed.owner.start(start);
  changed.changeTarget();
  changed.result.resolve(true);
  await until(() => changed.closes() === 1);
  assert.equal(changed.base.read(start.commandId)?.phase, 'running');
});

test('cancelled probe receipts cannot claim confirmed cancellation while retaining unknown process custody', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.owner.start(start);
  await f.owner.cancel(lookup);
  const saved = f.base.read(start.commandId)!;
  assert.throws(() => f.base.write({ ...saved, resourceHeld: true }));
  assert.equal(f.owner.read(lookup)?.phase, 'cancelled');
});

test('model limit identity is durable: changed limits conflict and invalid bounds never reach native', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const limits = { contextTokens: 4096, outputTokens: 128 };
  assert.deepEqual(f.owner.start({ ...start, limits }).limits, limits);
  assert.throws(() => f.owner.start({ ...start, limits: { ...limits, outputTokens: 256 } }), {
    code: 'conflict',
  });
  assert.equal(f.runs(), 1);
  f.result.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.deepEqual(f.make().start({ ...start, limits }).limits, limits);
  for (const limits of [
    { contextTokens: 0, outputTokens: 1 },
    { contextTokens: 1, outputTokens: 2 },
    { contextTokens: 100_000_001, outputTokens: 1 },
  ])
    assert.throws(() => f.owner.start({ ...start, commandId: 'TEST-invalid', limits }));
  assert.equal(f.runs(), 1);
  await f.owner.close();
});
