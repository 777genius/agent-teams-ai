import assert from 'node:assert/strict';
import { once } from 'node:events';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { closeNativeHostInput, startHost } from './fixtures/native-host.ts';
import { createPassiveNativeDiagnosticCapture, readOriginalHostCpuProfile } from './fixtures/native-opencode-team/passive-diagnostics.ts';

test('a failed original Node child retains CPU evidence and bounded file refusals stay distinguishable', {
  timeout: 10000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-cpu-exit1-')));
  const entry = join(root, 'TEST-exit1.mjs');
  const originalTrace = createPassiveNativeDiagnosticCapture();
  // Synthetic channel publications only; no HTTP/provider/Runtime is invoked by this sole finite child.
  writeFileSync(entry, `import { channel } from 'node:diagnostics_channel';
const secret = 'TEST-private-undici-token';
const publish = (name, request) => channel(name).publish({ request, headers: secret,
  socket: { privatePath: ${JSON.stringify(root)} }, chunk: Buffer.from(secret) });
for (const path of ['/api/plugin', '/api/model', '/api/info']) {
  const request = { origin: 'http://127.0.0.1:65530', path: path + '?private=' + secret, method: 'GET' };
  publish('undici:request:create', request);
  for (const name of ['undici:client:sendHeaders', 'undici:request:bodySent']) {
    publish(name, { ...request });
    publish(name, request);
    publish(name, request);
  }
}
const failedRead = channel('agent-teams:opencode-v2:read-cut-failed');
const failure = { stage: 'after-session', reason: 'deadline', elapsedMs: 30001, deadlineExpired: true, aborted: false };
failedRead.publish({ ...failure, error: secret, stack: secret, sessionId: secret, path: ${JSON.stringify(root)} });
for (const invalid of [{ ...failure, reason: secret }, { ...failure, stage: secret },
  { ...failure, elapsedMs: 60001 }, { ...failure, deadlineExpired: 'true' },
  { ...failure, reason: 'mutable_native_readback' }]) failedRead.publish(invalid);
let accessorCalls = 0;
failedRead.publish(Object.defineProperty({ ...failure }, 'stage', { get() { accessorCalls++; return 'after-session'; } }));
if (accessorCalls !== 0) process.exit(3);
const failedMetadata = channel('agent-teams:opencode-v2:metadata-read-failed');
const metadata = { stage: 'directory', reason: 'invalid_native_catalog', elapsedMs: 42, deadlineExpired: false, aborted: false };
for (const invalid of [{ ...metadata, stage: secret }, { ...metadata, reason: secret },
  { ...metadata, elapsedMs: 3600001 }, { ...metadata, deadlineExpired: 'false' },
  { ...metadata, aborted: null }]) failedMetadata.publish(invalid);
failedMetadata.publish(Object.defineProperty({ ...metadata }, 'reason', { get() { accessorCalls++; return 'held'; } }));
if (accessorCalls !== 0) process.exit(3);
for (let index = 0; index < 300; index++) publish('undici:request:create',
  { origin: 'http://127.0.0.1:65530', path: '/api/info?private=' + secret, method: 'GET' });
failedMetadata.publish({ ...metadata, error: secret, stack: secret, path: ${JSON.stringify(root)} });
failedMetadata.publish({ ...metadata, reason: 'deadline', elapsedMs: 30001, deadlineExpired: true });
const end = Date.now() + 50; while (Date.now() < end) Math.sqrt(Date.now());
// Flush only these synthetic diagnostic bytes; the existing parent test keeps its original bound.
process.stderr.write('', () => process.exit(1));
`, { mode: 0o600 });
  const host = startHost({ node: process.execPath, entry, root, profile: join(root, 'TEST-profile.json'),
    profileHash: 'a'.repeat(64), testCpuProfile: true,
    testImports: [new URL('./fixtures/native-opencode-team/passive-diagnostics.ts', import.meta.url).href],
    onDiagnostic: chunk => originalTrace.accept(chunk, 1) });
  const originalClose = once(host.child, 'close');
  try {
    const [code, signal] = await once(host.child, 'exit');
    assert.equal(code, 1); assert.equal(signal, null);
    await assert.rejects(host.close(), /Host exit zero confirms/);
    await originalClose;
    assert.deepEqual(originalTrace.entries.slice(0, 8).map(row => [row.event, row.request, row.route]), [
      ['request', 1, 'plugins'], ['request-send-headers', 1, 'plugins'], ['request-body-sent', 1, 'plugins'],
      ['request', 2, 'model-catalog'], ['request-send-headers', 2, 'model-catalog'], ['request-body-sent', 2, 'model-catalog'],
      ['request', 3, 'info'],
      ['read-cut-failed', null, null],
    ], 'same-object targeted phases appear once; foreign objects and untargeted phases are ignored');
    assert.ok(originalTrace.entries.slice(0, 7).every(row => row.epoch === 1 && row.method === 'GET' &&
      typeof row.atMs === 'number' && (row.event === 'request' ? row.durationMs === null :
        typeof row.durationMs === 'number' && row.durationMs >= 0)));
    const readFailure = originalTrace.entries.find(row => row.event === 'read-cut-failed')!;
    assert.deepEqual({ epoch: readFailure.epoch, stage: readFailure.stage, code: readFailure.code,
      durationMs: readFailure.durationMs, deadlineExpired: readFailure.deadlineExpired, aborted: readFailure.aborted },
    { epoch: 1, stage: 'after-session', code: 'deadline', durationMs: 30001, deadlineExpired: true, aborted: false });
    assert.equal('error' in readFailure || 'stack' in readFailure || 'sessionId' in readFailure || 'path' in readFailure, false);
    const metadataFailures = originalTrace.entries.filter(row => row.event === 'metadata-read-failed');
    assert.equal(metadataFailures.length, 1, 'reserved late metadata observation survives original trace saturation once');
    const metadataFailure = metadataFailures[0]!;
    assert.ok(isDeepStrictEqual({ epoch: metadataFailure.epoch, stage: metadataFailure.stage, code: metadataFailure.code,
      durationMs: metadataFailure.durationMs, deadlineExpired: metadataFailure.deadlineExpired, aborted: metadataFailure.aborted },
    { epoch: 1, stage: 'directory', code: 'invalid_native_catalog', durationMs: 42, deadlineExpired: false, aborted: false }),
    'first original metadata failure retains only the exact closed fields');
    assert.equal(originalTrace.entries.at(-1)!.event, 'metadata-read-failed');
    assert.equal(originalTrace.entries.filter(row => row.event === 'trace-limit').length, 1);
    assert.equal(originalTrace.limited, true);
    assert.ok(originalTrace.entries.length <= 257);
    assert.ok(originalTrace.entries.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 513));
    assert.ok(originalTrace.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0) <= 64 * 1024);
    assert.equal(JSON.stringify(originalTrace.entries).includes('TEST-private-undici-token'), false);
    assert.equal(JSON.stringify(originalTrace.entries).includes(root), false);
    const path = host.testCpuProfilePath!;
    assert.equal(host.testCpuProfileIntervalUs, 10000);
    assert.ok(host.child.spawnargs.includes('--cpu-prof-interval=10000'));
    const result = await readOriginalHostCpuProfile(path, true, host.testCpuProfileIntervalUs);
    assert.equal(result.status, 'available');
    assert.equal(result.samplingIntervalUs, 10000);
    assert.equal(result.rawDiscarded, true);
    assert.equal(result.fileOverLimit, false);
    assert.ok(result.fileBytes !== undefined && result.fileBytes > 0 && result.fileBytes <= 16 * 1024 * 1024);
    assert.equal(JSON.stringify(result).includes(root), false, 'closed evidence has no source URLs or paths');
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'missing', rawDiscarded: true,
    });
    writeFileSync(path, '', { mode: 0o600 });
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'empty-profile', rawDiscarded: true, fileBytes: 0, fileOverLimit: false,
    });
    const fd = openSync(path, 'w', 0o600);
    try { ftruncateSync(fd, 32 * 1024 * 1024); } finally { closeSync(fd); }
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'profile-over-limit', rawDiscarded: true,
      fileBytes: 16 * 1024 * 1024 + 1, fileOverLimit: true,
    });
    assert.equal(existsSync(path), false);

    // Synthetic stack attribution only: the original finite sampler above is the sole child.
    const privateSource = `file://${root}/TEST-private-cpu-token`;
    const frame = (source: string, functionName: string) => ({ url: `${privateSource}/${source}`, functionName });
    const clone = { url: 'node:internal/worker/js_transferable', functionName: 'structuredClone' };
    const profile = { startTime: 100, endTime: 1100, nodes: [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [2, 12] },
      { id: 2, callFrame: frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'), children: [3, 9, 10, 11] },
      { id: 3, callFrame: frame('adapters/team/TeamOwnerStore.js', 'fenced'), children: [4] },
      { id: 4, callFrame: frame('team/TeamOwner.js', 'state'), children: [5, 6] },
      { id: 5, callFrame: frame('team/TeamRuntimeRegistration.js', 'validate'), children: [] },
      { id: 6, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'current'), children: [7, 8] },
      { id: 7, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'read'), children: [14] },
      { id: 8, callFrame: clone, children: [] },
      { id: 9, callFrame: frame('foreign/FileTeamRuntimeBindings.js', 'current'), children: [] },
      { id: 10, callFrame: clone, children: [] },
      { id: 11, callFrame: frame('adapters/providers/OpenCodeV2CredentialScope.js', 'selected'), children: [] },
      { id: 12, callFrame: frame('adapters/team/FileTeamRuntimeBindings.js', 'current'), children: [13] },
      { id: 13, callFrame: clone, children: [] },
      { id: 14, callFrame: clone, children: [] },
    ], samples: [3, 4, 5, 6, 14, 8, 9, 10, 11, 13], timeDeltas: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] };
    writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
    const projected = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(projected.status, 'available');
    assert.equal(projected.sampledUs, 550); assert.equal(projected.unsampledUs, 450);
    assert.deepEqual(projected.categories.map(row => [row.category, row.exclusiveSamples,
      row.exclusiveSampledUs, row.inclusiveSamples, row.inclusiveSampledUs]), [
      ['configuration-read', 0, 0, 0, 0], ['credential-read', 1, 90, 1, 90],
      ['team-writer-authority', 8, 360, 9, 450], ['custody-image', 0, 0, 0, 0],
      ['provider-transport', 0, 0, 0, 0], ['other', 1, 100, 1, 100], ['idle', 0, 0, 0, 0],
    ], 'original broad totals and inclusive overlap remain unchanged');
    assert.deepEqual(projected.teamWriterDetails, [
      { family: 'namespace-fence', exclusiveSamples: 1, exclusiveSampledUs: 10 },
      { family: 'team-state', exclusiveSamples: 1, exclusiveSampledUs: 20 },
      { family: 'team-state-validation', exclusiveSamples: 1, exclusiveSampledUs: 30 },
      { family: 'launch-binding-read', exclusiveSamples: 1, exclusiveSampledUs: 50 },
      { family: 'launch-binding-current', exclusiveSamples: 1, exclusiveSampledUs: 40 },
      { family: 'launch-binding-clone', exclusiveSamples: 1, exclusiveSampledUs: 60 },
      { family: 'other-writer', exclusiveSamples: 2, exclusiveSampledUs: 150 },
    ]);
    assert.equal(projected.teamWriterDetails.reduce((sum, row) => sum + row.exclusiveSampledUs, 0), 360);
    assert.deepEqual(projected.teamWriterCallers.rows, ['node-timer', 'v2-request-admission', 'v2-request-password',
      'v2-read-snapshot', 'runtime-session-read', 'provider-attestation-wait', 'unclassified'].map(caller => ({
      caller, exclusiveSamples: caller === 'unclassified' ? 8 : 0,
      exclusiveSampledUs: caller === 'unclassified' ? 360 : 0,
      namespaceSamples: caller === 'unclassified' ? 1 : 0, namespaceSampledUs: caller === 'unclassified' ? 10 : 0,
    })), 'all fixed zero rows remain; non-writer exclusive samples never enter caller totals');
    assert.equal(JSON.stringify(projected).includes(root), false);
    assert.equal(JSON.stringify(projected).includes('TEST-private-cpu-token'), false);
    assert.equal(projected.rawDiscarded, true); assert.equal(existsSync(path), false);

    // Only original sampled ancestry identifies a caller; shared inner guards cannot replace it.
    const passwordFrame = frame('adapters/providers/OpenCodeV2MemberProvider.js', 'readPassword');
    const callerCases = [
      { caller: 'node-timer', frames: [{ url: 'node:internal/timers', functionName: 'processTimers' }, passwordFrame] },
      { caller: 'node-timer', frames: [{ url: 'node:internal/timers', functionName: 'listOnTimeout' }] },
      { caller: 'v2-request-admission', frames: [frame('adapters/providers/OpenCodeV2RequestAdmission.js', 'beforeRequest')] },
      { caller: 'v2-request-admission', frames: [frame('features/provider-session-implementation/adapters/opencode-protocol/v2-request-admission.js', 'acquire')] },
      { caller: 'v2-request-password', frames: [passwordFrame] },
      { caller: 'v2-request-password', frames: [{ ...frame('adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts', 'readPassword'),
        url: frame('adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts', 'readPassword').url.replaceAll('/', '\\') }] },
      { caller: 'v2-request-password', frames: [frame('features/provider-session-implementation/adapters/opencode-protocol/v2-execution-transport.js', 'requestHeaders')] },
      ...['read', 'attest', 'checkLease', 'beforeRequest', 'readPassword', 'fetchImpl'].map(functionName => ({
        caller: 'v2-read-snapshot', frames: [frame('adapters/providers/OpenCodeV2ReadOnlySnapshot.js', functionName), passwordFrame],
      })),
      { caller: 'runtime-session-read', frames: [frame('runtime/RuntimeOwner.ts', 'readSession')] },
      { caller: 'provider-attestation-wait', frames: [frame('adapters/providers/OpenCodeV2MemberProvider.js', 'waitForAttestation')] },
      { caller: 'unclassified', frames: [] }, // An async boundary may omit the initiating caller.
      { caller: 'unclassified', frames: [frame('foreign/OpenCodeV2MemberProvider.js', 'readPassword')] },
      { caller: 'unclassified', frames: [frame('adapters/providers/OpenCodeV2MemberProvider.js', 'unknown')] },
      { caller: 'unclassified', frames: [frame('adapters/providers/OpenCodeV2MemberProvider.js?private', 'readPassword')] },
      { caller: 'unclassified', frames: [frame('node:internal/timers', 'processTimers')] },
    ];
    const callerNodes: { id: number; callFrame: { url: string; functionName: string }; children: number[] }[] = [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [] },
    ];
    const callerSamples: number[] = [], callerDeltas: number[] = [];
    for (const [index, selected] of callerCases.entries()) {
      let parent = callerNodes[0]!;
      for (const callFrame of [...selected.frames,
        frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'),
        frame('adapters/team/TeamOwnerStore.js', 'fenced'), frame('team/TeamOwner.js', 'state')]) {
        const next = { id: callerNodes.length + 1, callFrame, children: [] as number[] };
        parent.children.push(next.id); callerNodes.push(next); parent = next;
      }
      callerSamples.push(parent.id - 1, parent.id);
      callerDeltas.push(10 * (index + 1), 3 * (index + 1));
    }
    writeFileSync(path, JSON.stringify({ startTime: 100, endTime: 100_000,
      nodes: callerNodes, samples: callerSamples, timeDeltas: callerDeltas }), { mode: 0o600 });
    const callerProjection = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(callerProjection.status, 'available');
    assert.equal(callerProjection.teamWriterCallers.attribution, 'outermost-allowlisted-caller-on-sampled-stack');
    const expectedCallers = ['node-timer', 'v2-request-admission', 'v2-request-password', 'v2-read-snapshot',
      'runtime-session-read', 'provider-attestation-wait', 'unclassified'].map(caller => {
      const weights = callerCases.flatMap((row, index) => row.caller === caller ? [index + 1] : []);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      return { caller, exclusiveSamples: 2 * weights.length, exclusiveSampledUs: 13 * total,
        namespaceSamples: weights.length, namespaceSampledUs: 10 * total };
    });
    assert.deepEqual(callerProjection.teamWriterCallers.rows, expectedCallers,
      'outer origins survive inner wrappers and never leak into sibling or unknown stacks');
    const writer = callerProjection.categories.find(row => row.category === 'team-writer-authority')!;
    const namespace = callerProjection.teamWriterDetails.find(row => row.family === 'namespace-fence')!;
    for (const [key, original] of [['exclusiveSamples', writer.exclusiveSamples],
      ['exclusiveSampledUs', writer.exclusiveSampledUs], ['namespaceSamples', namespace.exclusiveSamples],
      ['namespaceSampledUs', namespace.exclusiveSampledUs]] as const)
      assert.equal(callerProjection.teamWriterCallers.rows.reduce((sum, row) => sum + row[key], 0), original);
    assert.equal(writer.exclusiveSampledUs, callerProjection.sampledUs);
    assert.ok(callerProjection.teamWriterCallers.rows.every(row =>
      Object.values(row).filter(value => typeof value === 'number').every(value => Number.isSafeInteger(value) && value >= 0)));
    for (const privateValue of [root, 'TEST-private-cpu-token', 'readPassword', 'processTimers'])
      assert.equal(JSON.stringify(callerProjection).includes(privateValue), false);
    assert.equal(callerProjection.rawDiscarded, true); assert.equal(existsSync(path), false);

    writeFileSync(path, JSON.stringify({ ...profile, samples: [99], timeDeltas: [1] }), { mode: 0o600 });
    const malformed = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(malformed.status, 'unavailable'); assert.equal(malformed.reason, 'invalid-profile');
    assert.equal('teamWriterDetails' in malformed, false);
    assert.equal('teamWriterCallers' in malformed, false);
    assert.equal(malformed.rawDiscarded, true); assert.equal(existsSync(path), false);

    // Synthetic receipt decoding only: no additional native child or raw diagnostics are retained.
    const passive = createPassiveNativeDiagnosticCapture(), prefix = 'TEST_OPENCODE_V2_DIAGNOSTIC ';
    const secret = 'TEST-private-native-token';
    const fifth = prefix + JSON.stringify({ event: 'child-ready', atMs: 7, child: 5,
      raw: secret, path: root }) + '\n';
    passive.accept(Buffer.from(fifth.slice(0, 23)), 1);
    assert.equal(passive.entries.length, 0, 'a partial line does not invent an observation');
    passive.accept(Buffer.from(fifth.slice(23)), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'child-exit', atMs: 9,
      child: 6, exitCode: 0, unknownNativeField: secret }) + '\n' + secret + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'read-cut-failed', atMs: 10,
      stage: 'after-session', reason: secret, elapsedMs: 1, deadlineExpired: false, aborted: false }) + '\n'), 1);
    assert.equal(passive.entries.length, 2, 'receipt projection independently rejects an arbitrary read failure reason');
    assert.equal(passive.entries[0]!.child, 5, 'the source-derived metadata child remains observable');
    assert.equal(passive.entries[0]!.epoch, 1);
    assert.equal(passive.entries[1]!.child, null, 'an ordinal beyond the finite bound is not accepted');
    assert.equal(passive.entries[1]!.epoch, 2);
    assert.equal(JSON.stringify(passive.entries).includes(secret), false);
    assert.equal(JSON.stringify(passive.entries).includes(root), false);

    // The same synthetic capture spans epochs; UTF-8 bytes and the terminal reservation never reset.
    const pressure = { event: 'read-cut-failed', atMs: 3_600_000, child: 5, request: 4096,
      route: 'integration-connect', method: 'DELETE', status: 599, contentEncoding: 'other',
      stage: 'before-session', reason: 'native_session_binding_mismatch', elapsedMs: 60000,
      deadlineExpired: false, aborted: false, exitCode: 255, signal: 'SIGSEGV' };
    const oversized = prefix + JSON.stringify({ event: 'child-ready', atMs: 1, raw: 'é'.repeat(250) }) + '\n';
    assert.ok(oversized.length <= 513 && Buffer.byteLength(oversized) > 513, 'TEST line differs in UTF-8 byte length');
    passive.accept(Buffer.from(oversized), 1);
    assert.equal(passive.entries.length, 2, 'overlong UTF-8 input cannot consume an ordinary or terminal slot');
    for (let index = 0; index < 300; index++) passive.accept(Buffer.from(prefix + JSON.stringify(pressure) + '\n'), index < 150 ? 1 : 2);
    const ordinary = passive.entries.length;
    const beforeBytes = passive.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    assert.ok(ordinary < 255, 'closed-row bytes saturate before ordinary count in this capture');
    assert.ok(beforeBytes > 64 * 1024 - 3 * 513 && beforeBytes <= 64 * 1024 - 2 * 513);
    const terminal = { event: 'metadata-read-failed', atMs: 11, stage: 'admission', reason: 'held',
      elapsedMs: 0, deadlineExpired: true, aborted: null, raw: secret };
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'trace-limit', atMs: 10 }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, reason: secret }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, stage: 'directory' }) + '\n'), 2);
    assert.equal(passive.entries.length, ordinary + 1, 'malformed receiver records cannot consume the reserved terminal slot');
    passive.accept(Buffer.from(prefix + JSON.stringify(terminal) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, stage: 'directory', reason: 'deadline', aborted: true }) + '\n'), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'trace-limit', atMs: 12 }) + '\n'), 1);
    assert.equal(passive.entries.length, ordinary + 2, 'epoch changes do not reset either reserved slot');
    const terminalRows = passive.entries.filter(row => row.event === 'metadata-read-failed');
    assert.equal(terminalRows.length, 1);
    assert.ok(isDeepStrictEqual({ epoch: terminalRows[0]!.epoch, stage: terminalRows[0]!.stage,
      code: terminalRows[0]!.code, aborted: terminalRows[0]!.aborted },
    { epoch: 2, stage: 'admission', code: 'held', aborted: null }),
    'one original pre-signal failure survives across epochs without raw fields');
    assert.equal(passive.entries.filter(row => row.event === 'trace-limit').length, 1);
    assert.equal(passive.limited, true);
    assert.ok(passive.entries.length <= 257);
    assert.ok(passive.entries.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 513));
    assert.ok(passive.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0) <= 64 * 1024);
    assert.equal(JSON.stringify(passive.entries).includes(secret), false);
    assert.equal(JSON.stringify(passive.entries).includes(root), false);
  } finally {
    if (host.child.exitCode === null && host.child.signalCode === null) await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('native fixture observes advertised disposal before signaling the original child', async () => {
  const original = { now: 0, endCalls: 0, signals: [] as number[], waits: [] as number[] };
  // Runtime may already be closed; final backup is still allowed to finish at 45 s.
  await closeNativeHostInput(
    {
      endInput() {
        original.endCalls++;
      },
      async waitExit(timeoutMs) {
        original.waits.push(timeoutMs);
        const deadline = original.now + timeoutMs;
        if (deadline >= 45_000) {
          original.now = 45_000;
          return true;
        }
        original.now = deadline;
        return false;
      },
      terminate() {
        original.signals.push(original.now);
      },
    },
    60_000
  );
  assert.equal(original.endCalls, 1);
  assert.equal(original.now, 45_000);
  assert.deepEqual(original.waits, [62_000]);
  assert.deepEqual(
    original.signals,
    [],
    'same original child finishes naturally within its contract'
  );
});

test('native fixture retains failure after one bounded original-child fallback', async () => {
  let now = 0,
    endCalls = 0;
  const signals: number[] = [];
  await assert.rejects(
    closeNativeHostInput(
      {
        endInput() {
          endCalls++;
        },
        async waitExit(timeoutMs) {
          now += timeoutMs;
          return false;
        },
        terminate() {
          signals.push(now);
        },
      },
      60_000
    ),
    /captured Host must confirm provider cleanup before exiting/
  );
  assert.equal(endCalls, 1);
  assert.deepEqual(signals, [62_000]);
  assert.equal(now, 74_000, 'unconfirmed exit remains a bounded failure');
});

test('native fixture refuses invalid disposal budgets before touching the original child', async () => {
  const effects: string[] = [];
  for (const invalid of [60_001, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    await assert.rejects(
      closeNativeHostInput(
        {
          endInput() {
            effects.push('end');
          },
          async waitExit() {
            effects.push('wait');
            return true;
          },
          terminate() {
            effects.push('signal');
          },
        },
        invalid
      ),
      /within the captured TeamHost contract/
    );
  }
  assert.deepEqual(effects, []);
});
