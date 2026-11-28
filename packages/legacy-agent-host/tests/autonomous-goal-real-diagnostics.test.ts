// Pure owned TEST inputs only; no native executable, account, network or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GOAL_DIAGNOSTIC_LIMITS, goalRuntimeDiagnostics, goalTransportEnvironment } from './fixtures/real-vendor/goal-diagnostics.ts';
import type { RuntimeActivityEvent } from '../dist/runtime/activityContracts.js';

const event = (sequence: number, data: RuntimeActivityEvent['data']): RuntimeActivityEvent => ({
  sequence, eventId: `TEST-event-${sequence}`, observedAt: '2026-11-27T23:42:05.000Z',
  inputId: 'TEST-original-input', operationRef: 'TEST-original-operation', data,
});

test('goal transport copies only explicit existing proxy and CA keys without changing empty values or bypass rules', () => {
  const source = Object.freeze({
    HTTPS_PROXY: 'http://TEST-proxy.invalid:8443', https_proxy: '', HTTP_PROXY: '',
    ALL_PROXY: 'socks5://TEST-proxy.invalid:1080', all_proxy: undefined,
    NO_PROXY: ' localhost,127.0.0.1,::1,.internal ', no_proxy: '',
    SSL_CERT_FILE: '/TEST-ca.pem', SSL_CERT_DIR: '', NODE_EXTRA_CA_CERTS: '/TEST-node-ca.pem',
    HOME: '/TEST-account', PATH: '/TEST-bin', CODEX_HOME: '/TEST-auth',
    OPENAI_API_KEY: 'TEST-must-not-copy', REAL_CODEX_MODEL: 'TEST-must-not-copy',
    OPENAI_BASE_URL: 'https://TEST-endpoint.invalid', ARBITRARY_SECRET: 'TEST-must-not-copy',
  });
  assert.deepEqual(goalTransportEnvironment(source), {
    HTTP_PROXY: '', HTTPS_PROXY: source.HTTPS_PROXY, ALL_PROXY: source.ALL_PROXY,
    NO_PROXY: source.NO_PROXY, https_proxy: '', no_proxy: '', SSL_CERT_FILE: source.SSL_CERT_FILE,
    SSL_CERT_DIR: '', NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS,
  });
  assert.equal(source.OPENAI_API_KEY, 'TEST-must-not-copy');
  assert.deepEqual(goalTransportEnvironment({}), {});
  assert.deepEqual(goalTransportEnvironment(Object.create({ HTTPS_PROXY: 'TEST-inherited' }) as Record<string, string>), {});
});

test('original diagnostics retain result identities while excluding model text, tool arguments, stdout and config fields', () => {
  const events = [
    event(1, { kind: 'text', text: 'TEST-MODEL-PRIVATE' }),
    event(2, { kind: 'tool', input: { password: 'TEST-TOOL-PRIVATE' } }),
    event(3, { kind: 'interaction', request: { secret: 'TEST-INTERACTION-PRIVATE' } }),
    event(4, { kind: 'process-output', stream: 'stdout', text: 'TEST-STDOUT-PRIVATE' }),
    event(5, { kind: 'diagnostic', code: 'dependency-unavailable', config: { arbitrary: 'TEST-CONFIG-PRIVATE' } }),
    event(6, { kind: 'gap', reason: 'retention', text: 'TEST-GAP-PRIVATE' }),
    event(7, { kind: 'result', outcome: 'unknown', code: 'unknown', text: 'TEST-RESULT-PRIVATE' }),
  ];
  const result = goalRuntimeDiagnostics({ sequence: 7, events });
  assert.equal(result.status, 'available');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.events.map(row => row.sequence), [5, 6, 7]);
  assert.deepEqual(result.events.at(-1), { sequence: 7, observedAt: events[6]!.observedAt,
    inputId: 'TEST-original-input', operationRef: 'TEST-original-operation',
    data: { kind: 'result', code: 'unknown', outcome: 'unknown' } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(goalRuntimeDiagnostics(undefined).status, 'absent');
});

test('native diagnostic projection redacts held proxy values, credentials, escaped secret suffixes and configuration dumps', () => {
  const secret = 'TEST-held-proxy-private';
  const events = [
    event(1, { kind: 'process-output', stream: 'stderr', text: `TLS connection failed: ${secret}` }),
    event(2, { kind: 'process-output', stream: 'stderr',
      text: 'request https://TEST-user:TEST-password@service.invalid/path?token=TEST-query failed; Authorization: Bearer TEST-bearer' }),
    event(3, { kind: 'process-output', stream: 'stderr',
      text: String.raw`{"access_token":"TEST-prefix\"TEST-secret-suffix","message":"timeout"}` }),
    event(4, { kind: 'process-output', stream: 'stderr', text: 'configuration = { "arbitrary": "TEST-config-value" }' }),
    event(5, { kind: 'diagnostic', code: 'token=TEST-code-secret' }),
  ];
  const result = goalRuntimeDiagnostics({ sequence: 5, events }, [secret, '']);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /TLS connection failed/);
  assert.match(serialized, /redacted/);
  assert.match(serialized, /configuration\/auth\/environment dump hidden/);
  for (const value of [secret, 'TEST-user', 'TEST-password', 'TEST-query', 'TEST-bearer',
    'TEST-prefix', 'TEST-secret-suffix', 'TEST-config-value', 'TEST-code-secret']) assert.ok(!serialized.includes(value), value);
});

test('diagnostic receipts keep the newest bounded events and disclose lost retention or oversized input', () => {
  const events = Array.from({ length: 300 }, (_, index) => event(index + 10,
    { kind: 'process-output', stream: 'stderr', text: 'TEST line ' + index }));
  const result = goalRuntimeDiagnostics({ sequence: 309, events });
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, GOAL_DIAGNOSTIC_LIMITS.events);
  assert.equal(result.events[0]!.sequence, 278);
  assert.equal(result.events.at(-1)!.sequence, 309);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= GOAL_DIAGNOSTIC_LIMITS.bytes);
  const oversized = goalRuntimeDiagnostics({ sequence: 1, events: [event(1,
    { kind: 'process-output', stream: 'stderr', text: 'TEST-never-copy'.repeat(4000) })] });
  assert.equal(oversized.truncated, true);
  assert.doesNotMatch(JSON.stringify(oversized), /TEST-never-copy/);
  assert.match(JSON.stringify(oversized), /oversized diagnostic omitted/);
  const unicode = goalRuntimeDiagnostics({ sequence: 40, events: Array.from({ length: 40 }, (_, index) => event(index + 1,
    { kind: 'process-output', stream: 'stderr', text: '界'.repeat(2000) })) });
  assert.equal(unicode.truncated, true);
  assert.ok(unicode.events.length > 0 && unicode.events.length < GOAL_DIAGNOSTIC_LIMITS.events);
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) <= GOAL_DIAGNOSTIC_LIMITS.bytes);
  assert.equal(unicode.events.at(-1)!.sequence, 40);
});
