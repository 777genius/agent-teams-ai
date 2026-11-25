import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { it as test } from 'vitest';

import { createClaudeCloseDiagnostic, createClaudeManagementDiagnostic, createOpenCodeMetadataDiagnostic, createOpenCodeProbeCloseDiagnostic, createOpenCodeProbeDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { createCapturedHostDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/createCapturedHostDiagnostics';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { OpenCodeProbeCloseDiagnostic, OpenCodeProbeDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
  memberId: 'TEST-member', generation: 'restore-123' };
const prefix = 'legacy-agent-host: claude-close ';
const frame = (overrides: Record<string, unknown> = {}) => `${prefix}${JSON.stringify({
  binding, sessionRef: 'TEST-session', stage: 'custody-confirmed', physicalConfirmed: true, ...overrides })}\n`;
test('private close decoder handles splits, bounds malformed lines and never forwards raw stderr', async () => {
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(value => { values.push(value); });
  const valid = Buffer.from(frame());
  for (const byte of valid) decode(Buffer.from([byte]));
  const secret = 'TEST-raw-secret-error-and-path';
  decode(Buffer.from(`unrelated ${secret}\n${prefix}{broken:${secret}}\n`));
  decode(Buffer.from(frame({ extra: secret }) + frame({ stage: secret }) + frame({ binding: { ...binding, memberId: '/private/path' } })));
  decode(Buffer.from(frame({ physicalConfirmed: false })));
  decode(Buffer.from(`${prefix}${'x'.repeat(9000)}`));
  decode(Buffer.from(`discarded-${secret}\n${frame({ stage: 'sdk-read-error' })}${frame({ stage: 'capture-close-completed' })}`));
  assert.equal(values.length, 3);
  assert.deepEqual(values.map(value => (value as {stage: string}).stage), ['custody-confirmed', 'sdk-read-error', 'capture-close-completed']);
  assert.equal(JSON.stringify(values).includes(secret), false);
  assert.ok(values.every(Object.isFrozen));
  let calls = 0;
  const throwing = decodeClaudeCloseDiagnostics(() => { calls++; if (calls === 1) throw new Error(secret); return Promise.reject(new Error(secret)); });
  assert.doesNotThrow(() => throwing(Buffer.from(frame() + frame())));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'one broken diagnostic sink does not stop subsequent decoding');
});
test('Host captures original binding and emits only bounded finite stage diagnostics', () => {
  const lines: string[] = [];
  const selected = { ...binding };
  const observe = createClaudeCloseDiagnostic(selected, 'TEST-session', line => { lines.push(line); });
  selected.generation = 'later';
  observe({ stage: 'custody', outcome: 'confirmed' });
  observe({ stage: 'sdk-close', outcome: 'completed' });
  observe({ stage: 'sdk-read', outcome: 'error' });
  observe({ stage: 'capture-close', outcome: 'completed' });
  observe({ stage: 'capture-close', outcome: 'error' });
  assert.equal(lines.length, 4);
  const retained: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(value => { retained.push(value); });
  decode(Buffer.from(lines.join('')));
  assert.equal(retained.length, 4);
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 8192));
  assert.ok(lines.every(line => line.includes('restore-123') && !line.includes('later')));
  assert.ok(lines.every(line => line.includes('"physicalConfirmed":true')));
  assert.doesNotThrow(() => createClaudeCloseDiagnostic(binding, 'TEST-session', () => { throw new Error('TEST write failure'); })({ stage: 'custody', outcome: 'unconfirmed' }));
});


test('management diagnostics retain only finite failure stages/codes and captured hashes through existing framing', async () => {
  const secret = 'TEST-private-error-token-/config/path';
  const selected = { profileId: 'TEST-profile', configRevision: 'TEST-revision', environment: { HOME: secret, CLAUDE_CONFIG_DIR: secret } };
  const lines: string[] = [];
  const observe = createClaudeManagementDiagnostic(selected, secret, line => { lines.push(line); });
  selected.environment.HOME = 'changed';
  observe('host-probe', new Error('claude.probe.invalid-response'));
  observe('host-probe', new Error(secret));
  observe('host-cleanup', new Error('cleanup-unconfirmed'));
  observe('probe-metadata-wait', new Error('claude.metadata.timeout'));
  observe('host-probe', new Error(secret));
  assert.equal(lines.length, 4); assert.equal(lines.join('').includes(secret), false);
  assert.equal(lines.join('').includes('changed'), false); assert.equal(lines.join('').includes('TEST-profile'), false);
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, value => { values.push(value); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.deepEqual(values.map(value => (value as {code: string}).code), ['claude.probe.invalid-response', 'unavailable', 'cleanup-unconfirmed', 'claude.metadata.timeout']);
  assert.ok(values.every(Object.isFrozen));
  const valid = JSON.parse(lines[0]!.slice('legacy-agent-host: claude-management '.length)) as Record<string, unknown>;
  for (const unsafe of [{ ...valid, extra: secret }, { ...valid, profileHash: secret }, { ...valid, code: secret }, { ...valid, stage: secret }])
    decode(Buffer.from(`legacy-agent-host: claude-management ${JSON.stringify(unsafe)}\n`));
  assert.equal(values.length, 4);
  assert.doesNotThrow(() => createClaudeManagementDiagnostic(selected, undefined, () => { throw new Error(secret); })('host-probe', new Error(secret)));
  let calls = 0;
  const failedSink = decodeClaudeCloseDiagnostics(() => {}, () => { calls++; return Promise.reject(new Error(secret)); });
  assert.doesNotThrow(() => failedSink(Buffer.from(lines.join(''))));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 4);
});

test('retains original auth cleanup refusal through existing bounded management framing', () => {
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, value => { values.push(value); });
  const observe = createClaudeManagementDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision', environment: {} },
    undefined, line => { decode(Buffer.from(line)); });
  observe('auth-cleanup', new Error('cleanup-unconfirmed'));
  assert.deepEqual(values.map(value => ({stage: (value as {stage: string}).stage, code: (value as {code: string}).code})),
    [{ stage: 'auth-cleanup', code: 'cleanup-unconfirmed' }]);
});

