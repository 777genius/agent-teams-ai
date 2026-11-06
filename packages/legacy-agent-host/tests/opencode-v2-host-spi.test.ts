import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemberProviderContext } from '../src/adapters/providers/MemberProvider.ts';
import type { OpenCodeV2OwnedSession } from '../src/adapters/providers/OpenCodeV2MemberProvider.ts';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';

const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const { runtimeProfileSchema } = await import(sourceMode
  ? '../src/composition/runtimeProfile.ts'
  : '../dist/composition/runtimeProfile.js');
const { createOpenCodeV2MemberProvider } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeV2MemberProvider.ts'
  : '../dist/adapters/providers/OpenCodeV2MemberProvider.js');
const { createOpenCodeMemberProvider } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeMemberProvider.ts'
  : '../dist/adapters/providers/OpenCodeMemberProvider.js');

function v2Profile() {
  return {
    provider: 'opencode' as const,
    nativeGeneration: 'v2' as const,
    protocolRevision: '2.0.21' as const,
    cwd: '/TEST-only-opencode-v2',
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, '/TEST-only-opencode-v2/' + key])),
    executable: { path: '/TEST-only-opencode-v2/native-engine', sha256: 'a'.repeat(64) },
    teamId: 'test-team',
    memberId: 'test-member',
    principalId: 'test-principal',
    sessionId: 'test-session',
    generation: 1,
    configRevision: 'test-revision',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    endpoint: 'http://127.0.0.1:14321',
    nativeSessionId: 'ses_TESTowned',
    limits: {
      queuedInputs: 2, inputBytes: 8192, outputBytes: 8192,
      outputEvents: 100, pendingInteractions: 2, timeoutMs: 1000,
    },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build' },
  };
}

function request(): OpenConfig {
  return {
    tenantId: 'test-tenant', projectId: 'test-project', sessionId: 'test-session',
    generation: 1, configRevision: 'test-revision',
    requiredCapabilities: ['text'],
  };
}

function context(profile = v2Profile(), open = request()): MemberProviderContext {
  return {
    profile: profile as MemberProviderContext['profile'],
    request: open,
    endpoint: { binding: { backendId: 'test-backend', teamId: 'test-team', runId: 'test-run' } },
    isCurrent: () => true,
    canAllocate: () => true,
    onProgress: () => {},
    readCheckpoint: async () => undefined,
  } as unknown as MemberProviderContext;
}

function owner(probeOk: boolean, effective: 'deny' | 'ask' | 'allow' = 'deny') {
  const calls = { probe: 0, permissions: 0, password: 0, stop: 0, stopped: 0 };
  const captured: OpenCodeV2OwnedSession = {
    requiredExternalDirectory: 'deny',
    readPassword() { calls.password++; return 'TEST-only-password'; },
    async probe() { calls.probe++; return probeOk; },
    async readNativeEffectivePermissions() {
      calls.permissions++;
      return [{ action: 'external_directory', resource: '*', effect: effective }];
    },
    async stopOwned() { calls.stop++; return true; },
    async confirmStopped() { calls.stopped++; return true; },
  };
  return { calls, captured };
}

test('V2 profile is explicit and cannot inherit V1 plugin, auto-permission, argv or version', () => {
  const valid = v2Profile();
  assert.equal(runtimeProfileSchema.safeParse({ members: [valid] }).success, true);
  for (const invalid of [
    { ...valid, protocolRevision: '1.19.4' },
    { ...valid, protocolRevision: '2.1.4' },
    { ...valid, nativeGeneration: undefined },
    { ...valid, nativeSessionId: undefined },
    { ...valid, mcpPolicyPlugin: { path: '/TEST-only-plugin', sha256: 'b'.repeat(64) } },
    { ...valid, capturedMcpServers: {} },
    { ...valid, nativeOptions: { ...valid.nativeOptions, toolApprovalMode: 'auto' } },
    { ...valid, extraArgs: ['--install-v1-plugin'] },
  ]) assert.equal(runtimeProfileSchema.safeParse({ members: [invalid] }).success, false,
    JSON.stringify(invalid));
  assert.equal(runtimeProfileSchema.safeParse({ members: [
    { ...valid, nativeGeneration: undefined, protocolRevision: '1.19.4', nativeSessionId: undefined },
  ] }).success, true, 'unchanged V1 default remains valid');
});

