import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

import { it as test } from 'vitest';

import { createOpenCodeProbeCloseDiagnostic, createOpenCodeProbeDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { createOpenCodeCurrentnessTiming } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeCurrentnessTiming';
import { createPassiveNativeDiagnosticCapture } from '../../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

import type { OpenCodeProbeCloseDiagnostic, OpenCodeProbeDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

const transportCodes = ['cleanup_unknown', 'authority_or_deadline', 'authority_mismatch',
  'transport_failure', 'http_failure', 'invalid_response', 'disposed'] as const;
const source = readFileSync(resolve('packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe.ts'), 'utf8');
const declarationsStart = source.indexOf('  let runState:');
const declarationsEnd = source.indexOf('  type CloseStage', declarationsStart);
const runStart = source.indexOf('    run: (signal, originalDeadline) => {');
const runEnd = source.indexOf('    close: originalDeadline => {', runStart);
assert.ok(declarationsStart > 0 && declarationsEnd > declarationsStart && runStart > declarationsEnd && runEnd > runStart);
// Execute the original catch/rethrow and projection, without constructing a provider or socket.
const originalRun = new Script(stripTypeScriptTypes(`(() => {
  ${source.slice(declarationsStart, declarationsEnd)}
  let running, calls = 0;
  const coordination = false;
  const run = () => { calls++; return rejectRun ? Promise.reject(failure) : Promise.resolve(result); };
  const probe = { ${source.slice(runStart, runEnd)} };
  return { run: probe.run, read: () => ({ runState, outcome, errorClass, runErrorCode, runCauseCode, calls }) };
})()`));

interface RunDiagnostic {
  runState: string;
  outcome: string;
  errorClass: string;
  runErrorCode: string | null;
  runCauseCode: string | null;
  calls: number;
}
interface ProbeRun {
  run(signal?: AbortSignal, deadline?: number): Promise<boolean>;
  read(): RunDiagnostic;
}
const subject = (failure: unknown, rejectRun = true, result = false): ProbeRun =>
  originalRun.runInNewContext({ failure, rejectRun, result }) as ProbeRun;
const digest = 'a'.repeat(64);
const prefix = 'legacy-agent-host: opencode-probe-close-failed ';
const selected = { profileId: 'TEST-probe', configRevision: 'TEST-revision' };
const observation = (diagnostic: RunDiagnostic) => {
  const { calls: _calls, ...fields } = diagnostic;
  return { probeDigest: digest, ...fields, stage: 'close-result', reason: 'unconfirmed' };
};
function forward(diagnostic: RunDiagnostic) {
  const lines: string[] = [], decoded: OpenCodeProbeCloseDiagnostic[] = [];
  createOpenCodeProbeCloseDiagnostic(selected, 'TEST-command', digest, line => lines.push(line))(observation(diagnostic));
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]!) <= 768);
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined,
    value => { decoded.push(value); });
  decode(Buffer.from(lines[0]!));
  assert.equal(decoded.length, 1);
  const passive = createPassiveNativeDiagnosticCapture();
  passive.accept(Buffer.from('TEST_OPENCODE_V2_DIAGNOSTIC ' + JSON.stringify({
    event: 'host-probe-close-failed', atMs: 1, ...observation(diagnostic),
  }) + '\n'), 1);
  assert.equal(passive.entries.length, 1);
  for (const retained of [decoded[0]!, passive.entries[0]!]) {
    assert.equal(retained.runErrorCode, diagnostic.runErrorCode);
    assert.equal(retained.runCauseCode, diagnostic.runCauseCode);
    assert.equal(retained.outcome, 'unobserved');
    assert.equal(Object.hasOwn(retained, 'cleanupConfirmed'), false);
  }
  return { lines, decoded, passive: passive.entries };
}

test.each(transportCodes)('original probe rejection retains finite SDK code %s through both diagnostic consumers', async code => {
  const failure = Object.assign(new Error('TEST-private-provider-text'), { code,
    cause: Object.assign(new Error('TEST-private-cause'), { code }) });
  const probe = subject(failure), pending = probe.run();
  assert.equal(probe.run(), pending, 'the original run remains single-flight');
  await assert.rejects(pending, error => error === failure);
  const diagnostic = probe.read();
  assert.equal(diagnostic.runState, 'threw');
  assert.equal(diagnostic.errorClass, 'unknown');
  assert.equal(diagnostic.runErrorCode, code); assert.equal(diagnostic.runCauseCode, code);
  assert.equal(diagnostic.calls, 1);
  const retained = forward(diagnostic);
  assert.equal(JSON.stringify(retained).includes('TEST-private'), false);
});

