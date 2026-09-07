import { classifySupervisedProviderOperation } from './http-provider-operation';
import type { HostedHttpOperationV2 as OwnerHttpOperation, HostedHttpRecordV1, SupportedHostedHttpRecord } from './raw-http-types';
// Product codec extended from accepted Owner 18d6568771003bd8f344bb9a984bc354532f087f.
// Data validation only; this module grants no admission or effect authority.
import { canonicalJson, exactRecord, MATRIX_ROWS, sha256, type RawRecord } from './contracts';
import {
  HTTP_LIMITS,
  HTTP_OBSERVATION_KIND,
  HTTP_OBSERVATION_PURPOSE,
  type ConnectedHttpPeer,
  type HostedHttpContext,
  type HostedHttpOperation,
  type HostedHttpRecord,
  type HttpResponseObservation,
} from './raw-http-types';

export function httpCheck(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`p3c_http_${label}`);
}

export const httpHex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
export const httpId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:0|[1-9][0-9]{0,19})$/u.test(value) &&
  BigInt(value) <= 18446744073709551615n;

export function freezeHttpData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeHttpData);
    Object.freeze(value);
  }
  return value;
}

/** Canonical framing rejects duplicate keys and alternative spellings at every object depth. */
export function parseHttpCanonical(bytes: Buffer, label: string): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const unicode = (item: unknown, depth: number): void => {
    httpCheck(depth <= 64, `${label}_depth`);
    if (typeof item === 'string') {
      httpCheck(Buffer.from(item).toString('utf8') === item, `${label}_unicode`);
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        unicode(key, depth + 1);
        unicode(child, depth + 1);
      }
    }
  };
  unicode(value, 0);
  httpCheck(canonicalJson(value) === text, `${label}_noncanonical`);
  return value;
}

export function decodeHttpBase64(value: unknown, maximum: number, label: string): Buffer {
  httpCheck(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4, label);
  // Round-trip validation also rejects whitespace, URL alphabet, padding and unused-bit aliases.
  // Avoid the legacy nested repetition regexp on multi-megabyte base64 strings.
  const bytes = Buffer.from(value, 'base64');
  httpCheck(bytes.length <= maximum && bytes.toString('base64') === value, label);
  return bytes;
}

export function parseHttpContext(value: unknown): HostedHttpContext {
  const context = exactRecord(
    value,
    [
      'bootstrapV2HeaderSha256',
      'expectedHostSha256',
      'descriptorMapSha256',
      'captureId',
      'row',
      'routeId',
      'activation',
      'recorder',
      'expectedPeer',
    ],
    'http_context'
  );
  for (const key of [
    'bootstrapV2HeaderSha256',
    'expectedHostSha256',
    'descriptorMapSha256',
    'captureId',
  ]) {
    httpCheck(httpHex(context[key]), `context_${key}`);
  }
  httpCheck(MATRIX_ROWS.includes(context.row as never), 'context_row');
  httpCheck(context.routeId === null || httpId(context.routeId), 'context_route');
  const activation = exactRecord(
    context.activation,
    [
      'controllerNonce',
      'runId',
      'stackManifestSha256',
      'bootstrapDigest',
      'admissionDocumentDigest',
      'ownerArtifactDigest',
      'ownerGeneration',
      'ownerSessionId',
    ],
    'http_activation'
  );
  for (const key of ['controllerNonce', 'runId', 'stackManifestSha256', 'bootstrapDigest']) {
    httpCheck(httpHex(activation[key]), `activation_${key}`);
  }
  for (const key of ['admissionDocumentDigest', 'ownerArtifactDigest']) {
    httpCheck(
      typeof activation[key] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(activation[key]),
      key
    );
  }
  httpCheck(
    positive(activation.ownerGeneration) && httpId(activation.ownerSessionId),
    'activation_owner'
  );
  const recorder = exactRecord(
    context.recorder,
    ['role', 'pid', 'startTicks', 'processStartToken', 'ownerGeneration', 'ownerSessionId'],
    'http_recorder'
  );
  httpCheck(recorder.role === 'owner' && httpHex(recorder.processStartToken), 'recorder');
  httpCheck(
    recorder.ownerGeneration === activation.ownerGeneration &&
      recorder.ownerSessionId === activation.ownerSessionId,
    'recorder_activation'
  );
  const peer = exactRecord(
    context.expectedPeer,
    [
      'pid',
      'startTicks',
      'startIdentity',
      'supervisorProcessStartToken',
      'pidNamespaceInode',
      'networkNamespaceInode',
    ],
    'http_expected_peer'
  );
  for (const process of [recorder, peer]) {
    httpCheck(
      positive(process.pid) &&
        process.pid >= 2 &&
        process.pid <= 2147483647 &&
        decimal(process.startTicks) &&
        Number.isSafeInteger(Number(process.startTicks)),
      'process'
    );
  }
  httpCheck(
    httpHex(peer.supervisorProcessStartToken) &&
      decimal(peer.pidNamespaceInode) &&
      decimal(peer.networkNamespaceInode),
    'expected_peer'
  );
  httpCheck(
    peer.startIdentity === `start_${sha256(`${peer.pid}\0proc:${peer.startTicks}`)}`,
    'peer_start'
  );
  return freezeHttpData(context as unknown as HostedHttpContext);
}

