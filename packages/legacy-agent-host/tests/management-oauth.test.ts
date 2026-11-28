import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../dist/management/OAuthOperationOwner.js';
import { managementDigest } from '../dist/management/identity.js';
import { deriveSecretFingerprint } from '../dist/management/secretFingerprint.js';

import type { ManagementCommandStore, ManagementTarget, StoredOAuthCommand } from '../src/management/commandRecords.ts';
import type { ProviderOAuthSnapshot } from '../src/management/contracts.ts';
import type { OAuthNativeConversation } from '../src/management/OAuthOperationOwner.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check() && performance.now() < deadline) await new Promise<void>((done) => setImmediate(done));
  assert.ok(check(), 'the original operation reaches its expected durable state');
}
const initial = {
  operationId: 'TEST-oauth-one',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  methodIndex: 0,
  fields: { 'TEST-client': 'TEST-private-field' },
};
const lookup = {
  operationId: initial.operationId,
  profileId: initial.profileId,
  configRevision: initial.configRevision,
};
const authorization = {
  authorizationUrl: 'https://TEST.invalid/login?state=TEST-private-state',
  instructions: 'TEST-private-instructions',
  completionMethod: 'code' as const,
};
type Authorization = Awaited<ReturnType<OAuthNativeConversation['authorize']>>;
function fixture(
  options: {
    timeoutMs?: number;
    closeFails?: boolean;
    blockClose?: boolean;
    confirmedRejection?: boolean;
    browser?: boolean;
    beforePrepare?(): void;
    onProgress?(event: ProviderOAuthSnapshot): void;
    store?: (base: ManagementCommandStore) => ManagementCommandStore;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-oauth-')));
  const base = new FileManagementCommandStore(root);
  const store = options.store?.(base) ?? base;
  let target: ManagementTarget = {
    profileId: initial.profileId,
    configRevision: initial.configRevision,
    selectionDigest: 'a'.repeat(64),
    resourceId: 'b'.repeat(64),
  };
  let current = true,
    credentialWrites = 0;
  const events: ProviderOAuthSnapshot[] = [];
  const conversations: {
    authorize: ReturnType<typeof deferred<Authorization>>;
    complete: ReturnType<typeof deferred<boolean>>;
    close: ReturnType<typeof deferred<boolean>>;
    browser: ReturnType<typeof deferred<boolean>>;
    authorizeCalls: number;
    completeCalls: number;
    closeCalls: number;
    code: string | undefined;
  }[] = [];
  const fence = new ManagementResourceFence(store.list());
  const assertWriter = () => {
    if (!current) throw new Error('TEST writer revoked');
  };
  const select = (profileId: string, revision: string) => {
    assert.equal(profileId, target.profileId);
    assert.equal(revision, target.configRevision);
    return { ...target };
  };
  const prepare = (input: { operationId: string }) => {
    options.beforePrepare?.();
    const native = {
      authorize: deferred<Authorization>(),
      complete: deferred<boolean>(),
      close: deferred<boolean>(),
      browser: deferred<boolean>(),
      authorizeCalls: 0,
      completeCalls: 0,
      closeCalls: 0,
      code: undefined as string | undefined,
    };
    conversations.push(native);
    return {
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.confirmedRejection ? { nativeCompletion: Promise.resolve(false), nativeRejectionConfirmed: true }
        : options.browser ? { nativeCompletion: native.browser.promise } : {}),
      async authorize() {
        native.authorizeCalls++;
        assert.equal(base.read(input.operationId)?.phase, 'authorizing');
        return native.authorize.promise;
      },
      async complete(code: string | undefined) {
        native.completeCalls++;
        assert.equal(base.read(input.operationId)?.phase, 'completing');
        native.code = code;
        return native.complete.promise;
      },
      async close() {
        native.closeCalls++;
        return options.blockClose ? native.close.promise : !options.closeFails;
      },
    };
  };
  const owner = new OAuthOperationOwner({
    store,
    fence,
    assertWriter,
    select,
    prepare,
    onProgress: (event) => { events.push(structuredClone(event)); options.onProgress?.(event); },
  });
  const credentials = new CredentialCommandOwner({
    store,
    fence,
    assertCurrent: assertWriter,
    select,
    perform: async () => {
      credentialWrites++;
      return { ok: true, settled: true };
    },
  });
  const extraOwners: OAuthOperationOwner[] = [];
  return {
    owner,
    credentials,
    base,
    store,
    events,
    conversations,
    countWrites: () => credentialWrites,
    revoke: () => {
      current = false;
    },
    restoreWriter: () => { current = true; },
    changeTarget: () => {
      target = { ...target, selectionDigest: 'c'.repeat(64), resourceId: 'd'.repeat(64) };
    },
    restart() {
      current = false; // Simulate loss of the old exclusive writer before cold recovery.
      const recovered = new OAuthOperationOwner({
        store,
        fence: new ManagementResourceFence(store.list()),
        assertWriter() {},
        select,
        prepare,
        onProgress: (event) => events.push(structuredClone(event)),
      });
      extraOwners.push(recovered);
      return recovered;
    },
    files: () => readdirSync(join(root, 'management-commands')).map(name => join(root, 'management-commands', name)),
    serialized: () =>
      readdirSync(join(root, 'management-commands'))
        .map((name) => readFileSync(join(root, 'management-commands', name), 'utf8'))
        .join('\n'),
    async cleanup() {
      for (const native of conversations) native.close.resolve(true);
      await Promise.allSettled([owner, ...extraOwners].map((entry) => entry.close()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function controlledFingerprints(t: TestContext) {
  const callbacks: ((error?: Error) => void)[] = [];
  let started = 0;
  t.mock.method(crypto, 'scrypt', (...[input, salt, , , callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input) && Buffer.isBuffer(salt)); started++;
    callbacks.push(error => callback(error ?? null, crypto.createHash('sha256').update(input).update(salt).digest()));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { started: () => started, finish(error?: Error) { const next = callbacks.shift(); assert.ok(next); next(error); } };
}
async function waiting(f: ReturnType<typeof fixture>) {
  f.owner.start(initial);
  const native = f.conversations[0]!;
  native.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  return native;
}
function original(f: ReturnType<typeof fixture>): StoredOAuthCommand {
  const saved = f.base.read(initial.operationId);
  assert.ok(saved?.kind === 'oauth');
  return saved;
}

function changeReceipt(f: ReturnType<typeof fixture>, change: 'missing' | 'changed' | 'corrupt') {
  if (change === 'missing') unlinkSync(f.files()[0]!);
  else if (change === 'corrupt') writeFileSync(f.files()[0]!, 'TEST-invalid-json');
  else f.base.write({ ...original(f), selectionDigest: 'e'.repeat(64) });
  return f.serialized();
}

for (const phase of ['authorizing', 'completing'] as const) {
  for (const change of ['missing', 'changed', 'corrupt', 'expired'] as const) {
    test(`G1c ${phase} progress cannot admit native work after ${change}`, async t => {
      const controlled = controlledFingerprints(t);
      t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
      let bytes = '', changed = false;
      const f = fixture({ onProgress(event) {
        if (event.phase !== phase || changed) return;
        changed = true;
        if (change === 'expired') t.mock.timers.setTime(event.expiresAt);
        else bytes = changeReceipt(f, change);
      } });
      t.after(() => f.cleanup());
      if (phase === 'authorizing') f.owner.start(initial);
      else {
        await waiting(f);
        const submitted = f.owner.complete({ ...lookup, commandId: 'TEST-progress', code: 'TEST-code' });
        controlled.finish(); await submitted;
      }
      const native = f.conversations[0]!;
      assert.equal(changed, true);
      assert.equal(phase === 'authorizing' ? native.authorizeCalls : native.completeCalls, 0);
      await f.owner.close().catch(() => undefined);
      assert.equal(native.closeCalls, 1);
      if (change === 'expired') assert.equal(original(f).reason, 'expired');
      else assert.equal(f.serialized(), bytes);
    });
  }
}

for (const action of ['authorize', 'complete'] as const) {
  test(`G1c late ${action} result cannot publish after the original deadline`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
    const f = fixture(); t.after(() => f.cleanup());
    if (action === 'authorize') f.owner.start(initial);
    else {
      await waiting(f);
      await f.owner.complete({ ...lookup, commandId: 'TEST-late-result', code: 'TEST-code' });
    }
    const native = f.conversations[0]!;
    t.mock.timers.setTime(original(f).expiresAt);
    if (action === 'authorize') native.authorize.resolve(authorization);
    else native.complete.resolve(true);
    await new Promise<void>(done => setImmediate(done));
    assert.equal(native.closeCalls, 1);
    assert.equal(original(f).reason, 'expired');
    assert.equal(original(f).phase, 'cancelled');
    assert.equal(f.events.some(event => event.phase ===
      (action === 'authorize' ? 'waiting-for-code' : 'completed')), false);
  });
}

for (const field of ['profileId', 'configRevision'] as const) {
  for (const action of ['cancel', 'complete', 'authorization'] as const) {
    test(`G1c ${action} refuses a foreign ${field} before touching the active conversation`, async t => {
      const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
      const selected = { ...lookup, [field]: 'TEST-foreign' };
      f.base.write({ ...original(f), [field]: selected[field] });
      const bytes = f.serialized();
      if (action === 'authorization') assert.throws(() => f.owner.authorization(selected), { code: 'conflict' });
      else if (action === 'cancel') await assert.rejects(f.owner.cancel(selected), { code: 'conflict' });
      else await assert.rejects(f.owner.complete({ ...selected, commandId: 'TEST-foreign-control', code: 'TEST-code' }), { code: 'conflict' });
      await new Promise<void>(done => setImmediate(done));
      assert.equal(native.closeCalls, 0);
      assert.equal(native.completeCalls, 0);
      assert.equal(f.serialized(), bytes);
      await assert.rejects(f.owner.close(), { code: 'held' });
      assert.equal(native.closeCalls, 1);
      assert.equal(f.serialized(), bytes);
    });
  }
}

for (const change of ['changed', 'expired'] as const) {
  test(`G1c private authorization read refuses ${change} original without native effects`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
    const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
    if (change === 'changed') changeReceipt(f, change);
    else t.mock.timers.setTime(original(f).expiresAt);
    const bytes = f.serialized();
    assert.throws(() => f.owner.authorization(lookup));
    await new Promise<void>(done => setImmediate(done));
    assert.equal(native.closeCalls, 0);
    assert.equal(native.completeCalls, 0);
    assert.equal(f.serialized(), bytes);
    await f.owner.close().catch(() => undefined);
    assert.equal(native.closeCalls, 1);
    if (change === 'changed') assert.equal(f.serialized(), bytes);
  });
}

test('G1c a recovered writer cannot publish after the first stop admission failed', async t => {
  const f = fixture({ blockClose: true }); t.after(() => f.cleanup()); const native = await waiting(f);
  const bytes = f.serialized();
  f.revoke(); const closing = assert.rejects(f.owner.close(), { code: 'held' });
  await until(() => native.closeCalls === 1);
  f.restoreWriter(); native.close.resolve(true); await closing;
  assert.equal(f.serialized(), bytes);
  assert.equal(native.closeCalls, 1);
  await assert.rejects(f.credentials.execute({ profileId: initial.profileId,
    configRevision: initial.configRevision, commandId: 'TEST-writer-recovered',
    providerId: initial.providerId, kind: 'credential.forget' }), { code: 'held' });
  assert.equal(f.countWrites(), 0);
});

for (const action of ['timer', 'cancel', 'close', 'blocked-close'] as const) {
  test(`G1c ${action} keeps a corrupt original untouched and closes its capture once`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const f = fixture({ blockClose: action === 'blocked-close' });
    t.after(() => f.cleanup()); const native = await waiting(f);
    const pending = action === 'blocked-close' ? f.owner.cancel(lookup) : undefined;
    if (pending) await until(() => native.closeCalls === 1);
    const bytes = changeReceipt(f, 'corrupt');
    if (action === 'timer') {
      t.mock.timers.tick(30_000); await until(() => native.closeCalls === 1);
    }
    else if (action === 'cancel') await assert.rejects(f.owner.cancel(lookup));
    else if (action === 'blocked-close') native.close.resolve(true);
    await assert.rejects(f.owner.close(), { code: 'held' });
    if (pending) assert.equal((await pending).phase, 'held');
    assert.equal(native.closeCalls, 1);
    assert.equal(native.completeCalls, 0);
    assert.equal(f.serialized(), bytes);
  });
}

for (const phase of ['waiting-for-code', 'completed', 'cancelling', 'cancelled'] as const) {
  for (const committed of [false, true]) {
    test(`G1c ${phase} write failure preserves actual bytes: committed=${committed}`, async t => {
      let injected = false, bytes = '';
      const f = fixture({ store: base => ({ read: id => base.read(id), list: () => base.list(),
        write(record) {
          if (record.phase !== phase || injected) { base.write(record); return; }
          injected = true;
          if (committed) base.write(record);
          bytes = f.serialized();
          throw new Error('TEST uncertain publication');
        },
      }) });
      t.after(() => f.cleanup());
      if (phase === 'waiting-for-code') {
        f.owner.start(initial); f.conversations[0]!.authorize.resolve(authorization);
      } else {
        const native = await waiting(f);
        if (phase === 'completed') {
          await f.owner.complete({ ...lookup, commandId: 'TEST-write-outcome', code: 'TEST-code' });
          native.complete.resolve(true);
        } else await f.owner.cancel(lookup);
      }
      await until(() => injected && f.conversations[0]!.closeCalls === 1);
      await assert.rejects(f.owner.close(), { code: 'held' });
      assert.equal(f.serialized(), bytes, 'cleanup cannot replace a failed publication outcome');
      assert.equal(f.conversations[0]!.closeCalls, 1);
      assert.equal(f.conversations[0]!.completeCalls, phase === 'completed' ? 1 : 0);
      const held = original(f).resourceHeld, originalPath = f.files()[0]!;
      const cold = f.restart();
      if (held) assert.throws(() => cold.start({ ...initial, operationId: 'TEST-cold-after-write' }), { code: 'held' });
      else {
        assert.equal(cold.read(lookup)?.phase, phase);
        assert.equal(cold.start({ ...initial, operationId: 'TEST-cold-after-write' }).phase, 'authorizing');
      }
      assert.equal(readFileSync(originalPath, 'utf8'), bytes, 'cold recovery keeps the original receipt');
    });
  }
}

test('one-character OAuth code gets a private salted fingerprint and cold replay preserves bytes after expiry and target drift', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const native = await waiting(f), input = { ...lookup, commandId: 'TEST-salted', code: ' x ' };
  await f.owner.complete(input);
  const saved = original(f);
  assert.equal(saved.completionFingerprintKdf?.version, 1);
  const canonical = { commandId: input.commandId, code: 'x' };
  assert.equal(saved.completionFingerprint, (await deriveSecretFingerprint(canonical, saved.completionFingerprintKdf)).fingerprint);
  assert.equal(f.serialized().includes(managementDigest(canonical)), false);
  assert.equal(native.code, 'x');
  native.complete.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  const bytes = f.serialized();
  f.changeTarget(); const cold = f.restart();
  t.mock.timers.enable({ apis: ['Date'], now: saved.expiresAt + 1 });
  assert.equal((await cold.complete({ ...input, code: 'x' })).phase, 'completed');
  await assert.rejects(cold.complete({ ...input, code: 'y' }), { code: 'conflict' });
  await assert.rejects(cold.complete({ ...input, commandId: 'TEST-other' }), { code: 'conflict' });
  assert.equal(f.serialized(), bytes);
  assert.equal(native.completeCalls, 1);
  assert.equal(JSON.stringify(f.events).includes('completionFingerprint'), false);
});

test('legacy pasted-code and code-capable native null-code completions retain their original algorithm and bytes', async t => {
  for (const browser of [false, true]) {
    const f = fixture({ browser }); t.after(() => f.cleanup());
    const native = await waiting(f);
    let commandId = 'TEST-legacy', code: string | undefined = 'TEST-old-code';
    if (browser) {
      native.browser.resolve(true); await until(() => native.completeCalls === 1);
      native.complete.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'completed');
      commandId = original(f).completionCommandId!; code = undefined;
    } else f.base.write({ ...original(f), phase: 'completed', resourceHeld: false,
      completionCommandId: commandId, completionFingerprint: managementDigest({ commandId, code }) });
    assert.equal(original(f).completionMethod, 'code');
    assert.equal(original(f).completionFingerprintKdf, undefined);
    const bytes = f.serialized(), cold = f.restart();
    const mocked = t.mock.method(crypto, 'scrypt', () => { assert.fail('marker-less replay must not derive'); });
    syncBuiltinESMExports();
    try {
      assert.equal((await cold.complete({ ...lookup, commandId, ...(code ? { code } : {}) })).phase, 'completed');
      await assert.rejects(cold.complete({ ...lookup, commandId, code: 'TEST-changed' }), { code: 'conflict' });
      assert.equal(f.serialized(), bytes);
      assert.equal(native.completeCalls, browser ? 1 : 0);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('identical in-flight code joins once and browser completion cannot replace its original claim', async t => {
  const controlled = controlledFingerprints(t), f = fixture({ browser: true });
  t.after(() => f.cleanup()); const native = await waiting(f);
  const input = { ...lookup, commandId: 'TEST-code', code: 'TEST-paste' };
  const first = f.owner.complete(input), duplicate = f.owner.complete(input);
  assert.equal(first, duplicate);
  await assert.rejects(f.owner.complete({ ...input, code: 'TEST-changed' }), { code: 'conflict' });
  await assert.rejects(f.owner.complete({ ...input, commandId: 'TEST-other' }), { code: 'conflict' });
  native.browser.resolve(true); await Promise.resolve();
  assert.equal(native.completeCalls, 0); assert.equal(controlled.started(), 1);
  controlled.finish();
  assert.deepEqual(await first, await duplicate);
  assert.equal(original(f).completionCommandId, input.commandId);
  assert.equal(native.completeCalls, 1);
  native.complete.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'completed');
});

test('failed A allows B before the browser observer continues and B retains the only native completion', async t => {
  const controlled = controlledFingerprints(t), f = fixture({ browser: true });
  t.after(() => f.cleanup()); const native = await waiting(f);
  const first = f.owner.complete({ ...lookup, commandId: 'TEST-A', code: 'TEST-A-code' });
  let second: Promise<ProviderOAuthSnapshot> | undefined;
  const retry = first.catch(error => {
    assert.equal(error.code, 'held');
    second = f.owner.complete({ ...lookup, commandId: 'TEST-B', code: 'TEST-B-code' });
  });
  native.browser.resolve(true); await Promise.resolve();
  controlled.finish(new Error('TEST failed A')); await retry;
  assert.ok(second); assert.equal(controlled.started(), 2);
  assert.equal(native.completeCalls, 0);
  controlled.finish(); await second;
  assert.equal(original(f).completionCommandId, 'TEST-B');
  assert.equal(native.code, 'TEST-B-code'); assert.equal(native.completeCalls, 1);
  native.complete.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'completed');
});

test('busy or failed code preparation leaves the original browser outcome and namespace intact', async t => {
  const controlled = controlledFingerprints(t);
  for (const busy of [false, true]) for (const ok of [false, true]) {
    const f = fixture({ browser: true }); t.after(() => f.cleanup());
    const native = await waiting(f);
    const fillers = busy ? Array.from({ length: 9 }, (_, index) => deriveSecretFingerprint('TEST-fill-' + index)) : [];
    const rejected = assert.rejects(f.owner.complete({ ...lookup, commandId: 'TEST-rejected-code', code: 'TEST-code' }),
      { code: busy ? 'busy' : 'held' });
    await assert.rejects(f.credentials.execute({ commandId: 'TEST-no-early-release', profileId: initial.profileId,
      configRevision: initial.configRevision, providerId: initial.providerId, kind: 'credential.forget' }), { code: 'busy' });
    native.browser.resolve(ok); await Promise.resolve();
    if (!busy) controlled.finish(new Error('TEST code derivation failed'));
    await rejected;
    if (ok) {
      await until(() => native.completeCalls === 1);
      assert.match(original(f).completionCommandId!, /^native:/);
      assert.equal(original(f).completionFingerprintKdf, undefined);
      assert.equal(native.code, undefined);
      native.complete.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'completed');
    } else {
      await until(() => native.closeCalls === 1);
      assert.equal(native.completeCalls, 0);
    }
    for (let index = 0; index < fillers.length; index++) controlled.finish();
    await Promise.all(fillers);
  }
});

test('cancel and close clean before crypto settles while seal immediately fences and aborts', async t => {
  const controlled = controlledFingerprints(t);
  for (const action of ['cancel', 'close', 'seal'] as const) {
    const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
    const rejected = assert.rejects(f.owner.complete({ ...lookup, commandId: 'TEST-late-code', code: 'TEST-code' }), { code: 'held' });
    if (action === 'cancel') await f.owner.cancel(lookup);
    else {
      if (action === 'seal') { f.owner.seal(); assert.equal(native.closeCalls, 0); }
      await f.owner.close();
    }
    assert.equal(native.closeCalls, 1);
    const path = f.files()[0]!, bytes = readFileSync(path);
    if (action === 'cancel') f.owner.start({ ...initial, operationId: 'TEST-next-flow' });
    controlled.finish(); await rejected;
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(native.completeCalls, 0);
    if (action === 'cancel') assert.equal(f.conversations[1]?.completeCalls, 0);
  }
});

test('original deadline, writer and target are rechecked after crypto even before the expiry timer runs', async t => {
  const controlled = controlledFingerprints(t);
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  for (const fault of ['expired', 'writer', 'target'] as const) {
    t.mock.timers.setTime(100_000);
    const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
    const rejected = assert.rejects(f.owner.complete({ ...lookup, commandId: 'TEST-stale-code', code: 'TEST-code' }));
    const bytes = f.serialized();
    if (fault === 'expired') t.mock.timers.setTime(original(f).expiresAt);
    if (fault === 'writer') f.revoke();
    if (fault === 'target') f.changeTarget();
    controlled.finish(); await rejected;
    assert.equal(native.completeCalls, 0);
    if (fault === 'expired') {
      await until(() => native.closeCalls === 1);
      assert.equal(original(f).reason, 'expired');
    } else assert.equal(f.serialized(), bytes);
  }
});

test('initial explicit and browser completion preserve an already-changed receipt before expiry cleanup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  for (const browser of [false, true]) for (const missing of [false, true]) {
    t.mock.timers.setTime(100_000);
    const f = fixture({ browser }); t.after(() => f.cleanup()); const native = await waiting(f);
    const expiresAt = original(f).expiresAt;
    if (missing) unlinkSync(f.files()[0]!);
    else f.base.write({ ...original(f), providerId: 'TEST-replaced-provider' });
    const bytes = f.serialized();
    t.mock.timers.setTime(expiresAt);
    const error = browser ? undefined : await f.owner.complete({ ...lookup, commandId: 'TEST-expired-code', code: 'TEST-code' })
      .then(() => undefined, failure => failure);
    if (browser) native.browser.resolve(true);
    await until(() => native.closeCalls === 1);
    await f.owner.close().catch(() => undefined);
    assert.equal(f.serialized(), bytes, 'deadline cleanup cannot overwrite or resurrect the original receipt');
    assert.equal(native.completeCalls, 0);
    if (!browser) assert.equal(error?.code, 'conflict');
  }
});

