import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson, type RawRecord,sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { assembleEvidence, makeRawRecord, parseRawOrigin } from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import { parseKernelBoundNativeCaptures } from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import { correlateOpenCodeHttpEvidence } from '../../../../scripts/e2e/hosted-actual-owner/native-http-join';
import { decodePrivateHttpRecord } from '../../../../scripts/e2e/hosted-actual-owner/private-http';
import { type LocatedHttpObservation, PRIVATE_HTTP_DOMAIN, PRIVATE_HTTP_KIND, PRIVATE_HTTP_PURPOSE, PRIVATE_SUPERVISED_PROVIDER_OPERATIONS, type PrivateHttpOperationName,type PrivateHttpRecord } from '../../../../scripts/e2e/hosted-actual-owner/private-http-types';
import { decodeHttpRecord, decodeOwnerHttpRecordV2 } from '../../../../scripts/e2e/hosted-actual-owner/raw-http';
import { assertRawRecordWriters } from '../../../../scripts/e2e/hosted-actual-owner/raw-writer-binding';

import { context, controllerNonce, fixture, hex, ledger, readOperation, retainChanges } from './raw-http.fixtures';

// Producer-shaped public projection from Owner 248 + d07 partial reference.
// Test-only key and original bytes never become public payload expectations.
const sentinel = Buffer.from('{"nested":{"credential":"private-sentinel-r1112"}}');
function payload(record: unknown, kind: string = PRIVATE_HTTP_KIND) {
  const bytes = Buffer.from(canonicalJson(record));
  return { kind, recordBase64: bytes.toString('base64'), recordSha256: sha256(bytes) };
}
function encode(data: PrivateHttpRecord, sequence: number, override: Partial<RawRecord> = {}) {
  return makeRawRecord({ controllerNonce, origin: 'opencode', row: context.row, sequence,
    monotonicNs: String(10 + sequence), processStartToken: context.recorder.processStartToken,
    event: data.observation.phase === 'request-retained' ? 'hosted_http_request_retained' :
      data.observation.phase === 'response-retained' ? 'hosted_http_response_retained' : 'hosted_http_exchange_failed',
    correlation: data.observation.ownerExchangeNonce, effectCount: 0, ...override, payload: payload(data) });
}
function pair(operation: PrivateHttpOperationName, failure = false) {
  const metadata = { phase: 'request-retained' as const, operation, ownerExchangeNonce: hex(701),
    method: operation === 'mcp-add' || operation === 'mcp-connect' ? 'POST' as const : 'GET' as const };
  const commitment = (observation: unknown, bytes: Buffer) => ({ byteLength: bytes.length,
    hmacSha256: createHmac('sha256', Buffer.alloc(32, 7)).update(PRIVATE_HTTP_DOMAIN)
      .update(canonicalJson({ context, observation, byteLength: bytes.length, originalSha256: sha256(bytes) })).digest('hex') });
  const request: PrivateHttpRecord = { schemaVersion: 1, purpose: PRIVATE_HTTP_PURPOSE, context,
    observation: { ...metadata, privateBody: commitment(metadata, metadata.method === 'GET' ? Buffer.alloc(0) : sentinel) } };
  const first = encode(request, 1);
  const terminal = { phase: 'response-retained' as const, operation, ownerExchangeNonce: metadata.ownerExchangeNonce,
    requestRecordId: first.recordId, status: 200, complete: true, encoding: 'absent' as const,
    nonceStatus: 'missing' as const, connectedPeer: { localAddress: '127.0.0.1', localPort: 45678, remoteAddress: '127.0.0.1', remotePort: 4096 } };
  const response: PrivateHttpRecord = { ...request, observation: failure ? {
    phase: 'exchange-failed', operation, ownerExchangeNonce: metadata.ownerExchangeNonce,
    requestRecordId: first.recordId, failure: { phase: 'before-end', code: 'http_exchange_failed' }, privateBody: null,
  } : { ...terminal, privateBody: commitment(terminal, sentinel) } };
  return { request, response, records: [first, encode(response, 2)] };
}
const parse = (records: RawRecord[]) => parseRawOrigin(ledger(records), 'opencode', controllerNonce);