/** Copy at request admission, before delayed encoding; never resample on completion. */
export function snapshotHttpContext(value: HostedHttpContext): HostedHttpContext {
  return parseHttpContext(parseHttpCanonical(Buffer.from(canonicalJson(value)), 'context'));
}

export function httpOperationPath(operation: HostedHttpOperation): string {
  if (operation.kind === 'capability')
    return '/experimental/agent-teams/hosted-approval-capability';
  const session = `/experimental/agent-teams/hosted-approval/session/${encodeURIComponent(operation.sessionId)}`;
  return operation.kind === 'observe'
    ? `${session}/permissions`
    : `${session}/permission/${encodeURIComponent(operation.requestId)}/reply`;
}

export function parseHttpOperation(value: unknown): HostedHttpOperation {
  httpCheck(value !== null && typeof value === 'object', 'operation');
  const kind = (value as Record<string, unknown>).kind;
  const keys =
    kind === 'capability'
      ? ['kind']
      : kind === 'observe'
        ? ['kind', 'sessionId']
        : [
            'kind',
            'sessionId',
            'requestId',
            'runtimeInstanceId',
            'configGeneration',
            'sessionIncarnation',
            'requestIncarnation',
            'permissionDigest',
            'decision',
          ];
  const operation = exactRecord(value, keys, 'http_operation');
  httpCheck(['capability', 'observe', 'reply'].includes(kind as string), 'operation_kind');
  if (kind !== 'capability') httpCheck(httpId(operation.sessionId), 'operation_session');
  if (kind === 'reply') {
    httpCheck(
      httpId(operation.requestId) && operation.requestId.startsWith('per'),
      'operation_request'
    );
    for (const [key, prefix] of [
      ['runtimeInstanceId', 'runtime_instance'],
      ['configGeneration', 'config_generation'],
      ['sessionIncarnation', 'session_incarnation'],
      ['requestIncarnation', 'request_incarnation'],
    ]) {
      httpCheck(
        typeof operation[key] === 'string' &&
          new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u').test(operation[key]),
        `operation_${key}`
      );
    }
    httpCheck(
      httpHex(operation.permissionDigest) &&
        ['allow_once', 'reject'].includes(operation.decision as string),
      'operation_decision'
    );
  }
  return freezeHttpData(operation as unknown as HostedHttpOperation);
}

export function parseConnectedHttpPeer(value: unknown): ConnectedHttpPeer {
  const peer = exactRecord(
    value,
    ['localAddress', 'localPort', 'remoteAddress', 'remotePort'],
    'http_connected_peer'
  );
  httpCheck(
    peer.localAddress === '127.0.0.1' &&
      peer.remoteAddress === '127.0.0.1' &&
      positive(peer.localPort) &&
      peer.localPort <= 65535 &&
      positive(peer.remotePort) &&
      peer.remotePort <= 65535,
    'connected_peer'
  );
  return freezeHttpData(peer as unknown as ConnectedHttpPeer);
}

export function httpHeaderStatus(headers: readonly (readonly [string, string])[]): {
  nonceStatus: HttpResponseObservation['nonceStatus'];
  peerOperationNonce: string | null;
  identityEncoding: boolean;
} {
  const nonce = headers.filter(
    ([name]) => name.toLowerCase() === 'x-agent-teams-hosted-operation-nonce'
  );
  const encoding = headers.filter(([name]) => name.toLowerCase() === 'content-encoding');
  const present = nonce.length === 1 && httpHex(nonce[0]![1]);
  return {
    nonceStatus: present ? 'present' : nonce.length === 0 ? 'missing' : 'invalid',
    peerOperationNonce: present ? nonce[0]![1] : null,
    identityEncoding:
      encoding.length === 0 || (encoding.length === 1 && encoding[0]![1] === 'identity'),
  };
}