test('a missing or replaced receipt after derivation stays untouched through original native cleanup', async t => {
  const controlled = controlledFingerprints(t);
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  for (const missing of [false, true]) for (const expired of [false, true]) {
    t.mock.timers.setTime(100_000);
    const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
    const expiresAt = original(f).expiresAt;
    const rejected = assert.rejects(f.owner.complete({ ...lookup, commandId: 'TEST-stale-receipt', code: 'TEST-code' }), { code: 'conflict' });
    if (missing) unlinkSync(f.files()[0]!);
    else f.base.write({ ...original(f), providerId: 'TEST-replaced-provider' });
    const bytes = f.serialized();
    if (expired) t.mock.timers.setTime(expiresAt);
    controlled.finish(); await rejected;
    await until(() => native.closeCalls === 1);
    await assert.rejects(f.owner.close(), { code: 'held' });
    assert.equal(f.serialized(), bytes);
    assert.equal(native.completeCalls, 0);
    assert.equal(f.base.read(initial.operationId) === undefined, missing);
  }
});

test('retained replay returns advanced progress and fences changed receipts without itself performing cleanup', async t => {
  const controlled = controlledFingerprints(t);
  for (const change of ['progress', 'missing', 'salt'] as const) {
    const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
    const input = { ...lookup, commandId: 'TEST-replay', code: 'TEST-code' };
    const first = f.owner.complete(input); controlled.finish(); await first;
    const replay = f.owner.complete(input);
    const rejected = change === 'progress' ? undefined : assert.rejects(replay, { code: 'conflict' });
    if (change === 'progress') {
      native.complete.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'completed');
    } else if (change === 'missing') unlinkSync(f.files()[0]!);
    else f.base.write({ ...original(f), completionFingerprintKdf: { version: 1, salt: 'f'.repeat(32) } });
    const bytes = f.serialized();
    controlled.finish();
    if (change === 'progress') assert.equal((await replay).phase, 'completed');
    else {
      await rejected;
      assert.equal(native.closeCalls, 0, 'retained replay performs no native cleanup');
      await assert.rejects(f.owner.close(), { code: 'held' });
      assert.equal(native.closeCalls, 1);
      native.complete.resolve(true); await Promise.resolve();
    }
    assert.equal(f.serialized(), bytes);
    assert.equal(native.completeCalls, 1, 'only the original published completion was dispatched');
  }
});

