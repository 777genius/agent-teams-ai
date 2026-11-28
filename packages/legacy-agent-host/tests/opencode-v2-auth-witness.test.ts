import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';
import { OpenCodeV2ManagementHost } from '../dist/adapters/providers/OpenCodeV2ManagementHost.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { managementDigest } from '../dist/management/identity.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';
import { deriveSecretFingerprint, secretFingerprintKdfSchema } from '../dist/management/secretFingerprint.js';
import type { OpenCodeV2KeyOperation } from '../dist/adapters/providers/OpenCodeV2ManagementHost.js';
import type { StoredCredentialCommand } from '../dist/management/commandRecords.js';
import type { createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';

const work = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TEST timeout: ' + description)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'TEST finite native/crypto barrier');
    await turn();
  }
}

function fixture(t: TestContext, existing?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-auth-witness-')));
  const profile = openCodeManagementProfileSchema.parse({
    provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    profileId: 'TEST-profile', configRevision: 'TEST-config', accountBinding: 'TEST-account',
    cwd: root, executable: { path: join(root, 'TEST-no-native-binary'), sha256: 'a'.repeat(64) },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, root])), endpoint: 'http://127.0.0.1:19332', timeoutMs: 5000,
    nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
    embedded: { version: '2.1.4', platform: process.platform, arch: process.arch,
      directory: join(root, 'engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny' },
  });
  mkdirSync(join(root, 'opencode'), { mode: 0o700 });
  const authPath = join(root, 'opencode/auth.json');
  writeFileSync(authPath, JSON.stringify(existing === undefined ? {} : {
    'TEST-provider': { type: 'api', key: existing },
  }), { mode: 0o600 });
  const store = new FileManagementCommandStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = () => new OpenCodeV2CredentialScope(profile, 'TEST-provider', () => true).capture();
  const command = { profileId: profile.profileId, configRevision: profile.configRevision,
    commandId: 'TEST-original', providerId: 'TEST-provider', kind: 'credential.set' as const, key: 'x' };
  const bytes = () => readFileSync(join(root, 'management-commands', managementDigest(command.commandId) + '.json'), 'utf8');
  return { root, profile, store, scope, command, authPath, bytes };
}

function nativeBoundary(t: TestContext) {
  const calls = { admitted: 0, reads: 0, connected: 0, catalog: 0, rollback: 0, closed: 0, checked: 0 };
  const native: OpenCodeV2KeyOperation & { assertCurrent(): void } = {
    integrationId: 'TEST-provider',
    async read() { calls.reads++; return { integrationId: 'TEST-provider', name: 'TEST-provider', plainKey: true, connections: [] }; },
    async connectKey(key) { calls.connected++; assert.equal(key, 'x'); return { integrationId: 'TEST-provider', credentialId: 'cred_TEST' }; },
    async rollbackOwnedKey() { calls.rollback++; },
    async readCatalog() { calls.catalog++; throw new Error('TEST controlled stop before model probe'); },
    assertCurrent() { calls.checked++; },
  };
  t.mock.method(OpenCodeV2ManagementHost.prototype, 'keyOperation', async <T>(
    providerId: string, operation: (original: OpenCodeV2KeyOperation) => Promise<T>
  ): Promise<T> => { assert.equal(providerId, 'TEST-provider'); calls.admitted++; return operation(native); });
  t.mock.method(OpenCodeV2ManagementHost.prototype, 'close', async () => { calls.closed++; return true; });
  return calls;
}

function controlledWitnesses(t: TestContext) {
  const pending: { finished: boolean; finish(error?: Error): void }[] = [];
  t.mock.method(crypto, 'scrypt', (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input) && Buffer.isBuffer(salt));
    assert.equal(length, 32); assert.deepEqual(options, work);
    const finish = (error?: Error) => callback(error ?? null,
      error ? Buffer.alloc(32) : crypto.scryptSync(input, salt, length, work));
    if (!input.toString('utf8').includes('opencode-v2-auth-witness-v1')) { finish(); return; }
    const call = { finished: false, finish(error?: Error) {
      assert.equal(call.finished, false, 'one callback for the original derivation');
      call.finished = true; finish(error);
    } };
    pending.push(call);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    pending,
    async drain() {
      for (let count = 0; count < 12; count++) {
        for (const call of pending) if (!call.finished) call.finish();
        await turn();
      }
      assert.ok(pending.every(call => call.finished), 'no retained TEST crypto callback');
    },
  };
}

