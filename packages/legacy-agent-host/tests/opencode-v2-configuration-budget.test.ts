import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import * as configurationSelection from '../dist/composition/openCodeSelectedProviderConfiguration.js';

import type { TestContext } from 'node:test';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';

const limit = 256 * 1024;
const selection = { providerId: 'TEST-provider', modelId: 'TEST-first' };
const invalid = { reason: 'configuration-invalid' };

function fixture(
  t: TestContext,
  models: Record<string, unknown>,
  baseline?: NonNullable<OpenCodeManagementProfile['embedded']>['providerConfiguration']
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-catalog-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'project'), xdg = join(root, 'xdg');
  for (const directory of [home, project, xdg]) mkdirSync(directory);
  const path = join(project, 'opencode.json');
  writeFileSync(path, JSON.stringify({ provider: { [selection.providerId]: { models } } }), { mode: 0o600 });
  const input = { cwd: project, environment: { HOME: home, XDG_CONFIG_HOME: xdg } };
  const original = readFileSync(path, 'utf8');
  const source = captureOpenCodeConfigurationSource(input);
  const profile: OpenCodeManagementProfile = {
    ...input,
    provider: 'opencode', profileId: 'TEST-profile', accountBinding: 'TEST-account',
    configRevision: 'TEST-revision', executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:12345', timeoutMs: 1000,
    nativeGeneration: 'v2', protocolRevision: '2.1.4', nativeModel: selection,
    embedded: {
      version: '2.1.4', directory: root, manifestSha256: 'b'.repeat(64),
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny',
      configurationSource: source.reference,
      ...(baseline ? { providerConfiguration: baseline } : {}),
    },
  };
  let current = true;
  return {
    original,
    bytes: () => readFileSync(path, 'utf8'),
    revoke: () => { current = false; },
    capture: (purpose: 'model' | 'catalog' = 'catalog') =>
      captureOpenCodeV2Configuration(profile, selection, () => current, purpose),
  };
}

test('catalog refuses an oversized normalized prefix before expanding later models', () => {
  let laterReads = 0;
  const environment = {
    TEST_CHUNK: 'x'.repeat(64 * 1024),
    get TEST_LATER() { laterReads++; return 'TEST later model'; },
  };
  const config = {
    provider: {
      [selection.providerId]: {
        models: {
          'TEST-first': { name: '{env:TEST_CHUNK}{env:TEST_CHUNK}' },
          'TEST-second': { name: '{env:TEST_CHUNK}{env:TEST_CHUNK}' },
          'TEST-later': { name: '{env:TEST_LATER}' },
        },
      },
    },
  };
  for (const modelId of ['TEST-first', 'TEST-second']) {
    const single = configurationSelection.selectOpenCodeV2ProviderConfiguration(config, { ...selection, modelId }, environment);
    assert.ok(Buffer.byteLength(JSON.stringify(single.configuration)) < limit);
  }
  const before = JSON.stringify(config);
  assert.throws(() => configurationSelection.selectOpenCodeV2CatalogConfiguration(config, selection, environment), invalid);
  assert.equal(laterReads, 0, 'no later model expansion may follow a known oversized prefix');
  assert.equal(JSON.stringify(config), before);
});

test('catalog keeps original selected-key validation ahead of model expansion', () => {
  let modelReads = 0;
  const environment = {
    get TEST_MODEL() { modelReads++; return 'TEST model'; },
  };
  const config = { provider: { [selection.providerId]: {
    options: { apiKey: '{env:TEST_MISSING}' },
    models: { 'TEST-first': { name: '{env:TEST_MODEL}' } },
  } } };
  assert.throws(() => configurationSelection.selectOpenCodeV2CatalogConfiguration(config, selection, environment), invalid);
  assert.equal(modelReads, 0);
});