test('replay fences an already-replaced live receipt before a late native result can overwrite it', async t => {
  const f = fixture(); t.after(() => f.cleanup()); const native = await waiting(f);
  const input = { ...lookup, commandId: 'TEST-existing-drift', code: 'TEST-code' };
  await f.owner.complete(input);
  f.base.write({ ...original(f), selectionDigest: 'c'.repeat(64) });
  const bytes = f.serialized();
  const refused = await f.owner.complete(input).then(() => false, error => {
    assert.equal(error.code, 'conflict'); return true;
  });
  assert.equal(native.closeCalls, 0, 'replay itself cannot close the original native conversation');
  native.complete.resolve(true);
  await new Promise<void>(done => setImmediate(done));
  await f.owner.close().catch(() => undefined);
  assert.equal(f.serialized(), bytes, 'late finish and cleanup cannot overwrite the already-changed receipt');
  assert.equal(refused, true);
  assert.equal(native.completeCalls, 1);
});

test('completion write that commits then throws preserves its ID and descriptor through live and cold cleanup', async t => {
  const controlled = controlledFingerprints(t), failure = new Error('TEST completion fsync after rename');
  const f = fixture({ blockClose: true, store: base => ({ read: id => base.read(id), list: () => base.list(),
    write(record) { base.write(record); if (record.phase === 'completing') throw failure; } }) });
  t.after(() => f.cleanup()); const native = await waiting(f);
  const input = { ...lookup, commandId: 'TEST-unknown-publication', code: 'TEST-code' };
  const rejected = assert.rejects(f.owner.complete(input), error => error === failure);
  controlled.finish(); await rejected; await until(() => native.closeCalls === 1);
  const retained = f.owner.complete(input); controlled.finish();
  assert.equal((await retained).phase, 'held', 'a retired uncertain publication still matches its committed original');
  assert.equal(f.owner.read(lookup)?.phase, 'cancelling');
  native.close.resolve(true); await until(() => f.owner.read(lookup)?.phase === 'held');
  assert.equal(original(f).completionCommandId, input.commandId);
  assert.equal(original(f).completionFingerprintKdf?.version, 1);
  assert.equal(original(f).phase, 'completing');
  const bytes = f.serialized();
  assert.throws(() => f.owner.start({ ...initial, operationId: 'TEST-live-next' }), { code: 'held' });
  const cold = f.restart();
  assert.throws(() => cold.start({ ...initial, operationId: 'TEST-cold-next' }), { code: 'held' });
  const replay = cold.complete(input); controlled.finish();
  assert.equal((await replay).phase, 'held');
  assert.equal(f.serialized(), bytes);
  assert.equal(native.completeCalls, 0);
});

