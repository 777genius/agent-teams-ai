import assert from 'node:assert/strict';

import { it as test } from 'vitest';

import { createClaudeCloseDiagnostic, createClaudeManagementDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

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
