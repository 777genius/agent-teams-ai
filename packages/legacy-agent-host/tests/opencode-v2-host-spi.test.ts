import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
const { applyLaunchConfiguration } = await import(sourceMode
  ? '../src/composition/launchConfiguration.ts'
  : '../dist/composition/launchConfiguration.js');

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
    endpoint: { binding: { backendId: 'test-backend', teamId: 'test-team', runId: 'test-run', memberId: 'test-member', generation: 'test-generation' } },
    instructions: 'TEST-only role, team and workspace instructions',
    isCurrent: () => true,
    canAllocate: () => true,
    onProgress: () => {},
    readCheckpoint: async () => undefined,
  } as unknown as MemberProviderContext;
}

function testNativeCustody() {
  return {
    executablePath: v2Profile().executable.path,
    executableSha256: v2Profile().executable.sha256,
    pid: 17001,
    startIdentity: 'TEST-start-1',
    version: '2.0.21',
  };
}

function owner(probeOk: boolean, effective: 'deny' | 'ask' | 'allow' = 'deny') {
  const calls = { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 };
  const captured: OpenCodeV2OwnedSession = {
    requiredExternalDirectory: 'deny',
    readPassword() { calls.password++; return 'TEST-only-password'; },
    async probe() { calls.probe++; return probeOk; },
    async readNativeCustody() { return testNativeCustody(); },
    async readNativeEffectivePermissions() {
      calls.permissions++;
      return [{ action: 'external_directory', resource: '*', effect: effective }];
    },
    async installAndAttestInitialContext(capture) {
      calls.context++;
      return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
        generation: capture.generation, configRevision: capture.configRevision };
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

test('V2 launch rejects V1 manual/bypass choices before launch.prepare', () => {
  const base = runtimeProfileSchema.parse({ members: [v2Profile()] }).members[0]!;
  for (const permissions of ['manual', 'bypass'] as const) {
    assert.throws(() => applyLaunchConfiguration(base, { permissions }), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'invalid' &&
      'reason' in error && error.reason === 'launch-option-unsupported');
  }
  const selected = applyLaunchConfiguration(base, { model: 'TEST-next-model' });
  assert.equal(selected.provider, 'opencode');
  if (selected.provider !== 'opencode') throw new Error('Expected OpenCode profile');
  assert.equal(selected.model, 'TEST-next-model');
  assert.equal(selected.nativeOptions.toolApprovalMode, undefined,
    'V2 model choice must not inject V1 approval semantics');

  const v1 = runtimeProfileSchema.parse({ members: [{
    ...v2Profile(), nativeGeneration: undefined, protocolRevision: '1.19.4',
    nativeSessionId: undefined,
  }] }).members[0]!;
  const legacyChoice = applyLaunchConfiguration(v1, { permissions: 'manual' });
  assert.equal(legacyChoice.provider, 'opencode');
  if (legacyChoice.provider !== 'opencode') throw new Error('Expected OpenCode profile');
  assert.equal(legacyChoice.nativeOptions.toolApprovalMode, 'manual',
    'historical V1 launch choices remain unchanged');
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
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 });
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
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 native probe failure HOLDs without submission and physically stops its owner', async () => {
  const { captured, calls } = owner(false);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(calls.probe, 1);
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(calls, { probe: 1, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 TEST-owned probe uses existing Session SPI; stop is idempotent and revokes readiness', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(opened.driver.sessionRef.length > 0, true);
  assert.equal(provider.isReady(), true);
  assert.equal(calls.probe, 1);
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1);
  // A successful first installation is never submitted again by later
  // readiness checks: duplicated native mutations are unsafe after lost ACK.
  await opened.driver.checkReadiness();
  await opened.driver.checkReadiness();
  assert.equal(calls.context, 1, 're-probe must not replay native instruction installation');
  assert.deepEqual(provider.initialContextEvidence?.(), {
    kind: 'native-configuration',
    contextDigest: (await import('node:crypto')).createHash('sha256')
      .update('TEST-only role, team and workspace instructions').digest('hex'),
    generation: 'test-generation', configRevision: 'test-revision',
  });
  assert.equal(calls.password, 0, 'no credentials are read by a simulated readiness probe');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'same TEST owner stopped once');
  assert.equal(calls.stopped, 1);
});