test('code OAuth admits once, persists before callback, publishes safe ordered progress and never journals auth material', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.equal(f.owner.start(initial).phase, 'authorizing');
  const native = f.conversations[0]!;
  assert.equal(native.authorizeCalls, 1);
  assert.equal(f.owner.start(initial).phase, 'authorizing');
  assert.equal(f.conversations.length, 1);
  assert.throws(() => f.owner.start({ ...initial, fields: { 'TEST-client': 'TEST-different' } }), {
    code: 'conflict',
  });
  native.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  assert.deepEqual(f.owner.authorization(lookup), {
    authorizationUrl: new URL(authorization.authorizationUrl).href,
    instructions: authorization.instructions,
  });
  const complete = { ...lookup, commandId: 'TEST-code-submit', code: 'TEST-private-code' };
  assert.equal((await f.owner.complete(complete)).phase, 'completing');
  assert.equal(native.code, complete.code);
  assert.equal((await f.owner.complete(complete)).phase, 'completing');
  assert.equal(native.completeCalls, 1);
  await assert.rejects(f.owner.complete({ ...complete, commandId: 'TEST-wrong-completion-id' }), { code: 'conflict' });
  await assert.rejects(f.owner.complete({ ...complete, code: 'TEST-different' }), {
    code: 'conflict',
  });
  native.complete.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.equal(f.owner.start(initial).phase, 'completed');
  assert.equal(f.owner.authorization(lookup), null);
  assert.deepEqual(
    f.events.map((event) => event.phase),
    ['authorizing', 'waiting-for-code', 'completing', 'completed']
  );
  assert.deepEqual(
    f.events.map((event) => event.sequence),
    [1, 2, 3, 4]
  );
  const publicAndDurable = JSON.stringify(f.events) + f.serialized();
  for (const secret of [
    'TEST-private-code',
    'TEST-private-state',
    'TEST-private-field',
    'TEST-private-instructions',
    'authorizationUrl',
  ])
    assert.equal(publicAndDurable.includes(secret), false);
});

