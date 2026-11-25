import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, sep } from 'node:path';
import { test } from 'node:test';

import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { createOpenCodeLocalModelReadiness } from '../dist/adapters/providers/OpenCodeLocalModelReadiness.js';
import { managementDigest } from '../dist/management/identity.js';
import type { LocalModelReadinessOrigin, ReadinessSourceReference } from '../dist/management/commandRecords.js';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';
import type { TestContext } from 'node:test';

const providerId = 'test-provider', modelId = 'TEST-model', baseUrl = 'http://127.0.0.1:12345/v1';
type Mode = 'fallback' | 'absent' | 'configured' | 'manual' | 'v1';
type ReadKind = 'configuration' | 'policy' | 'approval' | 'authentication' | 'manual';

// Independent fixture evidence from complete files; production readers still perform every check.
function reference(path: string, root: string): ReadinessSourceReference {
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

function fixture(t: TestContext, mode: Mode = 'fallback', withOrigin = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-local-readiness-currentness-')));
  const cleanup: { probe?: ReturnType<typeof createOpenCodeLocalModelReadiness> } = {};
  t.after(async () => { await cleanup.probe?.close(Date.now() + 5000); rmSync(root, { recursive: true, force: true }); });
  const home = join(root, 'home'), cwd = join(root, 'workspace'), data = join(root, 'data'), xdg = join(root, 'config');
  for (const path of [home, cwd, data, xdg, join(data, 'opencode'), join(xdg, 'opencode')])
    mkdirSync(path, { mode: 0o700 });
  const paths: Record<ReadKind, string> = {
    configuration: join(xdg, 'opencode', 'opencode.json'), policy: join(cwd, 'opencode.json'),
    approval: join(root, 'approvals.json'), authentication: join(data, 'opencode', 'auth.json'),
    manual: join(root, 'manual.key'),
  };
  const configured = mode === 'configured' || mode === 'manual';
  const apiKey = mode === 'manual' ? '{file:' + paths.manual + '}' : 'TEST-configured-key';
  const config = JSON.stringify({ provider: { [providerId]: { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: baseUrl, ...(configured ? { apiKey } : {}) }, models: { [modelId]: { name: modelId } },
  } } });
  const approved = [{ configPath: paths.policy, providerId, baseUrl }];
  if (mode !== 'absent') {
    writeFileSync(paths.configuration, config, { mode: 0o600 });
    writeFileSync(paths.policy, config, { mode: 0o600 });
    writeFileSync(paths.approval, JSON.stringify({ schemaVersion: 1, approvals: approved }), { mode: 0o600 });
    writeFileSync(paths.authentication, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-auth-key' } }), { mode: 0o600 });
    if (mode === 'manual') writeFileSync(paths.manual, 'TEST-private-manual-key', { mode: 0o600 });
  }
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode', profileId: 'TEST-initial-preflight', configRevision: 'TEST-initial-preflight-revision',
    cwd, accountBinding: 'TEST-account', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    environment: { HOME: home, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: data },
    executable: { path: process.execPath, sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:12345',
    timeoutMs: 5000, modelProbeTimeoutMs: 5000, nativeModel: { providerId, modelId },
    embedded: { version: '2.1.4', directory: root, manifestSha256: 'b'.repeat(64),
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny',
      ...(mode === 'absent' ? { providerConfiguration: { package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: baseUrl, apiKey: 'TEST-baseline-key' }, models: { [modelId]: { name: modelId } } } } : {}) },
  };
  if (mode === 'v1') { delete profile.nativeGeneration; delete profile.protocolRevision; delete profile.embedded; }
  else profile.embedded!.configurationSource = captureOpenCodeConfigurationSource(profile, undefined,
    () => true, mode === 'absent' ? 'project' : 'global').reference;
  const scope = (global: boolean) => {
    const names = global ? ['opencode.json', 'opencode.jsonc'].map(name => join(home, '.config', 'opencode', name))
      : ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].map(name => join(cwd, name));
    return { sources: names.map(path => reference(path, global ? home : cwd)),
      selectedPath: names[0]!, invalid: false,
      providers: global || mode === 'absent' ? [] : [{ providerId, baseUrl, preset: 'custom' as const, hasConfiguredApiKey: configured }] };
  };
  const origin: LocalModelReadinessOrigin = {
    schemaVersion: 1, kind: 'team', ownerDigest: managementDigest({ owner: 'TEST-owner' }),
    contextId: 'TEST-context', commandId: 'TEST-preflight', selectionDigest: managementDigest({ selection: 'TEST' }),
    workspaces: [{ path: cwd, project: scope(false), global: mode === 'absent'
      ? { ...scope(true), selectedPath: null, invalid: true, selectorFailure: 'config-conflict' } : scope(true) }],
    approval: mode === 'absent' ? { notConsulted: 'no-private-target' }
      : { source: reference(paths.approval, root), approved },
  };
  let ownerCurrent = true, ownerThrows = false, ownerReads = 0, ordinaryRuns = 0;
  let current: () => boolean = () => assert.fail('ordinary adapter must receive the production currentness callback');
  // Only the native phase port is finite. Source, policy, approval, auth and currentness are production code.
  const probe = createOpenCodeLocalModelReadiness(profile, { commandId: 'TEST-preflight', profileId: profile.profileId,
    configRevision: profile.configRevision, providerId, modelId }, () => {
    ownerReads++;
    if (ownerThrows) throw new Error('TEST owner revoked');
    return ownerCurrent;
  }, {
    ordinary(_observe, captured) {
      current = captured;
      return { timeoutMs: 5000, run: async () => { ordinaryRuns++; return false; }, close: async () => true };
    },
    coordination: () => assert.fail('currentness regression cannot start coordination'),
    fetchImpl: async () => assert.fail('currentness regression cannot perform a network request'),
  }, withOrigin ? origin : undefined);
  cleanup.probe = probe;
  return { root, paths, config, profile, origin, probe, current,
    revoke: () => { ownerCurrent = false; }, throwOwner: () => { ownerThrows = true; },
    ownerReads: () => ownerReads, resetOwnerReads: () => { ownerReads = 0; }, ordinaryRuns: () => ordinaryRuns };
}

