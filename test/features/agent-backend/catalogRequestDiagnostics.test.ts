import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { createOpenCodeCatalogDiagnostic } from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import { createCapturedHostDiagnostics, observeCapturedCatalogRequest } from '../../../src/features/agent-backend/main/infrastructure/createCapturedHostDiagnostics';
import { decodeClaudeCloseDiagnostics, type OpenCodeCatalogDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';
import { addLogSink } from '../../../src/shared/utils/logger';

const requestId = '12345678-1234-4123-8123-123456789abc';
const requestIdHash = createHash('sha256').update(requestId, 'utf8').digest('hex');
const prefix = 'legacy-agent-host: opencode-catalog ';
const phases = ['queued', 'started', 'returned'] as const;
const inputs = [
  [{ providerId: 'TEST-private-provider', includeModels: true }, 'explicit-provider'],
  [{ includeModels: true }, 'include-models'],
  [{ includeModels: false }, 'directory'],
] as const;

for (const [input, inputKind] of inputs) it(`joins the original ${inputKind} RPC through the actual collector`, () => {
  const records: OpenCodeCatalogDiagnostic[] = [];
  const remove = addLogSink(entry => {
    if (entry.namespace === 'Host:OpenCodeCatalog') records.push(entry.args[1] as OpenCodeCatalogDiagnostic);
  });
  try {
    observeCapturedCatalogRequest(requestId, 'management.catalog', { ...input, profileId: 'TEST-private-profile' });
    const collect = createCapturedHostDiagnostics(() => 42);
    const observe = createOpenCodeCatalogDiagnostic(requestId, input, line => collect(Buffer.from(line)));
    for (const phase of phases) observe(phase);
    expect(records.map(record => record.phase)).toEqual(['main-admitted', ...phases]);
    expect(records.every(record => record.requestIdHash === requestIdHash && record.inputKind === inputKind)).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/12345678|TEST-private/);
  } finally { remove(); }
});

it('does not invent identity or catalog methods and isolates observer exceptions', () => {
  const lines: string[] = [], records: OpenCodeCatalogDiagnostic[] = [];
  for (const id of [undefined, 17]) {
    for (const phase of phases) createOpenCodeCatalogDiagnostic(id, {}, line => lines.push(line))(phase);
    observeCapturedCatalogRequest(id, 'management.catalog', {}, value => records.push(value));
  }
  observeCapturedCatalogRequest(requestId, 'runtime.source.management.catalog', {}, value => records.push(value));
  createOpenCodeCatalogDiagnostic(requestId, {}, line => lines.push(line))('main-admitted' as typeof phases[number]);
  expect(lines).toEqual([]); expect(records).toEqual([]);
  const fail = () => { throw new Error('TEST private sink failure'); };
  expect(() => observeCapturedCatalogRequest(requestId, 'management.catalog', {}, fail)).not.toThrow();
  const observe = createOpenCodeCatalogDiagnostic(requestId, {}, fail);
  for (const phase of phases) expect(() => observe(phase)).not.toThrow();
});

it('does not reread accessor input after original request serialization', () => {
  let reads = 0;
  const params = { get providerId() { reads++; return 'TEST-provider'; }, get includeModels() { reads++; return true; } };
  JSON.stringify(params);
  const originalReads = reads, records: OpenCodeCatalogDiagnostic[] = [];
  observeCapturedCatalogRequest(requestId, 'management.catalog', params, value => records.push(value));
  expect(reads).toBe(originalReads); expect(records).toEqual([]);
});

it('keeps catalog framing closed, bounded and separate from all custody/lifecycle sinks', async () => {
  const records: OpenCodeCatalogDiagnostic[] = [];
  let otherCalls = 0;
  const other = () => { otherCalls++; };
  const decode = decodeClaudeCloseDiagnostics(other, other, other, other, other, other, value => { records.push(value); });
  const value = { requestIdHash, inputKind: 'directory', phase: 'queued' };
  const frame = (data: unknown) => `${prefix}${JSON.stringify(data)}\n`;
  for (const invalid of [{ ...value, requestIdHash: requestId }, { ...value, inputKind: 'secret' },
    { ...value, phase: 'main-admitted' }, { ...value, raw: 'TEST-secret' }]) decode(Buffer.from(frame(invalid)));
  decode(Buffer.from(`${prefix}${' '.repeat(256)}${JSON.stringify(value)}\n`));
  for (const byte of Buffer.from(frame(value))) decode(Buffer.from([byte]));
  expect(records).toEqual([value]); expect(Object.isFrozen(records[0])).toBe(true); expect(otherCalls).toBe(0);
  let failedSinks = 0;
  const throwing = decodeClaudeCloseDiagnostics(other, undefined, undefined, undefined, undefined, undefined, () => {
    if (++failedSinks === 1) throw new Error('TEST sink');
    return Promise.reject(new Error('TEST sink'));
  });
  expect(() => throwing(Buffer.from(frame(value) + frame(value)))).not.toThrow();
  await Promise.resolve(); expect(failedSinks).toBe(2); expect(otherCalls).toBe(0);
});