test('automatic OAuth has the same bound callback identity and rejects an injected authorization code', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const native = f.conversations[0]!;
  native.authorize.resolve({ ...authorization, completionMethod: 'auto' });
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-browser');
  await assert.rejects(
    f.owner.complete({ ...lookup, commandId: 'TEST-auto', code: 'TEST-unexpected' }),
    { code: 'invalid' }
  );
  assert.equal(native.completeCalls, 0);
  await f.owner.complete({ ...lookup, commandId: 'TEST-auto' });
  assert.equal(native.code, undefined);
  native.complete.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
});

test('cancel fences before cleanup, retains the namespace until confirmed stop and ignores late authorization after reconnect', async (t) => {
  const f = fixture({ blockClose: true });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const old = f.conversations[0]!;
  const cancelled = f.owner.cancel(lookup);
  assert.equal(f.owner.read(lookup)?.phase, 'cancelling');
  assert.throws(() => f.owner.start({ ...initial, operationId: 'TEST-replacement' }), {
    code: 'busy',
  });
  await until(() => old.closeCalls === 1);
  old.close.resolve(true);
  assert.equal((await cancelled).phase, 'cancelled');
  const replacement = { ...initial, operationId: 'TEST-replacement' };
  f.owner.start(replacement);
  old.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.authorization(lookup), null);
  assert.equal(
    f.owner.read({ ...lookup, operationId: replacement.operationId })?.phase,
    'authorizing'
  );
  assert.equal(
    f.events.filter((event) => event.operationId === initial.operationId).at(-1)?.phase,
    'cancelled'
  );
  await assert.rejects(
    f.credentials.execute({
      commandId: 'TEST-forget',
      profileId: initial.profileId,
      configRevision: initial.configRevision,
      providerId: initial.providerId,
      kind: 'credential.forget',
    }),
    { code: 'busy' }
  );
  f.conversations[1]!.close.resolve(true);
});

