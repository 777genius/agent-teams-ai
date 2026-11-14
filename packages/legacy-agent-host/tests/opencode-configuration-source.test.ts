import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, sep } from 'node:path';
import { test } from 'node:test';

import { captureOpenCodeReadinessOrigin, captureReadinessPreparation, originalReadinessSubset, readOpenCodeReadinessSource } from '../dist/adapters/providers/OpenCodeReadinessOrigin.js';
import { createOpenCodeLocalModelReadiness } from '../dist/adapters/providers/OpenCodeLocalModelReadiness.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { managementDigest } from '../dist/management/identity.js';
import type { LocalModelReadinessOrigin, ReadinessSourceReference } from '../dist/management/commandRecords.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { captureOpenCodeV2SessionCredential } from '../dist/adapters/providers/OpenCodeV2SessionCredential.js';
import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';
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

test('captured OpenCode config keeps donor precedence and stores only original source identities', async (t) => {
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
  assert.equal(captured.selectedKeyOrigin('TEST-local')?.kind, 'file');
  const keyOrigin = captured.selectedKeyOrigin('TEST-local');
  assert.ok(keyOrigin?.kind === 'file');
  assert.equal(keyOrigin.path, join(f.home, '.config/opencode/opencode.json'),
    'later model-only documents retain the actual original key leaf');
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
  const originalAuth = readFileSync(auth);
  const explicit = captureOpenCodeV2Configuration(profile, selection, () => current);
  assert.equal(explicit.key?.readKey(), 'TEST-private-key', 'original explicit config wins same-account plain auth');
  assert.deepEqual(readFileSync(auth), originalAuth, 'selecting a config key cannot rewrite auth');
  assert.notEqual(explicit.key?.digest, new OpenCodeV2CredentialScope(profile, selection.providerId, () => current).capture().digest);
  writeKey('TEST-private-key');
  const configuration = captureOpenCodeV2Configuration(profile, selection, () => current);
  assert.equal(configuration.key?.digest, new OpenCodeV2CredentialScope(profile, selection.providerId, () => current).capture().digest,
    'matching literal key retains the historical auth-only digest');
  const configuredKey = configuration.key;
  assert.ok(configuredKey);
  assert.throws(() => captureOpenCodeV2SessionCredential(profile, selection.providerId,
    configuration.isCurrent, { ...configuredKey }), { code: 'held' }, 'a structurally equal view has no provenance');
  assert.throws(() => captureOpenCodeV2SessionCredential(profile, selection.providerId,
    () => configuration.isCurrent(), configuredKey), { code: 'held' }, 'another configuration owner cannot borrow it');
  assert.throws(() => captureOpenCodeV2SessionCredential({ ...profile, accountBinding: 'TEST-foreign' }, selection.providerId,
    configuration.isCurrent, configuredKey), { code: 'held' });
  const session = captureOpenCodeV2SessionCredential(profile, selection.providerId, configuration.isCurrent, configuredKey);
  assert.equal(session.isCurrent(), true);
  writeKey('TEST-replaced-key');
  assert.equal(configuration.isCurrent(), false, 'explicit config key keeps its original auth witness');
  assert.equal(session.isCurrent(), false, 'session current includes the captured config/key guard');
  writeKey('TEST-private-key');
  assert.equal(configuration.isCurrent(), true);

  const running = captureOpenCodeV2Configuration(profile, selection, () => current);
  running.bindRunningSession();
  const runningSession = captureOpenCodeV2SessionCredential(profile, selection.providerId, running.isCurrent, running.key);
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

  const origins = fixture(t), originGlobal = join(origins.home, '.config/opencode/opencode.json');
  origins.write(originGlobal, { provider: { 'TEST-local': { options: { apiKey: 'TEST-same' } } } });
  origins.write(origins.input.environment.OPENCODE_CONFIG, { provider: { 'TEST-local': { options: null } } });
  const originProject = join(origins.project, 'opencode.jsonc');
  origins.write(originProject, { provider: { 'TEST-local': { options: { baseURL: 'http://127.0.0.1/v1' } } } });
  assert.equal(captureOpenCodeConfigurationSource(origins.input).selectedKeyOrigin('TEST-local'), undefined,
    'replacing an ancestor cannot retain a historical key origin');
  origins.write(originProject, { provider: { 'TEST-local': { options: { apiKey: 'TEST-same' } } } });
  const replacedOrigin = captureOpenCodeConfigurationSource(origins.input).selectedKeyOrigin('TEST-local');
  assert.ok(replacedOrigin?.kind === 'file'); assert.equal(replacedOrigin.path, originProject,
    'an equal later key value still belongs to its own actual source leaf');

  for (const mode of ['absolute', 'legacy', 'env', 'wrong-provider', 'wrong-config', 'missing',
    'empty', 'oversize', 'utf8', 'hardlink', 'inline', 'manual', 'relative',
    ...(process.platform === 'win32' ? [] : ['symlink'])]) {
    const v = fixture(t), leaf = join(v.project, 'opencode.jsonc'), dataRoot = join(v.root, 'data');
    mkdirSync(dataRoot, { mode: 0o700 });
    const owned = join(v.home, '.config/opencode/agent-teams-credentials');
    mkdirSync(owned, { recursive: true, mode: 0o700 });
    const scopePath = mode === 'wrong-config' ? join(v.project, 'other.json') : leaf;
    const provider = mode === 'wrong-provider' ? 'TEST-other' : selection.providerId;
    const filename = provider + '-' + createHash('sha256').update(scopePath).digest('hex').slice(0, 16) +
      (mode === 'absolute' ? '-12345678-1234-4123-8123-123456789abc' : '') + '.key';
    const file = join(owned, filename), keyValue = 'TEST-managed-original';
    if (mode !== 'missing') writeFileSync(file,
      mode === 'empty' ? ' \n' : mode === 'oversize' ? Buffer.alloc(65537, 65)
        : mode === 'utf8' ? Buffer.from([0xff]) : '  ' + keyValue + '\n', { mode: 0o600 });
    if (mode === 'hardlink') linkSync(file, file + '.linked');
    if (mode === 'symlink') {
      const target = join(v.root, 'target.key'); writeFileSync(target, keyValue, { mode: 0o600 });
      rmSync(file); symlinkSync(target, file);
    }
    const reference = mode === 'legacy' ? '{file:~/.config/opencode/agent-teams-credentials/' + filename + '}'
      : mode === 'manual' ? '{file:/TEST-never-read-this-key}'
        : mode === 'relative' ? '{file:' + filename + '}' : '{file:' + file + '}';
    const declaration = { provider: { [selection.providerId]: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: mode === 'env' ? '{env:TEST_KEY}' : reference } } } };
    const environment = { ...v.input.environment, XDG_DATA_HOME: dataRoot, TEST_KEY: keyValue,
      ...(mode === 'inline' ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(declaration) } : {}) };
    if (mode !== 'inline') v.write(leaf, declaration);
    const keyProfile = { ...profile, ...v.input, environment, embedded: { ...profile.embedded! } };
    keyProfile.embedded.configurationSource = captureOpenCodeConfigurationSource(keyProfile).reference;
    const authPath = join(dataRoot, 'opencode/auth.json');
    v.write(authPath, { 'TEST-foreign': { type: 'api', key: 'TEST-unselected' },
      ...(mode === 'legacy' || mode === 'env' ? { [selection.providerId]: {
        type: 'api', key: mode === 'env' ? keyValue : 'TEST-different-primary' } } : {}) });
    const authBytes = readFileSync(authPath);
    const accepted = mode === 'absolute' || mode === 'legacy' || mode === 'env';
    if (!accepted) {
      assert.throws(() => captureOpenCodeV2Configuration(keyProfile, selection, () => true), { code: 'held' }, mode);
      assert.deepEqual(readFileSync(authPath), authBytes);
      continue;
    }
    const actual = captureOpenCodeV2Configuration(keyProfile, selection, () => true);
    assert.equal(actual.key?.readKey(), keyValue, mode);
    assert.equal(captureOpenCodeV2Configuration(keyProfile, selection, () => true).key?.digest, actual.key?.digest,
      'cold recapture of the unchanged source/key has the same private witness');
    if (mode === 'env') assert.equal(actual.key?.digest,
      new OpenCodeV2CredentialScope(keyProfile, selection.providerId, () => true).capture().digest,
      'matching resolved environment key preserves the historical digest');
    assert.equal(JSON.stringify(actual).includes(keyValue), false);
    if (mode === 'absolute') {
      let inputs = 0, closes = 0;
      const probe = createOpenCodeLocalModelReadiness(keyProfile, { commandId: 'TEST-managed-readiness',
        profileId: keyProfile.profileId, configRevision: keyProfile.configRevision, ...selection }, () => true, {
        ordinary: observe => ({ timeoutMs: 1000, run: async () => {
          observe({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:12345/v1' },
            credentialScopeDigest: actual.key!.digest }); inputs++; return true;
        }, close: async () => { closes++; return true; } }),
        coordination: () => { throw Error('TEST managed key cannot enter authless coordination'); },
        fetchImpl: async () => { throw Error('TEST managed key cannot fetch local metadata'); },
      });
      const cutoff = Date.now() + 900;
      try {
        assert.equal(await probe.run(t.signal, cutoff), true);
        assert.equal(probe.readiness?.()?.coordination, 'not-applicable'); assert.equal(inputs, 1);
      } finally { assert.equal(await probe.close(cutoff), true); assert.equal(closes, 1); }
    }
    actual.bindRunningSession();
    v.write(leaf, { model: 'TEST-local/TEST-next' });
    assert.equal(actual.isCurrent(), true, 'bound original key remains with config A');
    if (mode !== 'env') {
      writeFileSync(file, keyValue + '-changed', { mode: 0o600 });
      assert.equal(actual.isCurrent(), false, 'binding never discards the original file witness');
    }
    assert.deepEqual(readFileSync(authPath), authBytes);
  }
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
  assert.throws(() => selectOpenCodeV2ProviderConfiguration({ provider: { 'TEST-provider': {
    options: { apiKey: '{env:TEST_KEY}' },
  } } }, { providerId: 'TEST-provider', modelId: 'TEST-model' }, { TEST_KEY: '{file:/TEST-never-read}' }),
  { reason: 'configuration-invalid' }, 'an environment value cannot manufacture a file grant');
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

