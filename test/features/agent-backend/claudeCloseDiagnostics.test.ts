import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { it as test } from 'vitest';

import { createClaudeCloseDiagnostic, createClaudeManagementDiagnostic, createOpenCodeMetadataDiagnostic, createOpenCodeProbeDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { createCapturedHostDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/createCapturedHostDiagnostics';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { OpenCodeProbeDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

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
const probePhases = ['run', 'graph-start', 'graph-done', 'native-launch', 'native-ready',
  'credential', 'attestation', 'session-create', 'driver-open', 'first-submit'] as const;

test('probe phase observations retain captured hashes, a lazy clock and at most twelve transitions', () => {
  const secret = 'TEST-private-command-path-key';
  const selected = { profileId: 'TEST-original', configRevision: 'TEST-revision' };
  const original = { ...selected }, lines: string[] = [];
  let clock = 50, clockReads = 0;
  const observe = createOpenCodeProbeDiagnostic(selected, secret, 'a'.repeat(64), line => lines.push(line),
    () => { clockReads++; return clock; });
  selected.profileId = secret; selected.configRevision = secret; clock = 500;
  assert.equal(clockReads, 0); assert.deepEqual(lines, [], 'construction does not observe or start a probe');
  for (const phase of probePhases) { observe(phase); clock += 7; }
  for (let repeat = 0; repeat < 20; repeat++) for (const phase of probePhases) observe(phase);
  assert.equal(lines.length, probePhases.length); assert.ok(lines.length <= 12);
  assert.equal(clockReads, probePhases.length, 'duplicate transitions do not read the clock or write again');
  assert.ok(lines.every(line => Buffer.byteLength(line) < 8192));
  assert.equal(lines.join('').includes(secret), false);
  assert.equal(lines.join('').includes('TEST-original'), false);
  const retained: OpenCodeProbeDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { retained.push(value); });
  for (const byte of Buffer.from(lines.join(''))) decode(Buffer.from([byte]));
  assert.equal(retained.length, probePhases.length);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.deepEqual(retained, probePhases.map((phase, index) => ({
    profileHash: hash([original.profileId, original.configRevision]), commandHash: hash(secret),
    probeDigest: 'a'.repeat(64), phase, sequence: index + 1, elapsedMs: index * 7,
  })));
  assert.ok(retained.every(Object.isFrozen));
  assert.ok(retained.every(value => !Object.hasOwn(value, 'pid') && !Object.hasOwn(value, 'ready') &&
    !Object.hasOwn(value, 'released') && !Object.hasOwn(value, 'failed')));
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
    { ...valid, sequence: 0 }, { ...valid, sequence: 13 }, { ...valid, sequence: 1.5 },
    { ...valid, elapsedMs: -1 }, { ...valid, elapsedMs: 3_600_001 },
    { ...valid, elapsedMs: null }, { ...valid, elapsedMs: undefined },
  ]) decode(Buffer.from(frame(unsafe)));
  assert.deepEqual(values, []);
  decode(Buffer.concat([Buffer.from(probePrefix), Buffer.from([0xff]), Buffer.from('\n')]));
  decode(Buffer.from(probePrefix + 'x'.repeat(8193)));
  decode(Buffer.from('\n' + frame(valid) + frame({ ...valid, sequence: 12, elapsedMs: 3_600_000 })));
  assert.deepEqual(values, [valid, { ...valid, sequence: 12, elapsedMs: 3_600_000 }]);
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
    assert.deepEqual(entries.map(entry => entry.namespace),
      ['Host:OpenCodeProbe', 'Host:OpenCodeMetadata', 'Host:ClaudeClose', 'Host:ClaudeManagement']);
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
    pid = undefined;
    createOpenCodeProbeDiagnostic({ profileId: 'TEST-profile', configRevision: 'TEST-revision' },
      'TEST-command', 'a'.repeat(64), line => decode(Buffer.from(line)), () => 100)('run');
    assert.equal(entries.length, 4, 'no Host identity is invented for a missing original child');
  } finally { remove(); removeBroken(); }
});
