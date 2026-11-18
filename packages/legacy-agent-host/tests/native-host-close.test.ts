import assert from 'node:assert/strict';
import { once } from 'node:events';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { closeNativeHostInput, readNativeHostFrame, startHost } from './fixtures/native-host.ts';
import { ATTACHMENT_CHUNK_BYTES } from '../dist/attachments/contracts.js';
import { createPassiveNativeDiagnosticCapture, readOriginalHostCpuProfile } from './fixtures/native-opencode-team/passive-diagnostics.ts';

test('native Host keeps ordinary frame bounds and accepts only an exact request-bound attachment chunk', () => {
  const request = { method: 'team.message.attachment.read', messageAttachmentRead: {
    reference: 'TEST-message', attachmentId: 'TEST-image', offset: 0, expectedSha256: 'a'.repeat(64),
  } };
  const pending = new Map([[7, request]]);
  const value = { attachment: { id: 'TEST-image', filename: 'TEST-image.png', mimeType: 'image/png', size: 4 * 1024 * 1024 },
    offset: 0, sha256: request.messageAttachmentRead.expectedSha256,
    base64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 0x61).toString('base64'), nextOffset: ATTACHMENT_CHUNK_BYTES };
  const frame = { jsonrpc: '2.0', id: 7, result: { ok: true, value } };
  const line = JSON.stringify(frame);
  assert.ok(Buffer.byteLength(line) > 256 * 1024 && Buffer.byteLength(line) < 1024 * 1024);
  assert.deepEqual(readNativeHostFrame(line, pending), frame);
  assert.throws(() => readNativeHostFrame(' '.repeat(256 * 1024) + line, pending),
    'raw whitespace overhead must not disappear through JSON reserialization');
  const finalOffset = 10 * ATTACHMENT_CHUNK_BYTES;
  const final = { ...frame, result: { ok: true, value: { ...value, offset: finalOffset,
    base64: Buffer.alloc(value.attachment.size - finalOffset, 0x61).toString('base64'), nextOffset: null } } };
  assert.deepEqual(readNativeHostFrame(JSON.stringify(final), new Map([[7, { ...request,
    messageAttachmentRead: { ...request.messageAttachmentRead, offset: finalOffset } }]])), final);
  const ordinary = { jsonrpc: '2.0', id: 7, result: { ok: true, value: 'x'.repeat(256 * 1024 - 100) } };
  assert.deepEqual(readNativeHostFrame(JSON.stringify(ordinary), new Map()), ordinary);
  for (const reply of [
    { ...ordinary, result: { ok: true, value: 'x'.repeat(256 * 1024) } },
    { ...ordinary, result: { ok: true, value: 'x'.repeat(1024 * 1024) } },
    { jsonrpc: '2.0', method: 'host.gap', params: value },
    { jsonrpc: '2.0', id: 7, error: { code: -1, message: value.base64 } },
    { ...frame, id: 8 }, { ...frame, jsonrpc: 'TEST-invalid' }, { ...frame, privatePath: '/TEST-private' },
    { ...frame, result: { ...frame.result, privatePath: '/TEST-private' } },
    { ...frame, result: { ...frame.result, ok: false } },
  ]) assert.throws(() => readNativeHostFrame(JSON.stringify(reply), pending));
  for (const changed of [
    { ...value, privatePath: '/TEST-private' },
    { ...value, attachment: { ...value.attachment, privatePath: '/TEST-private' } },
    { ...value, attachment: { ...value.attachment, id: 'TEST-other' } },
    { ...value, offset: 1 }, { ...value, sha256: 'b'.repeat(64) }, { ...value, nextOffset: null },
    { ...value, base64: value.base64.slice(0, -1) + '\n' },
    { ...value, base64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1).toString('base64') },
    { ...value, base64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES - 1).toString('base64'), nextOffset: ATTACHMENT_CHUNK_BYTES - 1 },
  ]) assert.throws(() => readNativeHostFrame(JSON.stringify({ ...frame, result: { ok: true, value: changed } }), pending));
  for (const captured of [
    { ...request, method: 'runtime.read' }, { method: request.method },
    { ...request, messageAttachmentRead: { ...request.messageAttachmentRead, expectedSha256: undefined } },
    { ...request, messageAttachmentRead: { ...request.messageAttachmentRead, attachmentId: 'TEST-other' } },
    { ...request, messageAttachmentRead: { ...request.messageAttachmentRead, offset: 1 } },
    { ...request, messageAttachmentRead: { ...request.messageAttachmentRead, expectedSha256: 'b'.repeat(64) } },
  ]) assert.throws(() => readNativeHostFrame(line, new Map([[7, captured]])));
});

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
for (const path of ['/api/session/TEST-session/log',
  '/api/experimental/session/TEST-session/instructions/entries', '/api/info']) {
  const request = { origin: 'http://127.0.0.1:65530', path: path + '?private=' + secret, method: 'GET' };
  publish('undici:request:create', request);
  publish('undici:request:trailers', { ...request });
  publish('undici:request:trailers', request);
}
const failedRead = channel('agent-teams:opencode-v2:read-cut-failed');
const failure = { stage: 'after-session', reason: 'deadline', elapsedMs: 30001, deadlineExpired: true, aborted: false };
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
const failedClose = channel('agent-teams:opencode-v2:host-probe-close-failed');
const closeFailure = { probeDigest: 'a'.repeat(64), runState: 'pending', outcome: 'unobserved',
  errorClass: 'none', stage: 'request-drain', reason: 'unconfirmed' };
