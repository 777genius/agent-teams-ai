import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { createScheduledRunProvider } from '../dist/adapters/providers/ScheduledRunProvider.js';
import { readCodexMcpCatalog } from '../dist/adapters/providers/readCodexMcpCatalog.js';
import { HostWindowsLaunch } from '../dist/owned-process/HostWindowsLaunch.js';
import { createHostProviderManagementComposition } from '../dist/composition/createHostProviderManagementComposition.js';

import type { CapturedNativeProcessFactory } from '../dist/adapters/providers/capturedNativeProcessFactory.js';
import type { ProviderManagementProfile } from '../dist/management/profile.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

function fixture(provider: ProviderManagementProfile['provider']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-finite-route-')));
  for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'storage']) mkdirSync(join(root, name));
  const common = { profileId: 'TEST-profile', configRevision: 'TEST-config', accountBinding: 'TEST-account',
    cwd: join(root, 'workspace'), executable: { path: join(root, 'TEST-nonexistent-provider'), sha256: 'a'.repeat(64) },
    timeoutMs: 1000, environment: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'config'),
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), PATH: root },
    windowsBroker: { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: 'x64' as const,
      protocol: 1 as const, capability: 'service-scopes-v1' as const } };
  const profile: ProviderManagementProfile = provider === 'codex'
    ? { ...common, provider, protocolRevision: '0.169.0' }
    : provider === 'claude'
      ? { ...common, provider, sdkRevision: '0.3.305', configNamespace: 'custom-directory' }
      : { ...common, provider, endpoint: 'http://127.0.0.1:19281' };
  return { root, profile, identity: { profileId: profile.profileId, configRevision: profile.configRevision } };
}

const cases = [
  ['codex', 'metadata'], ['codex', 'login'], ['codex', 'probe'],
  ['claude', 'metadata'], ['claude', 'auth-status'], ['claude', 'login'], ['claude', 'probe'],
  ['opencode', 'catalog'],
] as const;