test('V1 factory refuses a generation-selected V2 member before starting a server', () => {
  assert.throws(() => createOpenCodeMemberProvider(context()), /V2 cannot run through/);
});

test('V2 adapter rejects V1, unsupported versions and V1 plugin before owner access', () => {
  const { captured, calls } = owner(true);
  const fixture = v2Profile();
  for (const bad of [
    { ...fixture, nativeGeneration: undefined },
    { ...fixture, protocolRevision: '2.1.4' },
    { ...fixture, mcpPolicyPlugin: { path: '/TEST-only-plugin', sha256: 'a'.repeat(64) } },
  ]) {
    assert.throws(() => createOpenCodeV2MemberProvider(
      context(bad as typeof fixture), captured), /separate native profile/);
  }
  assert.deepEqual(calls, { probe: 0, permissions: 0, password: 0, stop: 0, stopped: 0 });
});

test('V2 private SPI refuses mismatched request before native probe and credentials', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open({
    ...request(), configRevision: 'forged',
  }), /opencode.driver.invalid-config/);
  assert.equal(provider.isReady(), false);
  assert.equal(calls.probe, 0);
  assert.equal(calls.password, 0);
  assert.equal(calls.stop, 1, 'failed open retires owned process immediately');
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(calls, { probe: 0, permissions: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 native probe failure HOLDs without submission and physically stops its owner', async () => {
  const { captured, calls } = owner(false);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(calls.probe, 1);
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(calls, { probe: 1, permissions: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 TEST-owned probe uses existing Session SPI; stop is idempotent and revokes readiness', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(opened.driver.sessionRef.length > 0, true);
  assert.equal(provider.isReady(), true);
  assert.equal(calls.probe, 1);
  assert.equal(calls.permissions, 1);
  assert.equal(calls.password, 0, 'no credentials are read by a simulated readiness probe');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(provider.isReady(), false);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'same TEST owner stopped once');
  assert.equal(calls.stopped, 1);
});

test('V2 native-effective allow cannot satisfy captured deny, even after a successful native probe', async () => {
  const { captured, calls } = owner(true, 'allow');
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 1, permissions: 1, password: 0, stop: 1, stopped: 1 });
});

test('V1 checkpoint identity is rejected before V2 native probe or permission readback', async () => {
  const { captured, calls } = owner(true);
  const restoredRequest = { ...request(), checkpointRef: 'cp1-TEST-v1' };
  const input = context(v2Profile(), restoredRequest);
  input.readCheckpoint = async () => ({
    version: 1, engine: 'opencode-v1', nativeSessionId: 'ses_TESTowned', compatibility: 'a'.repeat(64),
  });
  const provider = createOpenCodeV2MemberProvider(input, captured);
  await assert.rejects(() => provider.factory.open(restoredRequest), /opencode.driver.checkpoint-incompatible/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 0, permissions: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'failed restore must not repeatedly signal an owner');
});

test('unknown physical cleanup on failed V2 open does not become a retryable success', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(
    () => provider.factory.open({ ...request(), configRevision: 'forged' }),
    /opencode.v2.owner-cleanup-unknown/
  );
  assert.equal(await provider.cleanup(), false);
  assert.equal(calls.stop, 1);
  assert.equal(calls.probe, 0);
  await assert.rejects(() => provider.factory.open(request()), /opencode.v2.owner-cleanup-unknown/);
  assert.equal(calls.stop, 1, 'unknown owner must not be signalled twice');
});
