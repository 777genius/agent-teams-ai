import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { managementDigest } from '../dist/management/identity.js';
import { deriveSecretFingerprint } from '../dist/management/secretFingerprint.js';
import type { StoredManagementCommand } from '../dist/management/commandRecords.js';
import type {
  CredentialCommand,
  CredentialCommandStore,
  CredentialTarget,
} from '../src/management/CredentialCommandOwner.ts';

const command: CredentialCommand = {
  commandId: 'TEST-set',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  kind: 'credential.set',
  key: 'TEST-private-credential',
  metadata: { 'TEST-field': 'TEST-private-metadata' },
};
const target: CredentialTarget = {
  profileId: command.profileId,
  configRevision: command.configRevision,
  selectionDigest: 'a'.repeat(64),
  resourceId: 'b'.repeat(64),
};
const lookup = {
  commandId: command.commandId,
  profileId: command.profileId,
  configRevision: command.configRevision,
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-credentials-')));
  const store = new FileManagementCommandStore(root);
  let current = true,
    selected = { ...target },
    calls = 0;
  let effect: () => Promise<{ ok: boolean; settled: boolean; rejected?: boolean }> = async () => ({
    ok: true,
    settled: true,
  });
  function owner(storage: CredentialCommandStore = store) {
    return new CredentialCommandOwner({
      store: storage,
      assertCurrent() {
        if (!current) throw new Error('TEST revoked writer');
      },
      select(profileId, configRevision) {
        assert.equal(profileId, selected.profileId);
        assert.equal(configRevision, selected.configRevision);
        return { ...selected };
      },
      async perform(input) {
        calls++;
        assert.equal(
          store.read(input.commandId)?.phase,
          'claimed',
          'native effects follow durable admission'
        );
        return effect();
      },
    });
  }
  return {
    root,
    store,
    owner,
    count: () => calls,
    setEffect: (next: typeof effect) => {
      effect = next;
    },
    revoke: () => {
      current = false;
    },
    changeSelection: () => {
      selected = { ...selected, selectionDigest: 'c'.repeat(64) };
    },
    files: () =>
      readdirSync(join(root, 'management-commands')).map((name) =>
        join(root, 'management-commands', name)
      ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function controlledFingerprints(t: TestContext) {
  const callbacks: ((error?: Error) => void)[] = [];
  t.mock.method(crypto, 'scrypt', (...[input, salt, , , callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input) && Buffer.isBuffer(salt));
    callbacks.push(error => callback(error ?? null, crypto.createHash('sha256').update(input).update(salt).digest()));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { finish(error?: Error) { const next = callbacks.shift(); assert.ok(next); next(error); } };
}

test('new one-character credential commands retain a salted fingerprint through cold replay without a parallel command digest', async t => {
  const f = fixture(); t.after(f.cleanup);
  const weak = { ...command, key: 'x' };
  const first = await f.owner().execute(weak);
  const saved = f.store.read(command.commandId);
  assert.ok(saved?.kind === 'credential.set' && saved.fingerprintKdf?.version === 1);
  assert.notEqual(saved.fingerprint, managementDigest(weak));
  const path = f.files()[0]!, bytes = readFileSync(path);
  assert.equal(bytes.includes(managementDigest(weak)), false);
  const cold = f.owner();
  assert.deepEqual(await cold.resume(weak), first);
  assert.deepEqual(await cold.execute(weak), first);
  await assert.rejects(cold.resume({ ...weak, key: 'y' }), { code: 'conflict' });
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal('fingerprintKdf' in first, false);
  assert.equal(f.count(), 1);
});

test('legacy credentials replay their original fingerprint and bytes without calling the new KDF', async t => {
  const f = fixture(); t.after(f.cleanup);
  f.store.write({ ...target, schemaVersion: 1, commandId: command.commandId,
    providerId: command.providerId, kind: 'credential.set', fingerprint: managementDigest(command),
    phase: 'completed', resourceHeld: false });
  const path = f.files()[0]!, bytes = readFileSync(path);
  t.mock.method(crypto, 'scrypt', () => { assert.fail('legacy replay does not derive a new witness'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const cold = f.owner(), receipt = cold.lookup(lookup);
  assert.deepEqual(await cold.execute(command), receipt);
  assert.deepEqual(await cold.resume(command), receipt);
  await assert.rejects(cold.resume({ ...command, key: 'TEST-other-key' }), { code: 'conflict' });
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(f.count(), 0);
});

test('same command ID claimed in another namespace during derivation cannot be overwritten or dispatched twice', async t => {
  const f = fixture(); t.after(f.cleanup);
  const crypto = controlledFingerprints(t);
  let effects = 0;
  const owner = new CredentialCommandOwner({ store: f.store, assertCurrent() {},
    select(profileId, configRevision) { return { ...target, profileId, configRevision,
      resourceId: profileId === target.profileId ? target.resourceId : 'd'.repeat(64) }; },
    async perform() { effects++; return { ok: true, settled: true }; },
  });
  const first = owner.execute(command);
  const other = owner.execute({ ...command, profileId: 'TEST-other-profile' });
  crypto.finish();
  assert.equal((await first).phase, 'completed');
  const bytes = readFileSync(f.files()[0]!);
  crypto.finish();
  await assert.rejects(other, { code: 'conflict' });
  assert.deepEqual(readFileSync(f.files()[0]!), bytes);
  assert.equal(effects, 1);
  assert.equal((await owner.execute({ ...lookup, commandId: 'TEST-other-forget',
    profileId: 'TEST-other-profile', providerId: command.providerId, kind: 'credential.forget' })).phase, 'completed');
  assert.equal(effects, 2, 'a preclaim conflict releases only its own transient namespace reservation');
});

test('revocation, target drift and crypto failure before claim leave no receipt or invented durable hold', async t => {
  const crypto = controlledFingerprints(t);
  for (const fault of ['revoked', 'target', 'crypto'] as const) {
    const f = fixture(); t.after(f.cleanup);
    let current = true, selected = { ...target }, effects = 0;
    const owner = new CredentialCommandOwner({ store: f.store,
      assertCurrent() { if (!current) throw new Error('TEST revoked'); }, select: () => selected,
      async perform() { effects++; return { ok: true, settled: true }; },
    });
    const pending = owner.execute(command);
    if (fault === 'revoked') current = false;
    if (fault === 'target') selected.selectionDigest = 'c'.repeat(64);
    crypto.finish(fault === 'crypto' ? new Error('TEST crypto failure') : undefined);
    await assert.rejects(pending);
    assert.deepEqual([...f.store.list()], []);
    assert.equal(effects, 0);
    current = true; selected = { ...target };
    assert.equal((await owner.execute({ ...lookup, commandId: 'TEST-after-preclaim',
      providerId: command.providerId, kind: 'credential.forget' })).phase, 'completed');
  }
});

test('queue saturation rejects before claim and releases the credential namespace for a later intent', async t => {
  const f = fixture(); t.after(f.cleanup);
  const crypto = controlledFingerprints(t), owner = f.owner();
  const pending = Array.from({ length: 9 }, (_, index) => deriveSecretFingerprint('TEST-fill-' + index));
  await assert.rejects(owner.execute(command), { code: 'busy' });
  assert.deepEqual([...f.store.list()], []);
  assert.equal(f.count(), 0);
  for (let index = 0; index < pending.length; index++) crypto.finish();
  await Promise.all(pending);
  assert.equal((await owner.execute({ ...lookup, commandId: 'TEST-after-saturation',
    providerId: command.providerId, kind: 'credential.forget' })).phase, 'completed');
});

test('replay rereads completed progress after hashing and lookup/pending never enqueue crypto work', async t => {
  const f = fixture(); t.after(f.cleanup);
  const crypto = controlledFingerprints(t), entered = Promise.withResolvers<void>();
  const native = Promise.withResolvers<{ ok: boolean; settled: boolean }>();
  f.setEffect(() => { entered.resolve(); return native.promise; });
  const owner = f.owner(), first = owner.execute(command);
  crypto.finish(); await entered.promise;
  const resumed = owner.resume(command);
  assert.equal(owner.lookup(lookup)?.phase, 'held');
  assert.equal(owner.pending({ profileId: command.profileId, configRevision: command.configRevision,
    providerId: command.providerId })?.phase, 'held');
  native.resolve({ ok: true, settled: true });
  const completed = await first, bytes = readFileSync(f.files()[0]!);
  crypto.finish();
  assert.deepEqual(await resumed, completed);
  assert.deepEqual(readFileSync(f.files()[0]!), bytes);
  assert.equal(f.count(), 1);
});

test('execute replay and retained resume refuse identity or currentness changes across their await', async t => {
  const crypto = controlledFingerprints(t);
  for (const method of ['execute', 'resume'] as const) for (const fault of ['salt', 'fingerprint', 'target', 'revoked'] as const) {
    const f = fixture(); t.after(f.cleanup);
    const owner = f.owner(), first = owner.execute(command);
    crypto.finish(); await first;
    const resumed = owner[method](command);
    const saved: StoredManagementCommand = f.store.read(command.commandId)!;
    assert.equal(saved.kind, 'credential.set');
    if (fault === 'salt' && saved.kind === 'credential.set')
      f.store.write({ ...saved, fingerprintKdf: { version: 1, salt: 'f'.repeat(32) } });
    if (fault === 'fingerprint') f.store.write({ ...saved, fingerprint: 'e'.repeat(64) });
    if (fault === 'target') f.changeSelection();
    if (fault === 'revoked') f.revoke();
    const bytes = readFileSync(f.files()[0]!);
    crypto.finish(); await assert.rejects(resumed);
    assert.deepEqual(readFileSync(f.files()[0]!), bytes);
    assert.equal(f.count(), 1);
  }
});

test('claim write that commits then throws retains the live and cold namespace hold without rewriting or performing', async t => {
  const f = fixture(); t.after(f.cleanup);
  const storage: CredentialCommandStore = { read: id => f.store.read(id), list: () => f.store.list(),
    write(record) { f.store.write(record); throw new Error('TEST directory fsync failed after rename'); } };
  const owner = f.owner(storage);
  await assert.rejects(owner.execute(command), /fsync failed after rename/);
  const path = f.files()[0]!, bytes = readFileSync(path);
  assert.equal(f.store.read(command.commandId)?.phase, 'claimed');
  assert.equal(f.store.read(command.commandId)?.resourceHeld, true);
  const next = { ...lookup, commandId: 'TEST-after-uncertain-write',
    providerId: command.providerId, kind: 'credential.forget' };
  await assert.rejects(owner.execute(next), { code: 'held' });
  const cold = f.owner();
  assert.equal((await cold.resume(command)).phase, 'held');
  await assert.rejects(cold.execute(next), { code: 'held' });
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(f.count(), 0);
});

test('credential mutation persists before native action and replay/restart returns the receipt without secrets or redispatch', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const first = await f.owner().execute(command);
  assert.equal(first.phase, 'completed');
  const resumed = f.owner();
  assert.deepEqual(await resumed.execute(command), first);
  assert.deepEqual(resumed.lookup(lookup), first);
  assert.equal(f.count(), 1);
  await assert.rejects(resumed.execute({ ...command, key: 'TEST-different' }), {
    code: 'conflict',
  });
  assert.equal(f.count(), 1);
  const serialized = f
    .files()
    .map((path) => {
      assert.equal(statSync(path).mode & 0o077, 0);
      return readFileSync(path, 'utf8');
    })
    .join('\n');
  for (const value of [command.key, 'TEST-private-metadata']) {
    assert.equal(serialized.includes(value), false);
    assert.equal(JSON.stringify(first).includes(value), false);
  }
  assert.deepEqual(
    Object.keys(first).sort(),
    ['commandId', 'profileId', 'configRevision', 'providerId', 'kind', 'phase'].sort()
  );
  f.changeSelection();
  await assert.rejects(resumed.execute(command), { code: 'conflict' });
  assert.throws(() => resumed.lookup(lookup), { code: 'conflict' });
});

test('one credential namespace serializes native writers; uncertain writer blocks new IDs after restart', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let finish!: (result: { ok: boolean; settled: boolean }) => void;
  const entered = Promise.withResolvers<void>();
  f.setEffect(
    () =>
      new Promise((done) => {
        finish = done;
        entered.resolve();
      })
  );
  const owner = f.owner(),
    pending = owner.execute(command);
  await entered.promise;
  assert.equal(f.count(), 1);
  const next = { ...command, commandId: 'TEST-next' };
  await assert.rejects(owner.execute(next), { code: 'busy' });
  assert.equal((await owner.execute(command)).phase, 'held');
  assert.equal(f.count(), 1);
  finish({ ok: false, settled: false });
  assert.equal((await pending).phase, 'held');
  const restarted = f.owner();
  assert.equal((await restarted.execute(command)).phase, 'held');
  await assert.rejects(restarted.execute(next), { code: 'held' });
  assert.equal(f.count(), 1);
});

test('original pending credentials survive cold lookup without replay; only explicit rejection plus cleanup permits a fresh intent', async (t) => {
  const pending = { profileId: command.profileId, configRevision: command.configRevision, providerId: command.providerId };
  for (const rejected of [false, true]) {
    const f = fixture();
    t.after(f.cleanup);
    f.setEffect(async () => ({ ok: false, settled: true, ...(rejected ? { rejected: true } : {}) }));
    const first = await f.owner().execute(command);
    const cold = f.owner();
    assert.equal(first.phase, 'held');
    assert.deepEqual(cold.pending(pending), rejected ? null : first);
    assert.deepEqual(await cold.resume(command), first);
    await assert.rejects(cold.resume({ ...command, key: 'TEST-changed-key' }), { code: 'conflict' });
    await assert.rejects(cold.resume({ ...command, commandId: 'TEST-never-claimed' }), { code: 'conflict' });
    assert.equal(f.count(), 1);
    if (rejected) {
      f.setEffect(async () => ({ ok: true, settled: true }));
      assert.equal((await cold.execute({ ...command, commandId: 'TEST-new-explicit-intent' })).phase, 'completed');
      assert.equal(cold.pending(pending), null);
      assert.equal(f.count(), 2);
    } else {
      f.changeSelection();
      assert.throws(() => cold.pending(pending), { code: 'conflict' });
      await assert.rejects(cold.resume(command), { code: 'conflict' });
      assert.equal(f.count(), 1);
    }
  }
});

test('publication loss never resubmits a completed native effect; a confirmed settled writer permits a separate later intent', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const failing: CredentialCommandStore = {
    read: (id) => f.store.read(id),
    list: () => f.store.list(),
    write(record) {
      if (record.phase === 'completed') throw new Error('TEST final publication loss');
      f.store.write(record);
    },
  };
  const receipt = await f.owner(failing).execute(command);
  assert.equal(receipt.phase, 'held');
  const restarted = f.owner();
  assert.deepEqual(await restarted.execute(command), receipt);
  assert.equal(f.count(), 1);
  assert.equal(f.store.read(command.commandId)?.resourceHeld, false);
  const forgotten = await restarted.execute({
    commandId: 'TEST-forget',
    profileId: command.profileId,
    configRevision: command.configRevision,
    providerId: command.providerId,
    kind: 'credential.forget',
  });
  assert.equal(forgotten.phase, 'completed');
  assert.equal(f.count(), 2);
});

test('late native reply after writer revocation does not publish over the retained claim', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.setEffect(async () => {
    f.revoke();
    return { ok: true, settled: true };
  });
  assert.equal((await f.owner().execute(command)).phase, 'held');
  assert.equal(f.store.read(command.commandId)?.phase, 'claimed');
  assert.equal(f.store.read(command.commandId)?.resourceHeld, true);
});

test('corrupt, public or symlinked credential receipts refuse recovery without resetting state', async (t) => {
  for (const fault of ['corrupt', 'mode', 'symlink', 'directory'] as const) {
    const f = fixture();
    t.after(f.cleanup);
    await f.owner().execute(command);
    const path = f.files()[0]!;
    if (fault === 'corrupt')
      writeFileSync(path, readFileSync(path, 'utf8').replace('"completed"', '"held"'), {
        mode: 0o600,
      });
    if (fault === 'mode') chmodSync(path, 0o644);
    if (fault === 'symlink') {
      const other = join(f.root, 'TEST-other');
      renameSync(path, other);
      symlinkSync(other, path);
    }
    if (fault === 'directory') {
      renameSync(join(f.root, 'management-commands'), join(f.root, 'TEST-moved'));
      mkdirSync(join(f.root, 'management-commands'), { mode: 0o700 });
    }
    assert.throws(() => f.owner());
    assert.equal(f.count(), 1);
  }
});

test('credential refresh is admitted once and a changed original selection cannot publish success', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const refresh: CredentialCommand = { ...lookup, providerId: 'codex', kind: 'credential.refresh' };
  const owner = f.owner();
  f.setEffect(async () => {
    f.changeSelection();
    return { ok: true, settled: true };
  });
  assert.equal((await owner.execute(refresh)).phase, 'held');
  assert.equal(f.count(), 1);
  await assert.rejects(owner.execute(refresh), /Provider management command conflict/);
  assert.equal(f.count(), 1, 'unknown original mutation is not resent with the changed binding');
});

test('unsupported credential actions reject before a journal claim or a native call', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const owner = new CredentialCommandOwner({
    store: f.store,
    select: () => target,
    assertCurrent() {},
    validate() {
      throw new Error('TEST unsupported before admission');
    },
    async perform() {
      assert.fail('no native effect');
    },
  });
  await assert.rejects(
    owner.execute({ ...lookup, providerId: 'codex', kind: 'credential.refresh' }),
    /unsupported before admission/
  );
  assert.equal(f.store.read(lookup.commandId), undefined);
});


test('refresh reuse is durable across aliases/restarts, never extends rotation age, and logout or a different namespace cannot reuse it', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let effects = 0;
  const owner = () => new CredentialCommandOwner({
    store: f.store,
    assertCurrent() {},
    select(profileId, configRevision) {
      return { ...target, profileId, configRevision,
        resourceId: profileId === 'TEST-independent' ? 'd'.repeat(64) : target.resourceId };
    },
    async perform() {
      effects++;
      return { ok: true, settled: true };
    },
  });
  const refresh = (profileId: string, commandId: string) => ({
    profileId, configRevision: 'TEST-config', commandId, providerId: 'codex',
    kind: 'credential.refresh' as const, reuseWindowMs: 30_000,
  });
  assert.equal((await owner().execute(refresh('TEST-A', 'TEST-first'))).phase, 'completed');
  t.mock.timers.tick(10_000);
  const aliased = refresh('TEST-B', 'TEST-alias');
  assert.equal((await owner().execute(aliased)).phase, 'completed');
  assert.equal(effects, 1, 'same native namespace reuses the original rotation after Host restart');
  assert.equal(f.store.read('TEST-alias')?.profileId, 'TEST-B', 'receipt retains its own selection');
  t.mock.timers.setTime(90_000);
  await owner().execute(refresh('TEST-B', 'TEST-clock-rollback'));
  assert.equal(effects, 1, 'wall-clock rollback must not force an immediate second rotation');
  t.mock.timers.setTime(131_000);
  await owner().execute(refresh('TEST-A', 'TEST-expired'));
  assert.equal(effects, 2, 'a reused receipt must not extend the original rotation window');
  await owner().execute({ profileId: 'TEST-B', configRevision: 'TEST-config',
    commandId: 'TEST-logout', providerId: 'codex', kind: 'credential.forget' });
  await owner().execute(refresh('TEST-A', 'TEST-after-logout'));
  assert.equal(effects, 4, 'logout through an alias invalidates all same-namespace reuse');
  await owner().execute(refresh('TEST-independent', 'TEST-other-namespace'));
  assert.equal(effects, 5);
});