for (const [provider, operation] of cases) test(`${provider} ${operation} reaches its original finite process factory`, async () => {
  const f = fixture(provider), marker = new Error('TEST original finite process factory');
  let calls = 0;
  const createProcess: CapturedNativeProcessFactory = (selected, current) => {
    calls++; assert.equal(selected.provider, provider); assert.equal(current(), true);
    assert.deepEqual(selected.executable, f.profile.executable);
    assert.deepEqual(selected.windowsBroker, f.profile.windowsBroker);
    throw marker; // Refuse before any native process, HTTP, login or model operation.
  };
  const owner = new ProviderManagementCoordinator([f.profile], () => {}, join(f.root, 'storage'), { createProcess });
  try {
    const action = async () => {
      const request = { ...f.identity, commandId: 'TEST-probe', modelId: 'TEST-model',
        providerId: provider === 'claude' ? 'anthropic' : provider };
      if (provider === 'codex') {
        if (operation === 'metadata') return owner.codex.read(f.identity);
        if (operation === 'login') return owner.codex.prepareLogin({ ...f.identity, providerId: 'codex', methodIndex: 0 });
        return owner.codex.prepareProbe(request, () => true).run(new AbortController().signal);
      }
      if (provider === 'claude') {
        if (operation === 'metadata') return owner.claude.read(f.identity);
        if (operation === 'auth-status') return owner.claudeAuth.read(f.identity);
        if (operation === 'login') return owner.claudeAuth.prepare({ ...f.identity, providerId: 'anthropic', methodIndex: 0 });
        return owner.claude.prepareProbe(request).run(new AbortController().signal);
      }
      return owner.catalog(f.identity);
    };
    await assert.rejects(action(), error => error === marker);
    assert.equal(calls, 1);
  } finally { await owner.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const provider of ['claude', 'codex'] as const) test(`${provider} schedule receives Main custody without Team service authority`, async t => {
  const f = fixture(provider), marker = new Error('TEST original Main port');
  const retained = new HostWindowsLaunch(() => undefined);
  let calls = 0;
  t.mock.method(retained, 'port', (...[selected, current, captureCurrent]: Parameters<HostWindowsLaunch['port']>) => {
    calls++; assert.deepEqual(selected.executable, f.profile.executable);
    assert.equal(current(), true); assert.equal(captureCurrent, undefined);
    throw marker;
  });
  const common = { cwd: f.profile.cwd, environment: f.profile.environment, executable: f.profile.executable,
    windowsBroker: f.profile.windowsBroker, configRevision: f.profile.configRevision, accountBinding: f.profile.accountBinding,
    teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal',
    sessionId: 'TEST-session', generation: 1, model: 'TEST-model',
    limits: { queuedInputs: 1, inputBytes: 4096, outputEvents: 128, outputBytes: 8192,
      pendingInteractions: 2, timeoutMs: 1000 } };
  const profile: RuntimeMemberProfile = provider === 'claude' ? { ...common, provider,
    configNamespace: 'custom-directory', nativeTools: [], autoAllowedTools: [] }
    : { ...common, provider, protocolRevision: '0.169.0', nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } };
  try {
    assert.throws(() => createScheduledRunProvider({ profile, retainedWindowsLaunch: retained,
      request: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session',
        generation: 1, configRevision: profile.configRevision, requiredCapabilities: [] },
      binding: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
        memberId: 'TEST-member', generation: '1' },
      isCurrent: () => true, onProgress() {} }), error => error === marker);
    assert.equal(calls, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Codex MCP read receives its original finite Main port before metadata execution', async t => {
  const f = fixture('codex'), marker = new Error('TEST original catalog port');
  const retained = new HostWindowsLaunch(() => undefined);
  let calls = 0;
  t.mock.method(retained, 'port', (...[selected, current, captureCurrent]: Parameters<HostWindowsLaunch['port']>) => {
    calls++; assert.deepEqual(selected.executable, f.profile.executable);
    assert.equal(current(), true); assert.equal(captureCurrent, undefined);
    throw marker;
  });
  try {
    await assert.rejects(readCodexMcpCatalog({ ...f.profile, provider: 'codex', protocolRevision: '0.169.0',
      teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal', sessionId: 'TEST-session',
      generation: 1, model: 'TEST-model', nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' },
      limits: { queuedInputs: 1, inputBytes: 4096,
        outputEvents: 128, outputBytes: 8192, pendingInteractions: 2, timeoutMs: 1000 } },
    () => {}, undefined, retained), error => error === marker);
    assert.equal(calls, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('source-version composition uses the same original Main port with only filtered captured environment', async t => {
  const f = fixture('codex'), retained = new HostWindowsLaunch(() => undefined);
  const executable = (name: string) => {
    const path = join(f.root, name), bytes = `TEST non-executable fixture ${name}\n`;
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  f.profile.executable = executable('TEST-seed');
  f.profile.environment.OPENAI_API_KEY = 'TEST never given to a version process';
  f.profile.environment.NODE_OPTIONS = 'TEST no loader flags';
  const candidate = executable('TEST-candidate');
  const profile: TeamHostProfile = { schemaVersion: 1, owner: { ownerId: 'TEST-owner', revision: 'TEST-owner-1',
    storageRoot: join(f.root, 'storage'), profileId: 'TEST-host', protocolVersion: 1, buildId: 'TEST-build',
    nodeSha256: 'c'.repeat(64), hostEntrySha256: 'd'.repeat(64) }, principalId: 'TEST-human',
    teams: [], management: [f.profile] };
  const grant = { targetId: 'e'.repeat(64), ownerId: profile.owner.ownerId, ownerRevision: profile.owner.revision,
    contextId: 'TEST-context', projectPath: f.profile.cwd, runtimeId: 'codex',
    profileId: f.profile.profileId, configRevision: f.profile.configRevision, teamScopes: [] };
  let calls = 0;
  t.mock.method(retained, 'port', (...[selected, current, captureCurrent]: Parameters<HostWindowsLaunch['port']>) => {
    calls++; assert.deepEqual(selected.executable, candidate);
    assert.equal(current(), true); assert.equal(captureCurrent, undefined);
    assert.equal(selected.environment.HOME, f.profile.environment.HOME);
    assert.equal(selected.environment.OPENAI_API_KEY, undefined);
    assert.equal(selected.environment.NODE_OPTIONS, undefined);
    throw new Error('TEST original Main refuses before native allocation');
  });
  const composition = createHostProviderManagementComposition(profile, () => {}, () => {}, undefined, undefined, retained);
  try {
    const before = composition.sources!.current({ grant });
    const result = await composition.sources!.publish({ grant, commandId: 'TEST-version', expectedRevision: before.revision,
      candidate: { sourceKind: 'app-managed', executable: candidate, nativeCli: { executable: candidate, version: '0.169.0' } } },
    () => assert.fail('A refused native version cannot publish'));
    assert.equal(calls, 1); assert.equal(result.phase, 'held');
    assert.equal(result.reason, 'native-outcome-unknown');
    assert.deepEqual(composition.sources!.current({ grant }), before);
  } finally {
    await composition.sources?.close(); await composition.management?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