test('actual native custody must match captured executable, digest, protocol and physical PID', async () => {
  const original = testNativeCustody();
  for (const bad of [
    { ...original, executablePath: '/TEST-only-opencode-v2/npm-wrapper' },
    { ...original, executableSha256: 'b'.repeat(64) },
    { ...original, version: '2.1.4' },
    { ...original, pid: 0 },
    { ...original, pid: Number.NaN },
    { ...original, startIdentity: '' },
  ]) {
    const { captured, calls } = owner(true);
    captured.readNativeCustody = async () => bad;
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.probe, 1);
    assert.equal(calls.permissions, 0, 'no permission read before actual native custody');
    assert.equal(calls.context, 0, 'no native instruction mutation with a wrong process');
    assert.equal(calls.password, 0);
    assert.equal(calls.stop, 1, 'only the TEST owner retires its own capture');
    assert.equal(await provider.cleanup(), true);
  }
});

test('V2 Host revokes a ready capture when the actual PID/start identity changes', async () => {
  const { captured, calls } = owner(true);
  let custody = testNativeCustody();
  let reads = 0;
  captured.readNativeCustody = async () => { reads++; return custody; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.equal(reads, 2);
  custody = { ...custody, pid: custody.pid + 1 };
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  custody = testNativeCustody();
  assert.equal((await opened.driver.checkReadiness()).ok, false,
    'restoring the old PID cannot renew a revoked capture');
  assert.equal(reads, 3, 'a revoked process has no further native authority');
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1, 'no replay of previously acknowledged instructions');
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('native permission drift revokes an already ready V2 SPI member, with no replay', async () => {
  const { captured, calls } = owner(true);
  let effective: 'deny' | 'allow' = 'deny';
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return [{ action: 'external_directory', resource: '*', effect: effective }];
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.notEqual(provider.initialContextEvidence?.(), undefined);

  effective = 'allow';
  const recheck = await opened.driver.checkReadiness();
  assert.equal(recheck.ok, false, 'the real native permission readback no longer satisfies deny');
  assert.equal(provider.isReady(), false, 'cached readiness must not survive failed recheck');
  assert.equal(provider.initialContextEvidence?.(), undefined,
    'old native instruction evidence must not survive permission drift');

  effective = 'deny';
  const next = await opened.driver.checkReadiness();
  assert.equal(next.ok, false, 'once revoked, restoring policy cannot revive the same capture');
  assert.equal(calls.permissions, 3, 'revoked owner must not perform more native reads');
  assert.equal(calls.context, 1, 'no mutation replay during re-attestation');
  assert.equal(calls.stop, 1, 'permission drift must stop the original TEST owner immediately');
  assert.equal(calls.stopped, 1, 'physical cleanup confirmed before exposing HOLD');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'stop only the original TEST owner once');
});

test('native probe loss after initial Host readiness revokes the capture permanently', async () => {
  const { captured, calls } = owner(true);
  let available = true;
  captured.probe = async () => { calls.probe++; return available; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  available = false;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  available = true;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(calls.probe, 2, 'failed native identity must not be reacquired');
  assert.equal(calls.context, 1);
  assert.equal(calls.stop, 1, 'lost native identity must stop the owned engine');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('lost Host allocation authority during recheck cannot resurrect cached V2 readiness', async () => {
  const { captured, calls } = owner(true);
  const input = context();
  let canAllocate = true;
  input.canAllocate = () => canAllocate;
  const provider = createOpenCodeV2MemberProvider(input, captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  canAllocate = false;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  canAllocate = true;
  assert.equal(provider.isReady(), false, 'stale attestation cannot revive when Host lease returns');
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.stop, 1, 'lost allocation stops the original TEST-owned process');
  assert.equal(calls.context, 1, 'initial native instructions are never replayed');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('transient authority loss observed without native recheck cannot revive V2 readiness', async () => {
  for (const lost of ['allocation', 'binding'] as const) {
    const { captured, calls } = owner(true);
    const input = context();
    let allocated = true;
    let bound = true;
    input.canAllocate = () => allocated;
    input.isCurrent = () => bound;
    const provider = createOpenCodeV2MemberProvider(input, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    assert.notEqual(provider.initialContextEvidence?.(), undefined);

    if (lost === 'allocation') allocated = false;
    else bound = false;
    assert.equal(provider.isReady(), false, 'one observed lapse revokes the capture');
    allocated = true;
    bound = true;
    assert.equal(provider.isReady(), false, 'restored Host authority cannot renew a V2 capture');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal((await opened.driver.checkReadiness()).ok, false);
    assert.equal(await provider.cleanup(), true);
    assert.equal(calls.stop, 1, 'only the original TEST-owned process is stopped once');
    assert.equal(calls.stopped, 1, 'physical stop must be confirmed');
    assert.equal(calls.context, 1, 'no second native instructions installation');
    assert.equal(calls.permissions, 2, 'revoked owner must not read native policy again');
  }
});


test('policy relaxed during native instructions cannot pass final Host admission', async () => {
  const { captured, calls } = owner(true);
  let effect: 'deny' | 'allow' = 'deny';
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return [{ action: 'external_directory', resource: '*', effect }];
  };
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    effect = 'allow';
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.permissions, 2, 'post-PUT native policy readback is mandatory');
  assert.equal(calls.context, 1, 'never replay instruction mutation');
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
});

test('PID changed during native instructions cannot inherit initial-context authority', async () => {
  const { captured, calls } = owner(true);
  let custody = testNativeCustody();
  let reads = 0;
  captured.readNativeCustody = async () => { reads++; return custody; };
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    custody = { ...custody, pid: custody.pid + 1 };
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(reads, 2, 'actual native PID must be remeasured after PUT');
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1);
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
});

test('V2 native-effective allow cannot satisfy captured deny, even after a successful native probe', async () => {
  const { captured, calls } = owner(true, 'allow');
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 0, password: 0, stop: 1, stopped: 1 });
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
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'failed restore must not repeatedly signal an owner');
});

test('native V2 submit preflight failure revokes Host readiness without replay or second owner stop', async () => {
  const { captured, calls } = owner(true);
  // Deterministic credential failure before any fetch. This exercises the
  // real private V2 Session SPI queue, not a fabricated submit response.
  captured.readPassword = () => { calls.password++; return ''; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.notEqual(provider.initialContextEvidence?.(), undefined);

  const first = await opened.driver.submit({
    inputId: 'TEST-not-sent', operationRef: 'TEST-preflight-op', content: 'TEST only; do not run a model',
  });
  assert.deepEqual(first, { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
  assert.equal(provider.isReady(), false, 'a sealed private V2 driver cannot leave Host ready');
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.password, 1, 'no credential or native mutation retry');
  assert.equal(calls.stop, 1, 'retire only the original captured native owner');
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-no-retry', operationRef: 'TEST-next-op', content: 'must not be submitted',
  }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
  assert.equal(calls.password, 1);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(calls.stop, 1, 'no duplicate stop after uncertain native ACK');
});

test('unknown physical stop after a failed V2 submit cannot claim safe reuse', async () => {
  const { captured, calls } = owner(true);
  captured.readPassword = () => { calls.password++; return ''; };
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-uncertain', operationRef: 'TEST-uncertain-op', content: 'TEST no model',
  }), /opencode.v2.owner-cleanup-unknown/,
  'unknown physical custody must be a distinct failure from known-not-sent input');
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-retry', operationRef: 'TEST-retry-op', content: 'must not send',
  }), /opencode.v2.owner-cleanup-unknown/);
  assert.equal(calls.password, 1, 'refused preflight never replays credentials or native POST');
  assert.equal(calls.stop, 1, 'never resignal the same owned PID after uncertain ACK');
  assert.equal(await provider.cleanup(), false);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  assert.equal(calls.stop, 1);
});

