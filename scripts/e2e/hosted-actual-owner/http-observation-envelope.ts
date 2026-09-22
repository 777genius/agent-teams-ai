import { PRIVATE_HTTP_KIND } from './private-http-types';
import { decodePrivateHttpRecord, assertPrivateHttpOuterBinding } from './private-http';
import { canonicalJson, exactRecord, MATRIX_ROWS, RAW_RECORD_PURPOSE, sha256, type RawRecord } from './contracts'
import { HTTP_LIMITS, HTTP_OBSERVATION_KIND } from './raw-http-types'
import { assertHttpOuterBinding, decodeHttpBase64, decodeHttpRecord, decodeOwnerHttpRecordV2,
  httpCheck, httpHex, httpId, OWNER_HTTP_OBSERVATION_KIND, parseHttpCanonical } from './raw-http'

const keys = ['schemaVersion', 'purpose', 'controllerNonce', 'origin', 'row', 'sequence',
  'monotonicNs', 'processStartToken', 'recordId', 'event', 'correlation', 'effectCount', 'payloadBase64', 'payloadSha256']
const recordId = (unsigned: unknown) => sha256(`agent-teams.p3c.raw-record-id/v1\0${canonicalJson(unsigned)}`)

/** Product-owned port of accepted Owner 18d outer validation. HTTP-only selection;
 * unknown prefixes reject. This validates bytes, never publication authority. */
export function parseHttpObservationEnvelope(bytes: Buffer, sequence: number, controllerNonce: string): RawRecord {
  httpCheck(bytes.length > 0 && bytes.length + 1 <= HTTP_LIMITS.line, 'outer_limit')
  const value = exactRecord(parseHttpCanonical(bytes, 'outer'), keys, 'raw_record')
  httpCheck(value.schemaVersion === 1 && value.purpose === RAW_RECORD_PURPOSE &&
    value.origin === 'opencode' && value.controllerNonce === controllerNonce && httpHex(controllerNonce) &&
    Number.isSafeInteger(sequence) && sequence >= 1 && value.sequence === sequence &&
    MATRIX_ROWS.includes(value.row as never) && httpId(value.event) && httpHex(value.correlation) &&
    httpHex(value.processStartToken) && httpHex(value.recordId) && httpHex(value.payloadSha256) &&
    Number.isSafeInteger(value.effectCount) && (value.effectCount as number) >= 0 &&
    (value.effectCount as number) <= 16 && typeof value.monotonicNs === 'string' &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(value.monotonicNs) &&
    BigInt(value.monotonicNs) <= 18446744073709551615n, 'outer_fields')
  const payload = decodeHttpBase64(value.payloadBase64, HTTP_LIMITS.payload, 'outer_base64')
  httpCheck(payload.length >= 2 && sha256(payload) === value.payloadSha256, 'outer_payload_digest')
  const unsigned = { ...value }; delete unsigned.recordId
  httpCheck(recordId(unsigned) === value.recordId, 'outer_identity')
  const outer = Object.freeze(value) as unknown as RawRecord
  const data = parseHttpCanonical(payload, 'payload') as Record<string, unknown>
  httpCheck(data !== null && typeof data === 'object' && !Array.isArray(data), 'outer_payload')
  if (data.kind === HTTP_OBSERVATION_KIND) assertHttpOuterBinding(outer, decodeHttpRecord(data))
  else if (data.kind === OWNER_HTTP_OBSERVATION_KIND) assertHttpOuterBinding(outer, decodeOwnerHttpRecordV2(data))
  else if (data.kind === PRIVATE_HTTP_KIND) assertPrivateHttpOuterBinding(outer, decodePrivateHttpRecord(data))
  else throw new Error('p3c_http_mixed_recorder_kinds')
  return outer
}