for (const existing of [undefined, 'x'] as const) {
  test('fresh auth witnesses protect short-key ' + (existing ? 'present' : 'absent') + ' before and published state', async t => {
    const f = fixture(t, existing), calls = nativeBoundary(t);
    const before = f.scope().digest;
    const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.root);
    try {
      const receipt = await bounded(owner.credentials.execute(f.command), 'original controlled Connect');
      assert.equal(receipt.phase, 'held', 'the TEST peer deliberately stops before probe');
      const saved = f.store.read(f.command.commandId);
      assert.ok(saved?.kind === 'credential.set' && saved.openCodeV2);
      const progress = saved.openCodeV2;
      assert.equal(progress.phase, 'key-published');
      const descriptor = secretFingerprintKdfSchema.parse(Reflect.get(progress, 'authWitnessKdf'));
      const vector = (digest: string) => crypto.scryptSync(JSON.stringify({ digest,
        kind: 'opencode-v2-auth-witness-v1' }), Buffer.from(descriptor.salt, 'hex'), 32, work).toString('hex');
      const after = f.scope().digest;
      assert.equal(progress.beforeAuthDigest, vector(before));
      assert.equal(progress.authDigest, vector(after));
      assert.notEqual(progress.beforeAuthDigest, before);
      assert.notEqual(progress.authDigest, after);
      assert.notDeepEqual(descriptor, saved.fingerprintKdf, 'command and auth witness have independent original salts');
      assert.equal(f.scope().readKey(), 'x');
      assert.equal(calls.admitted, 1); assert.equal(calls.connected, 1); assert.equal(calls.catalog, 1);
      assert.equal(calls.rollback, 0); assert.ok(calls.checked >= 1, 'after-proof checks the original native deadline');
      const bytes = f.bytes(), publicValue = JSON.stringify(receipt);
      for (const forbidden of [before, after, '"key"', '"x"']) assert.equal(bytes.includes(forbidden), false, forbidden);
      for (const forbidden of ['authWitnessKdf', descriptor.salt, progress.beforeAuthDigest, progress.authDigest!])
        assert.equal(publicValue.includes(forbidden), false);
    } finally { await owner.close().catch(() => {}); }
  });
}

