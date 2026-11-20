import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

import { it as test } from 'vitest';

import { createOpenCodeProbeCloseDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { createPassiveNativeDiagnosticCapture } from '../../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

import type { OpenCodeProbeCloseDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

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