describe('private HTTP structural source boundary', () => {
  it('enforces the Owner uint64 clock boundary during initial parsing', () => {
    const input = pair('config');
    expect(parse([encode(input.request, 1, { monotonicNs: '18446744073709551615' })])).toHaveLength(1);
    expect(() => parse([encode(input.request, 1, { monotonicNs: '18446744073709551616' })])).toThrow();
  });
  it.each(PRIVATE_SUPERVISED_PROVIDER_OPERATIONS)('reads all phases for %s without disclosing original bodies', operation => {
    for (const failure of [false, true]) {
      const input = pair(operation, failure);
      expect(parse(input.records).map(r => r.kind)).toEqual([PRIVATE_HTTP_KIND, PRIVATE_HTTP_KIND]);
      const publicText = canonicalJson(input.response);
      for (const secret of [sentinel.toString(), sentinel.toString('base64'), sha256(sentinel)]) expect(publicText).not.toContain(secret);
      expect(() => decodeHttpRecord(payload(input.request))).toThrow();
      expect(() => decodeOwnerHttpRecordV2(payload(input.request))).toThrow();
    }
  });
  it.each(['extra', 'body', 'hash', 'method', 'operation', 'version', 'purpose', 'length', 'hmac', 'status', 'peer', 'encoding', 'nonce'])( 'rejects malformed %s', mode => {
    const input = pair('mcp-add');
    const data = JSON.parse(canonicalJson(mode === 'status' || mode === 'peer' || mode === 'encoding' || mode === 'nonce' ? input.response : input.request));
    if (mode === 'extra') data.extra = true;
    if (mode === 'body') data.observation.privateBody.bodyBase64 = sentinel.toString('base64');
    if (mode === 'hash') data.observation.privateBody.sha256 = sha256(sentinel);
    if (mode === 'method') data.observation.method = 'GET';
    if (mode === 'operation') data.observation.operation = 'health';
    if (mode === 'version') data.schemaVersion = 2;
    if (mode === 'purpose') data.purpose = 'agent-teams.p3c.opencode-http-observation/v1';
    if (mode === 'length') data.observation.privateBody.byteLength = 1048577;
    if (mode === 'hmac') data.observation.privateBody.hmacSha256 = 'x';
    if (mode === 'status') data.observation.status = 600;
    if (mode === 'peer') data.observation.connectedPeer.remoteAddress = 'localhost';
    if (mode === 'encoding') data.observation.encoding = 'gzip';
    if (mode === 'nonce') data.observation.nonceStatus = 'accepted';
    expect(() => decodePrivateHttpRecord(payload(data))).toThrow();
  });
  it('rejects noncanonical base64/JSON, digest substitution and extra payload keys', () => {
    const input = payload(pair('config').request);
    for (const changed of [{ ...input, extra: 1 }, { ...input, recordBase64: input.recordBase64 + '\n' },
      { ...input, recordSha256: hex(1) }, { ...input, kind: 'opencode-http-private-observation/v2' }])
      expect(() => decodePrivateHttpRecord(changed)).toThrow();
    const bytes = Buffer.from(' ' + canonicalJson(pair('config').request));
    expect(() => decodePrivateHttpRecord({ ...input, recordBase64: bytes.toString('base64'), recordSha256: sha256(bytes) })).toThrow('noncanonical');
  });
  it.each(['context', 'nonce', 'request', 'operation', 'duplicate', 'outer', 'clock', 'effect'])('rejects %s pair/outer substitution', mode => {
    const input = pair('config');
    const data = JSON.parse(canonicalJson(input.response));
    if (mode === 'context') data.context.captureId = hex(900);
    if (mode === 'nonce') data.observation.ownerExchangeNonce = hex(901);
    if (mode === 'request') data.observation.requestRecordId = hex(902);
    if (mode === 'operation') data.observation.operation = 'providers';
    input.records[1] = encode(data, 2, mode === 'outer' ? { processStartToken: hex(903) } : mode === 'clock' ? { monotonicNs: '11' } : mode === 'effect' ? { effectCount: 1 } : {});
    if (mode === 'duplicate') input.records.push(encode(data, 3));
    expect(() => parse(input.records)).toThrow();
  });
  it('keeps actual public capability bytes eligible alongside private observations', () => {
    const input = fixture([readOperation('capability')]);
    const secret = pair('config');
    const first = encode(secret.request, 3);
    if (secret.response.observation.phase !== 'response-retained') throw new Error('fixture');
    input.records.push(first, encode({ ...secret.response, observation: { ...secret.response.observation,
      requestRecordId: first.recordId } }, 4));
    retainChanges(input);
    const native = parseKernelBoundNativeCaptures(input);
    const result = correlateOpenCodeHttpEvidence({ records: parse(input.records) as LocatedHttpObservation[],
      ledger: input.raw.opencode, shards: Object.values(native.shards).flat(), correlations: input.correlations, outcome: input.outcome });
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]!.status).toBe('correlated-unverified');
    expect(result.exchanges[0]!.facts.length).toBeGreaterThan(0);
    expect(result.status).toBe('incomplete-unverified');
  });
  it('rejects missing LF, duplicate outer keys, unknown extra records and nonce reuse', () => {
    const input = pair('config');
    const bytes = ledger(input.records);
    expect(() => parseRawOrigin(bytes.subarray(0, -1), 'opencode', controllerNonce)).toThrow();
    expect(() => parseRawOrigin(Buffer.from(bytes.toString().replace('{', '{"schemaVersion":1,')), 'opencode', controllerNonce)).toThrow();
    input.records.push(encode(input.request, 3));
    expect(() => parse(input.records)).toThrow('private_nonce_reused');
    const unknown = makeRawRecord({ ...input.records[2]!, payload: payload(input.request, 'unknown-private-kind') });
    expect(() => parse([...input.records.slice(0, 2), unknown])).toThrow();
    const data = JSON.parse(canonicalJson(input.request));
    for (const length of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      data.observation.privateBody.byteLength = length;
      expect(() => decodePrivateHttpRecord(payload(data))).toThrow();
    }
  });
  it('admits incomplete response then one generic failure and rejects later terminals', () => {
    const input = pair('config');
    if (input.response.observation.phase !== 'response-retained') throw new Error('fixture');
    input.records[1] = encode({ ...input.response, observation: { ...input.response.observation, complete: false } }, 2);
    const failed: PrivateHttpRecord = { ...input.request, observation: { phase: 'exchange-failed',
      operation: 'config', ownerExchangeNonce: hex(701), requestRecordId: input.records[0]!.recordId,
      failure: { phase: 'response-incomplete', code: 'http_exchange_failed' }, privateBody: null } };
    input.records.push(encode(failed, 3));
    expect(parse(input.records)).toHaveLength(3);
    input.records.push(encode(failed, 4));
    expect(() => parse(input.records)).toThrow('private_terminal_reused');
  });
  it('requires complete selection, retained-byte redecoding, writer custody and no approval qualification', () => {
    const input = fixture([readOperation('capability')]);
    const privateInput = pair('config');
    input.records = privateInput.records;
    retainChanges(input);
    const native = parseKernelBoundNativeCaptures(input);
    // Match the actual fixture listener, keeping producer-shaped peer fields.
    const response = privateInput.response;
    if (response.observation.phase !== 'response-retained') throw new Error('fixture');
    input.records[1] = encode({ ...response, observation: { ...response.observation,
      connectedPeer: { ...response.observation.connectedPeer, remotePort: input.correlations[0]!.endpoint.port } } }, 2);
    retainChanges(input);
    const args = { records: parse(input.records) as LocatedHttpObservation[], ledger: input.raw.opencode,
      shards: Object.values(native.shards).flat(), correlations: input.correlations, outcome: input.outcome };
    const result = correlateOpenCodeHttpEvidence(args);
    expect(result).toMatchObject({ admission: 'unverified', status: 'incomplete-unverified', exchanges: [] });
    expect(result.unmatchedNativeFacts.length).toBeGreaterThan(0);
    expect(() => assembleEvidence({ ...input, httpCorrelations: input.correlations })).toThrow();
    expect(() => correlateOpenCodeHttpEvidence({ ...args, records: args.records.slice(0, 1) })).toThrow('raw_selection_incomplete');
    const altered = args.records.map(record => record.kind === PRIVATE_HTTP_KIND ? { ...record, http: { ...record.http, context: { ...record.http.context, captureId: hex(999) } } } : record);
    expect(() => correlateOpenCodeHttpEvidence({ ...args, records: altered })).toThrow('raw_fact_content');
    expect(() => assertRawRecordWriters('opencode', args.records, { ...input.outcome,
      rawFiles: { ...input.outcome.rawFiles, opencode: { ...input.outcome.rawFiles.opencode, producerPidfdInodes: [] } } })).toThrow();
  });
});