test('cancel during callback closes the original target and a late success cannot complete the next account flow', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const old = f.conversations[0]!;
  old.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  await f.owner.complete({ ...lookup, commandId: 'TEST-code', code: 'TEST-code' });
  f.changeTarget();
  assert.equal((await f.owner.cancel(lookup)).phase, 'cancelled');
  assert.equal(old.closeCalls, 1);
  const next = { ...initial, operationId: 'TEST-other-account' };
  f.owner.start(next);
  old.complete.resolve(true);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.read(lookup)?.phase, 'cancelled');
  assert.equal(f.owner.read({ ...lookup, operationId: next.operationId })?.phase, 'authorizing');
  assert.equal(
    f.events.some(
      (event) => event.operationId === initial.operationId && event.phase === 'completed'
    ),
    false
  );
});

test('cold recovery holds the original pending OAuth request and cannot repeat authorization or create a second writer', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const recovered = f.restart();
  assert.equal(recovered.read(lookup)?.phase, 'held');
  assert.equal(recovered.start(initial).phase, 'held');
  assert.equal(recovered.authorization(lookup), null);
  assert.throws(() => recovered.start({ ...initial, operationId: 'TEST-new-id' }), {
    code: 'held',
  });
  assert.equal(f.conversations.length, 1);
});

