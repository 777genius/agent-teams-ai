import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { captureOpenCodeV2SessionCredential } from '../dist/adapters/providers/OpenCodeV2SessionCredential.js';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';
import {
  mapOpenCodeV2SelectedModel,
  selectOpenCodeV2ProviderConfiguration,
} from '../dist/composition/openCodeSelectedProviderConfiguration.js';

function fixture(t: { after(cleanup: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-config-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    project = join(root, 'project'),
    xdg = join(root, 'xdg');
  for (const path of [home, project, xdg]) mkdirSync(path);
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  };
  const input = {
    cwd: project,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      OPENCODE_CONFIG: join(root, 'explicit.json'),
      OPENCODE_CONFIG_CONTENT:
        '{"provider":{"TEST-local":{"models":{"TEST-model":{"name":"inline"}}}}}',
    },
  };
  return { root, home, project, xdg, input, write };
}

test('captured OpenCode config keeps donor precedence and stores only original source identities', (t) => {
  const f = fixture(t);
  f.write(join(f.home, '.config/opencode/opencode.json'), {
    model: 'TEST-local/TEST-model',
    provider: {
      'TEST-local': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'TEST-private-key' },
        models: { 'TEST-model': { name: 'canonical', limit: { context: 20000, output: 1000 } } },
      },
    },
  });
  f.write(join(f.xdg, 'opencode/opencode.jsonc'), {
    provider: { 'TEST-local': { models: { 'TEST-model': { name: 'xdg' } } } },
  });
  f.write(f.input.environment.OPENCODE_CONFIG, {
    provider: {
      'TEST-local': { models: { 'TEST-model': { name: 'explicit', limit: { output: 128 } } } },
    },
  });
  f.write(join(f.project, 'opencode.jsonc'), {
    provider: { 'TEST-local': { models: { 'TEST-model': { name: 'project' } } } },
  });
  let current = true;
  const captured = captureOpenCodeConfigurationSource(f.input, undefined, () => current);
  assert.deepEqual(captured.read(), {
    model: 'TEST-local/TEST-model',
    provider: {
      'TEST-local': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'TEST-private-key' },
        models: { 'TEST-model': { name: 'project', limit: { context: 20000, output: 128 } } },
      },
    },
  });
  assert.equal(captured.reference.files.length, 7);
  assert.ok(!JSON.stringify(captured.reference).includes('TEST-private-key'));
  assert.equal(
    captureOpenCodeConfigurationSource(f.input, captured.reference).digest,
    captured.digest
  );
  const global = captureOpenCodeConfigurationSource(f.input, undefined, () => true, 'global');
  assert.equal(global.reference.files.length, 5);
  assert.equal(
    captureOpenCodeConfigurationSource({ ...f.input, cwd: f.home }, global.reference).digest,
    global.digest,
    'global sources cannot import the caller project'
  );
  assert.throws(
    () => captureOpenCodeConfigurationSource({ ...f.input, cwd: f.home }, captured.reference),
    { reason: 'configuration-changed' }
  );
  const data = join(f.root, 'data'), auth = join(data, 'opencode', 'auth.json');
  mkdirSync(data, { mode: 0o700 });
  const selection = { providerId: 'TEST-local', modelId: 'TEST-model' };
  const profile: OpenCodeManagementProfile = {
    ...f.input, environment: { ...f.input.environment, XDG_DATA_HOME: data },
    provider: 'opencode', profileId: 'TEST-profile', accountBinding: 'TEST-account',
    configRevision: 'TEST-revision', executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:12345', timeoutMs: 1000,
    nativeGeneration: 'v2', protocolRevision: '2.1.4', nativeModel: selection,
    embedded: { version: '2.1.4', directory: f.root, manifestSha256: 'b'.repeat(64),
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny',
      configurationSource: captured.reference },
  };
  const writeKey = (key: string) => f.write(auth, { 'TEST-local': { type: 'api', key } });
  writeKey('TEST-conflicting-key');
  assert.throws(() => captureOpenCodeV2Configuration(profile, selection, () => current),
    { reason: 'configuration-invalid' });
  writeKey('TEST-private-key');
  const configuration = captureOpenCodeV2Configuration(profile, selection, () => current);
  const session = captureOpenCodeV2SessionCredential(profile, selection.providerId, configuration.isCurrent);
  assert.equal(session.isCurrent(), true);
  writeKey('TEST-replaced-key');
  assert.equal(configuration.isCurrent(), false, 'explicit config key keeps its original auth witness');
  assert.equal(session.isCurrent(), false, 'session current includes the captured config/key guard');
  writeKey('TEST-private-key');
  assert.equal(configuration.isCurrent(), true);

  const running = captureOpenCodeV2Configuration(profile, selection, () => current);
  running.bindRunningSession();
  const runningSession = captureOpenCodeV2SessionCredential(profile, selection.providerId, running.isCurrent);
  f.write(join(f.project, 'opencode.jsonc'), {
    provider: { 'TEST-local': { models: { 'TEST-model': { name: 'next-capture' } } } },
  });
  assert.equal(configuration.isCurrent(), false, 'unbound capture still checks original source bytes');
  assert.equal(session.isCurrent(), false);
  assert.equal(running.isCurrent(), true, 'running capture retains its original private config');
  assert.equal(runningSession.isCurrent(), true);
  current = false;
  assert.equal(running.isCurrent(), false, 'binding the config never removes owner authority');
  assert.equal(runningSession.isCurrent(), false);
  assert.equal(captured.isCurrent(), false);
  assert.throws(captured.read, { reason: 'configuration-changed' });
});