test('metadata diagnostics bind original catalog identity and reject missing, extra or unsafe lifecycle facts', async () => {
  const secret = 'TEST-private-path-or-auth-value';
  const selected = { profileId: 'TEST-original-profile', configRevision: 'TEST-original-revision' };
  const lines: string[] = [];
  const observe = createOpenCodeMetadataDiagnostic(selected, 'TEST-provider', line => { lines.push(line); });
  selected.profileId = secret; selected.configRevision = secret;
  const original = { pid: 42, startIdentity: 'TEST-boot:42:7:123456' };
  observe.ready(original);
  original.pid = 99; original.startIdentity = secret;
  observe.ready(original); observe.closed(true); observe.closed(false);
  assert.equal(lines.length, 2); assert.equal(lines.join('').includes(secret), false);
  assert.equal(lines.join('').includes('TEST-original-profile'), false);
  const values: Record<string, unknown>[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, value => { values.push({ ...value }); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.deepEqual(values.map(value => ({ stage: value.stage, pid: value.pid, startIdentity: value.startIdentity })),
    [{ stage: 'ready', pid: 42, startIdentity: 'TEST-boot:42:7:123456' },
      { stage: 'released', pid: 42, startIdentity: 'TEST-boot:42:7:123456' }]);
  assert.equal(values[0]!.profileHash, values[1]!.profileHash);
  assert.equal(values[0]!.mode, 'provider'); assert.match(String(values[0]!.providerHash), /^[a-f0-9]{64}$/);
  const prefix = 'legacy-agent-host: opencode-metadata ';
  for (const unsafe of [{ ...values[0], extra: secret }, { ...values[0], profileHash: secret },
    { ...values[0], mode: 'directory' }, { ...values[0], pid: 0 }, { ...values[0], startIdentity: '/private/path' },
    { ...values[0], stage: secret }]) decode(Buffer.from(prefix + JSON.stringify(unsafe) + '\n'));
  assert.equal(values.length, 2);
  const passive = createOpenCodeMetadataDiagnostic({ profileId: 'TEST', configRevision: 'TEST' }, undefined,
    line => decode(Buffer.from(line)));
  passive.ready({ pid: 43, startIdentity: 'TEST-boot:43:8:123457' }); passive.closed(false);
  assert.equal(values[2]!.mode, 'directory'); assert.equal(values[2]!.providerHash, null);
  assert.equal(values[3]!.stage, 'cleanup-unknown', 'unknown is never projected as confirmed release');
  const noReady = createOpenCodeMetadataDiagnostic(selected, undefined, line => { lines.push(line); });
  noReady.closed(true); assert.equal(lines.length, 2, 'no synthetic identity when startup never became ready');
  let calls = 0;
  const failed = decodeClaudeCloseDiagnostics(() => {}, undefined, () => { calls++; return Promise.reject(new Error(secret)); });
  failed(Buffer.from(lines.join('')));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  assert.doesNotThrow(() => {
    const broken = createOpenCodeMetadataDiagnostic(selected, undefined, () => { throw new Error(secret); });
    broken.ready({ pid: 44, startIdentity: 'TEST:44' }); broken.closed(true);
  });
});

test('metadata read failures retain closed original facts before ready without acquiring custody authority', async () => {
  const secret = 'TEST-private-key-path-or-error';
  const selected = { profileId: 'TEST-original-profile', configRevision: 'TEST-original-revision' };
  const expectedHash = createHash('sha256').update(JSON.stringify([selected.profileId, selected.configRevision])).digest('hex');
  const lines: string[] = [];
  const observe = createOpenCodeMetadataDiagnostic(selected, undefined, line => { lines.push(line); });
  selected.profileId = secret; selected.configRevision = secret;
  observe.readFailed({ stage: 'native-client', reason: 'unknown', elapsedMs: 0, deadlineExpired: false, aborted: null });
  observe.ready({ pid: 73, startIdentity: 'TEST-boot:73' });
  observe.readFailed({ stage: 'directory', reason: 'transport_failure', elapsedMs: 3_600_000, deadlineExpired: true, aborted: true });
  observe.closed(true);
  assert.equal(lines.length, 4);
  assert.equal(lines.join('').includes(secret), false);
  assert.equal(lines.join('').includes('TEST-original-profile'), false);
  const values: Record<string, unknown>[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, value => { values.push({ ...value }); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.equal(values.length, 4);
  assert.deepEqual(values.map(value => value.stage), ['read-failed', 'ready', 'read-failed', 'released']);
  const failures = values.filter(value => value.stage === 'read-failed');
  assert.deepEqual(failures, [
    { profileHash: expectedHash, mode: 'directory', providerHash: null, stage: 'read-failed',
      readStage: 'native-client', reason: 'unknown', elapsedMs: 0, deadlineExpired: false, aborted: null },
    { profileHash: expectedHash, mode: 'directory', providerHash: null, stage: 'read-failed',
      readStage: 'directory', reason: 'transport_failure', elapsedMs: 3_600_000, deadlineExpired: true, aborted: true },
  ]);
  assert.ok(failures.every(value => !Object.hasOwn(value, 'pid') && !Object.hasOwn(value, 'startIdentity')));
  assert.equal(values[1]!.pid, 73); assert.equal(values[3]!.pid, 73);
  const prefix = 'legacy-agent-host: opencode-metadata ';
  const valid = failures[0]!;
  const frame = (value: Record<string, unknown>) => prefix + JSON.stringify(value) + '\n';
  for (const unsafe of [
    { ...valid, extra: secret }, { ...valid, pid: 73 }, { ...valid, startIdentity: secret },
    { ...valid, stage: 'released' }, { ...valid, readStage: secret }, { ...valid, reason: secret },
    { ...valid, profileHash: secret }, { ...valid, mode: 'provider' },
    { ...valid, providerHash: 'a'.repeat(64) }, { ...valid, elapsedMs: -1 },
    { ...valid, elapsedMs: 3_600_001 }, { ...valid, elapsedMs: 0.5 },
    { ...valid, elapsedMs: null }, { ...valid, deadlineExpired: 1 },
    { ...valid, aborted: 0 }, { ...valid, aborted: undefined },
  ]) decode(Buffer.from(frame(unsafe)));
  assert.equal(values.length, 4, 'unknown, extra, missing or non-finite facts cannot cross the decoder');
  decode(Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from('\n')]));
  decode(Buffer.from(prefix + 'x'.repeat(8193)));
  decode(Buffer.from('\n' + frame(valid)));
  assert.equal(values.length, 5, 'invalid UTF-8 and oversized lines cannot swallow the next original record');
  const provider = createOpenCodeMetadataDiagnostic(
    { profileId: 'TEST-provider-profile', configRevision: 'TEST-provider-revision' }, 'TEST-provider',
    line => decode(Buffer.from(line)));
  provider.readFailed({ stage: 'credential', reason: 'held', elapsedMs: 1, deadlineExpired: false, aborted: false });
  assert.equal(values.length, 6);
  assert.equal(values[5]!.mode, 'provider');
  assert.equal(values[5]!.providerHash, createHash('sha256').update(JSON.stringify('TEST-provider')).digest('hex'));
  assert.equal(values[5]!.readStage, 'credential'); assert.equal(values[5]!.aborted, false);
  let calls = 0;
  const failing = decodeClaudeCloseDiagnostics(() => {}, undefined, () => {
    calls++; if (calls === 1) throw new Error(secret); return Promise.reject(new Error(secret));
  });
  assert.doesNotThrow(() => failing(Buffer.from(frame(valid) + frame(valid))));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'a failed sink cannot prevent the next closed diagnostic');
  assert.doesNotThrow(() => createOpenCodeMetadataDiagnostic(selected, undefined, () => { throw new Error(secret); })
    .readFailed({ stage: 'admission', reason: 'held', elapsedMs: 0, deadlineExpired: false, aborted: null }));
});

const probePrefix = 'legacy-agent-host: opencode-probe ';
const probeClosePrefix = 'legacy-agent-host: opencode-probe-close-failed ';
const probeCloseFailure = { probeDigest: 'a'.repeat(64), runState: 'threw', outcome: 'unobserved',
  errorClass: 'held', stage: 'owner-client', reason: 'threw', runErrorCode: null, runCauseCode: 'ECONNRESET' };
const catalogPhases = ([1, 2, 3] as const).flatMap(index => [
  `catalog-${index}-request-start`, `catalog-${index}-custody-start`, `catalog-${index}-custody-returned`,
  `catalog-${index}-request-admitted`, `catalog-${index}-lease-released`,
] as const);
const credentialPhases = (['catalog', 'directory', 'connect', 'restore', 'dispose'] as const).flatMap(stage =>
  [`credential-${stage}-start`, `credential-${stage}-returned`] as const);
const probePhases = ['run', 'graph-start', 'graph-done', 'native-launch', 'native-launch-returned', 'native-endpoint-resolved', 'native-ready',
  'graph-manifest-verified', 'graph-inventory-indexed', 'graph-census-returned',
  'graph-files-quarter', 'graph-files-half', 'graph-files-three-quarters', 'graph-files-returned',
  'identity-start', 'identity-request-start', 'identity-custody-start', 'identity-custody-returned', 'identity-request-admitted',
  'credential', ...credentialPhases, 'credential-returned', 'attestation', ...catalogPhases,
  'catalog-read-returned', 'catalog-current-returned', 'catalog-repeat', 'attestation-returned',
  'attestation-observe-returned', 'session-create', 'session-current-returned', 'session-create-returned', 'driver-open', 'first-submit',
  'driver-open-returned', 'first-submit-current-returned', 'first-submit-returned'] as const;
const startupFailurePhases = ['startup-timer-aborted', 'startup-parent-aborted', 'startup-lifecycle-aborted', 'startup-failed'] as const;
const allowedProbePhases = [...probePhases, ...startupFailurePhases];

test('probe phase observations retain captured hashes, a lazy clock and at most one observation per allowed phase', () => {
  const secret = 'TEST-private-command-path-key';
  const selected = { profileId: 'TEST-original', configRevision: 'TEST-revision' };
  const original = { ...selected }, lines: string[] = [];
  let clock = 50, clockReads = 0;
  const observe = createOpenCodeProbeDiagnostic(selected, secret, 'a'.repeat(64), line => lines.push(line),
    () => { clockReads++; return clock; });
  selected.profileId = secret; selected.configRevision = secret; clock = 500;
  assert.equal(clockReads, 0); assert.deepEqual(lines, [], 'construction does not observe or start a probe');
  observe('attestation-returned-extra' as typeof probePhases[number]);
  assert.equal(clockReads, 0, 'unknown phases cannot consume a sequence slot or read the clock');
  for (const phase of allowedProbePhases) { observe(phase); clock += 7; }
  for (let repeat = 0; repeat < 20; repeat++) for (const phase of allowedProbePhases) observe(phase);
  assert.equal(lines.length, allowedProbePhases.length); assert.equal(lines.length, 64);
  assert.equal(clockReads, allowedProbePhases.length, 'duplicate transitions do not read the clock or write again');
  assert.ok(lines.every(line => Buffer.byteLength(line) < 8192));
  assert.equal(lines.join('').includes(secret), false);
  assert.equal(lines.join('').includes('TEST-original'), false);
  const retained: OpenCodeProbeDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { retained.push(value); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.equal(retained.length, allowedProbePhases.length);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.deepEqual(retained, allowedProbePhases.map((phase, index) => ({
    profileHash: hash([original.profileId, original.configRevision]), commandHash: hash(secret),
    probeDigest: 'a'.repeat(64), phase, sequence: index + 1, elapsedMs: index * 7,
    ...(phase === 'first-submit-returned' ? { submitStatus: 'unclassified', submitCode: null, submitDelivery: 'unobserved' } : {}),
  })));
  assert.ok(retained.every(Object.isFrozen));
  assert.ok(retained.every(value => !Object.hasOwn(value, 'pid') && !Object.hasOwn(value, 'ready') &&
    !Object.hasOwn(value, 'released') && !Object.hasOwn(value, 'failed')));
});

test.each(startupFailurePhases)('probe decoder retains only the existing startup observation %s', phase => {
  const lines: string[] = [], records: OpenCodeProbeDiagnostic[] = [];
  const observe = createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
    'TEST-command', 'a'.repeat(64), line => lines.push(line), () => 100);
  observe('run'); observe('graph-start'); observe(phase); observe(phase);
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { records.push(value); });
  decode(Buffer.from(lines.join('')));
  assert.equal(lines.length, 3); assert.equal(records.length, 3);
  assert.equal(records[2]!.phase, phase); assert.equal(records[2]!.sequence, 3);
  assert.deepEqual(Object.keys(records[2]!).sort(), ['commandHash', 'elapsedMs', 'phase', 'probeDigest', 'profileHash', 'sequence']);
  assert.ok(records.every(Object.isFrozen));
});