test('existing network codes remain projected while arbitrary and credential-like codes stay hidden', async () => {
  for (const code of ['ECONNRESET', 'TEST-new-unknown-code', 'sk-TEST-private-credential', 'Bearer TEST-private-token']) {
    const expected = code === 'ECONNRESET' ? code : null;
    const failure = Object.assign(new Error(code), { code, cause: { code } });
    const probe = subject(failure);
    await assert.rejects(probe.run(), error => error === failure);
    const diagnostic = probe.read();
    assert.equal(diagnostic.runErrorCode, expected); assert.equal(diagnostic.runCauseCode, expected);
    const retained = forward(diagnostic);
    if (expected === null) assert.equal(JSON.stringify(retained).includes(code), false);
  }
});

test('throwing cause and code getters cannot replace the original rejection or become diagnostic text', async () => {
  for (const field of ['cause', 'code']) {
    let reads = 0;
    const failure = Object.defineProperty(Object.assign(new Error('TEST-private-original'), { code: 'cleanup_unknown' }), field,
      { get() { reads++; throw new Error('TEST-private-getter'); } });
    const probe = subject(failure);
    await assert.rejects(probe.run(), error => error === failure);
    assert.equal(reads, 0);
    const diagnostic = probe.read();
    assert.equal(diagnostic.runState, 'threw'); assert.equal(diagnostic.outcome, 'unobserved');
    assert.equal(diagnostic.runErrorCode, field === 'cause' ? 'cleanup_unknown' : null);
    assert.equal(diagnostic.runCauseCode, null);
    assert.equal(JSON.stringify(forward(diagnostic)).includes('TEST-private'), false);
  }
});

test('strict Host and Main consumers reject injected unknown codes and retain unchanged close bounds', () => {
  const invalid = { ...observation({ runState: 'threw', outcome: 'unobserved', errorClass: 'unknown',
    runErrorCode: null, runCauseCode: null, calls: 1 }), runErrorCode: 'sk-TEST-private-credential' };
  const lines: string[] = [], decoded: unknown[] = [];
  createOpenCodeProbeCloseDiagnostic(selected, 'TEST-command', digest, line => lines.push(line))(invalid);
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined,
    value => { decoded.push(value); });
  decode(Buffer.from(prefix + JSON.stringify({ profileHash: 'b'.repeat(64), commandHash: 'c'.repeat(64), ...invalid }) + '\n'));
  assert.deepEqual(lines, []); assert.deepEqual(decoded, []);
  const passive = createPassiveNativeDiagnosticCapture();
  passive.accept(Buffer.from('TEST_OPENCODE_V2_DIAGNOSTIC ' + JSON.stringify({
    event: 'host-probe-close-failed', atMs: 1, ...invalid,
  }) + '\n'), 1);
  assert.equal(passive.entries.length, 1);
  assert.equal(passive.entries[0]!.runErrorCode, null);
  assert.equal(JSON.stringify(passive.entries).includes('sk-TEST-private-credential'), false);
});

test('the original successful and false outcomes remain unchanged', async () => {
  for (const result of [true, false]) {
    const probe = subject(undefined, false, result);
    assert.equal(await probe.run(), result);
    const diagnostic = probe.read();
    assert.equal(diagnostic.runState, String(result)); assert.equal(diagnostic.errorClass, 'none');
    assert.equal(diagnostic.runErrorCode, null); assert.equal(diagnostic.runCauseCode, null);
    assert.equal(diagnostic.calls, 1);
  }
});

const admissionStart = source.indexOf('  const assertCurrent = (signal?: AbortSignal) => {');
const admissionEnd = source.indexOf('  const readPassword = () => {', admissionStart);
const identityStart = source.indexOf('    await withClient(signal, async (client, wire) => {');
const identityBody = source.indexOf('\n', identityStart);
const identityEnd = source.indexOf("      observePhase?.('credential');", identityBody);
assert.ok(admissionStart > 0 && admissionEnd > admissionStart && identityStart > admissionEnd && identityEnd > identityBody);
// Execute the actual first-identity entry, currentness guards and native lease path.
// Native measurement and client I/O are finite controlled seams; no provider or socket starts.
const originalIdentity = new Script(stripTypeScriptTypes(`(() => {
  ${source.slice(admissionStart, admissionEnd)}
  return { beforeRequest, async identity(signal) {
    const client = makeClient(beforeRequest, signal);
    ${source.slice(identityBody, identityEnd)}
    observePhase?.('credential');
    return identity;
  } };
})()`));
type Admission = (signal: AbortSignal) => Promise<() => void>;
type Identity = { pid: number; version: string };
const identityPhases = ['identity-start', 'identity-request-start', 'identity-custody-start',
  'identity-custody-returned', 'identity-request-admitted', 'credential'];

