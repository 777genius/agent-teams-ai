import { describe, expect, it } from 'vitest';

import { canonicalJson, RAW_RECORD_PURPOSE, type RawRecord,sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { assembleEvidence, parseRawOrigin } from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import { parseKernelBoundNativeCaptures } from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import { correlateOpenCodeHttpEvidence } from '../../../../scripts/e2e/hosted-actual-owner/native-http-join';
import { P1AdmissionUnverified } from '../../../../scripts/e2e/hosted-actual-owner/p1-admission';
import { decodeHttpRecord, ownerHttpOperationRouteV2 } from '../../../../scripts/e2e/hosted-actual-owner/raw-http';
import { type HostedHttpOperationV2, HTTP_OBSERVATION_KIND_V2, HTTP_OBSERVATION_PURPOSE_V2, isHttpObservationKind, type LocatedHttpRawRecord, type SupportedHostedHttpRecord } from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';

import { body, controllerNonce, fixture, hex, type HttpFixture,ledger, readOperation, recordData, retainChanges } from './raw-http.fixtures';

// Exact canonical JSON/base64/digest/LF algorithm of Owner 18d6568
// native-raw-envelope.ts encodeNativeRawEnvelope. No frozen imports, I/O or authority.
function encode(data: SupportedHostedHttpRecord, original: RawRecord, kind: string = HTTP_OBSERVATION_KIND_V2): RawRecord {
  const bytes = Buffer.from(canonicalJson(data));
  const payload = Buffer.from(canonicalJson({ kind, recordBase64: bytes.toString('base64'), recordSha256: sha256(bytes) }));
  const { recordId: _id, ...fields } = original;
  const unsigned = { ...fields, schemaVersion: 1 as const, purpose: RAW_RECORD_PURPOSE,
    payloadBase64: payload.toString('base64'), payloadSha256: sha256(payload),
    correlation: data.observation.ownerExchangeNonce ?? data.context.captureId };
  return { ...unsigned, recordId: sha256(`agent-teams.p3c.raw-record-id/v1\0${canonicalJson(unsigned)}`) };
}
function upgrade(input: HttpFixture, offset = 0, operation?: HostedHttpOperationV2) {
  const request = recordData(input.records[offset]!);
  if (request.observation.phase !== 'request-retained') throw new Error('fixture request');
  const op = operation ?? request.observation.operation;
  input.records[offset] = encode({ ...request, schemaVersion: 2, purpose: HTTP_OBSERVATION_PURPOSE_V2,
    observation: { ...request.observation, operation: op, ...ownerHttpOperationRouteV2(op) } }, input.records[offset]!);
  const response = recordData(input.records[offset + 1]!);
  if (response.observation.phase !== 'response-retained') throw new Error('fixture response');
  input.records[offset + 1] = encode({ ...response, schemaVersion: 2, purpose: HTTP_OBSERVATION_PURPOSE_V2,
    observation: { ...response.observation, requestRecordId: input.records[offset]!.recordId } }, input.records[offset + 1]!);
}
function patch(input: HttpFixture, index: number, mutate: (data: SupportedHostedHttpRecord) => SupportedHostedHttpRecord) {
  const data = recordData(input.records[index]!) as SupportedHostedHttpRecord;
  input.records[index] = encode(mutate(data), input.records[index]!);
}
function prepare(input: HttpFixture) {
  retainChanges(input);
  const native = parseKernelBoundNativeCaptures(input);
  const records = parseRawOrigin(input.raw.opencode, 'opencode', controllerNonce).filter(
    (record): record is LocatedHttpRawRecord => isHttpObservationKind(record.kind));
  return { records, ledger: input.raw.opencode, shards: Object.values(native.shards).flat(),
    correlations: input.correlations, outcome: input.outcome };
}
const join = (input: HttpFixture) => correlateOpenCodeHttpEvidence(prepare(input));

describe('actual Owner v2 bytes through Product reader and join', () => {
  it('dispatches mixed supported exchanges and keeps P1 closed in actual assembly', () => {
    const input = fixture([readOperation('capability', 1), readOperation('observe', 2)]);
    upgrade(input, 2);
    expect(prepare(input).records.map(record => record.http.schemaVersion)).toEqual([1, 1, 2, 2]);
    expect(join(input).status).toBe('correlated-unverified');
    expect(() => assembleEvidence({ ...input, httpCorrelations: input.correlations })).toThrow(P1AdmissionUnverified);
    const payload = JSON.parse(Buffer.from(input.records[2]!.payloadBase64, 'base64').toString());
    expect(() => decodeHttpRecord(payload)).toThrow('payload');
  });

  it.each([
    { kind: 'provider', name: 'config', method: 'GET', path: '/config' },
    { kind: 'provider', name: 'mcp-add', method: 'POST', path: '/mcp' },
    { kind: 'events', path: '/event' },
    { kind: 'events', path: '/global/event' },
    { kind: 'transcript', sessionId: 'ses_1', limit: 50 },
  ] satisfies HostedHttpOperationV2[])('never joins general $kind as hosted-observe', operation => {
    const input = fixture([readOperation('observe')]);
    upgrade(input, 0, operation);
    const result = join(input);
    expect(result.exchanges[0]).toMatchObject({ status: 'uncorrelated', terminalObservation: 'uncertain',
      appliedReceiptObservation: null, facts: [], problem: 'p3c_http_general_operation_native_facts_unavailable' });
    expect(result.unmatchedNativeFacts).toHaveLength(1);
    expect(result.admission).toBe('unverified');
  });

  it('preserves opaque POST bytes and requires GET bodies to be empty', () => {
    const input = fixture([readOperation('observe')]);
    upgrade(input, 0, { kind: 'provider', name: 'mcp-add', method: 'POST', path: '/mcp' });
    const bytes = Buffer.from([0xff, 0x00, 0x7b]);
    patch(input, 0, data => ({ ...data, observation: { ...data.observation, body: body(bytes) } } as SupportedHostedHttpRecord));
    // Rebind response after the actual request bytes change.
    patch(input, 1, data => ({ ...data, observation: { ...data.observation, requestRecordId: input.records[0]!.recordId } } as SupportedHostedHttpRecord));
    expect(join(input).exchanges[0]!.facts).toEqual([]);
    const parsed = prepare(input).records[0]!.http.observation;
    expect(parsed.phase === 'request-retained' && parsed.body).toEqual(body(bytes));
    patch(input, 0, data => ({ ...data, observation: { ...data.observation,
      operation: { kind: 'provider', name: 'config', method: 'GET', path: '/config' }, method: 'GET', path: '/config' } } as SupportedHostedHttpRecord));
    expect(() => prepare(input)).toThrow('get_body');
  });

  it.each(['version', 'context', 'owner-nonce', 'peer-nonce'] as const)('rejects or leaves unjoined %s substitution', change => {
    const input = fixture([readOperation('observe', 1), readOperation('observe', 2)]);
    upgrade(input, 0); upgrade(input, 2);
    if (change === 'version') {
      const data = recordData(input.records[1]!);
      input.records[1] = encode({ ...data, schemaVersion: 1, purpose: 'agent-teams.p3c.opencode-http-observation/v1' }, input.records[1]!, 'opencode-http-observation/v1');
      expect(() => join(input)).toThrow('exchange_snapshot');
    } else if (change === 'context') {
      patch(input, 1, data => ({ ...data, context: { ...data.context, captureId: hex(900) } }));
      input.correlations.push({ ...input.correlations[0]!, context: recordData(input.records[1]!).context });
      expect(() => join(input)).toThrow('exchange_snapshot');
    } else if (change === 'owner-nonce') {
      patch(input, 2, data => ({ ...data, observation: { ...data.observation,
        ownerExchangeNonce: recordData(input.records[0]!).observation.ownerExchangeNonce } } as SupportedHostedHttpRecord));
      expect(() => join(input)).toThrow('exchange_reused');
    } else {
      patch(input, 3, data => ({ ...data, observation: { ...data.observation,
        peerOperationNonce: hex(1), responseHeaders: [['x-agent-teams-hosted-operation-nonce', hex(1)]] } } as SupportedHostedHttpRecord));
      expect(join(input).exchanges[1]!.problem).toContain('operation_reused');
    }
  });

  it.each(['duplicate-header', 'sse-tail', 'invalid-utf8'] as const)('retains %s without native success', mode => {
    const input = fixture([readOperation('observe')]);
    upgrade(input, 0, { kind: 'events', path: '/global/event' });
    patch(input, 1, data => ({ ...data, observation: { ...data.observation,
      ...(mode === 'duplicate-header' ? {
        responseHeaders: [['X-Agent-Teams-Hosted-Operation-Nonce', hex(1)], ['x-agent-teams-hosted-operation-nonce', hex(1)]],
        nonceStatus: 'invalid', peerOperationNonce: null,
      } : { complete: false, body: body(mode === 'sse-tail' ? Buffer.from('data: {"partial":') : Buffer.from([0xff])) }),
    } } as SupportedHostedHttpRecord));
    const result = join(input);
    expect(result.exchanges[0]!.facts).toEqual([]);
    expect(result.exchanges[0]!.terminalObservation).toBe('uncertain');
    expect(prepare(input).records[1]!.http.observation).toEqual(recordData(input.records[1]!).observation);
  });

  it('rejects unknown prefixes, duplicate lines, missing LF, mismatched kind and tampered retained bytes', () => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    const first = input.records[0]!;
    const data = recordData(first) as SupportedHostedHttpRecord;
    for (const kind of ['opencode-http-observation/v3', 'opaque-owner-prefix']) {
      expect(() => parseRawOrigin(ledger([encode(data, first, kind)]), 'opencode', controllerNonce)).toThrow();
    }
    expect(() => parseRawOrigin(ledger([first, first]), 'opencode', controllerNonce)).toThrow();
    expect(() => parseRawOrigin(ledger(input.records).subarray(0, -1), 'opencode', controllerNonce)).toThrow('origin_frame');
    const prepared = prepare(input);
    const changed = [{ ...prepared.records[0]!, kind: 'opencode-http-observation/v1' }, prepared.records[1]!] as LocatedHttpRawRecord[];
    expect(() => correlateOpenCodeHttpEvidence({ ...prepared, records: changed })).toThrow('raw_fact_kind');
    expect(() => correlateOpenCodeHttpEvidence({ ...prepared, records: [...prepared.records, prepared.records[0]!] })).toThrow('duplicate_selection');
    const wrong = [{ ...prepared.records[0]!, http: { ...prepared.records[0]!.http, context: { ...data.context, captureId: hex(999) } } }, prepared.records[1]!] as LocatedHttpRawRecord[];
    expect(() => correlateOpenCodeHttpEvidence({ ...prepared, records: wrong })).toThrow('raw_fact_content');
  });

  it.each([
    ['GET', '/global/health', 'health'], ['GET', '/config', 'config'],
    ['GET', '/config/providers', 'config-providers'], ['GET', '/provider', 'providers'],
    ['GET', '/provider/auth', 'provider-auth-methods'], ['GET', '/doc', 'server-doc'],
    ['GET', '/agent', 'agents'], ['GET', '/mcp', 'mcp-read'], ['POST', '/mcp', 'mcp-add'],
    ['POST', '/mcp/tool_1/connect', 'mcp-connect'], ['POST', '/session', 'session-create'],
    ['GET', '/session/status', 'session-status'], ['GET', '/session/ses_1', 'session-read'],
    ['GET', '/session/ses_1/message', 'messages-read'],
    ['GET', '/session/ses_1/message?limit=50', 'messages-read'],
    ['GET', '/session/ses_1/message/msg_1', 'message-read'],
    ['POST', '/session/ses_1/message', 'message-send'],
    ['POST', '/session/ses_1/prompt_async', 'prompt-async'],
    ['POST', '/session/ses_1/abort', 'session-abort'],
    ['GET', '/experimental/tool/ids?directory=%2Fsandbox', 'tool-ids'],
    ['GET', '/experimental/tool?provider=test&model=test', 'tools'],
  ])('reads the independently specified Owner route %s %s', (method, path, name) => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    patch(input, 0, data => ({ ...data, context: { ...data.context, routeId: null },
      observation: { ...data.observation, method, path,
        operation: { kind: 'provider', name, method, path } } } as SupportedHostedHttpRecord));
    // Parsing a request does not require or invent a native operation result.
    const parsed = parseRawOrigin(ledger([input.records[0]!]), 'opencode', controllerNonce)[0]!;
    expect(isHttpObservationKind(parsed.kind)).toBe(true);
    if (parsed.kind === HTTP_OBSERVATION_KIND_V2 && parsed.http.observation.phase === 'request-retained') {
      expect(parsed.http.observation.operation).toEqual({ kind: 'provider', name, method, path });
    } else throw new Error('v2 request dispatch missing');
  });

  it('keeps v1 closed to provider extensions and rejects inconsistent v2 declarations', () => {
    const input = fixture([readOperation('observe')]);
    upgrade(input, 0, { kind: 'provider', name: 'config', method: 'GET', path: '/config' });
    const first = input.records[0]!;
    const data = recordData(first) as SupportedHostedHttpRecord;
    const v1 = { ...data, schemaVersion: 1, purpose: 'agent-teams.p3c.opencode-http-observation/v1' } as SupportedHostedHttpRecord;
    expect(() => parseRawOrigin(ledger([encode(v1, first, 'opencode-http-observation/v1')]), 'opencode', controllerNonce)).toThrow();
    expect(() => parseRawOrigin(ledger([encode(v1, first)]), 'opencode', controllerNonce)).toThrow('record_version');
  });

  it('rejects malformed canonical prefix and nonmonotonic clocks in the retained ledger', () => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    const bytes = ledger(input.records);
    const duplicateKey = Buffer.from(bytes.toString().replace('{', '{"schemaVersion":1,'));
    expect(() => parseRawOrigin(duplicateKey, 'opencode', controllerNonce)).toThrow('noncanonical');
    const data = recordData(input.records[1]!) as SupportedHostedHttpRecord;
    input.records[1] = encode(data, { ...input.records[1]!, monotonicNs: input.records[0]!.monotonicNs });
    expect(() => prepare(input)).toThrow('origin_clock');
    // Direct join also validates the full retained outer prefix before trusting selected objects.
    const other = fixture([readOperation('observe')]); upgrade(other);
    const prepared = prepare(other);
    expect(() => correlateOpenCodeHttpEvidence({ ...prepared, ledger: duplicateKey })).toThrow('noncanonical');
  });

  it('retains incomplete-response failure fields and binds them to the same v2 request', () => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    patch(input, 1, data => ({ ...data, observation: { ...data.observation, complete: false,
      body: body(Buffer.from('data: {')) } } as SupportedHostedHttpRecord));
    const request = recordData(input.records[0]!);
    const original = { ...input.records[1]!, sequence: 3, monotonicNs: '13', event: 'hosted_http_exchange_failed' };
    input.records.push(encode({ ...request, schemaVersion: 2, purpose: HTTP_OBSERVATION_PURPOSE_V2,
      observation: { phase: 'exchange-failed', ownerExchangeNonce: request.observation.ownerExchangeNonce,
        requestRecordId: input.records[0]!.recordId,
        failure: { phase: 'response-incomplete', code: 'ECONNRESET' } } }, original));
    expect(join(input).exchanges[0]).toMatchObject({ terminalObservation: 'uncertain',
      facts: [], failureRecordIds: [input.records[2]!.recordId] });
  });

  it('does not substitute the supervisor start for the OpenCode producer start', () => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    input.correlations[0] = { ...input.correlations[0]!, context: {
      ...input.correlations[0]!.context, expectedPeer: { ...input.correlations[0]!.context.expectedPeer,
        supervisorProcessStartToken: input.outcome.supervisorStart.startToken } } };
    expect(() => join(input)).toThrow('expected_peer_start');
  });

  it.each([
    { kind: 'transcript', sessionId: 'ses_1', limit: 51 },
    { kind: 'provider', name: 'config', method: 'POST', path: '/config' },
    { kind: 'provider', name: 'config', method: 'GET', path: '/provider' },
    { kind: 'events', path: '/events' },
  ])('rejects non-Owner operation $kind on the actual reader', operation => {
    const input = fixture([readOperation('observe')]); upgrade(input);
    patch(input, 0, data => ({ ...data, observation: { ...data.observation, operation } } as SupportedHostedHttpRecord));
    expect(() => prepare(input)).toThrow();
  });
});
