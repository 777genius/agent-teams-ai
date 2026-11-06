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
  const reply = await opened.driver.submit({
    inputId: 'TEST-uncertain', operationRef: 'TEST-uncertain-op', content: 'TEST no model',
  });
  assert.deepEqual(reply, { ok: false, code: 'unknown' },
    'unknown physical custody may not advertise known-not-sent recovery');
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-retry', operationRef: 'TEST-retry-op', content: 'must not send',
  }), { ok: false, code: 'unknown' });
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