function identitySubject(options: {
  brokenSink?: boolean; current?: boolean; beforeClientFailure?: Error; earlyClientRejection?: boolean;
} = {}) {
  const parent = new AbortController(), abort = new AbortController();
  const native = Promise.withResolvers<Identity & { startIdentity: string } | undefined>();
  const response = Promise.withResolvers<Identity>();
  const clientFailure = Promise.withResolvers<never>(), clientSettled = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>(), fetching = Promise.withResolvers<void>();
  const requests = new Set<Promise<void>>(), records: OpenCodeProbeDiagnostic[] = [];
  const ready = { pid: 48101, startIdentity: 'TEST-original-root', version: '2.1.4' };
  const held = new Error('TEST-original-held');
  let current = options.current ?? true, now = 100, checks = 0, custody = 0, http = 0;
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, value => { records.push(value); });
  const observePhase = createOpenCodeProbeDiagnostic(selected, 'TEST-command', digest, line => {
    decode(Buffer.from(line));
    if (options.brokenSink) throw new Error('TEST-private-diagnostic-sink');
  }, () => now);
  const currentnessTiming = createOpenCodeCurrentnessTiming(observePhase, () => now);
  const originals = () => records.filter(record => record.phase !== 'identity-currentness-summary');
  const subject = originalIdentity.runInNewContext({
    current: () => {
      const finishCurrent = currentnessTiming.enter();
      try { checks++; return current; } finally { finishCurrent(); }
    }, Date: { now: () => now }, deadline: 1000,
    unavailable: () => { throw held; }, abort, AbortSignal, requests, ready, observePhase, currentnessTiming,
    server: { async readNativeCustody(signal: AbortSignal) {
      custody++; assert.equal(signal.aborted, false); entered.resolve(); return native.promise;
    } },
    makeClient: (beforeRequest: Admission, signal: AbortSignal) => ({ async identity() {
      if (options.beforeClientFailure) throw options.beforeClientFailure;
      const work = (async () => {
        const release = await beforeRequest(signal);
        try { http++; fetching.resolve(); return await response.promise; }
        finally { release(); }
      })();
      void work.then(() => clientSettled.resolve(), () => clientSettled.resolve());
      return options.earlyClientRejection ? Promise.race([work, clientFailure.promise]) : work;
    } }),
  }) as { identity(signal: AbortSignal): Promise<Identity>; beforeRequest: Admission };
  return { subject, parent, abort, native, response, entered, fetching, requests, records, ready, held,
    clientFailure, clientSettled,
    start: () => subject.identity(parent.signal),
    originals, phases: () => originals().map(record => record.phase),
    summaries: () => records.filter(record => record.phase === 'identity-currentness-summary'),
    counts: () => ({ checks, custody, http, leases: requests.size }),
    revoke: () => { current = false; }, advance: (at: number) => { now = at; },
  };
}

function assertIdentitySummary(f: ReturnType<typeof identitySubject>, calls: number, sequence: number, elapsedMs = 0) {
  assert.deepEqual(f.summaries(), [{ ...f.originals()[0], phase: 'identity-currentness-summary',
    sequence, elapsedMs, currentCalls: calls, currentElapsedMs: 0 }]);
}

test.each([false, true])('first identity observes the original custody and HTTP boundaries with sink failure=%s', async brokenSink => {
  const f = identitySubject({ brokenSink }), run = f.start();
  await f.entered.promise;
  assert.deepEqual(f.phases(), identityPhases.slice(0, 3));
  assert.deepEqual(f.summaries(), []);
  assert.deepEqual(f.counts(), { checks: 1, custody: 1, http: 0, leases: 1 });
  f.advance(150); f.native.resolve(f.ready);
  await f.fetching.promise;
  assert.deepEqual(f.phases(), identityPhases.slice(0, 5));
  assertIdentitySummary(f, 2, 5, 50);
  assert.deepEqual(f.counts(), { checks: 2, custody: 1, http: 1, leases: 1 });
  f.advance(175); f.response.resolve(f.ready);
  assert.equal(await run, f.ready);
  assert.deepEqual(f.phases(), identityPhases);
  assert.deepEqual(f.counts(), { checks: 2, custody: 1, http: 1, leases: 0 });
  const laterRelease = await f.subject.beforeRequest(f.parent.signal);
  assert.deepEqual(f.phases(), identityPhases, 'later credential/attestation requests cannot reuse the first-identity token');
  assert.deepEqual(f.counts(), { checks: 4, custody: 2, http: 1, leases: 1 });
  laterRelease(); laterRelease();
  assert.equal(f.requests.size, 0, 'the original lease remains idempotent');
  assert.deepEqual(f.originals().map(record => record.elapsedMs), [0, 0, 0, 50, 50, 75]);
  assert.ok(f.originals().every(record => Object.keys(record).length === 6 && !Object.hasOwn(record, 'ready')));
  assertIdentitySummary(f, 2, 5, 50);
});