const currentnessPhases = ['identity-currentness-summary', 'catalog-1-currentness-summary',
  'catalog-2-currentness-summary', 'catalog-3-currentness-summary',
  'credential-catalog-currentness-summary', 'credential-directory-currentness-summary', 'credential-connect-currentness-summary'] as const;

test('four request and three credential summaries preserve the original phase fields and sequence slots', () => {
  const lines: string[] = [], records: OpenCodeProbeDiagnostic[] = [];
  let clock = 10;
  const observe = createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
    'TEST-command', 'a'.repeat(64), line => lines.push(line), () => clock);
  observe('run');
  for (const [index, phase] of currentnessPhases.entries()) {
    clock += 10;
    observe(phase, { currentCalls: index, currentElapsedMs: index * 10 });
    observe(phase, { currentCalls: 999, currentElapsedMs: 999 });
  }
  observe('graph-start');
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { records.push(value); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.equal(records.length, 9); assert.ok(records.every(Object.isFrozen));
  assert.deepEqual(records.map(record => record.sequence), [1, 1, 1, 1, 1, 1, 1, 1, 2]);
  for (const record of [records[0]!, records[8]!]) assert.deepEqual(Object.keys(record).sort(),
    ['commandHash', 'elapsedMs', 'phase', 'probeDigest', 'profileHash', 'sequence']);
  assert.deepEqual(records.slice(1, 8).map(({ phase, currentCalls, currentElapsedMs }) =>
    ({ phase, currentCalls, currentElapsedMs })), currentnessPhases.map((phase, index) =>
    ({ phase, currentCalls: index, currentElapsedMs: index * 10 })));
});

