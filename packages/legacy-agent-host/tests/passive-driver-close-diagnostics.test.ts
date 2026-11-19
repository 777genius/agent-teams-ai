import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const diagnosticPrefix = 'TEST_OPENCODE_V2_DIAGNOSTIC ';
const closeChannel = 'agent-teams:opencode-v2:driver-close-failed';
const binding = 'a'.repeat(64);
const failure = { trustedBinding: binding, stage: 'protocol-dispose', outcome: 'threw' };
type Entry = Record<string, unknown>;
type Capture = { entries: Entry[]; readonly limited: boolean; accept(chunk: Buffer, epoch: number): void };

/** Real fixture bodies and diagnostics channels, with process streams in memory only. */
function fixture() {
  const url = new URL('./fixtures/native-opencode-team/passive-diagnostics.ts', import.meta.url);
  const source = stripTypeScriptTypes(readFileSync(url, 'utf8')).replace(/^import [^\n]+;\r?\n/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(url.href));
  const writes: string[] = [], stdin = new EventEmitter();
  const subscriptions: { name: string; listener: (message: unknown, name: string | symbol) => void }[] = [];
  const bindings = { lstat, open, unlink, performance, fileURLToPath,
    process: { platform: 'linux', arch: 'x64', version: 'v24.21.0', execArgv: [], stdin,
      stderr: { write: (value: string) => { writes.push(value); return true; } } },
    channel: (name: string) => ({ subscribe(listener: (message: unknown, name: string | symbol) => void) {
      channel(name).subscribe(listener); subscriptions.push({ name, listener });
    } }),
  };
  const evaluate = new Function(...Object.keys(bindings), '"use strict";\n' + source +
    '\nreturn { observeOriginalHost, createPassiveNativeDiagnosticCapture };') as (...args: unknown[]) => {
      observeOriginalHost(): void; createPassiveNativeDiagnosticCapture(): Capture;
    };
  const actual = evaluate(...Object.values(bindings));
  return { writes, capture: actual.createPassiveNativeDiagnosticCapture, start: actual.observeOriginalHost,
    rows: () => writes.map(line => JSON.parse(line.slice(diagnosticPrefix.length)) as Entry),
    close() {
      for (const { name, listener } of subscriptions) channel(name).unsubscribe(listener);
      subscriptions.length = 0; stdin.removeAllListeners();
    },
  };
}

function accept(capture: Capture, value: Entry, epoch = 3) {
  capture.accept(Buffer.from(diagnosticPrefix + JSON.stringify(value) + '\n'), epoch);
}

function otherFailures() {
  channel('agent-teams:opencode-v2:read-cut-failed').publish({ stage: 'after-log', reason: 'transport_failure',
    elapsedMs: 1, deadlineExpired: false, aborted: false });
  channel('agent-teams:opencode-v2:metadata-read-failed').publish({ stage: 'admission', reason: 'held',
    elapsedMs: 1, deadlineExpired: false, aborted: null });
  channel('agent-teams:opencode-v2:host-probe-close-failed').publish({ probeDigest: 'c'.repeat(64),
    runState: 'threw', outcome: 'unknown', errorClass: 'unknown', stage: 'driver-close', reason: 'unconfirmed' });
  channel('agent-teams.legacy-host.first-refusal').publish({ kind: 'consumer', phase: 'reference',
    reason: 'held', cutoff: 4, observedAt: 5 });
}

test('original driver close failure reaches both passive boundaries with an opaque binding', () => {
  for (const stage of ['original-work', 'protocol-dispose', 'confirm-stopped']) {
    for (const outcome of ['threw', 'unconfirmed']) {
      const actual = fixture();
      try {
        actual.start();
        const trustedBinding = outcome === 'threw' ? binding : 'b'.repeat(64);
        channel(closeChannel).publish({ trustedBinding, stage, outcome, rawError: 'TEST-secret-never-retained' });
        assert.equal(actual.writes.length, 1, 'existing producer failure channel must reach original Host diagnostics');
        const emitted = actual.rows()[0]!;
        assert.deepEqual(Object.keys(emitted).sort(), ['atMs', 'event', 'outcome', 'stage', 'trustedBinding']);
        assert.equal(emitted.event, 'driver-close-failed');
        const capture = actual.capture(), bytes = Buffer.from(actual.writes[0]!);
        capture.accept(bytes.subarray(0, 17), 3); assert.equal(capture.entries.length, 0);
        capture.accept(bytes.subarray(17), 3);
        assert.deepEqual(capture.entries, [{ epoch: 3, ...emitted }]);
        assert.equal(emitted.trustedBinding, trustedBinding, 'a well-formed binding stays opaque, without a new equality selector');
        assert.equal(JSON.stringify(capture.entries).includes('TEST-secret'), false);
        channel(closeChannel).publish({ ...failure, trustedBinding: 'd'.repeat(64) });
        assert.equal(actual.writes.length, 1, 'only the first original driver failure is retained');
      } finally { actual.close(); }
    }
  }
});