for (const field of ['probeDigest', 'runState', 'outcome', 'errorClass', 'stage', 'reason'])
  failedClose.publish({ ...closeFailure, [field]: secret });
failedClose.publish({ ...closeFailure, probeDigest: 'a'.repeat(65) });
failedClose.publish(Object.defineProperty({ ...closeFailure }, 'outcome', { get() { accessorCalls++; throw new Error(secret); } }));
failedClose.publish(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } }));
if (accessorCalls !== 0) process.exit(3);
const failedReadiness = channel('agent-teams.legacy-host.first-refusal');
const readiness = { kind: 'consumer', phase: 'cutoff', reason: 'held', cutoff: 1000, observedAt: 1262 };
for (const invalid of [{ ...readiness, kind: 'reference' }, { ...readiness, phase: secret },
  { ...readiness, reason: secret }, { ...readiness, cutoff: -1 }, { ...readiness, observedAt: null },
  { ...readiness, observedAt: Number.MAX_SAFE_INTEGER + 1 }]) failedReadiness.publish(invalid);
for (const field of ['kind', 'phase', 'reason', 'cutoff', 'observedAt'])
  failedReadiness.publish(Object.defineProperty({ ...readiness }, field,
    { get() { accessorCalls++; throw new Error(secret); } }));
failedReadiness.publish(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } }));
if (accessorCalls !== 0) process.exit(3);
for (let index = 0; index < 300; index++) publish('undici:request:create',
  { origin: 'http://127.0.0.1:65530', path: '/api/info?private=' + secret, method: 'GET' });
failedRead.publish({ ...failure, reason: secret });
failedRead.publish({ ...failure, error: secret, stack: secret, sessionId: secret, path: ${JSON.stringify(root)} });
failedRead.publish({ ...failure, reason: 'cleanup_unknown', aborted: true });
failedMetadata.publish({ ...metadata, error: secret, stack: secret, path: ${JSON.stringify(root)} });
failedMetadata.publish({ ...metadata, reason: 'deadline', elapsedMs: 30001, deadlineExpired: true });
failedClose.publish({ ...closeFailure, error: secret, stack: secret, token: secret, path: ${JSON.stringify(root)} });
failedClose.publish({ ...closeFailure, stage: 'server-stop', runState: 'false' });
failedReadiness.publish({ ...readiness, error: secret, consumerId: secret, actionDigest: secret,
  currentCalls: { private: secret }, path: ${JSON.stringify(root)} });