test('summary writer accepts only fixed numeric own fields without invoking getters or serializers', () => {
  const lines: string[] = [];
  let reads = 0, clockReads = 0;
  const stats = { currentCalls: 1, currentElapsedMs: 5 };
  const getter = Object.defineProperty({ ...stats }, 'currentCalls', {
    get() { reads++; throw Error('TEST-private-getter'); }, enumerable: true,
  });
  const observe = createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
    'TEST-command', 'a'.repeat(64), line => lines.push(line), () => { clockReads++; return 100; });
  observe('identity-currentness-summary', stats);
  assert.equal(clockReads, 0, 'a summary cannot start the original run clock');
  observe('run');
  for (const invalid of [undefined, null, [], {}, getter, { ...stats, extra: 'TEST-private' },
    { ...stats, [Symbol('TEST-private')]: true }, { ...stats, toJSON() { reads++; return stats; } },
    Object.assign(Object.create({ currentCalls: 1 }), { currentElapsedMs: 5 }),
    { ...stats, currentCalls: -1 }, { ...stats, currentCalls: 1.5 }, { ...stats, currentCalls: 1_000_001 },
    { ...stats, currentCalls: NaN }, { ...stats, currentElapsedMs: Infinity },
    { ...stats, currentElapsedMs: -1 }, { ...stats, currentElapsedMs: 3_600_001 },
    new Proxy({}, { ownKeys() { throw Error('TEST-private-proxy'); } }),
  ]) assert.doesNotThrow(() => observe('identity-currentness-summary', invalid as typeof stats));
  observe('graph-start', stats);
  assert.equal(reads, 0); assert.equal(clockReads, 1); assert.equal(lines.length, 1);
  observe('identity-currentness-summary', stats);
  assert.equal(lines.length, 2, 'invalid diagnostic inputs do not consume a valid summary');
});

test('summary decoder rejects missing, extra, nonfinite, unbounded or authority-like fields', () => {
  const valid = { profileHash: 'a'.repeat(64), commandHash: 'b'.repeat(64), probeDigest: 'c'.repeat(64),
    phase: 'identity-currentness-summary', sequence: 1, elapsedMs: 0, currentCalls: 0, currentElapsedMs: 0 };
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { values.push(value); });
  const frame = (value: unknown) => Buffer.from(probePrefix + JSON.stringify(value) + '\n');
  for (const unsafe of [
    { ...valid, currentCalls: undefined }, { ...valid, currentElapsedMs: undefined },
    { ...valid, currentCalls: -1 }, { ...valid, currentCalls: 1.5 }, { ...valid, currentCalls: '1' },
    { ...valid, currentCalls: 1_000_001 }, { ...valid, currentCalls: NaN },
    { ...valid, currentElapsedMs: -1 }, { ...valid, currentElapsedMs: 0.5 },
    { ...valid, currentElapsedMs: 3_600_001 }, { ...valid, currentElapsedMs: Infinity },
    { ...valid, currentElapsedMs: null }, { ...valid, pid: 31 }, { ...valid, ready: true },
    { ...valid, phase: 'catalog-4-currentness-summary' }, { ...valid, phase: 'identity-currentness-summary-extra' },
    { ...valid, phase: 'credential-dispose-currentness-summary' }, { ...valid, phase: 'credential-restore-currentness-summary' },
    { ...valid, phase: 'run' }, { ...valid, sequence: 65 },
  ]) decode(frame(unsafe));
  assert.deepEqual(values, []);
  decode(frame(valid));
  const maximum = { ...valid, phase: 'catalog-3-currentness-summary', sequence: 64,
    elapsedMs: 3_600_000, currentCalls: 1_000_000, currentElapsedMs: 3_600_000 };
  decode(frame(maximum));
  assert.deepEqual(values, [valid, maximum]);
});