test('unknown physical cleanup on failed V2 open does not become a retryable success', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
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

test('mutable owner cannot downgrade an already captured deny to ask', async () => {
  const { captured, calls } = owner(true, 'ask');
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  // A subsequent owner revision is not allowed to change the captured product
  // security boundary for an already selected native generation.
  (captured as { requiredExternalDirectory: 'ask' | 'deny' }).requiredExternalDirectory = 'ask';
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('native instructions are not treated as installed when identity attestation is wrong', async () => {
  const { captured, calls } = owner(true);
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    return { nativeSessionId: capture.nativeSessionId,
      contextDigest: '0'.repeat(64),
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 1, password: 0, stop: 1, stopped: 1 });
});

test('cleanup retries only read-only physical confirmation after uncertain stop ACK', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return calls.stopped > 1; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open({ ...request(), configRevision: 'forged' }),
    /opencode.v2.owner-cleanup-unknown/);
  assert.equal(await provider.cleanup(), true, 'later physical readback may confirm exit');
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'never replay an uncertain stop');
  assert.equal(calls.stopped, 2);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
});

test('sealing a ready V2 capture initiates its own physical stop before explicit cleanup', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  provider.seal();
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.stop, 1, 'seal itself must initiate the TEST-owned stop');

  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(calls.stop, 1, 'cleanup and close cannot replay a stop with an unknown ACK');
  assert.equal(calls.stopped, 1);
});

