import { exactRecord, sha256, type RawRecord } from './contracts';
import { HTTP_LIMITS } from './raw-http-types';
import { httpCheck, httpHex, decodeHttpBase64, parseHttpCanonical, parseHttpContext, parseConnectedHttpPeer, freezeHttpData } from './raw-http';
import { PRIVATE_HTTP_KIND, PRIVATE_HTTP_PURPOSE, PRIVATE_SUPERVISED_PROVIDER_OPERATIONS, type PrivateHttpRecord, type PrivateHttpObservation } from './private-http-types';
const names = new Set<string>(PRIVATE_SUPERVISED_PROVIDER_OPERATIONS);

/** Strict structural decoder. A valid commitment remains unverified observation
 * data; this routine never exposes an approval/native receipt constructor. */
export function decodePrivateHttpRecord(payload: Record<string, unknown>): PrivateHttpRecord {
  exactRecord(payload, ['kind', 'recordBase64', 'recordSha256'], 'private_http_payload')
  httpCheck(payload.kind === PRIVATE_HTTP_KIND && httpHex(payload.recordSha256), 'private_http_kind')
  const bytes = decodeHttpBase64(payload.recordBase64, HTTP_LIMITS.record, 'private_http_record')
  httpCheck(sha256(bytes) === payload.recordSha256, 'private_http_digest')
  const record = exactRecord(parseHttpCanonical(bytes, 'private_http_record'),
    ['schemaVersion', 'purpose', 'context', 'observation'], 'private_http_record')
  httpCheck(record.schemaVersion === 1 && record.purpose === PRIVATE_HTTP_PURPOSE, 'private_http_version')
  const context = parseHttpContext(record.context)
  const raw = record.observation as Record<string, unknown>
  httpCheck(raw && typeof raw === 'object' && !Array.isArray(raw), 'private_http_observation')
  const common = ['phase', 'ownerExchangeNonce', 'operation', 'privateBody']
  const extra = raw.phase === 'request-retained' ? ['method'] : raw.phase === 'response-retained' ?
    ['requestRecordId', 'status', 'connectedPeer', 'complete', 'encoding', 'nonceStatus'] :
    raw.phase === 'exchange-failed' ? ['requestRecordId', 'failure'] : null
  httpCheck(extra, 'private_http_phase')
  const observation = exactRecord(raw, [...common, ...extra], 'private_http_observation')
  httpCheck(httpHex(observation.ownerExchangeNonce) && typeof observation.operation === 'string' &&
    names.has(observation.operation), 'private_http_operation')
  if (observation.phase === 'request-retained') {
    const method = ['mcp-add', 'mcp-connect'].includes(observation.operation as string) ? 'POST' : 'GET'
    httpCheck(observation.method === method, 'private_http_method')
  } else {
    httpCheck(httpHex(observation.requestRecordId), 'private_http_request')
    if (observation.phase === 'response-retained') {
      httpCheck(Number.isSafeInteger(observation.status) && Number(observation.status) >= 100 &&
        Number(observation.status) <= 599 && typeof observation.complete === 'boolean' &&
        ['absent', 'identity', 'unexpected'].includes(observation.encoding as string) &&
        ['present', 'missing', 'invalid'].includes(observation.nonceStatus as string), 'private_http_response')
      parseConnectedHttpPeer(observation.connectedPeer)
    } else {
      const failure = exactRecord(observation.failure, ['phase', 'code'], 'private_http_failure')
      httpCheck(['before-end', 'end-attempted', 'response-incomplete'].includes(failure.phase as string) &&
        failure.code === 'http_exchange_failed' && observation.privateBody === null, 'private_http_failure')
    }
  }
  if (observation.phase !== 'exchange-failed') {
    const body = exactRecord(observation.privateBody, ['byteLength', 'hmacSha256'], 'private_http_body')
    httpCheck(Number.isSafeInteger(body.byteLength) && Number(body.byteLength) >= 0 &&
      Number(body.byteLength) <= HTTP_LIMITS.body && httpHex(body.hmacSha256), 'private_http_body')
  }
  return freezeHttpData({ schemaVersion: 1 as const, purpose: PRIVATE_HTTP_PURPOSE, context, observation: observation as unknown as PrivateHttpObservation })
}

export function assertPrivateHttpOuterBinding(outer: RawRecord, record: PrivateHttpRecord) {
  const c = record.context, o = record.observation
  const event = o.phase === 'request-retained' ? 'hosted_http_request_retained' :
    o.phase === 'response-retained' ? 'hosted_http_response_retained' : 'hosted_http_exchange_failed'
  httpCheck(outer.origin === 'opencode' && outer.effectCount === 0 && outer.event === event &&
    outer.row === c.row && outer.processStartToken === c.recorder.processStartToken &&
    outer.controllerNonce === c.activation.controllerNonce && outer.correlation === o.ownerExchangeNonce,
  'private_http_outer_binding')
}
