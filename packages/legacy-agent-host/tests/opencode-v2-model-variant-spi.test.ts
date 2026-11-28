import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { MemberProviderContext } from '../src/adapters/providers/MemberProvider.ts';
import type { OpenCodeV2OwnedSession } from '../src/adapters/providers/OpenCodeV2OwnedSession.ts';

const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const { createOpenCodeV2MemberProvider } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeV2MemberProvider.ts'
  : '../dist/adapters/providers/OpenCodeV2MemberProvider.js');

// Synthetic owner callbacks exercise the real Host SPI, not native execution.
function fixture(capturedVariant: string | undefined, nativeVariant: unknown,
  revision: '2.0.0' | '2.0.21' = '2.0.21') {
  const separator = process.platform === 'win32' ? String.fromCharCode(92) : '/';
  const root = process.platform === 'win32' ? 'C:' + separator + 'TEST-v2-variant' : '/TEST-v2-variant';
  const profile = {
    provider: 'opencode' as const, nativeGeneration: 'v2' as const, protocolRevision: revision,
    cwd: root, executable: { path: root + separator + 'native', sha256: 'a'.repeat(64) },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, root + separator + key])),
    teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal',
    sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-config',
    model: 'TEST-model', accountBinding: 'TEST-account', endpoint: 'http://127.0.0.1:14321',
    nativeSessionId: 'ses_TESTvariant',
    nativeOptions: { providerId: 'TEST-provider', agent: 'build',
      ...(capturedVariant === undefined ? {} : { variant: capturedVariant }) },
    limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 8192,
      outputEvents: 100, pendingInteractions: 2, timeoutMs: 1000 },
  };
  const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project',
    sessionId: profile.sessionId, generation: 1, configRevision: profile.configRevision,
    requiredCapabilities: ['text'] };
  const context = {
    profile, request,
    endpoint: { binding: { backendId: 'TEST-backend', teamId: profile.teamId,
      runId: 'TEST-run', memberId: profile.memberId, generation: 'TEST-generation' } },
    instructions: 'TEST captured Host instructions', isCurrent: () => true,
    canAllocate: () => true, onProgress: () => {}, readCheckpoint: async () => undefined,
  } as unknown as MemberProviderContext;
  const calls = { writes: 0, stops: 0, credentials: 0 };
  let observed = nativeVariant;
  let afterInstall: (() => void) | undefined;
  const owner: OpenCodeV2OwnedSession = {
    requiredExternalDirectory: 'deny',
    readPassword() { calls.credentials++; return 'TEST-only-password'; },
    async probe() { return true; },
    async readNativeCustody() {
      return { executablePath: profile.executable.path, executableSha256: profile.executable.sha256,
        pid: 17001, startIdentity: 'TEST-start', version: revision };
    },
    async readNativeEffectivePermissions() {
      return { nativeSessionId: profile.nativeSessionId, directory: profile.cwd,
        modelProviderId: profile.nativeOptions.providerId, modelId: profile.model,
        // Deliberately exercise malformed owner values without weakening production types.
        modelVariant: observed as string | null, pid: 17001, startIdentity: 'TEST-start',
        rules: [{ action: 'external_directory', resource: '*', effect: 'deny' }] };
    },
    async installAndAttestInitialContext(capture) {
      calls.writes++;
      afterInstall?.();
      return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
        generation: capture.generation, configRevision: capture.configRevision };
    },
    async readAndAttestInitialContext(capture) {
      return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
        generation: capture.generation, configRevision: capture.configRevision };
    },
    async stopOwned() { calls.stops++; return true; },
    async confirmStopped() { return true; },
  };
  return { request, calls, provider: createOpenCodeV2MemberProvider(context, owner),
    changeVariant(value: unknown) { observed = value; },
    changeAfterInstall(value: unknown) { afterInstall = () => { observed = value; }; } };
}

for (const revision of ['2.0.0', '2.0.21'] as const) {
  for (const [captured, observed] of [[undefined, 'default'], ['default', null], ['high', 'high']] as const) {
    test(`${revision} Host accepts equivalent variant ${String(captured)} / ${String(observed)} without replay`, async () => {
      const f = fixture(captured, observed, revision);
      let opened: Awaited<ReturnType<typeof f.provider.factory.open>> | undefined;
      try {
        opened = await f.provider.factory.open(f.request);
        assert.equal(f.provider.isReady(), true);
        assert.ok(f.provider.initialContextEvidence?.());
        assert.equal((await opened.driver.checkReadiness()).ok, true);
        assert.equal(f.calls.writes, 1);
        assert.equal(f.calls.credentials, 0, 'readback qualification does not dispatch a model request');
      } finally {
        await opened?.driver.close();
        assert.equal(await f.provider.cleanup(), true);
      }
      assert.equal(f.calls.stops, 1);
    });
  }
}

for (const observed of [undefined, '', {}, new String('default'), 'high']) {
  test(`Host rejects non-default or malformed owner variant ${String(observed)} before context mutation`, async () => {
    const f = fixture(undefined, observed);
    await assert.rejects(() => f.provider.factory.open(f.request), /dependency-unavailable/);
    assert.equal(f.provider.isReady(), false);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.credentials, 0);
    assert.equal(await f.provider.cleanup(), true);
    assert.equal(f.calls.stops, 1);
  });
}

for (const [captured, before, changed] of [
  [undefined, 'default', 'high'], ['high', 'high', 'default'], ['high', 'high', 'low'],
] as const) {
  test(`Host rejects variant change during initial context PUT (${String(captured)} -> ${changed})`, async () => {
    const f = fixture(captured, before);
    f.changeAfterInstall(changed);
    await assert.rejects(() => f.provider.factory.open(f.request), /dependency-unavailable/);
    assert.equal(f.calls.writes, 1);
    assert.equal(f.calls.credentials, 0);
    assert.equal(f.provider.isReady(), false);
    assert.equal(f.provider.initialContextEvidence?.(), undefined);
    assert.equal(await f.provider.cleanup(), true);
    assert.equal(f.calls.stops, 1);
  });
  test(`Host revokes an admitted variant change on re-attestation (${String(captured)} -> ${changed})`, async () => {
    const f = fixture(captured, before);
    const opened = await f.provider.factory.open(f.request);
    try {
      f.changeVariant(changed);
      assert.equal((await opened.driver.checkReadiness()).ok, false);
      assert.equal(f.provider.isReady(), false);
      assert.equal(f.provider.initialContextEvidence?.(), undefined);
      f.changeVariant(before);
      assert.equal((await opened.driver.checkReadiness()).ok, false, 'lost admission cannot be restored');
      assert.equal(f.calls.writes, 1);
      assert.equal(f.calls.credentials, 0);
    } finally {
      await opened.driver.close();
      assert.equal(await f.provider.cleanup(), true);
    }
    assert.equal(f.calls.stops, 1);
  });
}