test('unconfirmed OAuth writer cleanup remains held for credential mutations and shutdown', async (t) => {
  const f = fixture({ closeFails: true });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  assert.equal((await f.owner.cancel(lookup)).phase, 'held');
  assert.equal(f.base.read(initial.operationId)?.resourceHeld, true);
  await assert.rejects(
    f.credentials.execute({
      commandId: 'TEST-forget',
      profileId: initial.profileId,
      configRevision: initial.configRevision,
      providerId: initial.providerId,
      kind: 'credential.forget',
    }),
    { code: 'held' }
  );
  assert.equal(f.countWrites(), 0);
  await assert.rejects(f.owner.close(), { code: 'held' });
});

for (const clean of [true, false]) {
  test(`confirmed native rejection requires original cleanup before retry: cleanup=${clean}`, async (t) => {
    const f = fixture({ confirmedRejection: true, blockClose: true });
    t.after(() => f.cleanup());
    f.owner.start(initial);
    const native = f.conversations[0]!;
    native.authorize.resolve({ ...authorization, completionMethod: 'auto' });
    await until(() => native.closeCalls === 1);
    assert.equal(f.owner.read(lookup)?.phase, 'cancelling');
    const next = { ...initial, operationId: 'TEST-explicit-retry' };
    assert.throws(() => f.owner.start(next), { code: 'busy' });
    native.close.resolve(clean);
    await until(() => f.owner.read(lookup)?.phase === (clean ? 'failed' : 'held'));
    assert.equal(f.owner.read(lookup)?.reason, 'native-rejected');
    assert.equal(f.base.read(initial.operationId)?.resourceHeld, !clean);
    assert.equal(f.owner.authorization(lookup), null);
    assert.equal(native.completeCalls, 0, 'rejection cannot become successful completion');
    if (clean) {
      assert.equal(f.owner.start(next).phase, 'authorizing');
      f.conversations[1]!.close.resolve(true);
    } else assert.throws(() => f.owner.start(next), { code: 'held' });
  });
}