test('probe diagnostics cannot replace clock, write or sink failures with authority', async () => {
  const selected = { profileId: 'TEST-original', configRevision: 'TEST-revision' };
  const secret = 'TEST-private-diagnostic-error', lines: string[] = [];
  let attempts = 0, clock = 100;
  const observe = createOpenCodeProbeDiagnostic(selected, 'TEST-command', 'a'.repeat(64), line => {
    if (++attempts === 1) throw new Error(secret);
    lines.push(line);
  }, () => clock);
  assert.doesNotThrow(() => observe('run'));
  clock += 13; observe('graph-start');
  assert.equal(JSON.parse(lines[0]!.slice(probePrefix.length)).sequence, 2,
    'a lost write is not relabelled as an earlier observation');
  assert.equal(JSON.parse(lines[0]!.slice(probePrefix.length)).elapsedMs, 13);
  const badClock = createOpenCodeProbeDiagnostic(selected, 'TEST-command', 'a'.repeat(64), line => lines.push(line),
    () => { throw new Error(secret); });
  for (const phase of probePhases) assert.doesNotThrow(() => badClock(phase));
  assert.equal(lines.length, 1);
  for (const firstRead of ['throw', 'nan'] as const) {
    let reads = 0;
    const missingOrigin = createOpenCodeProbeDiagnostic(selected, 'TEST-command', 'a'.repeat(64),
      line => lines.push(line), () => {
        if (++reads > 1) return 1000;
        if (firstRead === 'throw') throw new Error(secret);
        return NaN;
      });
    for (const phase of probePhases) assert.doesNotThrow(() => missingOrigin(phase));
    assert.equal(reads, 1, 'a missing original timestamp is never replaced by a later phase');
    assert.equal(lines.length, 1);
  }
  for (const value of [NaN, Infinity, -1]) {
    const invalidClock = createOpenCodeProbeDiagnostic(selected, 'TEST-command', 'a'.repeat(64), line => lines.push(line), () => value);
    assert.doesNotThrow(() => invalidClock('run'));
  }
  assert.equal(lines.length, 1);
  let sinkCalls = 0;
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, () => {
    if (++sinkCalls === 1) throw new Error(secret);
    return Promise.reject(new Error(secret));
  });
  assert.doesNotThrow(() => decode(Buffer.from(lines[0]! + lines[0]!)));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sinkCalls, 2);
  const noObserver = decodeClaudeCloseDiagnostics(() => { throw new Error('TEST unrelated decoder'); });
  assert.doesNotThrow(() => noObserver(Buffer.from(lines[0]!)));
});

test('probe diagnostic construction failures return a silent observer without reading its clock', () => {
  const failure = new Error('TEST private diagnostic construction failure');
  let reads = 0, clockReads = 0, writes = 0;
  const getter = Object.defineProperty({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
    'profileId', { get() { reads++; throw failure; } });
  const serializer = { profileId: { toJSON() { reads++; throw failure; } } as unknown as string,
    configRevision: 'TEST-revision' };
  for (const selected of [getter, serializer]) {
    const observe = createOpenCodeProbeDiagnostic(selected, 'TEST-command', 'a'.repeat(64),
      () => { writes++; }, () => { clockReads++; return 1; });
    for (const phase of probePhases) assert.doesNotThrow(() => observe(phase));
  }
  let digestCoercions = 0;
  const rawDigest = {
    toString() { digestCoercions++; return 'a'.repeat(64); },
    toJSON() { return 'TEST private oversized diagnostic ' + 'x'.repeat(9000); },
  } as unknown as string;
  const invalid = createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
    'TEST-command', rawDigest, () => { writes++; }, () => { clockReads++; return 1; });
  for (const phase of probePhases) assert.doesNotThrow(() => invalid(phase));
  assert.equal(digestCoercions, 0, 'a malformed digest is never coerced into bounded-string evidence');
  assert.equal(reads, 2); assert.equal(clockReads, 0); assert.equal(writes, 0);
});

test('probe decoder rejects raw, nonfinite, extra and custody-like fields and recovers framing', () => {
  const valid = { profileHash: 'a'.repeat(64), commandHash: 'b'.repeat(64), probeDigest: 'c'.repeat(64),
    phase: 'graph-start', sequence: 2, elapsedMs: 7 };
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { values.push(value); });
  const frame = (value: Record<string, unknown>) => probePrefix + JSON.stringify(value) + '\n';
  for (const unsafe of [
    { ...valid, extra: 'TEST-secret' }, { ...valid, pid: 42 }, { ...valid, ready: true },
    { ...valid, profileHash: 'TEST-path' }, { ...valid, commandHash: '/private/path' },
    { ...valid, probeDigest: null }, { ...valid, phase: 'released' }, { ...valid, phase: 'failure' },
    { ...valid, phase: 'attestation-returned-extra' },
    { ...valid, phase: 'catalog-0-request-start' }, { ...valid, phase: 'catalog-4-request-start' },
    { ...valid, phase: 'catalog-1-http-succeeded' }, { ...valid, phase: 'catalog-3-lease-released-extra' },
    { ...valid, sequence: 0 }, { ...valid, sequence: allowedProbePhases.length + 1 }, { ...valid, sequence: 1.5 },
    { ...valid, elapsedMs: -1 }, { ...valid, elapsedMs: 3_600_001 },
    { ...valid, elapsedMs: null }, { ...valid, elapsedMs: undefined },
  ]) decode(Buffer.from(frame(unsafe)));
  assert.deepEqual(values, []);
  decode(Buffer.concat([Buffer.from(probePrefix), Buffer.from([0xff]), Buffer.from('\n')]));
  decode(Buffer.from(probePrefix + 'x'.repeat(8193)));
  const final = { ...valid, phase: 'session-create-returned', sequence: allowedProbePhases.length, elapsedMs: 3_600_000 };
  decode(Buffer.from('\n' + frame(valid) + frame(final)));
  assert.deepEqual(values, [valid, final]);
});