test('new or replaced config invalidates its original reference; malformed JSONC is never an empty success', (t) => {
  const f = fixture(t);
  const original = captureOpenCodeConfigurationSource(f.input);
  const path = join(f.project, 'opencode.json');
  f.write(path, { model: 'TEST-local/TEST-next' });
  assert.equal(original.isCurrent(), false);
  assert.throws(() => captureOpenCodeConfigurationSource(f.input, original.reference), {
    reason: 'configuration-changed',
  });
  const next = captureOpenCodeConfigurationSource(f.input);
  assert.equal(next.read().model, 'TEST-local/TEST-next');
  writeFileSync(path, '{"provider":{},"provider":{}}', { mode: 0o600 });
  assert.equal(next.isCurrent(), false);
  assert.throws(() => captureOpenCodeConfigurationSource(f.input), {
    reason: 'configuration-invalid',
  });
  writeFileSync(path, '{invalid JSONC', { mode: 0o600 });
  assert.throws(() => captureOpenCodeConfigurationSource(f.input), {
    reason: 'configuration-invalid',
  });
  if (process.platform !== 'win32') {
    const first = join(f.root, 'linked-A.json'), second = join(f.root, 'linked-B.json');
    f.write(first, { model: 'TEST-local/TEST-linked' });
    f.write(second, { model: 'TEST-local/TEST-linked' });
    rmSync(path);
    symlinkSync(first, path);
    const linked = captureOpenCodeConfigurationSource(f.input);
    assert.equal(linked.read().model, 'TEST-local/TEST-linked');
    rmSync(path);
    symlinkSync(second, path);
    assert.equal(linked.isCurrent(), false, 'same bytes at a new link target do not preserve original identity');
    assert.throws(() => captureOpenCodeConfigurationSource(f.input, linked.reference), {
      reason: 'configuration-changed',
    });
    rmSync(path);
    linkSync(first, path);
    assert.equal(captureOpenCodeConfigurationSource(f.input).read().model, 'TEST-local/TEST-linked');
  }
});

test('selected V2 declaration preserves alias, limits, variant body and captured environment without importing another model', () => {
  const selected = selectOpenCodeV2ProviderConfiguration(
    {
      provider: {
        'TEST-provider': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: '{env:TEST_KEY}' },
          models: {
            'TEST-model': {
              id: 'TEST-upstream',
              name: 'TEST selected',
              tool_call: true,
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 32000, output: 128 },
              headers: { 'x-test-selected': '${TEST_HEADER}' },
              variants: [{ id: 'high', body: { reasoning_effort: 'high' } }],
            },
            'TEST-unselected': {
              mystery: true,
              headers: { authorization: '{file:/TEST-foreign}' },
            },
          },
        },
        'TEST-other': { options: { apiKey: '{env:TEST_MISSING}' } },
      },
    },
    { providerId: 'TEST-provider', modelId: 'TEST-model' },
    { TEST_KEY: 'TEST-private-key', TEST_HEADER: 'TEST-original-header' }
  );
  assert.equal(selected.apiKey, 'TEST-private-key');
  assert.deepEqual(selected.configuration, {
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:12345/v1' },
    models: {
      'TEST-model': {
        modelID: 'TEST-upstream',
        name: 'TEST selected',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 32000, output: 128 },
        headers: { 'x-test-selected': 'TEST-original-header' },
        variants: [{ id: 'high', body: { reasoning_effort: 'high' } }],
      },
    },
  });
  assert.ok(!JSON.stringify(selected.configuration).includes('TEST-private-key'));
  assert.deepEqual(
    mapOpenCodeV2SelectedModel('TEST-model', { variants: { high: { reasoningEffort: 'high' } } }),
    { 'TEST-model': { variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] } }
  );
});

test('incompatible selected aliases and native declaration fields are refused without normalizing away intent', () => {
  for (const declaration of [
    { id: 'TEST-A', modelID: 'TEST-B' },
    { npm: '@ai-sdk/openai', package: '@ai-sdk/openai' },
    { limit: { context: 'unbounded' } },
    { capabilities: { tools: false } },
    { variants: { high: { disabled: true } } },
    { variants: [{ id: 'high' }, { id: 'high' }] },
    { mystery: true },
  ])
    assert.throws(() => mapOpenCodeV2SelectedModel('TEST-model', declaration), {
      reason: 'configuration-invalid',
    });
});