test('completion admission loss stops the original flow without submitting a code', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write(record) {
        if (record.phase === 'completing') throw new Error('TEST journal failure');
        base.write(record);
      },
    }),
  });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const native = f.conversations[0]!;
  native.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  await assert.rejects(
    f.owner.complete({ ...lookup, commandId: 'TEST-code', code: 'TEST-sensitive-code' })
  );
  await until(() => f.owner.read(lookup)?.phase === 'held');
  assert.equal(native.completeCalls, 0);
  assert.equal(native.closeCalls, 1);
  assert.equal(f.serialized().includes('TEST-sensitive-code'), false);
});

test('expiration cancels the captured flow and later authorization cannot restore it', async (t) => {
  const f = fixture({ timeoutMs: 25 });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.owner.read(lookup)?.reason, 'expired');
  f.conversations[0]!.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.authorization(lookup), null);
  assert.equal(f.conversations[0]!.closeCalls, 1);
});

test('revoked writer cannot publish late OAuth progress or overwrite its original claim', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  f.revoke();
  f.conversations[0]!.authorize.resolve(authorization);
  await until(() => f.conversations[0]!.closeCalls === 1);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(
    f.events.map((event) => event.phase),
    ['authorizing']
  );
  assert.equal(f.base.read(initial.operationId)?.phase, 'authorizing');
});

test('initial OAuth write that commits then throws keeps live and cold custody without authorizing or rewriting', async (t) => {
  const failure = new Error('TEST initial fsync failure after rename');
  const f = fixture({ store: base => ({ read: id => base.read(id), list: () => base.list(),
    write(record) { base.write(record); throw failure; } }) });
  t.after(() => f.cleanup());
  assert.throws(() => f.owner.start(initial), error => error === failure);
  const bytes = f.serialized();
  assert.equal(f.base.read(initial.operationId)?.phase, 'authorizing');
  assert.equal(f.base.read(initial.operationId)?.resourceHeld, true);
  assert.equal(f.conversations[0]?.authorizeCalls, 0);
  assert.throws(() => f.owner.start({ ...initial, operationId: 'TEST-live-next' }), { code: 'held' });
  const cold = f.restart();
  assert.throws(() => cold.start({ ...initial, operationId: 'TEST-cold-next' }), { code: 'held' });
  assert.equal(f.serialized(), bytes);
  assert.equal(f.conversations.length, 1);
});

test('attempted initial publication failure retains custody even without a visible receipt', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write(record) {
        if (record.kind === 'oauth') throw new Error('TEST initial journal failure');
        base.write(record);
      },
    }),
  });
  t.after(() => f.cleanup());
  assert.throws(() => f.owner.start(initial));
  assert.equal(f.conversations[0]?.authorizeCalls, 0);
  assert.equal(f.base.read(initial.operationId), undefined);
  await assert.rejects(f.credentials.execute({
    commandId: 'TEST-set',
    profileId: initial.profileId,
    configRevision: initial.configRevision,
    providerId: initial.providerId,
    kind: 'credential.set',
    key: 'TEST-key',
  }), { code: 'held' });
  assert.equal(f.countWrites(), 0);
});

test('construction failure before an initial write keeps the same live namespace retryable', async t => {
  let fail = true;
  const f = fixture({ beforePrepare() { if (fail) throw new Error('TEST prepare before claim'); } });
  t.after(() => f.cleanup());
  assert.throws(() => f.owner.start(initial), /prepare before claim/);
  assert.equal(f.base.read(initial.operationId), undefined);
  assert.equal(f.conversations.length, 0);
  fail = false;
  assert.equal(f.owner.start({ ...initial, operationId: 'TEST-after-prepare' }).phase, 'authorizing');
  assert.equal(f.conversations[0]?.authorizeCalls, 1);
});

test('unsafe authorization URLs never leave the captured flow and cause confirmed cleanup', async (t) => {
  for (const url of ['file:///TEST-private', 'https://TEST-user:TEST-password@TEST.invalid/']) {
    const f = fixture();
    t.after(() => f.cleanup());
    f.owner.start(initial);
    f.conversations[0]!.authorize.resolve({ ...authorization, authorizationUrl: url });
    await until(() => f.owner.read(lookup)?.phase === 'held');
    assert.equal(f.owner.authorization(lookup), null);
    assert.equal(f.conversations[0]!.closeCalls, 1);
    assert.equal(JSON.stringify(f.events).includes(url), false);
  }
});

test('orderly shutdown cancels the owned pending flow durably and cold recovery permits a separate new intent', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  await f.owner.close();
  assert.equal(f.base.read(initial.operationId)?.phase, 'cancelled');
  assert.equal(f.base.read(initial.operationId)?.resourceHeld, false);
  const recovered = f.restart();
  assert.equal(recovered.start(initial).phase, 'cancelled');
  assert.equal(f.conversations.length, 1);
  assert.equal(
    recovered.start({ ...initial, operationId: 'TEST-new-after-shutdown' }).phase,
    'authorizing'
  );
  f.conversations[0]!.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(recovered.read(lookup)?.phase, 'cancelled');
  assert.equal(f.conversations[0]!.closeCalls, 1);
});