test('captured Host logs retain the new phase separately from original metadata custody records', () => {
  const entries: { namespace: string; args: readonly unknown[] }[] = [];
  const removeBroken = addLogSink(() => { throw new Error('TEST sink failure'); });
  const remove = addLogSink(entry => { entries.push(entry); });
  let pid: number | undefined = 731;
  const decode = createCapturedHostDiagnostics(() => pid);
  try {
    createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      'TEST-command', 'a'.repeat(64), line => decode(Buffer.from(line)), () => 100)('run');
    createOpenCodeMetadataDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      undefined, line => decode(Buffer.from(line))).ready({ pid: 732, startIdentity: 'TEST:original:732' });
    createClaudeCloseDiagnostic(binding, 'TEST-session', line => decode(Buffer.from(line)))({ stage: 'custody', outcome: 'confirmed' });
    createClaudeManagementDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision', environment: {} },
      undefined, line => decode(Buffer.from(line)))('host-cleanup', new Error('cleanup-unconfirmed'));
    createOpenCodeProbeCloseDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      'TEST-command', 'a'.repeat(64), line => decode(Buffer.from(line)))(probeCloseFailure);
    assert.deepEqual(entries.map(entry => entry.namespace),
      ['Host:OpenCodeProbe', 'Host:OpenCodeMetadata', 'Host:ClaudeClose', 'Host:ClaudeManagement', 'Host:OpenCodeProbeClose']);
    assert.deepEqual(entries[0]!.args, ['OpenCode probe phase', {
      profileHash: createHash('sha256').update(JSON.stringify(['TEST-profile', 'TEST-revision'])).digest('hex'),
      commandHash: createHash('sha256').update(JSON.stringify('TEST-command')).digest('hex'),
      probeDigest: 'a'.repeat(64), phase: 'run', sequence: 1, elapsedMs: 0, hostPid: 731,
    }]);
    assert.deepEqual(entries[1]!.args, ['OpenCode metadata stage', {
      profileHash: createHash('sha256').update(JSON.stringify(['TEST-profile', 'TEST-revision'])).digest('hex'),
      mode: 'directory', providerHash: null, pid: 732, stage: 'ready',
      startIdentityHash: createHash('sha256').update('TEST:original:732', 'utf8').digest('hex'), hostPid: 731,
    }]);
    assert.deepEqual(entries[4]!.args, ['OpenCode probe close failure', {
      profileHash: createHash('sha256').update(JSON.stringify(['TEST-profile', 'TEST-revision'])).digest('hex'),
      commandHash: createHash('sha256').update(JSON.stringify('TEST-command')).digest('hex'),
      ...probeCloseFailure, hostPid: 731,
    }]);
    pid = undefined;
    createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      'TEST-command', 'a'.repeat(64), line => decode(Buffer.from(line)), () => 100)('run');
    createOpenCodeProbeCloseDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      'TEST-command', 'a'.repeat(64), line => decode(Buffer.from(line)))(probeCloseFailure);
    assert.equal(entries.length, 5, 'no Host identity is invented for a missing original child');
  } finally { remove(); removeBroken(); }
});

test('probe close failure bridge retains one original closed observation without opaque values or getters', () => {
  const secret = 'TEST-private-close-error-path-key', selected = { profileId: 'TEST-original', configRevision: 'TEST-revision' };
  const original = { ...selected }, lines: string[] = [];
  const observe = createOpenCodeProbeCloseDiagnostic(selected, secret, probeCloseFailure.probeDigest, line => lines.push(line));
  selected.profileId = secret; selected.configRevision = secret;
  let getterReads = 0;
  const getter = Object.defineProperty({ ...probeCloseFailure }, 'stage', { enumerable: true,
    get() { getterReads++; throw new Error(secret); } });
  const { stage, ...withoutStage } = probeCloseFailure;
  for (const invalid of [
    getter, Object.assign(Object.create({ stage }), withoutStage),
    new Proxy({}, { ownKeys() { throw new Error(secret); } }),
    { ...probeCloseFailure, [Symbol(secret)]: secret }, { ...probeCloseFailure, raw: secret },
    { ...probeCloseFailure, probeDigest: 'b'.repeat(64) }, { ...probeCloseFailure, runState: secret },
    { ...probeCloseFailure, stage: secret }, { ...probeCloseFailure, reason: secret },
    { ...probeCloseFailure, outcome: secret }, { ...probeCloseFailure, errorClass: secret },
    { ...probeCloseFailure, runErrorCode: secret }, { ...probeCloseFailure, runCauseCode: undefined },
  ]) assert.doesNotThrow(() => observe(invalid));
  assert.equal(getterReads, 0); assert.equal(lines.length, 0);
  observe(probeCloseFailure);
  for (let i = 0; i < 20; i++) observe({ ...probeCloseFailure, stage: 'namespace', reason: 'identity' });
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]!) <= 768);
  assert.equal(lines.join('').includes(secret), false); assert.equal(lines.join('').includes('TEST-original'), false);
  const retained: OpenCodeProbeCloseDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined,
    value => { retained.push(value); });
  for (const byte of Buffer.from(lines[0]!)) decode(Buffer.from([byte]));
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.deepEqual(retained, [{ profileHash: hash([original.profileId, original.configRevision]),
    commandHash: hash(secret), ...probeCloseFailure }]);
  assert.ok(retained.every(Object.isFrozen));
  assert.ok(retained.every(value => !Object.hasOwn(value, 'elapsedMs') && !Object.hasOwn(value, 'ready') && !Object.hasOwn(value, 'released')));

  const selectedGetter = Object.defineProperty({ ...original }, 'profileId', {
    get() { getterReads++; throw new Error(secret); } });
  createOpenCodeProbeCloseDiagnostic(selectedGetter, secret, probeCloseFailure.probeDigest, line => lines.push(line))(probeCloseFailure);
  assert.equal(getterReads, 0); assert.equal(lines.length, 1);
  let writeAttempts = 0;
  const failedSink = createOpenCodeProbeCloseDiagnostic(original, secret, probeCloseFailure.probeDigest,
    () => { writeAttempts++; throw new Error(secret); });
  assert.doesNotThrow(() => failedSink(probeCloseFailure));
  assert.doesNotThrow(() => failedSink({ ...probeCloseFailure, stage: 'namespace', reason: 'identity' }));
  assert.equal(writeAttempts, 1, 'a lost first diagnostic is never replaced by a later close stage');
});