export const OWNER_HTTP_OBSERVATION_KIND = 'opencode-http-observation/v2' as const;
export const OWNER_HTTP_OBSERVATION_PURPOSE = 'agent-teams.p3c.opencode-http-observation/v2' as const;
export type OwnerHostedHttpRecordV2 = Readonly<{
  schemaVersion: 2;
  purpose: typeof OWNER_HTTP_OBSERVATION_PURPOSE;
  context: HostedHttpContext;
  observation: Exclude<HostedHttpRecord['observation'], { phase: 'request-retained' }> |
    Readonly<{ phase: 'request-retained'; ownerExchangeNonce: string; operation: OwnerHttpOperation;
      method: 'GET' | 'POST'; path: string; body: import('./raw-http-types').RetainedHttpBody }>;
}>;
export function decodeHttpRecord(payload: Record<string, unknown>): HostedHttpRecordV1 {
  return decodeVersionedHttpRecord(payload, 1) as HostedHttpRecordV1;
}
export function decodeOwnerHttpRecordV2(payload: Record<string, unknown>): OwnerHostedHttpRecordV2 {
  return decodeVersionedHttpRecord(payload, 2) as OwnerHostedHttpRecordV2;
}
function decodeVersionedHttpRecord(payload: Record<string, unknown>, version: 1 | 2): HostedHttpRecord | OwnerHostedHttpRecordV2 {
  exactRecord(payload, ['kind', 'recordBase64', 'recordSha256'], 'http_payload');
  httpCheck(payload.kind === (version === 1 ? HTTP_OBSERVATION_KIND : OWNER_HTTP_OBSERVATION_KIND) && httpHex(payload.recordSha256), 'payload');
  const bytes = decodeHttpBase64(payload.recordBase64, HTTP_LIMITS.record, 'record_base64');
  httpCheck(sha256(bytes) === payload.recordSha256, 'record_digest');
  const record = exactRecord(
    parseHttpCanonical(bytes, 'record'),
    ['schemaVersion', 'purpose', 'context', 'observation'],
    'http_record'
  );
  httpCheck(
    record.schemaVersion === version && record.purpose === (version === 1 ? HTTP_OBSERVATION_PURPOSE : OWNER_HTTP_OBSERVATION_PURPOSE),
    'record_version'
  );
  const context = parseHttpContext(record.context);
  httpCheck(record.observation !== null && typeof record.observation === 'object', 'observation');
  const phase = (record.observation as Record<string, unknown>).phase;
  const observation = exactRecord(
    record.observation,
    phase === 'request-retained'
      ? ['phase', 'ownerExchangeNonce', 'operation', 'method', 'path', 'body']
      : phase === 'response-retained'
        ? [
            'phase',
            'ownerExchangeNonce',
            'requestRecordId',
            'status',
            'responseHeaders',
            'peerOperationNonce',
            'nonceStatus',
            'connectedPeer',
            'body',
            'complete',
          ]
        : ['phase', 'ownerExchangeNonce', 'requestRecordId', 'failure'],
    'http_observation'
  );
  httpCheck(
    ['request-retained', 'response-retained', 'exchange-failed'].includes(phase as string),
    'phase'
  );
  if (phase === 'exchange-failed') {
    httpCheck(
      (observation.ownerExchangeNonce === null && observation.requestRecordId === null) ||
        (httpHex(observation.ownerExchangeNonce) && httpHex(observation.requestRecordId)),
      'failure_binding'
    );
    const failure = exactRecord(observation.failure, ['phase', 'code'], 'http_failure');
    httpCheck(
      ['before-end', 'end-attempted', 'response-incomplete'].includes(failure.phase as string) &&
        httpId(failure.code),
      'failure'
    );
  } else {
    httpCheck(httpHex(observation.ownerExchangeNonce), 'exchange_nonce');
    const body = exactRecord(observation.body, ['byteLength', 'sha256', 'bodyBase64'], 'http_body');
    const bodyBytes = decodeHttpBase64(body.bodyBase64, HTTP_LIMITS.body, 'body_base64');
    httpCheck(
      body.byteLength === bodyBytes.length &&
        httpHex(body.sha256) &&
        sha256(bodyBytes) === body.sha256,
      'body_digest'
    );
    // Body bytes remain opaque here, including malformed UTF-8 and incomplete entity prefixes.
    httpCheck(
      bytes.length - (body.bodyBase64 as string).length <= HTTP_LIMITS.metadata,
      'metadata_limit'
    );
    if (phase === 'request-retained') {
      const operation = version === 1 ? parseHttpOperation(observation.operation) : parseOwnerHttpOperationV2(observation.operation);
      const route = ownerHttpOperationRouteV2(operation);
      httpCheck(
        observation.method === route.method && observation.path === route.path,
        'request_route'
      );
      httpCheck(!['observe', 'reply'].includes(operation.kind) || context.routeId !== null, 'request_route_id');
      httpCheck(route.method === 'POST' || bodyBytes.length === 0, 'get_body');
    } else {
      httpCheck(
        httpHex(observation.requestRecordId) &&
          Number.isSafeInteger(observation.status) &&
          (observation.status as number) >= 100 &&
          (observation.status as number) <= 599 &&
          typeof observation.complete === 'boolean',
        'response'
      );
      httpCheck(Array.isArray(observation.responseHeaders), 'headers');
      for (const pair of observation.responseHeaders) {
        httpCheck(
          Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === 'string' &&
            typeof pair[1] === 'string' &&
            !/[\r\n\0]/u.test(pair[1]) &&
            ['content-encoding', 'x-agent-teams-hosted-operation-nonce'].includes(
              pair[0].toLowerCase()
            ),
          'header'
        );
      }
      const headers = httpHeaderStatus(observation.responseHeaders as [string, string][]);
      httpCheck(
        headers.nonceStatus === observation.nonceStatus &&
          headers.peerOperationNonce === observation.peerOperationNonce,
        'header_nonce'
      );
      parseConnectedHttpPeer(observation.connectedPeer);
    }
  }
  if (phase === 'exchange-failed')
    httpCheck(bytes.length <= HTTP_LIMITS.metadata, 'metadata_limit');
  return freezeHttpData(record as unknown as HostedHttpRecord);
}