test.each(['current', 'deadline', 'aborted'] as const)('first identity cannot bypass original %s admission refusal', async kind => {
  const f = identitySubject({ current: kind !== 'current' });
  const reason = new Error('TEST-original-abort');
  if (kind === 'deadline') f.advance(1000);
  if (kind === 'aborted') f.parent.abort(reason);
  await assert.rejects(f.start(), error => error === (kind === 'aborted' ? reason : f.held));
  assert.deepEqual(f.phases(), identityPhases.slice(0, 2));
  assert.deepEqual(f.counts(), { checks: kind === 'aborted' ? 0 : 1, custody: 0, http: 0, leases: 0 });
  assertIdentitySummary(f, kind === 'aborted' ? 0 : 1, 2);
});

test.each(['missing', 'pid', 'startIdentity', 'version', 'current', 'deadline', 'aborted'] as const)(
  'first identity preserves the original post-custody %s refusal and releases its original lease', async kind => {
    const f = identitySubject(), run = f.start(), reason = new Error('TEST-original-late-abort');
    const rejected = assert.rejects(run, error => error === (kind === 'aborted' ? reason : f.held));
    await f.entered.promise;
    if (kind === 'current') f.revoke();
    if (kind === 'deadline') f.advance(1000);
    if (kind === 'aborted') f.parent.abort(reason);
    const custody = { ...f.ready,
      ...(kind === 'pid' ? { pid: f.ready.pid + 1 } : {}),
      ...(kind === 'startIdentity' ? { startIdentity: 'TEST-different-root' } : {}),
      ...(kind === 'version' ? { version: '2.1.3' } : {}),
    };
    f.native.resolve(kind === 'missing' ? undefined : custody);
    await rejected;
    assert.deepEqual(f.phases(), identityPhases.slice(0, 4));
    assert.deepEqual(f.counts(), { checks: kind === 'aborted' ? 1 : 2, custody: 1, http: 0, leases: 0 });
    assertIdentitySummary(f, kind === 'aborted' ? 1 : 2, 4, kind === 'deadline' ? 900 : 0);
  }
);

test('first identity retains an original thrown custody error without reporting a returned or admitted lease', async () => {
  const f = identitySubject({ brokenSink: true }), run = f.start();
  const failure = new Error('TEST-original-custody-failure');
  const rejected = assert.rejects(run, error => error === failure);
  await f.entered.promise; f.native.reject(failure);
  await rejected;
  assert.deepEqual(f.phases(), identityPhases.slice(0, 3));
  assert.deepEqual(f.counts(), { checks: 1, custody: 1, http: 0, leases: 0 });
  assertIdentitySummary(f, 1, 3);
});

test('late native return after identity rejection observes only the original continuation and releases its lease', async () => {
  const f = identitySubject({ earlyClientRejection: true }), run = f.start();
  const failure = new Error('TEST-original-transport-failure');
  const rejected = assert.rejects(run, error => error === failure);
  await f.entered.promise;
  f.parent.abort(failure); f.clientFailure.reject(failure);
  await rejected;
  assert.deepEqual(f.phases(), identityPhases.slice(0, 3));
  assert.deepEqual(f.counts(), { checks: 1, custody: 1, http: 0, leases: 1 });
  assert.deepEqual(f.summaries(), []);
  f.advance(250); f.native.resolve(f.ready);
  await f.clientSettled.promise;
  assert.deepEqual(f.phases(), identityPhases.slice(0, 4));
  assert.deepEqual(f.counts(), { checks: 1, custody: 1, http: 0, leases: 0 });
  assertIdentitySummary(f, 1, 4, 150);
  await assert.rejects(run, error => error === failure);
});

test('identity failure before beforeRequest clears observation scope for later calls', async () => {
  const failure = new Error('TEST-original-client-failure'), f = identitySubject({ beforeClientFailure: failure });
  await assert.rejects(f.start(), error => error === failure);
  assert.deepEqual(f.phases(), ['identity-start']);
  assert.deepEqual(f.counts(), { checks: 0, custody: 0, http: 0, leases: 0 });
  assert.deepEqual(f.summaries(), []);
  f.native.resolve(f.ready);
  const release = await f.subject.beforeRequest(f.parent.signal);
  release();
  assert.deepEqual(f.phases(), ['identity-start']);
  assert.deepEqual(f.counts(), { checks: 2, custody: 1, http: 0, leases: 0 });
  assert.deepEqual(f.summaries(), []);
});