test('probe close decoder rejects noncanonical shapes and oversized raw frames without changing existing framing', async () => {
  const valid = { profileHash: 'b'.repeat(64), commandHash: 'c'.repeat(64), ...probeCloseFailure };
  const { runErrorCode: _error, runCauseCode: _cause, ...plain } = valid;
  const nonthrowing = { ...plain, runState: 'false', errorClass: 'none', stage: 'server-stop', reason: 'unconfirmed' };
  const values: unknown[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined,
    value => { values.push(value); });
  const frame = (value: unknown) => probeClosePrefix + JSON.stringify(value) + '\n';
  for (const invalid of [
    { ...valid, extra: 'TEST-secret' }, { ...valid, cleanupConfirmed: true }, { ...valid, elapsedMs: 0 },
    { ...valid, profileHash: 'TEST-private-path' }, { ...valid, commandHash: null }, { ...valid, probeDigest: '' },
    { ...valid, runState: 'completed' }, { ...valid, outcome: 'allowed' }, { ...valid, errorClass: 'TEST-raw-error' },
    { ...valid, stage: 'released' }, { ...valid, reason: 'confirmed' },
    { ...valid, runErrorCode: 'TEST-secret' }, { ...valid, runCauseCode: false },
    plain, { ...valid, runCauseCode: undefined }, { ...nonthrowing, runErrorCode: null, runCauseCode: null },
  ]) decode(Buffer.from(frame(invalid)));
  decode(Buffer.from(probeClosePrefix + ' '.repeat(768) + JSON.stringify(valid) + '\n'));
  decode(Buffer.concat([Buffer.from(probeClosePrefix), Buffer.from([0xff]), Buffer.from('\n')]));
  assert.deepEqual(values, []);
  decode(Buffer.from(probeClosePrefix + 'x'.repeat(8193)));
  decode(Buffer.from('\n' + frame(valid) + frame(nonthrowing)));
  assert.deepEqual(values, [valid, nonthrowing]);
  let attempts = 0;
  const broken = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined, () => {
    if (++attempts === 1) throw new Error('TEST-private-sink');
    return Promise.reject(new Error('TEST-private-sink'));
  });
  assert.doesNotThrow(() => broken(Buffer.from(frame(valid) + frame(nonthrowing))));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
});

test('passive probe handoff projects only bounded own SPI fields without getters or proxy traps', () => {
  const secret = 'TEST-private-payload-token-and-path';
  const codes = ['invalid-config', 'unavailable', 'dependency-unavailable', 'backpressure', 'stale', 'unsupported',
    'checkpoint-incompatible', 'checkpoint-missing', 'provider-failure', 'output-limit', 'unknown'];
  let forbiddenReads = 0;
  const getter = () => { forbiddenReads++; throw new Error(secret); };
  const trapped = new Proxy({}, { get: getter, ownKeys: getter, getOwnPropertyDescriptor: getter,
    getPrototypeOf: getter, has: getter });
  const opaque = { submitStatus: 'unclassified', submitCode: null, submitDelivery: 'unobserved' };
  const cases: [unknown, Record<string, unknown>][] = [
    ...codes.map(code => [{ ok: false, code, delivery: 'known-not-sent', value: secret },
      { submitStatus: 'refused', submitCode: code, submitDelivery: 'known-not-sent' }] as [unknown, Record<string, unknown>]),
    [{ ok: false, code: secret }, { submitStatus: 'refused', submitCode: null, submitDelivery: 'unobserved' }],
    [{ ok: false, code: 'stale' }, { submitStatus: 'refused', submitCode: 'stale', submitDelivery: 'unobserved' }],
    [{ ok: false, code: 'unknown', delivery: secret }, { submitStatus: 'refused', submitCode: 'unknown', submitDelivery: 'unobserved' }],
    [Object.defineProperties({ ok: false }, { code: { get: getter }, delivery: { get: getter }, value: { get: getter } }),
      { submitStatus: 'refused', submitCode: null, submitDelivery: 'unobserved' }],
    [Object.defineProperties({ ok: true }, { code: { get: getter }, delivery: { get: getter }, value: { get: getter } }),
      { submitStatus: 'ok', submitCode: null, submitDelivery: 'unobserved' }],
    [Object.create({ ok: false, code: 'stale', delivery: 'known-not-sent' }), opaque],
    [Object.defineProperty({}, 'ok', { get: getter }), opaque], [trapped, opaque], [null, opaque],
  ];
  for (const [reply, expected] of cases) {
    const lines: string[] = [], retained: OpenCodeProbeDiagnostic[] = [];
    const observe = createOpenCodeProbeDiagnostic({ profileId: 'TEST', configRevision: 'TEST' }, secret,
      'a'.repeat(64), line => lines.push(line), () => 50);
    observe('run');
    const submit = observe as (phase: string, reply?: unknown) => void;
    submit('first-submit-returned', reply); submit('first-submit-returned', reply);
    assert.equal(lines.length, 2, 'one immediate reply snapshot, independent of cleanup');
    assert.ok(lines.every(line => Buffer.byteLength(line) < 512));
    const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { retained.push(value); });
    for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
    assert.equal(retained.length, 2);
    assert.deepEqual(retained[1], { profileHash: retained[0]!.profileHash, commandHash: retained[0]!.commandHash,
      probeDigest: 'a'.repeat(64), phase: 'first-submit-returned', sequence: 2, elapsedMs: 0, ...expected });
    assert.ok(Object.isFrozen(retained[1]));
    assert.equal(lines.join('').includes(secret), false);
  }
  assert.equal(forbiddenReads, 0, 'projection never invokes accessors or Proxy reflection');
});

