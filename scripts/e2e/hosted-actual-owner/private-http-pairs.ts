import { canonicalJson } from './contracts';
import { httpCheck } from './raw-http';
import { HTTP_LIMITS } from './raw-http-types';
import { PRIVATE_HTTP_KIND, type LocatedHttpObservation } from './private-http-types';

/** Structural exchange state only. Neither a terminal nor an HMAC proves an effect. */
export function privateHttpPairReader(ledgerByteLength: number) {
  const requests = new Map<string, LocatedHttpObservation>();
  const nonces = new Map<string, string>();
  const responses = new Map<string, boolean>();
  const failures = new Set<string>();
  let privateBytes = 0;
  return (record: LocatedHttpObservation): void => {
    const o = record.http.observation;
    const privateRecord = record.kind === PRIVATE_HTTP_KIND;
    if (privateRecord) {
      privateBytes += record.http.observation.privateBody?.byteLength ?? 0;
      httpCheck(privateBytes + ledgerByteLength <= HTTP_LIMITS.ledger, 'private_budget');
    }
    if (o.phase === 'request-retained') {
      const priorKind = nonces.get(o.ownerExchangeNonce);
      httpCheck(!priorKind || (priorKind !== PRIVATE_HTTP_KIND && !privateRecord), 'private_nonce_reused');
      nonces.set(o.ownerExchangeNonce, record.kind);
      httpCheck(requests.size < 65536, 'private_request_limit');
      requests.set(record.recordId, record);
      return;
    }
    const request = o.requestRecordId && requests.get(o.requestRecordId);
    if (!privateRecord && (!request || request.kind !== PRIVATE_HTTP_KIND)) return;
    httpCheck(request && request.kind === PRIVATE_HTTP_KIND && privateRecord &&
      request.http.observation.phase === 'request-retained' &&
      request.sequence < record.sequence &&
      request.http.observation.ownerExchangeNonce === o.ownerExchangeNonce &&
      record.kind === PRIVATE_HTTP_KIND && request.http.observation.operation === record.http.observation.operation &&
      canonicalJson(request.http.context) === canonicalJson(record.http.context), 'private_pair');
    const id = request.recordId;
    httpCheck(!failures.has(id), 'private_terminal_reused');
    if (o.phase === 'response-retained') {
      httpCheck(!responses.has(id), 'private_response_reused');
      responses.set(id, o.complete);
    } else {
      httpCheck(!responses.has(id) || (responses.get(id) === false && o.failure.phase === 'response-incomplete'), 'private_failure_pair');
      failures.add(id);
    }
  };
}
