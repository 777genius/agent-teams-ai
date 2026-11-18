import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { it as test, vi } from 'vitest';

import { createRuntimeOpenDiagnostic } from '../../../packages/legacy-agent-host/src/diagnostics/runtimeOpenDiagnostic';
import { createCapturedHostDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/createCapturedHostDiagnostics';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { RuntimeOpenPhase } from '../../../packages/legacy-agent-host/src/diagnostics/runtimeOpenDiagnostic';
import type { RuntimeOpenDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

const prefix = 'legacy-agent-host: runtime-open ';
const selected = () => ({
  profileId: 'TEST-private-profile', configuration: { sessionId: 'TEST-private-session', revision: 'TEST-original' },
  source: 'factory' as const,
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid: RuntimeOpenDiagnostic = {
  profileHash: 'a'.repeat(64), configurationHash: 'b'.repeat(64), source: 'factory',
  phase: 'driver-open', category: 'held', observedAtMs: 123,
};
const frame = (value: unknown = valid) => prefix + JSON.stringify(value) + '\n';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const decodeTo = (values: RuntimeOpenDiagnostic[]) => decodeClaudeCloseDiagnostics(
  () => {}, undefined, undefined, undefined, value => { values.push(value); }
);

test('captures original hashes once and observes only the first failure at its original time', () => {
  const target = selected(), original = structuredClone(target), lines: string[] = [];
  let clock = 100, reads = 0;
  const observe = createRuntimeOpenDiagnostic(target, line => { lines.push(line); },
    () => { reads++; return clock; });
  target.profileId = 'TEST-replaced'; target.configuration.revision = 'TEST-later';
  assert.deepEqual(lines, []); assert.equal(reads, 0);
  observe('driver-open', Object.assign(new Error('TEST-secret-message'), { code: 'forbidden' }));
  clock = 200; observe('driver-wrap', new Error('TEST-later-error'));
  assert.equal(lines.length, 1); assert.equal(reads, 1);
  const values: RuntimeOpenDiagnostic[] = [];
  decodeTo(values)(Buffer.from(lines[0]!));
  assert.deepEqual(values, [{
    profileHash: hash(original.profileId), configurationHash: hash(original.configuration),
    source: 'factory', phase: 'driver-open', category: 'forbidden', observedAtMs: 100,
  }]);
  assert.equal(lines.join('').includes('TEST-'), false);
  assert.ok(Buffer.byteLength(lines[0]!) < 8192);
});

test('classifies only fixed own data properties without invoking error getters or inherited fields', () => {
  const secret = 'TEST-private-path-token-error', lines: string[] = [];
  let reads = 0;
  const accessor = Object.defineProperties({}, {
    code: { get() { reads++; throw new Error(secret); } },
    name: { get() { reads++; throw new Error(secret); } },
    message: { get() { reads++; throw new Error(secret); } },
  });
  const inherited = Object.create({ code: 'forbidden', name: 'AbortError' }) as unknown;
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
  for (const error of [accessor, inherited, proxy, secret, null, new Error(secret)]) {
    createRuntimeOpenDiagnostic(selected(), line => { lines.push(line); }, () => 1)('driver-open', error);
  }
  assert.equal(reads, 0);
  assert.ok(lines.every(line => !line.includes(secret)));
  assert.ok(lines.every(line => JSON.parse(line.slice(prefix.length)).category === 'unknown'));
  assert.equal(lines.length, 6);
});

test('fixed code and name categories are finite and never forward raw fields', () => {
  const cases: [unknown, string][] = [
    [{ code: 'invalid' }, 'invalid'], [{ code: 'conflict' }, 'conflict'],
    [{ code: 'forbidden' }, 'forbidden'], [{ code: 'hold' }, 'held'],
    [{ code: 'held' }, 'held'], [{ code: 'busy' }, 'busy'],
    [{ code: 'ABORT_ERR' }, 'aborted'], [{ code: 'deadline' }, 'deadline'],
    [{ code: 'ETIMEDOUT' }, 'deadline'], [{ name: 'AbortError' }, 'aborted'],
    [{ name: 'TimeoutError' }, 'deadline'], [{ code: 'TEST-raw-code' }, 'unknown'],
  ];
  for (const [error, category] of cases) {
    const lines: string[] = [];
    createRuntimeOpenDiagnostic(selected(), line => { lines.push(line); }, () => 2)('selection', error);
    const record = JSON.parse(lines[0]!.slice(prefix.length)) as Record<string, unknown>;
    assert.equal(record.category, category);
    assert.deepEqual(Object.keys(record).sort(),
      ['profileHash', 'configurationHash', 'source', 'phase', 'category', 'observedAtMs'].sort());
  }
});

test('missing original hash or time cannot be replaced by a later successful observation', () => {
  const lines: string[] = [], circular: { self?: unknown } = {};
  circular.self = circular;
  const target = { ...selected(), configuration: circular };
  const lostHash = createRuntimeOpenDiagnostic(target, line => { lines.push(line); }, () => 3);
  delete circular.self;
  lostHash('selection', new Error('TEST-error')); lostHash('driver-open', new Error('TEST-error'));
  assert.deepEqual(lines, []);
  for (const first of [NaN, Infinity, -1, 0.5, 'throw'] as const) {
    let calls = 0;
    const observe = createRuntimeOpenDiagnostic(selected(), line => { lines.push(line); }, () => {
      calls++;
      if (calls > 1) return 5;
      if (first === 'throw') throw new Error('TEST-clock');
      return first;
    });
    assert.doesNotThrow(() => observe('selection', null));
    observe('driver-open', null);
    assert.equal(calls, 1);
  }
  assert.deepEqual(lines, []);
});

test('failed synchronous or asynchronous diagnostic writers cannot alter the original refusal or retry it', async () => {
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const observe = createRuntimeOpenDiagnostic(selected(), () => {
      calls++;
      if (asynchronous) return Promise.reject(new Error('TEST-write'));
      throw new Error('TEST-write');
    }, () => 4);
    assert.doesNotThrow(() => observe('driver-open', { code: 'hold' }));
    assert.doesNotThrow(() => observe('driver-wrap', { code: 'busy' }));
    await tick(); assert.equal(calls, 1);
  }
});

test('producer refuses phases from another source and cannot add custody facts', () => {
  const lines: string[] = [];
  for (const [source, phase] of [['runtime', 'endpoint'], ['factory', 'readiness'], ['factory', 'TEST-raw']] as const) {
    createRuntimeOpenDiagnostic({ ...selected(), source }, line => { lines.push(line); }, () => 1)(
      phase as RuntimeOpenPhase, { code: 'hold', released: true, pid: 731 }
    );
  }
  assert.deepEqual(lines, []);
});

test('private default Console frames one record and leaves global console and stderr listeners unchanged', () => {
  const before = process.stderr.rawListeners('error'), globalError = console.error, lines: string[] = [];
  const original = process.stderr.write;
  const mock = vi.spyOn(process.stderr, 'write').mockImplementation(function (
    this: NodeJS.WriteStream, ...args: Parameters<NodeJS.WriteStream['write']>
  ) {
    const text = String(args[0]);
    if (!text.startsWith(prefix)) return original.apply(this, args);
    lines.push(text);
    const callback = args.find(value => typeof value === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    createRuntimeOpenDiagnostic(selected(), undefined, () => 7)('driver-open', { code: 'hold' });
    assert.equal(lines.length, 1); assert.ok(lines[0]!.endsWith('\n'));
    assert.equal(lines[0]!.split('\n').length, 2, 'Console adds exactly the one original frame delimiter');
    assert.equal(JSON.parse(lines[0]!.slice(prefix.length)).observedAtMs, 7);
    assert.deepEqual(process.stderr.rawListeners('error'), before);
    assert.equal(console.error, globalError);
  } finally { mock.mockRestore(); }
});

test('private default Console contains a synchronous stderr failure without a lasting listener', () => {
  const before = process.stderr.rawListeners('error'), original = process.stderr.write;
  let calls = 0;
  const mock = vi.spyOn(process.stderr, 'write').mockImplementation(function (
    this: NodeJS.WriteStream, ...args: Parameters<NodeJS.WriteStream['write']>
  ) {
    if (!String(args[0]).startsWith(prefix)) return original.apply(this, args);
    calls++; throw new Error('TEST-synchronous-stderr-failure');
  });
  try {
    const observe = createRuntimeOpenDiagnostic(selected(), undefined, () => 8);
    assert.doesNotThrow(() => observe('driver-open', { code: 'hold' }));
    observe('driver-wrap', { code: 'busy' });
    assert.equal(calls, 1);
    assert.deepEqual(process.stderr.rawListeners('error'), before);
  } finally { mock.mockRestore(); }
});

test('private default Console handles asynchronous callback and error emission without a lasting listener', async () => {
  const before = process.stderr.rawListeners('error'), original = process.stderr.write;
  let resolve!: () => void, reject!: (error: unknown) => void, calls = 0;
  const settled = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  const failure = new Error('TEST-asynchronous-stderr-failure');
  const mock = vi.spyOn(process.stderr, 'write').mockImplementation(function (
    this: NodeJS.WriteStream, ...args: Parameters<NodeJS.WriteStream['write']>
  ) {
    if (!String(args[0]).startsWith(prefix)) return original.apply(this, args);
    calls++;
    const callback = args.find(value => typeof value === 'function');
    queueMicrotask(() => {
      try {
        assert.equal(typeof callback, 'function');
        if (typeof callback === 'function') callback(failure);
        process.stderr.emit('error', failure);
        resolve();
      } catch (error) { reject(error); }
    });
    return false;
  });
  try {
    assert.doesNotThrow(() => createRuntimeOpenDiagnostic(selected(), undefined, () => 9)(
      'driver-open', { code: 'hold' }
    ));
    await settled;
    assert.equal(calls, 1);
    assert.deepEqual(process.stderr.rawListeners('error'), before);
  } finally { mock.mockRestore(); }
});

test('decoder keeps six exact frozen fields across byte splits', () => {
  const values: RuntimeOpenDiagnostic[] = [], decode = decodeTo(values);
  for (const byte of Buffer.from(frame())) decode(Buffer.from([byte]));
  assert.deepEqual(values, [valid]); assert.ok(Object.isFrozen(values[0]));
});

test('decoder rejects raw fields, wrong-source phases and malformed hashes, categories or timestamps', () => {
  const values: RuntimeOpenDiagnostic[] = [], decode = decodeTo(values);
  const unsafe = [
    { ...valid, extra: 'TEST-secret' }, { ...valid, pid: 731 }, { ...valid, released: true },
    { ...valid, message: '/TEST/private/error' }, { ...valid, environment: {} },
    { ...valid, profileHash: '/TEST/private/path' }, { ...valid, configurationHash: 'A'.repeat(64) },
    { ...valid, source: 'provider' }, { ...valid, phase: 'readiness' },
    { ...valid, source: 'runtime', phase: 'endpoint' }, { ...valid, category: 'TEST-error' },
    { ...valid, observedAtMs: -1 }, { ...valid, observedAtMs: 1.5 },
    { ...valid, observedAtMs: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, observedAtMs: null },
    { ...valid, observedAtMs: undefined }, { ...valid, observedAtMs: '1' },
  ];
  for (const value of unsafe) decode(Buffer.from(frame(value)));
  decode(Buffer.from(frame(null) + frame([])));
  assert.deepEqual(values, []);
  decode(Buffer.from(frame({ ...valid, source: 'runtime', phase: 'readiness' })));
  assert.equal(values.length, 1);
});

test('the original shared 8192-byte frame limit and fatal UTF-8 recovery remain exact', () => {
  const values: RuntimeOpenDiagnostic[] = [], decode = decodeTo(values);
  const original = frame().slice(0, -1), exact = original + ' '.repeat(8192 - Buffer.byteLength(original));
  decode(Buffer.from(exact + '\n'));
  assert.equal(values.length, 1);
  decode(Buffer.from(exact + ' '));
  decode(Buffer.from('\n' + frame()));
  assert.equal(values.length, 2, 'oversized frame is discarded without losing the next original frame');
  decode(Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from('\n')]));
  decode(Buffer.from(frame()));
  assert.equal(values.length, 3);
});

test('new refusal frames coexist with the original close, management, metadata and probe callbacks', () => {
  const kinds: string[] = [];
  const decode = decodeClaudeCloseDiagnostics(
    () => { kinds.push('close'); }, () => { kinds.push('management'); },
    () => { kinds.push('metadata'); }, () => { kinds.push('probe'); }, () => { kinds.push('runtime'); }
  );
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
    memberId: 'TEST-member', generation: '1' };
  const close = 'legacy-agent-host: claude-close ' + JSON.stringify({
    binding, sessionRef: 'TEST-session', stage: 'custody-confirmed', physicalConfirmed: true,
  }) + '\n';
  const management = 'legacy-agent-host: claude-management ' + JSON.stringify({
    profileHash: valid.profileHash, namespaceHash: valid.configurationHash, commandHash: null,
    stage: 'host-cleanup', code: 'cleanup-unconfirmed',
  }) + '\n';
  const metadata = 'legacy-agent-host: opencode-metadata ' + JSON.stringify({
    profileHash: valid.profileHash, mode: 'directory', providerHash: null,
    stage: 'ready', pid: 732, startIdentity: 'TEST:732:1',
  }) + '\n';
  const probe = 'legacy-agent-host: opencode-probe ' + JSON.stringify({
    profileHash: valid.profileHash, commandHash: valid.configurationHash, probeDigest: 'c'.repeat(64),
    phase: 'run', sequence: 1, elapsedMs: 0,
  }) + '\n';
  decode(Buffer.from(close + frame() + management + metadata + probe));
  assert.deepEqual(kinds, ['close', 'runtime', 'management', 'metadata', 'probe']);
  let closes = 0;
  decodeClaudeCloseDiagnostics(() => { closes++; })(Buffer.from(frame() + close));
  assert.equal(closes, 1, 'old callers with no new sink keep their existing records');
});

test('decoder contains synchronous and asynchronous sink failure without stopping later frames', async () => {
  let calls = 0;
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, () => {
    if (++calls === 1) throw new Error('TEST-sink');
    return Promise.reject(new Error('TEST-sink'));
  });
  assert.doesNotThrow(() => decode(Buffer.from(frame() + frame())));
  await tick(); assert.equal(calls, 2);
});

test('Main binds the observation to its captured Host PID without accepting a peer-supplied PID', () => {
  const entries: { namespace: string; args: readonly unknown[] }[] = [];
  let pid: number | undefined = 731;
  const removeBroken = addLogSink(() => { throw new Error('TEST-broken-log-sink'); });
  const remove = addLogSink(entry => { entries.push(entry); });
  const decode = createCapturedHostDiagnostics(() => pid);
  try {
    decode(Buffer.from(frame({ ...valid, hostPid: 999 }) + frame()));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.namespace, 'Host:RuntimeOpen');
    assert.deepEqual(entries[0]!.args, ['Runtime open refusal', { ...valid, hostPid: 731 }]);
    pid = undefined;
    decode(Buffer.from(frame()));
    assert.equal(entries.length, 1, 'a missing original Host child cannot be replaced by a new identity');
  } finally { remove(); removeBroken(); }
});