for (const mode of ['seal', 'before-failure', 'after-failure', 'before-receipt-drift', 'after-receipt-drift'] as const) {
  test('registered auth witness ' + mode + ' has no late native effect or invented rejection', async t => {
    const f = fixture(t), calls = nativeBoundary(t), cryptoControl = controlledWitnesses(t);
    const before = readFileSync(f.authPath, 'utf8');
    const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.root);
    let finished = false;
    const run = owner.credentials.execute(f.command).finally(() => { finished = true; });
    void run.catch(() => {});
    let replaced: string | undefined;
    const replaceReceipt = () => {
      const original = f.store.read(f.command.commandId);
      assert.ok(original?.kind === 'credential.set');
      f.store.write({ ...original, phase: 'held', resourceHeld: true });
      replaced = f.bytes();
    };
    try {
      await until(() => cryptoControl.pending.length >= 1 || finished);
      assert.equal(cryptoControl.pending.length, 1, 'before proof is awaited inside the registered operation');
      assert.equal(calls.admitted, 0, 'no native allocation before before-proof completion');
      if (mode === 'seal') {
        owner.seal();
        cryptoControl.pending[0]!.finish();
      } else if (mode === 'before-failure') cryptoControl.pending[0]!.finish(new Error('TEST crypto failure'));
      else if (mode === 'before-receipt-drift') { replaceReceipt(); cryptoControl.pending[0]!.finish(); }
      else {
        cryptoControl.pending[0]!.finish();
        await until(() => cryptoControl.pending.length >= 2 || finished);
        assert.equal(cryptoControl.pending.length, 2);
        assert.equal(calls.connected, 1); assert.equal(calls.catalog, 0);
        assert.equal(f.scope().readKey(), 'x', 'native connect and actual auth publication already succeeded');
        if (mode === 'after-receipt-drift') { replaceReceipt(); cryptoControl.pending[1]!.finish(); }
        else cryptoControl.pending[1]!.finish(new Error('TEST after-publication crypto failure'));
      }
      const receipt = await bounded(run, 'settle original operation');
      assert.equal(receipt.phase, 'held');
      const saved = f.store.read(f.command.commandId);
      assert.ok(saved?.kind === 'credential.set');
      assert.notEqual(saved.terminalRejection, true);
      if (mode.startsWith('after-')) {
        assert.equal(saved.openCodeV2?.phase, 'key-connected');
        assert.equal(f.scope().readKey(), 'x', 'failed witness does not undo confirmed auth publication');
        assert.equal(calls.connected, 1);
      } else {
        assert.equal(saved.openCodeV2, undefined);
        assert.equal(readFileSync(f.authPath, 'utf8'), before);
        assert.equal(calls.admitted, 0); assert.equal(calls.connected, 0);
      }
      assert.equal(calls.catalog, 0); assert.equal(calls.rollback, 0);
      if (replaced !== undefined) assert.equal(f.bytes(), replaced, 'late proof and catch never overwrite a changed original');
    } finally {
      await cryptoControl.drain(); await bounded(Promise.allSettled([run]), 'drain original run');
      await owner.close().catch(() => {});
    }
  });
}

type CatalogClient = Pick<ReturnType<typeof createOpenCodeV2OwnedSessionClient>,
  'identity' | 'builtinPluginsOnly' | 'savedPermissionsEmpty' | 'readMcp' | 'readDirectory' | 'dispose'>;

function catalogBoundary(t: TestContext, f: ReturnType<typeof fixture>, dispose: () => Promise<void> = async () => {}) {
  const calls: { directory: number; disposed: number; signal?: AbortSignal } = { directory: 0, disposed: 0 };
  const client: CatalogClient = {
    async identity() { return { pid: 1234, version: '2.1.4' }; },
    async builtinPluginsOnly() { return true; }, async savedPermissionsEmpty() { return true; },
    async readMcp() { return []; },
    async readDirectory() {
      calls.directory++;
      return { providers: ['TEST-provider', 'TEST-second'].map(id => ({ id, name: id, activation: 'enabled' as const })),
        models: [], integrations: ['TEST-provider', 'TEST-second'].map(id => ({ id, name: id, plainKey: true })), defaultModel: null };
    },
    async dispose() { calls.disposed++; await dispose(); },
  };
  // Replace only the existing native transport acquisition. Public catalog projection,
  // captured auth, Coordinator receipt selection and all post-await guards remain real.
  const original = new OpenCodeV2ManagementHost(f.profile, () => true);
  const prototype = Object.getPrototypeOf(original);
  assert.equal(typeof Reflect.get(prototype, 'nativeClient'), 'function');
  t.mock.method(prototype, 'nativeClient', async (signal: AbortSignal, deadline: number) => {
    calls.signal = signal;
    return { client, ready: { pid: 1234 }, config: { endpoint: f.profile.endpoint,
      directory: f.profile.cwd, version: '2.1.4', signal, deadline,
      readPassword: () => 'TEST-finite-peer-password',
      fetchImpl: async () => { assert.fail('TEST catalog and deadline guards cannot issue credential requests'); },
    } };
  });
  return calls;
}