failedReadiness.publish({ ...readiness, phase: 'reference', reason: 'threw' });
const runtimeOpen = { source: 'factory', phase: 'driver-open', category: 'held', observedAtMs: 1262 };
for (const invalid of [{ ...runtimeOpen, source: secret }, { ...runtimeOpen, phase: secret },
  { ...runtimeOpen, source: 'runtime', phase: 'provider-create' },
  { ...runtimeOpen, category: secret }, { ...runtimeOpen, observedAtMs: -1 }])
  process.stderr.write('legacy-agent-host: runtime-open ' + JSON.stringify(invalid) + '\\n');
process.stderr.write('legacy-agent-host: runtime-open ' + JSON.stringify({ ...runtimeOpen,
  profileHash: secret, configurationHash: secret, error: secret }) + '\\n');
process.stderr.write('legacy-agent-host: runtime-open ' + JSON.stringify({ ...runtimeOpen,
  source: 'runtime', observedAtMs: 1263 }) + '\\n');
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
    assert.deepEqual(originalTrace.entries.slice(0, 7).map(row => [row.event, row.request, row.route]), [
      ['request', 1, 'plugins'], ['request-send-headers', 1, 'plugins'], ['request-body-sent', 1, 'plugins'],
      ['request', 2, 'model-catalog'], ['request-send-headers', 2, 'model-catalog'], ['request-body-sent', 2, 'model-catalog'],
      ['request', 3, 'info'],
    ], 'same-object targeted phases appear once; foreign objects and untargeted phases are ignored');
    assert.ok(originalTrace.entries.slice(0, 7).every(row => row.epoch === 1 && row.method === 'GET' &&
      typeof row.atMs === 'number' && (row.event === 'request' ? row.durationMs === null :
        typeof row.durationMs === 'number' && row.durationMs >= 0)));
    const responseEnds = originalTrace.entries.filter(row => row.event === 'response-end');
    assert.deepEqual(responseEnds.map(row => [row.request, row.route]), [[4, 'log'], [5, 'instructions']],
      'only the original finite log/instruction request objects can report body arrival');
    assert.ok(responseEnds.every(row => row.epoch === 1 && row.method === 'GET' &&
      typeof row.atMs === 'number' && typeof row.durationMs === 'number' && row.durationMs >= 0));
    const readFailures = originalTrace.entries.filter(row => row.event === 'read-cut-failed');
    assert.equal(readFailures.length, 1, 'reserved late read failure survives original trace saturation once');
    const readFailure = readFailures[0]!;
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
    const closeFailures = originalTrace.entries.filter(row => row.event === 'host-probe-close-failed');
    assert.equal(closeFailures.length, 1, 'one reserved Host close failure survives original trace saturation');
    assert.deepEqual({ epoch: closeFailures[0]!.epoch, stage: closeFailures[0]!.stage, code: closeFailures[0]!.code,
      probeDigest: closeFailures[0]!.probeDigest, runState: closeFailures[0]!.runState,
      outcome: closeFailures[0]!.outcome, errorClass: closeFailures[0]!.errorClass },
    { epoch: 1, stage: 'request-drain', code: 'unconfirmed', probeDigest: 'a'.repeat(64),
      runState: 'pending', outcome: 'unobserved', errorClass: 'none' });
    const readinessFailures = originalTrace.entries.filter(row => row.event === 'readiness-refused');
    assert.equal(readinessFailures.length, 1, 'first consumer refusal survives saturation without invoking getters');
    const { atMs: readinessAt, ...readinessFailure } = readinessFailures[0]!;
    assert.ok(typeof readinessAt === 'number' && readinessAt >= 0);
    assert.deepEqual(readinessFailure, { epoch: 1, event: 'readiness-refused', kind: 'consumer',
      phase: 'cutoff', reason: 'held', cutoff: 1000, observedAt: 1262, expired: true });
    assert.deepEqual(originalTrace.entries.filter(row => row.event === 'runtime-open-failed'), [
      { epoch: 1, event: 'runtime-open-failed', source: 'factory', phase: 'driver-open',
        category: 'held', observedAtMs: 1262 },
    ], 'first existing refusal is retained without hashes, IDs or fabricated elapsed time');
    assert.deepEqual(originalTrace.entries.slice(-6).map(row => row.event),
      ['trace-limit', 'read-cut-failed', 'metadata-read-failed', 'host-probe-close-failed',
        'readiness-refused', 'runtime-open-failed']);
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
      ['v8-garbage-collector', 0, 0, 0, 0], ['v8-program', 0, 0, 0, 0],
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
    assert.deepEqual(projected.namespaceFenceDetails, [
      { family: 'directoryPath', exclusiveSamples: 0, exclusiveSampledUs: 0 },
      { family: 'tree', exclusiveSamples: 0, exclusiveSampledUs: 0 },
      { family: 'controller-lock', exclusiveSamples: 0, exclusiveSampledUs: 0 },
      { family: 'residual', exclusiveSamples: 1, exclusiveSampledUs: 10 },
    ]);
    assert.equal(JSON.stringify(projected).includes(root), false);
    assert.equal(JSON.stringify(projected).includes('TEST-private-cpu-token'), false);
    assert.equal(projected.rawDiscarded, true); assert.equal(existsSync(path), false);

    // Fixed V8 states split previously unclassified samples without retaining frame text.
    const vmFrames = [
      { url: '', functionName: '(garbage collector)' }, { url: '', functionName: '(program)' },
      { url: '', functionName: '(idle)' }, frame('private.js', '(garbage collector)'),
      frame('private.js', '(program)'), { url: '', functionName: '(garbage collector) ' },
      { url: '', functionName: 'TEST-private-cpu-token' },
    ];
    writeFileSync(path, JSON.stringify({ startTime: 100, endTime: 300, nodes: [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: vmFrames.map((_, index) => index + 2) },
      ...vmFrames.map((callFrame, index) => ({ id: index + 2, callFrame, children: [] })),
    ], samples: [2, 3, 4, 5, 6, 7, 8], timeDeltas: [11, 13, 17, 19, 23, 29, 31] }), { mode: 0o600 });
    const vmProjection = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(vmProjection.status, 'available');
    assert.equal(vmProjection.sampledUs, 143); assert.equal(vmProjection.unsampledUs, 57);
    assert.deepEqual(vmProjection.categories.filter(row => row.exclusiveSamples > 0)
      .map(row => [row.category, row.exclusiveSamples, row.exclusiveSampledUs]), [
        ['other', 4, 102], ['idle', 1, 17], ['v8-garbage-collector', 1, 11], ['v8-program', 1, 13],
      ], 'only exact empty-URL VM frames are classified; lookalikes remain other');
    assert.equal(vmProjection.categories.reduce((sum, row) => sum + row.exclusiveSampledUs, 0), 143);
    for (const privateValue of [root, 'TEST-private-cpu-token', '(garbage collector)', '(program)'])
      assert.equal(JSON.stringify(vmProjection).includes(privateValue), false);
    assert.equal(vmProjection.rawDiscarded, true); assert.equal(existsSync(path), false);

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
    const callerNamespace = callerProjection.teamWriterDetails.find(row => row.family === 'namespace-fence')!;
    for (const [key, original] of [['exclusiveSamples', writer.exclusiveSamples],
      ['exclusiveSampledUs', writer.exclusiveSampledUs], ['namespaceSamples', callerNamespace.exclusiveSamples],
      ['namespaceSampledUs', callerNamespace.exclusiveSampledUs]] as const)
      assert.equal(callerProjection.teamWriterCallers.rows.reduce((sum, row) => sum + row[key], 0), original);
    assert.equal(writer.exclusiveSampledUs, callerProjection.sampledUs);
    assert.ok(callerProjection.teamWriterCallers.rows.every(row =>
      Object.values(row).filter(value => typeof value === 'number').every(value => Number.isSafeInteger(value) && value >= 0)));
    for (const privateValue of [root, 'TEST-private-cpu-token', 'readPassword', 'processTimers'])
      assert.equal(JSON.stringify(callerProjection).includes(privateValue), false);
    assert.equal(callerProjection.rawDiscarded, true); assert.equal(existsSync(path), false);

    // Same reader/child: controlled namespace stacks, never a claimed native distribution.
    const namespaceProfile = { ...profile, nodes: [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [2, 40, 42] },
      { id: 2, callFrame: frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'), children: [3] },
      { id: 3, callFrame: frame('adapters/team/TeamOwnerStore.js', 'fenced'), children: [4, 6, 9, 18, 19, 20, 21, 22] },
      { id: 4, callFrame: frame('adapters/team/TeamOwnerStore.js', 'directoryPath'), children: [5, 28, 34, 36] },
      { id: 5, callFrame: frame('node-fs.js', 'lstatSync'), children: [] },
      { id: 6, callFrame: frame('adapters/team/TeamOwnerStore.js', 'tree'), children: [7] },
      { id: 7, callFrame: frame('adapters/team/TeamOwnerStore.js', 'tree'), children: [8] },
      { id: 8, callFrame: frame('node-fs.js', 'readdirSync'), children: [] },
      { id: 9, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'withFileLockSync'), children: [10, 13, 14] },
      { id: 10, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'acquireFileLockSync'), children: [11, 15, 23, 30] },
      { id: 11, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'sleepSync'), children: [12] },
      { id: 12, callFrame: frame('node-internal.js', 'TEST-private-function-token'), children: [] },
      { id: 13, callFrame: frame('agent-teams-controller\\dist\\internal\\fileLock.js', 'releaseLock'), children: [] },
      { id: 14, callFrame: frame('protected-action.js', ''), children: [] },
      { id: 15, callFrame: frame('adapters/team/TeamOwnerStore.js', 'validateNamespace'), children: [16] },
      { id: 16, callFrame: frame('unknown-helper.js', ''), children: [] },
      { id: 18, callFrame: frame('foreign/src/internal/fileLock.js', 'sleepSync'), children: [] },
      { id: 19, callFrame: frame('host/packages/0007/src/internal/fileLock.js', 'releaseLock'), children: [] },
      { id: 20, callFrame: frame('adapters/team/TeamOwnerStore.js', ''), children: [] },
      { id: 21, callFrame: frame('foreign/TeamOwnerStore.js', 'directoryPath'), children: [] },
      { id: 22, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'withFileLockSyncExtra'), children: [] },
      { id: 23, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'withFileLockSync'), children: [24] },
      { id: 24, callFrame: frame('protected-action.js', ''), children: [] },
      { id: 28, callFrame: frame('adapters/team/TeamOwnerStore.js', 'fenced'), children: [29] },
      { id: 29, callFrame: frame('unknown-helper.js', ''), children: [] },
      { id: 30, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'withFileLock'), children: [31] },
      { id: 31, callFrame: frame('protected-action.js', ''), children: [] },
      { id: 34, callFrame: frame('team/TeamOwner.js', 'state'), children: [35] },
      { id: 35, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'sleepSync'), children: [] },
      { id: 36, callFrame: frame('adapters/providers/OpenCodeV2CredentialScope.js', 'selected'), children: [37, 38] },
      { id: 37, callFrame: frame('node-fs.js', 'lstatSync'), children: [] },
      { id: 38, callFrame: frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'), children: [39] },
      { id: 39, callFrame: frame('unknown-helper.js', ''), children: [] },
      { id: 40, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'acquireFileLockSync'), children: [41] },
      { id: 41, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'sleepSync'), children: [] },
      { id: 42, callFrame: frame('composition/captureMemberProviderAuthority.js', 'assertCurrent'), children: [43] },
      { id: 43, callFrame: frame('agent-teams-controller/src/internal/fileLock.js', 'sleepSync'), children: [] },
    ], samples: [5, 8, 12, 13, 14, 16, 18, 19, 20, 21, 22, 24, 31, 29, 35, 37, 39, 41, 43],
    timeDeltas: [11, 13, 17, 29, 23, 53, 31, 37, 41, 43, 47, 83, 89, 59, 61, 67, 71, 73, 79] };
    writeFileSync(path, JSON.stringify(namespaceProfile), { mode: 0o600 });
    const refined = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(refined.status, 'available');
    assert.equal(refined.sampledUs, 927); assert.equal(refined.unsampledUs, 73);
    assert.deepEqual(refined.namespaceFenceDetails, [
      { family: 'directoryPath', exclusiveSamples: 1, exclusiveSampledUs: 11 },
      { family: 'tree', exclusiveSamples: 1, exclusiveSampledUs: 13 },
      { family: 'controller-lock', exclusiveSamples: 2, exclusiveSampledUs: 46 },
      { family: 'residual', exclusiveSamples: 11, exclusiveSampledUs: 577 },
    ]);
    assert.deepEqual(refined.teamWriterDetails.map(row => [row.exclusiveSamples, row.exclusiveSampledUs]),
      [[15, 647], [1, 61], [0, 0], [0, 0], [0, 0], [0, 0], [1, 79]]);
    assert.deepEqual(refined.categories.map(row => [row.exclusiveSamples, row.exclusiveSampledUs,
      row.inclusiveSamples, row.inclusiveSampledUs]),
      [[0, 0, 0, 0], [1, 67, 2, 138], [17, 787, 18, 854], [0, 0, 0, 0],
        [0, 0, 0, 0], [1, 73, 1, 73], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const namespace = refined.teamWriterDetails[0]!;
    assert.equal(refined.namespaceFenceDetails.reduce((sum, row) => sum + row.exclusiveSamples, 0),
      namespace.exclusiveSamples);
    assert.equal(refined.namespaceFenceDetails.reduce((sum, row) => sum + row.exclusiveSampledUs, 0),
      namespace.exclusiveSampledUs);
    for (const secret of [root, 'TEST-private-cpu-token', 'TEST-private-function-token', 'sleepSync', 'fileLock.js'])
      assert.equal(JSON.stringify(refined).includes(secret), false);
    assert.equal(refined.rawDiscarded, true); assert.equal(existsSync(path), false);
    writeFileSync(path, JSON.stringify({ ...profile, samples: [99], timeDeltas: [1] }), { mode: 0o600 });
    const malformed = await readOriginalHostCpuProfile(path, true, 10000);
    assert.equal(malformed.status, 'unavailable'); assert.equal(malformed.reason, 'invalid-profile');
    assert.equal('teamWriterDetails' in malformed, false);
    assert.equal('teamWriterCallers' in malformed, false);
    assert.equal('namespaceFenceDetails' in malformed, false);
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
    const pressure = { event: 'response', atMs: 3_600_000, child: 5, request: 4096,
      route: 'integration-connect', method: 'DELETE', status: 599, contentEncoding: 'other',
      stage: 'configuration', code: 'UND_ERR_HEADERS_TIMEOUT', durationMs: 3_600_000,
      exitCode: 255, signal: 'SIGSEGV' };
    const oversized = prefix + JSON.stringify({ event: 'child-ready', atMs: 1, raw: 'é'.repeat(250) }) + '\n';
    assert.ok(oversized.length <= 513 && Buffer.byteLength(oversized) > 513, 'TEST line differs in UTF-8 byte length');
    passive.accept(Buffer.from(oversized), 1);
    assert.equal(passive.entries.length, 2, 'overlong UTF-8 input cannot consume an ordinary or terminal slot');
    for (let index = 0; index < 300; index++) passive.accept(Buffer.from(prefix + JSON.stringify(pressure) + '\n'), index < 150 ? 1 : 2);
    const ordinary = passive.entries.length;
    const beforeBytes = passive.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    assert.ok(ordinary < 253, 'closed-row bytes saturate before ordinary count in this capture');
    assert.ok(beforeBytes > 64 * 1024 - 7 * 513 && beforeBytes <= 64 * 1024 - 6 * 513);
    const terminal = { event: 'metadata-read-failed', atMs: 11, stage: 'admission', reason: 'held',
      elapsedMs: 0, deadlineExpired: true, aborted: null, raw: secret };
    const lateRead = { event: 'read-cut-failed', atMs: 12, stage: 'after-log', reason: 'cleanup_unknown',
      elapsedMs: 9, deadlineExpired: false, aborted: true, raw: secret };
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'trace-limit', atMs: 10 }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, reason: secret }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, stage: 'directory' }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...lateRead, reason: secret }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...lateRead, aborted: null }) + '\n'), 2);
    const hostClose = { event: 'host-probe-close-failed', atMs: 13, probeDigest: 'b'.repeat(64),
      runState: 'threw', outcome: 'unknown', errorClass: 'held', stage: 'driver-close', reason: 'threw', raw: secret };
    for (const field of ['probeDigest', 'runState', 'outcome', 'errorClass', 'stage', 'reason'])
      passive.accept(Buffer.from(prefix + JSON.stringify({ ...hostClose, [field]: secret }) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...hostClose, probeDigest: 'b'.repeat(65) }) + '\n'), 2);
    const oversizedClose = prefix + JSON.stringify({ ...hostClose, raw: 'é'.repeat(250) }) + '\n';
    assert.ok(Buffer.byteLength(oversizedClose) > 513);
    passive.accept(Buffer.from(oversizedClose), 2);
    assert.equal(passive.entries.length, ordinary + 1, 'malformed receiver records cannot consume reserved failure slots');
    passive.accept(Buffer.from(prefix + JSON.stringify(terminal) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify(lateRead) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify(hostClose) + '\n'), 2);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...terminal, stage: 'directory', reason: 'deadline', aborted: true }) + '\n'), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...lateRead, reason: 'deadline' }) + '\n'), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ event: 'trace-limit', atMs: 12 }) + '\n'), 1);
    passive.accept(Buffer.from(prefix + JSON.stringify({ ...hostClose, stage: 'server-stop', reason: 'unconfirmed' }) + '\n'), 1);
    assert.equal(passive.entries.length, ordinary + 4, 'epoch changes do not reset any reserved slot');
    const hostCloses = passive.entries.filter(row => row.event === 'host-probe-close-failed');
    assert.equal(hostCloses.length, 1);
    assert.deepEqual({ epoch: hostCloses[0]!.epoch, stage: hostCloses[0]!.stage, code: hostCloses[0]!.code,
      probeDigest: hostCloses[0]!.probeDigest, runState: hostCloses[0]!.runState,
      outcome: hostCloses[0]!.outcome, errorClass: hostCloses[0]!.errorClass },
    { epoch: 2, stage: 'driver-close', code: 'threw', probeDigest: 'b'.repeat(64),
      runState: 'threw', outcome: 'unknown', errorClass: 'held' });
    const terminalRows = passive.entries.filter(row => row.event === 'metadata-read-failed');
    assert.equal(terminalRows.length, 1);
    assert.ok(isDeepStrictEqual({ epoch: terminalRows[0]!.epoch, stage: terminalRows[0]!.stage,
      code: terminalRows[0]!.code, aborted: terminalRows[0]!.aborted },
    { epoch: 2, stage: 'admission', code: 'held', aborted: null }),
    'one original pre-signal failure survives across epochs without raw fields');
    const lateReads = passive.entries.filter(row => row.event === 'read-cut-failed');
    assert.equal(lateReads.length, 1);
    assert.deepEqual({ epoch: lateReads[0]!.epoch, stage: lateReads[0]!.stage,
      code: lateReads[0]!.code, aborted: lateReads[0]!.aborted },
    { epoch: 2, stage: 'after-log', code: 'cleanup_unknown', aborted: true });
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