// A fixture reference is generated from complete local test files, independently of either bounded reader.
function readinessReference(path: string, root: string): ReadinessSourceReference {
  const directories: unknown[] = [];
  let directory = parsePath(path).root;
  for (const part of ['', ...dirname(path).slice(directory.length).split(sep).filter(Boolean)]) {
    if (part) directory = join(directory, part);
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, root, present: false, digest: managementDigest({ path, root, directories, missing: directory }) };
    }
    directories.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]);
  }
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, root, present: false, digest: managementDigest({ path, root, directories, missing: path }) };
  }
  return { path, root, present: true, digest: managementDigest({ path, root, directories,
    file: [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink],
    bytes: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }) };
}

test('original Main source, exact approval and whole-command commitment survive bounded grouped probes', async (t) => {
  const f = fixture(t), second = join(f.root, 'second');
  mkdirSync(second);
  const config = join(f.project, 'opencode.json'), approvals = join(f.root, 'private-network-approvals.json');
  const providerId = 'home-server', baseUrl = 'http://192.168.1.20:8080/v1';
  const policy = { providerId, baseUrl, preset: 'custom' as const, hasConfiguredApiKey: true };
  f.write(config, { provider: { [providerId]: { npm: '@ai-sdk/openai-compatible', options: {
    baseURL: baseUrl, apiKey: '{file:/TEST-never-read-this-secret}',
  } } } });
  const tuple = { configPath: config, providerId, baseUrl };
  f.write(approvals, { schemaVersion: 1, approvals: [tuple] });
  assert.equal(readOpenCodeReadinessSource(readinessReference(approvals, parsePath(approvals).root),
    131072, () => {}), readFileSync(approvals, 'utf8'), 'filesystem root retains its single separator');
  const otherPolicies = Array.from({ length: 96 }, (_, index) => ({ providerId: 'test-' + index,
    baseUrl: 'https://example.test/' + 'x'.repeat(900) + '/v1', preset: 'custom' as const, hasConfiguredApiKey: false }));
  f.write(join(second, 'opencode.json'), { provider: Object.fromEntries(otherPolicies.map(row => [row.providerId,
    { npm: '@ai-sdk/openai-compatible', options: { baseURL: row.baseUrl } }])) });
  const scope = (workspace: string, global: boolean, providers: typeof otherPolicies) => {
    const paths = global ? ['opencode.json', 'opencode.jsonc'].map(name => join(f.home, '.config', 'opencode', name))
      : ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].map(name => join(workspace, name));
    return { selectedPath: paths[0]!, invalid: false, sources: paths.map(path => readinessReference(path, global ? f.home : workspace)), providers };
  };
  const owner = { ownerId: 'TEST-owner' }, selection = { preparationId: 'TEST-preparation', workspaces: [f.project, second] };
  const origin: LocalModelReadinessOrigin = {
    schemaVersion: 1, kind: 'create', ownerDigest: managementDigest(owner), contextId: 'TEST-main-context',
    commandId: 'TEST-preparation', selectionDigest: managementDigest(selection),
    workspaces: [
      { path: f.project, project: scope(f.project, false, [policy]), global: scope(f.project, true, []) },
      { path: second, project: scope(second, false, otherPolicies), global: scope(second, true, []) },
    ], approval: { source: readinessReference(approvals, f.root), approved: [tuple] },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(origin)) > 64 * 1024);
  const subset = originalReadinessSubset(origin, f.project, providerId);
  assert.ok(Buffer.byteLength(JSON.stringify(subset)) < 64 * 1024);
  const captured = captureOpenCodeReadinessOrigin(subset, { cwd: f.project }, providerId, () => true);
  assert.equal(captured.privateNetworkApproved, true);
  assert.equal(captured.policy?.hasConfiguredApiKey, true);
  assert.equal(JSON.stringify(subset).includes('TEST-never-read-this-secret'), false);
  const expected = { kind: 'create' as const, owner, contextId: origin.contextId, commandId: origin.commandId,
    selection, workspaces: [f.project, second], anchorCommandId: 'TEST-first-probe', admittedAt: Date.now() };
  const prepared = captureReadinessPreparation({ origin, remainingMs: 90000 }, { ...expected, original: { present: false } });
  const store = new FileManagementCommandStore(f.root);
  const target = { profileId: 'TEST-Claude', configRevision: 'TEST-config', selectionDigest: 'a'.repeat(64), resourceId: 'b'.repeat(64) };
  let nativeCalls = 0;
  const options = { store, fence: new ManagementResourceFence(store.list()), assertWriter() {}, select: () => target,
    prepare: () => ({ timeoutMs: 180000, run: async () => { nativeCalls++; return true; }, close: async () => true }) };
  const probes = new ModelProbeOwner(options);
  const input = { commandId: expected.anchorCommandId, profileId: target.profileId, configRevision: target.configRevision,
    providerId: 'anthropic', modelId: 'TEST-model', context: 'c'.repeat(64) };
  const started = probes.startPrepared(input, () => true, { anchor: prepared.anchor });
  assert.ok(started.expiresAt > prepared.anchor.expiresAt, 'anchor does not shorten the non-OpenCode native timeout');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(probes.read({ commandId: input.commandId, profileId: input.profileId, configRevision: input.configRevision })?.phase, 'completed');
  assert.equal(nativeCalls, 1);
  const original = probes.readPreparation(input.commandId);
  assert.deepEqual(original.anchor, prepared.anchor);
  const equal = captureReadinessPreparation({ origin: structuredClone(origin), remainingMs: 90000 },
    { ...expected, admittedAt: Date.now() + 100, original });
  assert.deepEqual(equal.anchor, prepared.anchor, 'an equal replay cannot renew the original cutoff');
  const otherWorkspaceChanged = structuredClone(origin);
  otherWorkspaceChanged.workspaces[1]!.project.sources[0]!.digest = 'd'.repeat(64);
  assert.throws(() => captureReadinessPreparation({ origin: otherWorkspaceChanged, remainingMs: 90000 },
    { ...expected, original }), { code: 'held' });
  const cold = new ModelProbeOwner({ ...options, fence: new ManagementResourceFence(store.list()) });
  assert.deepEqual(cold.readPreparation(input.commandId), original);
  assert.equal(nativeCalls, 1, 'cold reference reads allocate nothing');
  const historical = { ...input, commandId: 'TEST-historical' };
  probes.start(historical);
  await new Promise<void>(resolve => setImmediate(resolve));
  const old = store.read(historical.commandId);
  assert.throws(() => captureReadinessPreparation({ origin, remainingMs: 90000 }, {
    ...expected, anchorCommandId: historical.commandId, original: probes.readPreparation(historical.commandId),
  }), { code: 'held' });
  assert.deepEqual(store.read(historical.commandId), old);
  const compiledTargets = [
    { workspace: f.project, providerId },
    { workspace: second, providerId: otherPolicies[0]!.providerId },
  ];
  const projectOnly = structuredClone(origin);
  for (const workspace of projectOnly.workspaces)
    workspace.global = { notConsulted: 'project-precedence' };
  const originalRecord = store.read(input.commandId);
  for (const candidate of [projectOnly, { ...origin, approval: { notConsulted: 'no-private-target' as const } }]) {
    assert.throws(() => captureReadinessPreparation({ origin: candidate, remainingMs: 90000 },
      { ...expected, targets: compiledTargets, original }), { code: 'held' },
    'an existing commitment cannot acquire either unconsulted arm');
    assert.deepEqual(store.read(input.commandId), originalRecord);
  }
  const newSelection = { ...selection, preparationId: 'TEST-new-preparation' };
  projectOnly.commandId = newSelection.preparationId;
  projectOnly.selectionDigest = managementDigest(newSelection);
  const fresh = { ...expected, selection: newSelection, commandId: projectOnly.commandId,
    anchorCommandId: 'TEST-new-first-probe', original: { present: false } };
  assert.throws(() => captureReadinessPreparation({ origin: projectOnly, remainingMs: 90000 }, fresh), { code: 'held' });
  assert.throws(() => captureReadinessPreparation({ origin: projectOnly, remainingMs: 90000 },
    { ...fresh, targets: compiledTargets.slice(0, 1) }), { code: 'held' }, 'a group cannot hide another workspace');
  assert.throws(() => captureReadinessPreparation({ origin: projectOnly, remainingMs: 90000 },
    { ...fresh, targets: [...compiledTargets, { workspace: second, providerId: 'missing-provider' }] }),
  { code: 'held' }, 'every compiled provider must be covered before an unconsulted arm is accepted');
  const projectOnlyPrepared = captureReadinessPreparation({ origin: projectOnly, remainingMs: 90000 },
    { ...fresh, targets: compiledTargets });
  assert.equal(projectOnlyPrepared.anchor.originDigest, managementDigest(projectOnly));
  assert.deepEqual(store.read(input.commandId), originalRecord, 'source validation does not rewrite or admit a probe');

  const dependency = fixture(t), dependencyConfig = join(dependency.project, 'opencode.json');
  const publicPolicy = { providerId, baseUrl: 'https://api.example.test/v1', preset: 'custom' as const, hasConfiguredApiKey: false };
  dependency.write(dependencyConfig, { provider: { [providerId]: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: publicPolicy.baseUrl } } } });
  const unusedGlobal = join(dependency.home, '.config', 'opencode', 'opencode.json');
  mkdirSync(dirname(unusedGlobal), { recursive: true });
  writeFileSync(unusedGlobal, Buffer.alloc(1024 * 1024 + 1));
  writeFileSync(join(dependency.root, 'unused-approvals.json'), Buffer.alloc(131073));
  const dependencyOrigin: LocalModelReadinessOrigin = { ...projectOnly,
    workspaces: [{ path: dependency.project, project: scope(dependency.project, false, [publicPolicy]),
      global: { notConsulted: 'project-precedence' } }], approval: { notConsulted: 'no-private-target' },
  };
  const independent = captureOpenCodeReadinessOrigin(dependencyOrigin, { cwd: dependency.project }, providerId, () => true);
  assert.equal(independent.policy?.baseUrl, publicPolicy.baseUrl);
  assert.equal(independent.privateNetworkApproved, false, 'unconsulted approval is never approval');
  const uncovered = structuredClone(dependencyOrigin);
  uncovered.workspaces[0]!.project.providers = [];
  assert.throws(() => captureOpenCodeReadinessOrigin(uncovered, { cwd: dependency.project }, providerId, () => true), { code: 'held' });
  dependency.write(dependencyConfig, { provider: {} });
  assert.equal(independent.isCurrent(), false, 'the consulted project identity remains mandatory');
  const profile: OpenCodeManagementProfile = { ...f.input, provider: 'opencode', profileId: 'TEST-profile',
    accountBinding: 'TEST-account', configRevision: 'TEST-revision', executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:12345', timeoutMs: 1000 };
  const probeInput = { ...input, profileId: profile.profileId,
    configRevision: profile.configRevision, providerId, modelId: 'TEST-model' };
  const refuse = (scope: LocalModelReadinessOrigin['workspaces'][number]['project']) => ({
    ...scope, selectedPath: null, invalid: true as const, selectorFailure: 'config-conflict' as const, providers: [],
  });
  const globalRefusal = structuredClone(subset);
  const originalGlobal = globalRefusal.workspaces[0]!.global;
  assert.ok('sources' in originalGlobal);
  globalRefusal.workspaces[0]!.global = refuse(originalGlobal);
  assert.equal(captureOpenCodeReadinessOrigin(globalRefusal, profile, providerId, () => true).invalid,
    false, 'a clean project provider keeps original precedence over a global selector refusal');
  const unavailable = structuredClone(globalRefusal);
  unavailable.workspaces[0]!.project = refuse(unavailable.workspaces[0]!.project);
  assert.ok('approved' in unavailable.approval);
  unavailable.approval.approved = [];
  const unknown = captureOpenCodeReadinessOrigin(unavailable, profile, providerId, () => true);
  assert.equal(unknown.invalid, true);
  assert.equal(unknown.policy, undefined);
  let ordinaryAdmissions = 0, ordinaryRuns = 0;
  const unused = { ordinary: () => {
    ordinaryAdmissions++;
    return { timeoutMs: 1000, run: async () => { ordinaryRuns++; return true; }, close: async () => true };
  }, coordination: () => { throw new Error('refused selector cannot authorize a challenge'); } };
  assert.throws(() => createOpenCodeLocalModelReadiness(profile, probeInput, () => true, unused,
    { ...subset, approval: { notConsulted: 'no-private-target' } }), { code: 'held' },
  'an unconsulted approval cannot authorize the source-declared native private URL');
  assert.throws(() => createOpenCodeLocalModelReadiness(profile, probeInput, () => true, unused, unavailable),
    { code: 'held' }, 'an unknown ID cannot hide the captured native private URL');
  assert.throws(() => createOpenCodeLocalModelReadiness(profile, { ...probeInput, providerId: 'ollama' },
    () => true, unused, unavailable), { code: 'held' }, 'known local IDs retain selector-error blocking');
  assert.equal(ordinaryAdmissions, 0, 'private refusal happens before even constructing the ordinary adapter');
  assert.equal(ordinaryRuns, 0, 'private refusal happens before the ordinary phase, not only before model input');
  const publicCloud = createOpenCodeLocalModelReadiness(profile, { ...probeInput, providerId: 'public-cloud' },
    () => true, { ordinary: observe => ({ timeoutMs: 1000, run: async () => {
      ordinaryRuns++;
      observe({ npm: '@ai-sdk/openai', options: { baseURL: 'https://api.example.test/v1', apiKey: 'TEST-native-key' } });
      return true;
    }, close: async () => true }), coordination: unused.coordination,
    fetchImpl: async () => { throw new Error('unknown public provider must not receive local metadata requests'); },
  }, unavailable);
  const cloudDeadline = Date.now() + 900;
  assert.equal(await publicCloud.run(new AbortController().signal, cloudDeadline), true);
  assert.equal(ordinaryRuns, 1);
  await publicCloud.close(cloudDeadline);
  let modelInputs = 0;
  const rejected = createOpenCodeLocalModelReadiness(profile, probeInput, () => true, {
    ordinary: observe => ({ timeoutMs: 1000, run: async () => {
      observe({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://192.168.1.21:8080/v1', apiKey: 'TEST-resolved-key' } });
      modelInputs++; return true;
    }, close: async () => true }),
    coordination: () => { throw new Error('keyed route cannot request an authless challenge'); },
  }, subset);
  const deadline = Date.now() + 900;
  await assert.rejects(rejected.run(new AbortController().signal, deadline), { code: 'held' });
  assert.equal(modelInputs, 0);
  await rejected.close(deadline);
  // Real original config/auth captures; only the ordinary adapter observation is synthetic.
  for (const mode of ['credential', 'missing-digest', 'null-digest', 'malformed-digest',
    'foreign-digest', 'auth-replaced', 'owner-revoked', 'wrong-url', 'unapproved-url',
    'authless', 'unexpected-digest', 'baseline', 'baseline-wrong-key',
    'baseline-foreign-provider', 'baseline-unbound-key'] as const) {
    const v = fixture(t), data = join(v.root, 'data'), nativeAuth = join(data, 'opencode/auth.json');
    mkdirSync(data, { mode: 0o700 });
    const baseline = mode.startsWith('baseline'), absent = baseline || mode === 'authless' || mode === 'unexpected-digest';
    const keyedPolicy = mode !== 'authless' && mode !== 'unexpected-digest';
    const url = keyedPolicy ? baseUrl : 'https://api.example.test/v1';
    const originalKey = 'TEST-original-V2-key';
    const nativeConfig = join(v.project, 'opencode.json'), approvalPath = join(v.root, 'approvals.json');
    v.write(nativeConfig, { provider: { [providerId]: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: url, ...(keyedPolicy ? { apiKey: originalKey } : {}) },
    } } });
    v.write(nativeAuth, { 'TEST-foreign': { type: 'api', key: 'TEST-unselected-key' },
      ...(!absent ? { [providerId]: { type: 'api', key: originalKey } } : {}) });
    const approved = mode === 'unapproved-url' || !keyedPolicy ? [] : [
      { configPath: nativeConfig, providerId, baseUrl: url },
    ];
    v.write(approvalPath, { schemaVersion: 1, approvals: approved });
    const originalScope = (global: boolean) => {
      const paths = global ? ['opencode.json', 'opencode.jsonc'].map(name => join(v.home, '.config/opencode', name))
        : ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
          .map(name => join(v.project, name));
      return { selectedPath: paths[0]!, invalid: false,
        sources: paths.map(path => readinessReference(path, global ? v.home : v.project)),
        providers: global ? [] : [{ providerId, baseUrl: url, preset: 'custom' as const, hasConfiguredApiKey: keyedPolicy }] };
    };
    const keyOrigin: LocalModelReadinessOrigin = { ...origin,
      selectionDigest: managementDigest({ preparationId: 'TEST-keyed-preparation', workspaces: [v.project] }),
      workspaces: [{ path: v.project, project: originalScope(false), global: originalScope(true) }],
      approval: { source: readinessReference(approvalPath, v.root), approved },
    };
    let keyCurrent = true;
    const keyProfile: OpenCodeManagementProfile = { ...profile, ...v.input,
      environment: { ...v.input.environment, XDG_DATA_HOME: data },
      nativeGeneration: 'v2', protocolRevision: '2.1.4', nativeModel: {
        providerId: mode === 'baseline-foreign-provider' ? 'TEST-other-provider' : providerId, modelId: 'TEST-model',
      }, embedded: { version: '2.1.4', directory: v.root, manifestSha256: 'b'.repeat(64),
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny',
        ...(baseline && mode !== 'baseline-unbound-key'
          ? { providerConfiguration: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: url, apiKey: originalKey } } } : {}),
      },
    };
    keyProfile.embedded!.configurationSource = captureOpenCodeConfigurationSource(keyProfile, undefined,
      () => keyCurrent, baseline ? 'global' : 'project').reference;
    const capturedKey = new OpenCodeV2CredentialScope(keyProfile, providerId, () => keyCurrent).capture();
    assert.equal(capturedKey.present, !absent);
    let runs = 0, inputs = 0, closes = 0, metadataReads = 0, challenges = 0;
    const ordinary = { ordinary: (observe: (provider: unknown) => boolean) => ({ timeoutMs: 1000,
      run: async () => {
        runs++;
        if (mode === 'auth-replaced') v.write(nativeAuth, { [providerId]: { type: 'api', key: 'TEST-replaced-key' } });
        if (mode === 'owner-revoked') keyCurrent = false;
        const digest = mode === 'null-digest' ? null : mode === 'malformed-digest' ? 'TEST-not-a-digest'
          : mode === 'foreign-digest' ? 'f'.repeat(64) : capturedKey.digest;
        observe({ npm: '@ai-sdk/openai-compatible', options: {
          baseURL: mode === 'wrong-url' ? 'http://192.168.1.21:8080/v1' : url,
          ...(baseline ? { apiKey: mode === 'baseline-wrong-key' ? 'TEST-unowned-key' : originalKey } : {}),
        }, ...(!baseline && mode !== 'authless' && mode !== 'missing-digest' ? { credentialScopeDigest: digest } : {}) });
        inputs++; return true;
      }, close: async () => { closes++; return true; },
    }), coordination: () => { challenges++; throw Error('TEST keyed/remote route cannot coordinate'); },
    fetchImpl: async () => { metadataReads++; throw Error('TEST keyed/remote route cannot inspect local metadata'); } };
    const prepare = () => createOpenCodeLocalModelReadiness(keyProfile,
      { ...probeInput, profileId: keyProfile.profileId, configRevision: keyProfile.configRevision },
      () => keyCurrent, ordinary, keyOrigin);
    if (mode === 'unapproved-url') {
      assert.throws(prepare, { code: 'held' });
      assert.equal(runs, 0); assert.equal(inputs, 0); assert.equal(closes, 0);
      continue;
    }
    const probe = prepare(), originalDeadline = Date.now() + 900;
    const accepted = mode === 'credential' || mode === 'authless' || mode === 'baseline';
    try {
      if (accepted) {
        assert.equal(await probe.run(new AbortController().signal, originalDeadline), true);
        assert.equal(probe.readiness?.()?.coordination, 'not-applicable');
        assert.equal(probe.readiness?.()?.accountDigest, managementDigest({ binding: keyProfile.accountBinding,
          key: capturedKey.digest, configuredKey: baseline || !keyedPolicy ? null : originalKey }));
        const serialized = JSON.stringify(probe.readiness?.());
        assert.equal(serialized.includes(originalKey), false);
        assert.equal(serialized.includes('credentialScopeDigest'), false);
      } else await assert.rejects(probe.run(new AbortController().signal, originalDeadline), { code: 'held' });
      assert.equal(runs, 1); assert.equal(inputs, accepted ? 1 : 0);
      assert.equal(metadataReads, 0); assert.equal(challenges, 0);
    } finally {
      assert.equal(await probe.close(originalDeadline), true);
      assert.equal(closes, 1, 'the same original adapter closes after success or refusal');
    }
  }
  const foreign = { ...tuple, configPath: join(f.home, '.config', 'opencode', 'opencode.json') };
  f.write(approvals, { schemaVersion: 1, approvals: [foreign] });
  assert.equal(captured.isCurrent(), false, 'approval-source replacement invalidates the original reference');
  const newOrigin = structuredClone(subset);
  newOrigin.approval = { source: readinessReference(approvals, f.root), approved: [foreign] };
  assert.equal(captureOpenCodeReadinessOrigin(newOrigin, { cwd: f.project }, providerId, () => true).privateNetworkApproved,
    false, 'same URL at a different config file cannot borrow approval');
  await probes.close(); await cold.close();
});