function retainedSuccess(f: ReturnType<typeof fixture>, owner: ProviderManagementCoordinator,
  providerId: string, legacy: boolean): StoredCredentialCommand {
  const commandId = 'TEST-retained-' + providerId;
  const source = new OpenCodeV2CredentialScope(f.profile, providerId, () => true).capture();
  const descriptor = { version: 1 as const, salt: 'c'.repeat(32) };
  const witness = legacy ? source.digest : crypto.scryptSync(JSON.stringify({ digest: source.digest,
    kind: 'opencode-v2-auth-witness-v1' }), Buffer.from(descriptor.salt, 'hex'), 32, work).toString('hex');
  const record: StoredCredentialCommand = {
    schemaVersion: 1, ...owner.readinessTarget(f.profile), commandId, kind: 'credential.set', providerId,
    fingerprint: managementDigest({ ...f.command, commandId, providerId, key: source.readKey() }),
    phase: 'completed', resourceHeld: false, finishedAtMs: 1000,
    openCodeV2: { phase: 'probe-completed', integrationId: providerId,
      nativeNamespace: managementDigest({ profile: f.profile, commandId }),
      beforeAuthDigest: witness, authDigest: witness, ...(!legacy ? { authWitnessKdf: descriptor } : {}),
      credentialId: 'cred_TEST', verification: { commandId: 'TEST-probe-' + providerId,
        modelId: providerId + '/TEST-model', ok: true } },
  };
  f.store.write(record);
  return record;
}

function catalogFixture(t: TestContext) {
  const f = fixture(t);
  // Neither earlier provider is the configured provider: its independent global
  // configuration guard cannot accidentally stand in for the earlier proof guard.
  f.profile.nativeModel = { providerId: 'TEST-unconfigured-default', modelId: 'TEST-model' };
  writeFileSync(f.authPath, JSON.stringify({ 'TEST-provider': { type: 'api', key: 'x' },
    'TEST-second': { type: 'api', key: 'y' } }), { mode: 0o600 });
  const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.root);
  const request = { profileId: f.profile.profileId, configRevision: f.profile.configRevision };
  return { ...f, owner, request };
}

for (const legacy of [true, false]) {
  test('public catalog matches ' + (legacy ? 'legacy' : 'protected') + ' originals without journal or auth writes', async t => {
    const f = catalogFixture(t), calls = catalogBoundary(t, f);
    const records = ['TEST-provider', 'TEST-second'].map(id => retainedSuccess(f, f.owner, id, legacy));
    const auth = readFileSync(f.authPath, 'utf8');
    const journals = records.map(row => readFileSync(join(f.root, 'management-commands', managementDigest(row.commandId) + '.json'), 'utf8'));
    try {
      const result = await bounded(f.owner.catalog(f.request), 'read-only original catalog');
      assert.deepEqual(result.providers.map(row => [row.providerId, row.connected]), [['TEST-provider', true], ['TEST-second', true]]);
      assert.equal(calls.directory, 1); assert.equal(calls.disposed, 1);
      assert.equal(readFileSync(f.authPath, 'utf8'), auth);
      records.forEach((row, index) => assert.equal(readFileSync(join(f.root, 'management-commands', managementDigest(row.commandId) + '.json'), 'utf8'), journals[index]));
      const publicValue = JSON.stringify(result);
      for (const row of records) for (const privateValue of [row.openCodeV2!.authDigest!, 'authWitnessKdf', 'beforeAuthDigest', '"x"', '"y"'])
        assert.equal(publicValue.includes(privateValue), false);
    } finally { await f.owner.close(); }
  });
}