test('passive probe handoff decoder accepts the exact reply shape only at the reply phase', () => {
  const values: OpenCodeProbeDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { values.push(value); });
  const base = { profileHash: 'a'.repeat(64), commandHash: 'b'.repeat(64), probeDigest: 'c'.repeat(64),
    phase: 'first-submit-returned', sequence: 64, elapsedMs: 3_600_000 };
  const valid = { ...base, submitStatus: 'refused', submitCode: 'checkpoint-incompatible', submitDelivery: 'known-not-sent' };
  const frame = (value: unknown) => Buffer.from(probePrefix + JSON.stringify(value) + '\n');
  for (const invalid of [base, { ...valid, submitCode: undefined }, { ...valid, submitStatus: undefined },
    { ...valid, submitDelivery: undefined }, { ...valid, submitStatus: 'TEST-private' },
    { ...valid, submitCode: 'TEST-private' }, { ...valid, submitDelivery: 'unknown' },
    { ...valid, submitStatus: 'ok' }, { ...valid, submitStatus: 'unclassified' },
    { ...valid, phase: 'run' }, { ...valid, phase: 'first-submit-current-returned' },
    { ...valid, phase: 'identity-currentness-summary', currentCalls: 1, currentElapsedMs: 0 },
    { ...valid, currentCalls: 1, currentElapsedMs: 0 }, { ...valid, sequence: 65 },
    { ...valid, value: 'TEST-private' }]) decode(frame(invalid));
  assert.deepEqual(values, []);
  decode(frame(valid));
  const unknown = { ...base, submitStatus: 'unclassified', submitCode: null, submitDelivery: 'unobserved' };
  decode(frame(unknown));
  assert.deepEqual(values, [valid, unknown]);
});

test('catalog repeat diagnostics retain only an optional own boolean pair without getters or Proxy traps', () => {
  const secret = 'TEST-private-catalog-provider-model-path';
  const pairs = [
    { catalogProviderPresent: false, catalogModelPresent: false },
    { catalogProviderPresent: false, catalogModelPresent: true },
    { catalogProviderPresent: true, catalogModelPresent: false },
  ];
  let forbiddenReads = 0;
  const getter = () => { forbiddenReads++; throw Error(secret); };
  const trapped = new Proxy({}, { get: getter, ownKeys: getter, getOwnPropertyDescriptor: getter,
    getPrototypeOf: getter, has: getter });
  const cases: [unknown, Record<string, boolean>][] = [
    ...pairs.map(pair => [pair, pair] as [unknown, Record<string, boolean>]),
    [undefined, {}], [null, {}], [[], {}], [{}, {}], [trapped, {}],
    [Object.defineProperty({ catalogModelPresent: false }, 'catalogProviderPresent', { get: getter }), {}],
    [Object.assign(Object.create({ catalogProviderPresent: false }), { catalogModelPresent: true }), {}],
    [{ catalogProviderPresent: true, catalogModelPresent: true }, {}],
    [{ catalogProviderPresent: false, catalogModelPresent: secret }, {}],
    [{ catalogProviderPresent: false }, {}], [{ ...pairs[0], extra: secret }, {}],
    [{ ...pairs[0], [Symbol(secret)]: true }, {}], [{ ...pairs[0], toJSON: getter }, {}],
  ];
  for (const [detail, expected] of cases) {
    const lines: string[] = [], retained: OpenCodeProbeDiagnostic[] = [];
    const observe = createOpenCodeProbeDiagnostic({ profileId: 'TEST', configRevision: 'TEST' }, secret,
      'a'.repeat(64), line => lines.push(line), () => 50);
    const emit = observe as (phase: string, detail?: unknown) => void;
    observe('run'); emit('catalog-repeat', detail); emit('catalog-repeat', detail);
    assert.equal(lines.length, 2, 'invalid detail does not erase or repeat the original phase');
    const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { retained.push(value); });
    for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
    assert.equal(retained.length, 2);
    assert.deepEqual(retained[1], { profileHash: retained[0]!.profileHash, commandHash: retained[0]!.commandHash,
      probeDigest: 'a'.repeat(64), phase: 'catalog-repeat', sequence: 2, elapsedMs: 0, ...expected });
    assert.ok(Object.isFrozen(retained[1]));
    assert.ok(lines.every(line => Buffer.byteLength(line) < 512));
    assert.equal(lines.join('').includes(secret), false);
  }
  assert.equal(forbiddenReads, 0, 'diagnostics cannot execute a getter, serializer or Proxy trap');
});

test('catalog repeat decoder accepts exactly the optional missing-selection pair at its original phase', () => {
  const values: OpenCodeProbeDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { values.push(value); });
  const base = { profileHash: 'a'.repeat(64), commandHash: 'b'.repeat(64), probeDigest: 'c'.repeat(64),
    phase: 'catalog-repeat', sequence: 64, elapsedMs: 3_600_000 };
  const valid = { ...base, catalogProviderPresent: false, catalogModelPresent: true };
  const frame = (value: unknown) => Buffer.from(probePrefix + JSON.stringify(value) + '\n');
  for (const invalid of [
    { ...valid, catalogProviderPresent: undefined }, { ...valid, catalogModelPresent: undefined },
    { ...valid, catalogProviderPresent: true }, { ...valid, catalogProviderPresent: null },
    { ...valid, catalogModelPresent: 'TEST-private' }, { ...valid, phase: 'catalog-read-returned' },
    { ...valid, phase: 'run' }, { ...valid, currentCalls: 1, currentElapsedMs: 0 },
    { ...valid, submitStatus: 'ok', submitCode: null, submitDelivery: 'unobserved' },
    { ...valid, ready: true }, { ...valid, sequence: 65 },
  ]) decode(frame(invalid));
  assert.deepEqual(values, []);
  for (const value of [base, valid, { ...valid, catalogModelPresent: false },
    { ...valid, catalogProviderPresent: true, catalogModelPresent: false }]) {
    for (const byte of frame(value)) decode(Buffer.from([byte]));
  }
  assert.deepEqual(values, [base, valid, { ...valid, catalogModelPresent: false },
    { ...valid, catalogProviderPresent: true, catalogModelPresent: false }]);
});