test('sealing aborts an in-flight V2 native probe before permission or context installation', async () => {
  const { captured, calls } = owner(true);
  const entered = Promise.withResolvers<void>();
  captured.probe = async (signal) => {
    calls.probe++;
    entered.resolve();
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      signal.addEventListener('abort', () => resolve(false), { once: true });
    });
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opening = provider.factory.open(request());
  await entered.promise;
  provider.seal();
  await assert.rejects(opening, /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.deepEqual(calls, { probe: 1, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
});

test('late native readiness ACK cannot restore revoked Host authority or hide UNKNOWN cleanup',
  { timeout: 3000 }, async () => {
    for (const stopConfirmed of [true, false]) {
      const { captured, calls } = owner(true);
      let hostCurrent = true;
      let progress = 0;
      const host = {
        ...context(),
        isCurrent: () => hostCurrent,
        // The final native probe has already completed, but the Host lease
        // can expire before the private Session SPI returns its ACK.
        onProgress: () => { if (++progress === 2) hostCurrent = false; },
      };
      captured.confirmStopped = async () => { calls.stopped++; return stopConfirmed; };
      const provider = createOpenCodeV2MemberProvider(host, captured);
      const opened = await provider.factory.open(request());
      assert.equal(progress, 1);
      assert.equal(provider.isReady(), true);
      const pending = opened.driver.checkReadiness();
      if (stopConfirmed) {
        assert.deepEqual(await pending, { ok: false, code: 'unavailable' },
          'the completed native probe cannot renew a revoked Host lease');
        assert.equal(await provider.cleanup(), true);
      } else {
        await assert.rejects(pending, /opencode.v2.owner-cleanup-unknown/,
          'uncertain physical teardown cannot appear as healthy readiness');
        assert.equal(await provider.cleanup(), false);
      }
      assert.equal(progress, 2, 'the second native probe really completed');
      assert.equal(provider.isReady(), false);
      assert.equal(provider.initialContextEvidence?.(), undefined);
      assert.equal(calls.stop, 1, 'never repeat an uncertain stop ACK');
      assert.equal(calls.password, 0, 'no native credentials accessed');
      assert.equal(calls.context, 1, 'never replay native instructions');
    }
  });

test('retained V2 driver handle cannot mutate or checkpoint after Host seal', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  provider.seal();
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-after-seal', operationRef: 'TEST-no-post', content: 'must not send',
  }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
  assert.deepEqual(await opened.driver.respondToInteraction('perTEST-foreign',
    { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unavailable' });
  assert.deepEqual(await opened.driver.interrupt('TEST-foreign-operation'),
    { ok: false, code: 'unavailable' });
  assert.deepEqual(await opened.driver.checkReadiness(), { ok: false, code: 'unavailable' });
  assert.deepEqual(opened.driver.checkpoint(), { ok: false, code: 'unavailable' });
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.password, 0, 'revoked driver never reads native credentials');
  assert.equal(calls.context, 1, 'no native instructions replay');
  assert.equal(calls.stop, 1, 'only the captured TEST-owned process is stopped');
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('retained V2 controls surface UNKNOWN process custody, never re-signal', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  provider.seal();

  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-unknown-stop', operationRef: 'TEST-no-retry', content: 'must not send',
  }), /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.respondToInteraction('perTEST-foreign',
    { kind: 'permission', decision: 'allow' }), /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.interrupt('TEST-foreign-operation'),
    /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.checkReadiness(),
    /opencode.v2.owner-cleanup-unknown/);
  assert.deepEqual(opened.driver.checkpoint(), { ok: false, code: 'unavailable' });
  assert.equal(calls.stop, 1, 'unknown ACK never causes a second physical stop');
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), false);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  await assert.rejects(async () => {
    for await (const _event of opened.driver.observe()) { /* Drain sealed feed. */ }
  }, /opencode.v2.owner-cleanup-unknown/,
  'natural observation exhaustion must not mask UNKNOWN process custody');
});

