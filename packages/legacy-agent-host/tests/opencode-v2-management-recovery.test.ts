import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenCodeV2ManagementHost } from '../dist/adapters/providers/OpenCodeV2ManagementHost.js';
import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { managementDigest } from '../dist/management/identity.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';

function testProfile(root: string) {
  return openCodeManagementProfileSchema.parse({
    provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    profileId: 'TEST-profile', configRevision: 'TEST-config', accountBinding: 'TEST-account',
    cwd: root, executable: { path: join(root, 'TEST-bun'), sha256: 'a'.repeat(64) },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, root])),
    endpoint: 'http://127.0.0.1:19332', timeoutMs: 1000,
    nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
    embedded: { version: '2.1.4', platform: process.platform, arch: process.arch,
      directory: join(root, 'engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny' },
  });
}

test('only the same account rejected publication admits corrected Connect across source revisions', async t => {
  let admissions = 0;
  t.mock.method(OpenCodeV2ManagementHost.prototype, 'keyOperation', async () => {
    admissions++;
    throw new Error('TEST ends at original native admission; no native connection is simulated');
  });
  for (const scenario of ['same-account', 'account-changed', 'home-changed', 'key-changed', 'later-success', 'unknown'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-key-revision-')));
    const profile = testProfile(root), store = new FileManagementCommandStore(root);
    const directories = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(key => {
      const path = profile.environment[key]!, stat = statSync(path);
      return [key, { path, dev: stat.dev, ino: stat.ino }];
    }));
    const target = { profileId: profile.profileId, configRevision: profile.configRevision,
      selectionDigest: managementDigest({ profile, directories }), resourceId: managementDigest(directories.XDG_DATA_HOME) };
    let accepted = false;
    // Controlled native progress goes through the real command owner, validator, private auth publication and journal.
    const originalOwner = new CredentialCommandOwner({ store, assertCurrent() {},
      select: () => target,
      async perform(command, _target, progress) {
        if (command.kind !== 'credential.set') throw new Error('TEST only sets its own key');
        const scope = new OpenCodeV2CredentialScope(profile, command.providerId, () => true);
        const publication = scope.prepare(command.key);
        const base = { integrationId: 'TEST-integration', nativeNamespace: managementDigest({ profile, commandId: command.commandId }),
          beforeAuthDigest: publication.before.digest };
        progress({ ...base, phase: 'key-intent' });
        const connected = { ...base, credentialId: 'cred_TEST' };
        progress({ ...connected, phase: 'key-connected' });
        const published = { ...connected, authDigest: publication.publish().digest };
        progress({ ...published, phase: 'key-published' });
        const verification = { commandId: 'TEST-verify-' + command.commandId, modelId: 'TEST-provider/TEST-model' };
        progress({ ...published, phase: 'probe-intent', verification });
        progress({ ...published, phase: 'probe-completed', verification: { ...verification, ok: accepted } });
        return { ok: accepted, settled: true, ...(!accepted && scenario !== 'unknown' ? { rejected: true } : {}) };
      },
    });
    const originalCommand = { profileId: profile.profileId, configRevision: profile.configRevision,
      providerId: 'TEST-provider', commandId: 'TEST-rejected', kind: 'credential.set' as const, key: 'TEST-rejected-key' };
    const originalReceipt = await originalOwner.execute(originalCommand);
    const originalRecord = store.read(originalCommand.commandId);
    const selected = { ...profile, profileId: 'runtime-source:' + 'c'.repeat(64), configRevision: 'c'.repeat(64) };
    if (scenario === 'account-changed') selected.accountBinding = 'TEST-other-account';
    if (scenario === 'home-changed') {
      const home = join(root, 'TEST-other-home'); mkdirSync(home, { mode: 0o700 });
      selected.environment = { ...profile.environment, HOME: home };
    }
    if (scenario === 'key-changed') writeFileSync(join(root, 'opencode/auth.json'),
      JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-independent-key' } }), { mode: 0o600 });
    if (scenario === 'later-success') {
      accepted = true;
      assert.equal((await originalOwner.execute({ ...originalCommand, commandId: 'TEST-later-success' })).phase, 'completed');
    }
    // A cold Coordinator restores the original retained profile alongside the newly selected source profile.
    const owner = new ProviderManagementCoordinator([profile, selected], () => {}, root);
    admissions = 0;
    try {
      const command = { ...originalCommand, profileId: selected.profileId, configRevision: selected.configRevision,
        commandId: 'TEST-new-explicit-connect', key: scenario === 'unknown' ? originalCommand.key : 'TEST-corrected-key' };
      if (scenario === 'same-account') {
        assert.equal((await owner.credentials.execute(command)).phase, 'held', 'TEST stops before any native effect');
        assert.equal(admissions, 1, 'both validation and effect admission preserve original rejection authority');
      } else {
        await assert.rejects(owner.credentials.execute(command), { code: scenario === 'unknown' ? 'conflict' : 'held' });
        assert.equal(admissions, 0, scenario);
      }
      assert.deepEqual(owner.credentials.lookup({ profileId: profile.profileId, configRevision: profile.configRevision,
        commandId: originalCommand.commandId }), originalReceipt);
      assert.deepEqual(store.read(originalCommand.commandId), originalRecord, 'new source never rewrites the original receipt');
      assert.equal(new OpenCodeV2CredentialScope(profile, originalCommand.providerId, () => true).capture().readKey(),
        scenario === 'key-changed' ? 'TEST-independent-key' : originalCommand.key);
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('overlapping V2 status and directory reads preserve the active owner and original deadlines', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-catalog-overlap-')));
  const profile = testProfile(root);
  const originalFailure = new Error('TEST original read failed');
  const catalog = { profileId: profile.profileId, configRevision: profile.configRevision,
    configuredDefaultModelId: null, providers: [] };
  const calls: { host: OpenCodeV2ManagementHost; deadline: number | undefined }[] = [];
  const closed = new Set<OpenCodeV2ManagementHost>();
  let clock = Date.now(), pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let closing: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const closeEntered = Promise.withResolvers<void>();
  let fail = false;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(OpenCodeV2ManagementHost.prototype, 'catalog', async function (
    this: OpenCodeV2ManagementHost, _providerId?: string, _includeModels?: boolean, deadline?: number
  ) {
    calls.push({ host: this, deadline });
    const gate = pending.promise, rejected = fail;
    entered.resolve();
    await gate;
    assert.equal(closed.has(this), false, 'a mode change cannot close a pending native read');
    if (rejected) throw originalFailure;
    return catalog;
  });
  t.mock.method(OpenCodeV2ManagementHost.prototype, 'close', async function (this: OpenCodeV2ManagementHost) {
    closed.add(this);
    if (closing) { closeEntered.resolve(); await closing.promise; }
    return true;
  });
  const owner = new ProviderManagementCoordinator([profile], () => {}, root);
  const request = { profileId: profile.profileId, configRevision: profile.configRevision };
  try {
    const admittedAt = clock;
    const status = owner.catalog({ ...request, includeModels: true });
    await entered.promise;
    const directory = owner.catalog(request);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(closed.size, 0);
    clock += 50;
    pending.resolve();
    assert.deepEqual(await Promise.all([status, directory]), [catalog, catalog]);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0]!.host, calls[1]!.host);
    assert.deepEqual(calls.map(call => call.deadline), [admittedAt + profile.timeoutMs, admittedAt + profile.timeoutMs],
      'queue wait does not reset the original native read budget');

    pending = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>(); fail = true;
    const failing = owner.catalog(request);
    const rejected = assert.rejects(failing, error => error === originalFailure);
    await entered.promise;
    const afterFailure = owner.catalog({ ...request, includeModels: true });
    fail = false;
    pending.resolve();
    await rejected;
    assert.deepEqual(await afterFailure, catalog, 'a failed predecessor does not poison later reads');
    assert.notEqual(calls[2]!.host, calls[3]!.host);

    pending = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
    const active = owner.catalog({ ...request, includeModels: true });
    await entered.promise;
    const expired = owner.catalog(request);
    const expiry = assert.rejects(expired, /held/);
    clock += profile.timeoutMs;
    pending.resolve();
    await active; await expiry;
    assert.equal(calls.length, 5, 'an expired queued request cannot allocate or read another owner');

    closing = Promise.withResolvers<void>();
    const revoking = owner.catalog(request);
    const revoked = assert.rejects(revoking, /unavailable/);
    await closeEntered.promise;
    const queued = owner.catalog({ ...request, includeModels: true }), sealed = assert.rejects(queued, /unavailable/);
    owner.seal();
    closing.resolve();
    await revoked; await sealed;
    assert.equal(calls.length, 5, 'seal during original cleanup prevents replacement and queued native reads');
  } finally {
    pending.resolve();
    closing?.resolve();
    await owner.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cleanup of ['confirmed', 'unknown', 'rejected'] as const) {
  test(`a failed V2 catalog retires only after ${cleanup} original cleanup`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-catalog-recovery-')));
    const profile = testProfile(root);
    const seen: OpenCodeV2ManagementHost[] = [], sealed = new Set<OpenCodeV2ManagementHost>();
    const originalFailure = new Error('TEST original catalog deadline');
    const catalog = { profileId: profile.profileId, configRevision: profile.configRevision,
      configuredDefaultModelId: null, providers: [] };
    t.mock.method(OpenCodeV2ManagementHost.prototype, 'catalog', async function (this: OpenCodeV2ManagementHost) {
      seen.push(this);
      if (seen.length === 1) { sealed.add(this); throw originalFailure; }
      if (sealed.has(this)) throw new Error('TEST retained owner is sealed');
      return catalog;
    });
    t.mock.method(OpenCodeV2ManagementHost.prototype, 'close', async function (this: OpenCodeV2ManagementHost) {
      sealed.add(this);
      if (cleanup === 'rejected') throw new Error('TEST cleanup unavailable');
      return cleanup === 'confirmed';
    });
    const owner = new ProviderManagementCoordinator([profile], () => {}, root);
    try {
      const request = { profileId: profile.profileId, configRevision: profile.configRevision };
      await assert.rejects(owner.catalog(request), error => error === originalFailure,
        'cleanup failure never replaces the original catalog error');
      if (cleanup === 'confirmed') {
        assert.deepEqual(await owner.catalog(request), catalog);
        assert.notEqual(seen[1], seen[0], 'a later request obtains a fresh owner after confirmed retirement');
        assert.deepEqual(await owner.catalog(request), catalog);
        assert.equal(seen[2], seen[1], 'a successful owner remains shared');
      } else {
        await assert.rejects(owner.catalog(request), /retained owner is sealed/);
        assert.equal(seen[1], seen[0], 'unknown cleanup never allocates a replacement owner');
      }
    } finally {
      await owner.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}