test('captured catalogs retain special own model keys and the original baseline metadata', t => {
  const models = Object.fromEntries([
    ['TEST-first', { name: 'TEST first' }],
    ['__proto__', { name: 'TEST own proto model' }],
    ['constructor', { name: 'TEST own constructor model' }],
    ['toString', { name: 'TEST own string model' }],
  ]);
  const baseline = {
    package: 'aisdk:TEST-baseline',
    settings: { baseURL: 'https://example.invalid/v1' },
    models: { 'TEST-baseline': { name: 'TEST retained baseline' } },
  };
  const f = fixture(t, models, baseline);
  const captured = f.capture();
  assert.deepEqual(captured.configuration, {
    ...baseline, models: { ...baseline.models, ...models },
  });
  const actual = captured.configuration?.models;
  assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual));
  for (const key of Object.keys(models)) assert.equal(Object.hasOwn(actual, key), true, key);
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal(f.bytes(), f.original);
  assert.equal(captured.isCurrent(), true);
  f.revoke();
  assert.equal(captured.isCurrent(), false);
});

test('the actual merged catalog preserves the exact UTF8 JSON limit and refuses its next byte', t => {
  const second = 'TEST-"quoted\\model-水';
  for (const unit of ['x', '水', '\u0001']) {
    const empty = { models: { 'TEST-first': { name: '' }, [second]: { name: '' } } };
    const remaining = limit - Buffer.byteLength(JSON.stringify(empty));
    const width = Buffer.byteLength(JSON.stringify(unit)) - 2;
    const fill = (size: number) => unit.repeat(Math.floor(size / width)) + 'x'.repeat(size % width);
    const firstLength = Math.floor(remaining / 2);
    const models = {
      'TEST-first': { name: fill(firstLength) },
      [second]: { name: fill(remaining - firstLength) },
    };
    const expected = { models };
    assert.equal(Buffer.byteLength(JSON.stringify(expected)), limit);
    const accepted = fixture(t, models), captured = accepted.capture();
    assert.deepEqual(captured.configuration, expected);
    assert.equal(Buffer.byteLength(JSON.stringify(captured.configuration)), limit);
    assert.equal(accepted.bytes(), accepted.original);

    const excessive = fixture(t, {
      ...models, [second]: { name: models[second]!.name + 'x' },
    });
    assert.throws(() => excessive.capture(), invalid);
    assert.equal(excessive.bytes(), excessive.original);
  }
});

test('ordinary model capture still ignores unrelated catalog entries', t => {
  const f = fixture(t, {
    'TEST-first': { name: 'TEST selected only' },
    'TEST-unselected': { unsupported: 'TEST invalid unselected declaration' },
  });
  assert.deepEqual(f.capture('model').configuration, {
    models: { 'TEST-first': { name: 'TEST selected only' } },
  });
  assert.throws(() => f.capture('catalog'), invalid);
  assert.equal(f.bytes(), f.original);
});

test('selected-key expansion stops before reading the remaining oversized replacements', () => {
  const chunk = 'x'.repeat(64 * 1024);
  let reads = 0;
  const environment = { get TEST_KEY() { reads++; return chunk; } };
  assert.throws(() => configurationSelection.selectOpenCodeV2ConfigurationKey('{env:TEST_KEY}'.repeat(129), environment), invalid);
  assert.equal(reads, 5, 'the fifth legal environment value exceeds 256 KiB before joining the result');
});

test('selected keys retain their original UTF16 limit and separate literal file rules', () => {
  // This is the selection contract; the actual credential scope keeps its separate byte limit.
  const key = '漢'.repeat(64 * 1024);
  assert.equal(key.length, 64 * 1024);
  assert.equal(Buffer.byteLength(key), 192 * 1024);
  assert.deepEqual(configurationSelection.selectOpenCodeV2ConfigurationKey('{env:TEST_KEY}', { TEST_KEY: key }), { apiKey: key });
  assert.throws(() => configurationSelection.selectOpenCodeV2ConfigurationKey('{env:TEST_KEY}x', { TEST_KEY: key }), invalid);
  assert.deepEqual(configurationSelection.selectOpenCodeV2ConfigurationKey(undefined, {}), {});
  const file = '{file:TEST-original-credential}';
  assert.deepEqual(configurationSelection.selectOpenCodeV2ConfigurationKey(file, {}), { apiKeyFile: file });
  for (const [raw, environment] of [
    ['{env:MISSING}', {}],
    ['{env:TEST_KEY}', { TEST_KEY: 'TEST\0key' }],
    ['{env:TEST_KEY}', { TEST_KEY: file }],
    [file + '\n', {}],
    [{ apiKey: 'TEST-invalid-type' }, {}],
  ] as const) assert.throws(() => configurationSelection.selectOpenCodeV2ConfigurationKey(raw, environment), invalid);
});