test('buffered private V2 terminal never escapes a revoked Host observer', async () => {
  const { captured, calls } = owner(true);
  captured.readPassword = () => { calls.password++; return ''; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-buffered-failure', operationRef: 'TEST-buffered-op',
    content: 'TEST preflight only; no model',
  }), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
  assert.equal(provider.isReady(), false);
  // Private EventFeed.finishWith deliberately retains a diagnostic frame.
  // Host must suppress it once the captured generation has been retired.
  const received = await opened.driver.observe()[Symbol.asyncIterator]().next();
  assert.equal(received.done, true, 'revoked Host cannot expose buffered native diagnostic');
  assert.equal(calls.stop, 1);
  assert.equal(calls.password, 1);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('direct V2 SPI close retires its TEST owner without a separate Host cleanup call',
  { timeout: 4000 }, async () => {
    for (const physicallyConfirmed of [true, false]) {
      const { captured, calls } = owner(true);
      captured.confirmStopped = async () => { calls.stopped++; return physicallyConfirmed; };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      const opened = await provider.factory.open(request());
      const observer = opened.driver.observe()[Symbol.asyncIterator]();
      // Attach both handlers before close(): the pending next() can reject
      // while physical custody remains UNKNOWN, and that rejection must not
      // become an unhandled promise or be mistaken for clean exhaustion.
      const observed = observer.next().then(
        (event: IteratorResult<unknown>) => event.done ? 'done' : 'unexpected-event',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      const receipt = await opened.driver.close();
      assert.equal(await observed, physicallyConfirmed ? 'done' : 'opencode.v2.owner-cleanup-unknown',
        'close wakes the feed; uncertain physical custody must fail closed');
      assert.deepEqual(receipt, {
        logicallyClosed: true,
        cleanup: physicallyConfirmed ? 'confirmed' : 'unknown',
      }, 'an uncertain physical stop cannot be reported as a confirmed close');
      assert.equal(provider.isReady(), false);
      assert.equal(provider.initialContextEvidence?.(), undefined);
      assert.equal(calls.stop, 1, 'close alone stops the original owned PID exactly once');
      assert.equal(await provider.cleanup(), physicallyConfirmed);
      assert.equal(calls.stop, 1, 'later cleanup never resends an uncertain stop');
      assert.equal(calls.password, 0, 'no native request or credential read during close');
    }
  });

test('consumer cancel before first V2 observation retires the unclaimable native session',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const cancelled = await observer.return?.();
    assert.equal(cancelled?.done, true);
    assert.equal((await observer.next()).done, true);
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'cancel must stop only the captured TEST owner');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0, 'no native request is allowed after cancel');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(calls.stop, 1, 'no duplicate stop signal');
  });

test('consumer cancel wakes a suspended native V2 next without Host seal',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pendingNext = observer.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingCancel = observer.return?.();
    assert.equal((await pendingNext).done, true, 'pending next must be released');
    assert.equal((await pendingCancel)?.done, true);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.stop, 1, 'the same owned process is stopped once');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('consumer observer cancel reports uncertain physical native cleanup',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    captured.stopOwned = async () => { calls.stop++; return false; };
    captured.confirmStopped = async () => { calls.stopped++; return false; };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    await assert.rejects(async () => { await observer.return?.(); },
      /opencode.v2.owner-cleanup-unknown/);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.stop, 1, 'uncertain ACK must never be replayed');
    assert.equal(await provider.cleanup(), false);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  });