export function assertHttpOuterBinding(outer: RawRecord, http: HostedHttpRecord | OwnerHostedHttpRecordV2): void {
  const events = {
    'request-retained': 'hosted_http_request_retained',
    'response-retained': 'hosted_http_response_retained',
    'exchange-failed': 'hosted_http_exchange_failed',
  } as const;
  httpCheck(
    outer.origin === 'opencode' &&
      outer.effectCount === 0 &&
      outer.controllerNonce === http.context.activation.controllerNonce &&
      outer.row === http.context.row &&
      outer.processStartToken === http.context.recorder.processStartToken &&
      outer.event === events[http.observation.phase] &&
      outer.correlation === (http.observation.ownerExchangeNonce ?? http.context.captureId),
    'outer_binding'
  );
}

/** Explicit Owner operation ABI v2. P1 parsing above stays closed to extensions.
 * Product reader acceptance is required before selecting v2 records. */
export const OWNER_HTTP_OPERATION_ABI = 'agent-teams.owner.http-operation/v2' as const;
export function parseOwnerHttpOperationV2(value: unknown): OwnerHttpOperation {
  httpCheck(value !== null && typeof value === 'object', 'operation');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'capability' || kind === 'observe' || kind === 'reply') return parseHttpOperation(value);
  if (kind === 'provider') {
    const op = exactRecord(value, ['kind', 'name', 'method', 'path'], 'http_provider_operation');
    httpCheck(typeof op.method === 'string' && typeof op.path === 'string', 'provider_route');
    const actual = classifySupervisedProviderOperation(op.method, op.path);
    httpCheck(actual.kind === 'provider' && actual.name === op.name, 'provider_name');
    return actual;
  }
  if (kind === 'events') {
    const op = exactRecord(value, ['kind', 'path'], 'http_events_operation');
    httpCheck(op.path === '/event' || op.path === '/global/event', 'events_path');
    return Object.freeze({ kind, path: op.path });
  }
  const op = exactRecord(value, ['kind', 'sessionId', 'limit'], 'http_transcript_operation');
  httpCheck(kind === 'transcript' && typeof op.sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(op.sessionId) && op.limit === 50, 'transcript_route');
  return Object.freeze({ kind: 'transcript', sessionId: op.sessionId, limit: 50 });
}

export function ownerHttpOperationRouteV2(value: unknown): Readonly<{ method: 'GET' | 'POST'; path: string }> {
  const op = parseOwnerHttpOperationV2(value);
  if (op.kind === 'provider') return Object.freeze({ method: op.method, path: op.path });
  if (op.kind === 'events') return Object.freeze({ method: 'GET', path: op.path });
  if (op.kind === 'transcript') return Object.freeze({ method: 'GET',
    path: `/session/${encodeURIComponent(op.sessionId)}/message?limit=50` });
  return Object.freeze({ method: op.kind === 'reply' ? 'POST' : 'GET', path: httpOperationPath(op) });
}

/** Explicit dispatch only: never probe another decoder after failure. */
export function decodeSupportedHttpRecord(payload: Record<string, unknown>): SupportedHostedHttpRecord {
  if (payload.kind === HTTP_OBSERVATION_KIND) return decodeHttpRecord(payload);
  if (payload.kind === OWNER_HTTP_OBSERVATION_KIND) return decodeOwnerHttpRecordV2(payload);
  throw new Error('p3c_http_payload_version');
}
