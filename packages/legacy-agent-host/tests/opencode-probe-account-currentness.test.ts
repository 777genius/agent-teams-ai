import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { captureOpenCodeProbeAccount } from '../dist/composition/prepareTeamModelReadiness.js';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';
import type { TestContext } from 'node:test';

const providerId = 'TEST-provider', modelId = 'TEST-model';

function fixture(t: TestContext, configured: boolean, sourcesPresent = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-probe-account-currentness-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), data = join(root, 'data'), cwd = join(root, 'workspace'), xdg = join(root, 'config');
  for (const path of [home, data, cwd, xdg, join(data, 'opencode')]) mkdirSync(path, { mode: 0o700 });
  const configPath = join(cwd, 'opencode.json'), authPath = join(data, 'opencode', 'auth.json');
  const config = JSON.stringify({ provider: { [providerId]: {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'http://127.0.0.1:12345/v1', ...(configured ? { apiKey: 'TEST-config-key' } : {}) },
    models: { [modelId]: { name: modelId } },
  } } });
  if (sourcesPresent) {
    writeFileSync(configPath, config, { mode: 0o600 });
    writeFileSync(authPath, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-auth-key' } }), { mode: 0o600 });
  }
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode', profileId: 'TEST-probe-account', configRevision: 'TEST-probe-account-revision',
    cwd, accountBinding: 'TEST-account', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    environment: { HOME: home, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: data },
    executable: { path: process.execPath, sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:12345',
    timeoutMs: 5000, nativeModel: { providerId, modelId },
    embedded: { version: '2.1.4', directory: root, manifestSha256: 'b'.repeat(64),
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny',
      ...(!sourcesPresent ? { providerConfiguration: { package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'TEST-baseline-key' },
        models: { [modelId]: { name: modelId } } } } : {}) },
  };
  profile.embedded!.configurationSource = captureOpenCodeConfigurationSource(profile).reference;
  let current = true, ownerReads = 0;
  const account = captureOpenCodeProbeAccount(profile, { providerId, modelId }, () => { ownerReads++; return current; });
  assert.ok(account);
  return { root, config, configPath, authPath, profile, account, revoke: () => { current = false; },
    ownerReads: () => ownerReads, resetOwnerReads: () => { ownerReads = 0; } };
}

function observeReads(t: TestContext, configPath: string, authPath: string) {
  const original = fs.openSync;
  const reads = { configuration: 0, authentication: 0 };
  const observed = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === configPath) reads.configuration++;
    if (args[0] === authPath) reads.authentication++;
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { observed.mock.restore(); syncBuiltinESMExports(); });
  return reads;
}

test('V2 account currentness observes an already-bound configuration key once per fresh call', t => {
  const f = fixture(t, true);
  const configuration = captureOpenCodeV2Configuration(f.profile, { providerId, modelId }, () => true);
  assert.ok(configuration.key);
  assert.equal(configuration.key.isCurrent, configuration.isCurrent,
    'the nominal configuration key carries the exact same freshness callback');
  const reads = observeReads(t, f.configPath, f.authPath);
  for (let call = 1; call <= 2; call++) {
    assert.equal(f.account.isCurrent(), true);
    assert.deepEqual(reads, { configuration: 2 * call, authentication: call },
      'each call reopens the source and selected auth; its bound callback is not repeated without an intervening operation');
  }
});

test('V2 account currentness separately observes the fallback auth key and its source fences', t => {
  const f = fixture(t, false);
  const configuration = captureOpenCodeV2Configuration(f.profile, { providerId, modelId }, () => true);
  assert.equal(configuration.key, undefined);
  const reads = observeReads(t, f.configPath, f.authPath);
  for (let call = 1; call <= 2; call++) {
    assert.equal(f.account.isCurrent(), true);
    assert.deepEqual(reads, { configuration: 2 * call, authentication: call },
      'the separate fallback key retains its own before/after configuration checks');
  }
  writeFileSync(f.authPath, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-rotated-key' } }), { mode: 0o600 });
  assert.equal(f.account.isCurrent(), false, 'fallback auth cannot borrow configuration freshness');
});

test('V2 baseline configuration with absent source files and auth keeps both fresh source-owner fences', t => {
  const f = fixture(t, false, false);
  const reference = f.profile.embedded!.configurationSource!;
  assert.equal(reference.files.length, 6);
  assert.ok(reference.files.every(file => !fs.existsSync(file.path)));
  assert.equal(reference.inlineDigest, null);
  assert.equal(fs.existsSync(f.authPath), false);
  const configuration = captureOpenCodeV2Configuration(f.profile, { providerId, modelId }, () => true);
  assert.equal(configuration.key, undefined, 'a baseline key is not a selected source key');
  const reads = observeReads(t, f.configPath, f.authPath);
  f.resetOwnerReads();
  for (let call = 1; call <= 2; call++) {
    assert.equal(f.account.isCurrent(), true);
    assert.equal(f.ownerReads(), 4 * call, 'source capture checks its owner before and after each side of the auth read');
    assert.deepEqual(reads, { configuration: 0, authentication: 0 });
  }
  writeFileSync(f.authPath, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-later-key' } }), { mode: 0o600 });
  assert.equal(f.account.isCurrent(), false, 'original absence cannot accept a newly published auth key');
});

for (const mutation of ['owner', 'configuration'] as const) {
  test(`V2 fallback account rejects ${mutation} revocation during the original auth read`, t => {
    const f = fixture(t, false);
    const originalOpen = fs.openSync, originalRead = fs.readSync;
    let authFd: number | undefined, mutations = 0;
    const opening = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(originalOpen, fs, args);
      if (args[0] === f.authPath) authFd = fd;
      return fd;
    });
    const reading = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(originalRead, fs, args);
      if (args[0] === authFd && count > 0 && mutations === 0) {
        mutations++;
        if (mutation === 'owner') f.revoke();
        else {
          const replacement = join(f.root, 'replacement.json');
          writeFileSync(replacement, f.config, { mode: 0o600 });
          renameSync(replacement, f.configPath);
        }
      }
      return count;
    });
    syncBuiltinESMExports();
    t.after(() => { opening.mock.restore(); reading.mock.restore(); syncBuiltinESMExports(); });
    assert.equal(f.account.isCurrent(), false, 'the closing source-owner fence observes changes after the opening fence');
    assert.equal(mutations, 1, 'the mutation follows the real auth read, after all opening checks');
  });
}

for (const configured of [true, false]) {
  for (const mutation of ['owner', 'auth', 'configuration'] as const) {
    test(`V2 ${configured ? 'configured' : 'fallback'} account reobserves ${mutation} revocation on the next call`, t => {
      const f = fixture(t, configured);
      assert.equal(f.account.isCurrent(), true);
      if (mutation === 'owner') f.revoke();
      else if (mutation === 'auth') {
        writeFileSync(f.authPath, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-rotated-key' } }), { mode: 0o600 });
      } else {
        const replacement = join(f.root, 'replacement.json');
        writeFileSync(replacement, f.config, { mode: 0o600 });
        renameSync(replacement, f.configPath);
      }
      assert.equal(f.account.isCurrent(), false, 'no previous successful observation authorizes changed inputs');
    });
  }
}