test('Host seal wakes a suspended native V2 observer without delivering a late event',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const iterator = opened.driver.observe()[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    provider.seal();
    const result = await next;
    assert.equal(result.done, true, 'revocation resolves even when private feed has no events');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('idle observer revokes an expired native V2 lease without seal or native events',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    let leaseValid = true;
    const ctx = { ...context(), canAllocate: () => leaseValid };
    const provider = createOpenCodeV2MemberProvider(ctx, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pending = observer.next();
    // Start one genuine idle next() and then remove Host authority WITHOUT
    // calling isReady(), seal(), or a mutating SPI method. The observer must
    // notice lease expiration itself rather than wait indefinitely for events.
    await new Promise<void>((resolve) => setImmediate(resolve));
    leaseValid = false;
    const expired = Promise.withResolvers<never>();
    const deadline = setTimeout(() => expired.reject(new Error('idle V2 lease watcher did not wake')),
      1750);
    try {
      const result = await Promise.race([pending, expired.promise]);
      assert.equal(result.done, true, 'expired Host cannot leak an idle native event');
    } finally {
      clearTimeout(deadline);
      provider.seal();
    }
    leaseValid = true;
    assert.equal(provider.isReady(), false, 'lease restoration cannot revive a retired capture');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'only the captured TEST-owned process was stopped once');
    assert.equal(calls.context, 1, 'no initial-context mutation replay');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('pending native V2 re-attestation fences concurrent controls without retiring owner',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    captured.probe = async () => {
      calls.probe++;
      entered.resolve();
      await resume.promise;
      return true;
    };
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pendingEvent = observer.next();
    let observerSettled = false;
    void pendingEvent.then(() => { observerSettled = true; }, () => { observerSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recheck = opened.driver.checkReadiness();
    await entered.promise;
    assert.equal(provider.isReady(), false, 'pending native recheck cannot reuse stale readiness');

    assert.deepEqual(await opened.driver.submit({
      inputId: 'TEST-overlap', operationRef: 'TEST-overlap-op', content: 'TEST only; no model',
    }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
    assert.deepEqual(await opened.driver.respondToInteraction('perTEST-foreign',
      { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unavailable' });
    assert.deepEqual(await opened.driver.interrupt('TEST-foreign-operation'),
      { ok: false, code: 'unavailable' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observerSettled, false,
      'an already-running native observer stays pending through re-attestation');
    assert.equal(calls.stop, 0, 'a pending probe must not stop its still-owned native PID');
    assert.equal(calls.password, 0, 'fenced controls never read native credentials');

    resume.resolve();
    assert.equal((await recheck).ok, true);
    assert.equal(provider.isReady(), true, 'successful re-attestation restores the same captured owner');
    assert.equal(calls.context, 1, 'no initial-instruction replay');
    assert.equal(calls.stop, 0);
    assert.equal(observerSettled, false, 'the same observer remains live after re-attestation');
    provider.seal();
    assert.equal((await pendingEvent).done, true, 'revocation wakes the retained observer');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(calls.stop, 1, 'only Host seal stops the original native owner');
  });

// Pinned private PR #1 uses config.directory.startsWith('/') even on Windows.
// This is a source-grounded qualification HOLD, not a native Windows test.
// Do not replace the synthetic late-ACK fixture's path with a Windows drive
// until the versioned private transport is independently qualified and pinned.
test('pinned private V2 PR1 refuses Windows native cwd before network access (HOLD)',
  { skip: process.platform !== 'win32' }, async () => {
    const fixture = v2Profile();
    fixture.cwd = String.raw`C:\TEST-only-opencode-v2`;
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(fixture), captured);
    await assert.rejects(() => provider.factory.open(request()), /opencode.driver.invalid-config/);
    assert.equal(calls.probe, 0, 'unqualified Windows native path cannot reach a probe');
    assert.equal(calls.password, 0, 'no native credentials');
    assert.equal(calls.stop, 1, 'only this TEST-owned capture is retired');
    assert.equal(await provider.cleanup(), true);
  });

test('late native prompt ACK stays UNKNOWN across re-attestation recovery and Host seal',
  { timeout: 15000 }, async () => {
    // An outer node:test timeout alone cannot release unresolved promises or
    // close live peers. Bound each synthetic HTTP/re-attestation handshake.
    const within = async <T>(work: Promise<T>, stage: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TEST handshake timeout: ' + stage)), 5000);
        })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // Independent disposable peers: active turns must never cross TEST sessions.
    for (const mode of ['recheck', 'recheck-restored', 'seal'] as const) {
      const profile = v2Profile();
      const postSeen = Promise.withResolvers<void>();
      const releaseAck = Promise.withResolvers<void>();
      const recheckEntered = Promise.withResolvers<void>();
      const completeRecheck = Promise.withResolvers<void>();
      let postCount = 0;
      const sessionPath = '/api/session/' + profile.nativeSessionId;
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const json = (value: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(value));
        };
        if (req.method === 'GET' && url.pathname === sessionPath) {
          // Pinned V2 queue preflight decodes the raw session GET body;
          // the { data: ... } envelope belongs to prompt POST responses.
          json({
            id: profile.nativeSessionId, location: { directory: profile.cwd },
            agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' },
            time: { created: 1 },
          });
          return;
        }
        if (req.method === 'GET' &&
            url.pathname === '/api/experimental/session/' + profile.nativeSessionId + '/log') {
          res.setHeader('content-type', 'text/event-stream');
          res.end([
            {
              id: 'evt_created', type: 'session.created',
              durable: { aggregateID: profile.nativeSessionId, seq: 0 },
              data: { sessionID: profile.nativeSessionId },
              location: { directory: profile.cwd },
            },
            { type: 'log.synced', aggregateID: profile.nativeSessionId, seq: 0 },
          ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
          return;
        }
        if (req.method === 'POST' && url.pathname === sessionPath + '/prompt') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            const input = JSON.parse(body) as { id: string; text: string };
            postCount++;
            postSeen.resolve();
            void releaseAck.promise.then(() => json({ data: {
              id: input.id, sessionID: profile.nativeSessionId, type: 'user',
              delivery: 'queue', time: { created: 1 }, payload: { text: input.text },
            } }));
          });
          return;
        }
        res.writeHead(404); res.end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      profile.endpoint = 'http://127.0.0.1:' + address.port;
      let opened: Awaited<ReturnType<ReturnType<typeof createOpenCodeV2MemberProvider>['factory']['open']>> | undefined;
      const { captured, calls } = owner(true);
      try {
        const provider = createOpenCodeV2MemberProvider(context(profile), captured);
        opened = await provider.factory.open(request());
        assert.equal(provider.isReady(), true);
        const pending = opened.driver.submit({
          inputId: 'TEST-late-' + mode, operationRef: 'TEST-late-' + mode + '-op',
          content: 'TEST only; no model',
        });
        // The pinned driver probes before its POST. Only block the separate
        // re-attestation AFTER the TEST HTTP peer has received the mutation.
        await within(postSeen.promise, mode + ' POST received');
        if (mode !== 'seal') {
          captured.probe = async () => {
            calls.probe++;
            recheckEntered.resolve();
            await completeRecheck.promise;
            return true;
          };
          const recheck = opened.driver.checkReadiness();
          await within(recheckEntered.promise, 're-attestation started');
          assert.equal(provider.isReady(), false);
          if (mode === 'recheck-restored') {
            completeRecheck.resolve();
            const recoveredReadback = await within(recheck, 'successful re-attestation');
            assert.ok(recoveredReadback && typeof recoveredReadback === 'object' &&
              'ok' in recoveredReadback, 're-attestation returns a structured SPI reply');
            assert.equal(recoveredReadback.ok, true);
            assert.equal(provider.isReady(), true, 'owner restored before late native POST ACK');
            assert.equal(calls.stop, 0, 'a successful probe alone must not retire the owner');
          }
          releaseAck.resolve();
          assert.deepEqual(await within(pending, mode + ' native ACK'), { ok: false, code: 'unknown' },
            'late POST ACK cannot inherit newly restored readiness after an intervening probe');
          assert.equal(postCount, 1, 'no second native POST after uncertain ACK');
          // The original native POST is uncertain after its ACK raced the
          // policy probe. Quarantine this capture before any further dispatch.
          // A probe by itself must not stop the PID; an uncertain mutation does.
          assert.equal(calls.stop, 1, 'uncertain native handoff retires only its TEST-owned PID');
          assert.equal(provider.isReady(), false, 'no renewed readiness after UNKNOWN delivery');
          if (mode === 'recheck') {
            provider.seal();
            completeRecheck.resolve();
            const sealedReadback = await within(recheck, 'sealed re-attestation');
            assert.ok(sealedReadback && typeof sealedReadback === 'object' && 'ok' in sealedReadback,
              'the private Session SPI must return a structured readiness result');
            assert.equal(sealedReadback.ok, false, 'seal revokes the suspended native probe');
          }
        } else {
          provider.seal();
          releaseAck.resolve();
          assert.deepEqual(await within(pending, 'sealed native ACK'), { ok: false, code: 'unknown' },
            'post-seal native ACK is neither authorized nor known-not-sent');
        }
        assert.equal(postCount, 1, 'each TEST case sends exactly one native POST');
        assert.equal(provider.isReady(), false);
        assert.equal(calls.stop, 1, 'only the captured TEST-owned process is stopped');
        assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
        assert.equal(await provider.cleanup(), true);
        assert.equal(calls.stop, 1, 'stop is single-flight after uncertain ACK');
      } finally {
        completeRecheck.resolve();
        releaseAck.resolve();
        await opened?.driver.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      }
    }
  });