test('driver failure projection rejects malformed fields and never invokes diagnostic getters', () => {
  const actual = fixture(); let getterCalls = 0;
  try {
    actual.start();
    const invalid: unknown[] = [null, [], 'TEST-invalid', {}, Object.create(failure),
      ...[undefined, null, 1, [binding], '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)]
        .map(trustedBinding => ({ ...failure, trustedBinding })),
      { ...failure, stage: 'TEST-native-error' }, { ...failure, outcome: 'confirmed' },
      { ...failure, stage: ['protocol-dispose'] }, { ...failure, outcome: ['threw'] }];
    for (const field of ['trustedBinding', 'stage', 'outcome']) {
      invalid.push(Object.defineProperty({ ...failure }, field, { get() { getterCalls++; throw Error('TEST-getter'); } }));
    }
    invalid.push(new Proxy({}, { getOwnPropertyDescriptor() { throw Error('TEST-descriptor'); } }));
    for (const value of invalid) channel(closeChannel).publish(value);
    assert.equal(actual.writes.length, 0);
    channel(closeChannel).publish(Object.defineProperty({ ...failure }, 'rawError', {
      get() { getterCalls++; throw Error('TEST-unknown-field'); },
    }));
    assert.equal(actual.writes.length, 1, 'discarded extra fields cannot replace a valid original failure');
    assert.equal(getterCalls, 0);
  } finally { actual.close(); }
});

test('receipt independently projects driver labels and retains the first observation across epochs', () => {
  const actual = fixture();
  try {
    const capture = actual.capture(), value = { event: 'driver-close-failed', atMs: 1, ...failure };
    for (const malformed of [{ ...value, trustedBinding: 'foreign' }, { ...value, stage: 'TEST-private-stage' },
      { ...value, outcome: 'confirmed' }, { ...value, atMs: -1 }, { ...value, trustedBinding: [binding] }]) accept(capture, malformed);
    accept(capture, { ...value, discarded: 'x'.repeat(600) });
    assert.equal(capture.entries.length, 0, 'invalid and overlong rows do not consume the reserved slot');
    accept(capture, { ...value, discarded: 'TEST-private-payload' }, 2);
    accept(capture, { ...value, stage: 'confirm-stopped', trustedBinding: 'b'.repeat(64) }, 3);
    assert.deepEqual(capture.entries, [{ epoch: 2, event: 'driver-close-failed', atMs: 1, ...failure }]);
  } finally { actual.close(); }
});

test('driver close and all existing failures survive the ordinary cap within original total bounds', () => {
  const actual = fixture();
  try {
    actual.start();
    for (let index = 0; index < 500; index++) channel('undici:request:create').publish({
      request: { origin: 'http://127.0.0.1:12345', path: '/api/info', method: 'GET' },
    });
    assert.equal(actual.rows().filter(row => row.event === 'request').length, 251);
    assert.equal(actual.rows().filter(row => row.event === 'trace-limit').length, 1);
    channel(closeChannel).publish(failure); otherFailures();
    assert.equal(actual.writes.length, 257, 'one fewer ordinary row reserves the new failure without raising total rows');
    assert.ok(actual.writes.every(line => Buffer.byteLength(line) <= 513));
    assert.ok(Buffer.byteLength(actual.writes.join('')) <= 64 * 1024);
    const capture = actual.capture();
    for (const line of actual.writes) capture.accept(Buffer.from(line), 3);
    capture.accept(Buffer.from('legacy-agent-host: runtime-open ' + JSON.stringify({ source: 'runtime',
      phase: 'driver-open', category: 'held', observedAtMs: 1000 }) + '\n'), 3);
    assert.equal(capture.entries.filter(row => row.event === 'request').length, 250);
    assert.equal(capture.entries.length, 257);
    for (const event of ['driver-close-failed', 'host-probe-close-failed', 'metadata-read-failed',
      'read-cut-failed', 'readiness-refused', 'runtime-open-failed', 'trace-limit']) {
      assert.equal(capture.entries.filter(row => row.event === event).length, 1, event);
    }
    assert.ok(capture.entries.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 513));
    assert.ok(capture.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0) <= 64 * 1024);
    assert.equal(capture.limited, true);
  } finally { actual.close(); }
});

test('receipt reserves driver failure under byte pressure without expanding trace or line budgets', () => {
  const actual = fixture();
  try {
    const capture = actual.capture();
    const pressure = { event: 'response', atMs: 3600000, child: 5, request: 4096,
      route: 'credential-remove', method: 'DELETE', durationMs: 3600000, status: 599,
      contentEncoding: 'deflate', stage: 'configuration', code: 'UND_ERR_BODY_TIMEOUT', exitCode: 255, signal: 'SIGSEGV' };
    for (let index = 0; index < 1000; index++) accept(capture, pressure, index < 500 ? 1 : 2);
    const ordinary = capture.entries.length;
    assert.ok(ordinary < 250 && ordinary > 0, 'the byte bound is exercised before the row bound');
    accept(capture, { event: 'driver-close-failed', atMs: 1, ...failure });
    accept(capture, { event: 'trace-limit', atMs: 2 });
    assert.equal(capture.entries.length, ordinary + 2);
    assert.equal(capture.entries.filter(row => row.event === 'driver-close-failed').length, 1);
    assert.ok(capture.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0) <= 64 * 1024);
    assert.ok(capture.entries.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 513));
  } finally { actual.close(); }
});

test('loading the actual capture remains passive and finite subscriptions are removed after verification', () => {
  const before = channel(closeChannel).hasSubscribers, actual = fixture();
  channel(closeChannel).publish(failure);
  assert.equal(actual.writes.length, 0, 'import alone does not activate original Host observation');
  try {
    actual.start(); assert.equal(channel(closeChannel).hasSubscribers, true);
    channel(closeChannel).publish(failure); assert.equal(actual.writes.length, 1);
  } finally { actual.close(); }
  assert.equal(channel(closeChannel).hasSubscribers, before);
  channel(closeChannel).publish({ ...failure, stage: 'confirm-stopped' });
  assert.equal(actual.writes.length, 1, 'no finite TEST callback remains subscribed');
});