function observations(t: TestContext, paths: Record<ReadKind, string>) {
  const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync;
  const descriptors = new Map<number, ReadKind>();
  const events: ReadKind[] = [], reads = { configuration: 0, policy: 0, approval: 0, authentication: 0, manual: 0 };
  let mutation: { kind: ReadKind; action(): void } | undefined, mutations = 0;
  const opening = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd: number = Reflect.apply(originalOpen, fs, args);
    const kind = (Object.keys(paths) as ReadKind[]).find(key => paths[key] === args[0]);
    if (kind) { descriptors.set(fd, kind); reads[kind]++; events.push(kind); }
    return fd;
  });
  const reading = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const count: number = Reflect.apply(originalRead, fs, args);
    if (count > 0 && mutation !== undefined && mutation.kind === descriptors.get(args[0])) {
      const action = mutation.action; mutation = undefined; mutations++; action();
    }
    return count;
  });
  const closing = t.mock.method(fs, 'closeSync', (...args: Parameters<typeof fs.closeSync>) => {
    descriptors.delete(args[0]); return Reflect.apply(originalClose, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { opening.mock.restore(); reading.mock.restore(); closing.mock.restore(); syncBuiltinESMExports(); });
  return { events, reads, mutateDuring: (kind: ReadKind, action: () => void) => { mutation = { kind, action }; },
    mutations: () => mutations };
}

function replace(path: string, bytes: string) {
  const replacement = path + '.TEST-replacement';
  writeFileSync(replacement, bytes, { mode: 0o600 }); renameSync(replacement, path);
}

test('initial V2 fallback preflight keeps policy before auth and uses only its fresh source brackets', t => {
  const f = fixture(t), seen = observations(t, f.paths); f.resetOwnerReads();
  for (let call = 1; call <= 2; call++) {
    assert.equal(f.current(), true);
    assert.deepEqual(seen.reads, { configuration: 2 * call, policy: call, approval: call, authentication: call, manual: 0 });
    assert.deepEqual(seen.events.slice((call - 1) * 5), ['policy', 'approval', 'configuration', 'authentication', 'configuration']);
    assert.equal(f.ownerReads(), 6 * call, 'policy and both source observations retain opening and closing owner fences');
  }
});

test('initial V2 Resume preflight freshly observes absent config and auth with the original policy origin', t => {
  const f = fixture(t, 'absent'), seen = observations(t, f.paths);
  const source = f.profile.embedded!.configurationSource!;
  assert.equal(source.files.length, 6); assert.equal(source.inlineDigest, null);
  assert.ok(source.files.every(file => !fs.existsSync(file.path)));
  assert.equal(fs.existsSync(f.paths.authentication), false);
  f.resetOwnerReads();
  for (let call = 1; call <= 2; call++) {
    assert.equal(f.current(), true);
    assert.equal(f.ownerReads(), 6 * call, 'the original absent policy and both source sides remain fresh');
    assert.deepEqual(seen.events, []);
  }
  writeFileSync(f.paths.authentication, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-new-auth' } }), { mode: 0o600 });
  assert.equal(f.current(), false, 'an earlier absent auth observation cannot authorize later credentials');
});

for (const mutation of ['owner', 'source', 'policy', 'approval'] as const) {
  test(`initial V2 preflight refuses ${mutation} mutation during its real policy read before opening auth`, t => {
    const f = fixture(t), seen = observations(t, f.paths);
    seen.mutateDuring('policy', () => {
      if (mutation === 'owner') f.revoke();
      else if (mutation === 'source') replace(f.paths.configuration, f.config);
      else if (mutation === 'policy') replace(f.paths.policy, f.config);
      else replace(f.paths.approval, JSON.stringify({ schemaVersion: 1, approvals: [] }));
    });
    assert.equal(f.current(), false);
    assert.equal(seen.mutations(), 1, 'the injection follows a real policy read');
    assert.equal(seen.reads.authentication, 0, 'policy and source refusal prevent auth access');
  });
}

for (const mutation of ['owner', 'configuration', 'authentication'] as const) {
  test(`initial V2 preflight refuses ${mutation} mutation during the real auth read`, t => {
    const f = fixture(t), seen = observations(t, f.paths);
    seen.mutateDuring('authentication', () => {
      if (mutation === 'owner') f.revoke();
      else if (mutation === 'configuration') replace(f.paths.configuration, f.config);
      else replace(f.paths.authentication, JSON.stringify({ [providerId]: { type: 'api', key: 'TEST-new-auth' } }));
    });
    assert.equal(f.current(), false, 'the original auth read and closing source/owner fence reject mutation');
    assert.equal(seen.mutations(), 1);
    assert.equal(seen.reads.policy, 1); assert.equal(seen.reads.approval, 1); assert.equal(seen.reads.authentication, 1);
  });
}

test('initial V2 preflight rechecks revoked policy on the next call and refuses run before the ordinary phase', async t => {
  const f = fixture(t); assert.equal(f.current(), true);
  replace(f.paths.approval, JSON.stringify({ schemaVersion: 1, approvals: [] }));
  const seen = observations(t, f.paths);
  assert.equal(f.current(), false); assert.equal(seen.reads.authentication, 0);
  await assert.rejects(f.probe.run(new AbortController().signal, Date.now() + 4000), { code: 'held' });
  assert.equal(f.ordinaryRuns(), 0);
});

for (const withOrigin of [true, false]) {
  test(`initial V2 fallback ${withOrigin ? 'with' : 'without'} origin refuses a throwing owner before file reads`, t => {
    const f = fixture(t, 'fallback', withOrigin), seen = observations(t, f.paths); f.throwOwner();
    let accepted = false;
    try { accepted = f.current(); } catch { /* The original outer guard may throw; both routes refuse. */ }
    assert.equal(accepted, false); assert.deepEqual(seen.events, []);
  });
}

test('closed initial V2 preflight cannot read any source or auth again', async t => {
  const f = fixture(t); await f.probe.close(Date.now() + 4000);
  const seen = observations(t, f.paths); f.resetOwnerReads();
  assert.equal(f.current(), false); assert.equal(f.ownerReads(), 0); assert.deepEqual(seen.events, []);
});

for (const mode of ['configured', 'manual', 'v1'] as const) {
  test(`initial ${mode} preflight retains its original source-before-policy checks`, t => {
    const f = fixture(t, mode), seen = observations(t, f.paths);
    assert.equal(f.current(), true);
    assert.equal(seen.events[0], 'configuration', 'only a locally captured V2 fallback may omit the opening source check');
    assert.equal(seen.reads.manual, 0, 'manual file-key contents remain native-owned');
    replace(f.paths.configuration, f.config);
    const authReads = seen.reads.authentication;
    assert.equal(f.current(), false); assert.equal(seen.reads.authentication, authReads);
  });
}