for (const drift of ['none', 'earlier-receipt', 'earlier-auth', 'dispose-receipt', 'dispose-auth',
  'deadline-after-proof', 'deadline-after-dispose'] as const) {
  test('catalog protected proofs are sequential and recheck ' + drift + ' after the final await', async t => {
    const f = catalogFixture(t);
    const earlier = retainedSuccess(f, f.owner, 'TEST-provider', false);
    retainedSuccess(f, f.owner, 'TEST-second', false);
    const originalBytes = readFileSync(join(f.root, 'management-commands', managementDigest(earlier.commandId) + '.json'), 'utf8');
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    let replacement: string | undefined;
    const mutate = () => {
      if (drift.endsWith('receipt')) {
        f.store.write({ ...earlier, finishedAtMs: 1001 });
        replacement = readFileSync(join(f.root, 'management-commands', managementDigest(earlier.commandId) + '.json'), 'utf8');
      } else writeFileSync(f.authPath, JSON.stringify({ 'TEST-provider': { type: 'api', key: 'z' },
        'TEST-second': { type: 'api', key: 'y' } }), { mode: 0o600 });
    };
    const calls = catalogBoundary(t, f, async () => {
      if (drift.startsWith('dispose-')) mutate();
      if (drift === 'deadline-after-dispose') clock += f.profile.timeoutMs + 1;
    });
    const secondDigest = new OpenCodeV2CredentialScope(f.profile, 'TEST-second', () => true).capture().digest;
    const originalCapture = OpenCodeV2CredentialScope.prototype.capture, captures: string[] = [];
    t.mock.method(OpenCodeV2CredentialScope.prototype, 'capture', function (this: OpenCodeV2CredentialScope) {
      const source = originalCapture.call(this);
      captures.push(source.digest);
      return source;
    });
    const controlled = controlledWitnesses(t);
    let finished = false;
    const read = f.owner.catalog(f.request).finally(() => { finished = true; });
    void read.catch(() => {});
    try {
      await until(() => controlled.pending.length === 1 || finished);
      assert.equal(controlled.pending.length, 1, 'first provider starts exactly one witness');
      await turn(); assert.equal(captures.includes(secondDigest), false, 'second provider is not captured or queued before first proof settles');
      assert.equal(calls.disposed, 0);
      controlled.pending[0]!.finish();
      await until(() => controlled.pending.length === 2 || finished);
      assert.equal(controlled.pending.length, 2);
      assert.equal(captures.includes(secondDigest), true);
      if (drift.startsWith('earlier-')) mutate();
      if (drift === 'deadline-after-proof') clock += f.profile.timeoutMs + 1;
      assert.equal(calls.signal?.aborted, false, 'TEST uses the original clock deadline before its abort timer fires');
      controlled.pending[1]!.finish();
      if (drift === 'none') assert.deepEqual((await bounded(read, 'complete protected catalog')).providers.map(row => row.connected), [true, true]);
      else await assert.rejects(bounded(read, 'reject stale earlier catalog proof'), { code: 'held' });
      assert.equal(calls.disposed, 1);
      const bytes = readFileSync(join(f.root, 'management-commands', managementDigest(earlier.commandId) + '.json'), 'utf8');
      assert.equal(bytes, replacement ?? originalBytes, 'a read never rewrites original or changed receipts');
    } finally {
      await controlled.drain(); await bounded(Promise.allSettled([read]), 'drain catalog');
      await f.owner.close().catch(() => {});
    }
  });
}

test('native key operation rejects its expired original deadline after KDF before the abort timer fires', async t => {
  const f = fixture(t), calls = catalogBoundary(t, f), controlled = controlledWitnesses(t);
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const host = new OpenCodeV2ManagementHost(f.profile, () => true, undefined, { retainedCommandId: 'TEST-deadline' });
  let finished = false;
  const run = host.keyOperation('TEST-provider', async native => {
    await deriveSecretFingerprint({ kind: 'opencode-v2-auth-witness-v1', digest: f.scope().digest });
    native.assertCurrent();
    assert.fail('an expired original cannot continue to key publication');
  }).finally(() => { finished = true; });
  void run.catch(() => {});
  try {
    await until(() => controlled.pending.length === 1 || finished);
    assert.equal(controlled.pending.length, 1, 'actual native callback reached the finite derivation');
    clock += f.profile.timeoutMs + 1;
    assert.equal(calls.signal?.aborted, false);
    controlled.pending[0]!.finish();
    await assert.rejects(bounded(run, 'expired key operation'), { code: 'held' });
    assert.equal(calls.disposed, 1);
  } finally {
    await controlled.drain(); await bounded(Promise.allSettled([run]), 'drain expired key operation');
    await host.close();
  }
});
