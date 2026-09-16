import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  decodeReadResponse,
  type ValidatedObservationResult,
} from '../../../../scripts/e2e/hosted-actual-owner/http-entity';
import type { HttpResponseObservation } from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';

const protocol = 'agent-teams-hosted-approval-v2';
const runtimeInstanceId = `runtime_instance_${'1'.repeat(32)}`;
const configGeneration = `config_generation_${'2'.repeat(32)}`;
const sessionId = 'ses_observation';

function rawPermission(
  requestId: string,
  metadata: Record<string, unknown> = { source: 'authoritative-raw-permission' }
) {
  return {
    id: requestId,
    sessionID: sessionId,
    permission: 'read',
    patterns: ['src/**'],
    metadata,
    always: [],
  };
}

function permission(
  requestId: string,
  sessionIncarnation: string,
  requestIncarnation: string,
  raw = rawPermission(requestId)
) {
  return {
    sessionId,
    requestId,
    sessionIncarnation,
    requestIncarnation,
    permissionDigest: sha256(canonicalJson(raw)),
    rawPermission: raw,
  };
}

function responseFromBytes(bytes: Buffer): HttpResponseObservation {
  return {
    phase: 'response-retained',
    ownerExchangeNonce: 'owner-exchange-observation',
    requestRecordId: 'request-record-observation',
    status: 200,
    responseHeaders: [],
    peerOperationNonce: null,
    nonceStatus: 'missing',
    connectedPeer: {
      localAddress: '127.0.0.1',
      localPort: 45131,
      remoteAddress: '127.0.0.1',
      remotePort: 45132,
    },
    body: {
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      bodyBase64: bytes.toString('base64'),
    },
    complete: true,
  };
}

function observationResponse(permissions: readonly unknown[]): HttpResponseObservation {
  return responseFromBytes(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        protocol,
        runtimeInstanceId,
        configGeneration,
        sessionId,
        permissions,
      })
    )
  );
}

function decode(response: HttpResponseObservation): ValidatedObservationResult {
  const result = decodeReadResponse({ kind: 'observe', sessionId }, response);
  expect(result.kind).toBe('observation');
  return result as ValidatedObservationResult;
}

describe('validated OpenCode observation entities', () => {
  it('accepts an actual-shape entry and retains its exact tuple, envelope identity, and bytes', () => {
    const item = permission(
      'per_reusable',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`
    );
    const response = observationResponse([item]);

    const result = decode(response);

    expect(item).not.toHaveProperty('runtimeInstanceId');
    expect(item).not.toHaveProperty('configGeneration');
    expect(result.permissions).toEqual([{ runtimeInstanceId, configGeneration, ...item }]);
    expect(result.responseBody).toEqual(response.body);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.permissions)).toBe(true);
    expect(Object.isFrozen(result.permissions[0])).toBe(true);
    expect(Object.isFrozen(result.permissions[0]!.rawPermission.metadata)).toBe(true);
    expect(Object.isFrozen(result.responseBody)).toBe(true);
  });

  it('treats metadata tuple lookalikes as data with no identity authority', () => {
    const raw = rawPermission('per_authoritative', {
      runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
      configGeneration: `config_generation_${'b'.repeat(32)}`,
      sessionId: 'ses_spoofed',
      requestId: 'per_spoofed',
      sessionIncarnation: `session_incarnation_${'c'.repeat(32)}`,
      requestIncarnation: `request_incarnation_${'d'.repeat(32)}`,
    });
    const item = permission(
      'per_authoritative',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`,
      raw
    );

    expect(decode(observationResponse([item])).permissions[0]).toMatchObject({
      runtimeInstanceId,
      configGeneration,
      sessionId,
      requestId: 'per_authoritative',
      sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
      requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
    });
  });

  it('retains ABA-reused request IDs as distinct incarnation tuples', () => {
    const first = permission(
      'per_reused',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`
    );
    const second = permission(
      'per_reused',
      `session_incarnation_${'5'.repeat(32)}`,
      `request_incarnation_${'6'.repeat(32)}`
    );

    const result = decode(observationResponse([first, second]));

    expect(result.permissions).toHaveLength(2);
    expect(
      result.permissions.map(({ requestId, sessionIncarnation, requestIncarnation }) => ({
        requestId,
        sessionIncarnation,
        requestIncarnation,
      }))
    ).toEqual([
      {
        requestId: 'per_reused',
        sessionIncarnation: first.sessionIncarnation,
        requestIncarnation: first.requestIncarnation,
      },
      {
        requestId: 'per_reused',
        sessionIncarnation: second.sessionIncarnation,
        requestIncarnation: second.requestIncarnation,
      },
    ]);
  });

  it.each([
    ['missing request ID', (item: Record<string, unknown>) => delete item.requestId],
    ['missing session ID', (item: Record<string, unknown>) => delete item.sessionId],
    [
      'mismatched request ID',
      (item: Record<string, unknown>) => {
        item.requestId = 'not-a-permission-id';
      },
    ],
    [
      'mismatched session ID',
      (item: Record<string, unknown>) => {
        item.sessionId = 'ses_other';
      },
    ],
  ] as const)('rejects a permission entry with %s', (_label, mutate) => {
    const item: Record<string, unknown> = permission(
      'per_identity',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`
    );
    mutate(item);

    expect(() =>
      decodeReadResponse({ kind: 'observe', sessionId }, observationResponse([item]))
    ).toThrow();
  });

  it.each([
    ['request ID', { id: 'per_other' }],
    ['session ID', { sessionID: 'ses_other' }],
  ] as const)('rejects rawPermission disagreement on %s', (_label, disagreement) => {
    const raw = { ...rawPermission('per_identity'), ...disagreement };
    const item = permission(
      'per_identity',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`,
      raw
    );

    expect(() =>
      decodeReadResponse({ kind: 'observe', sessionId }, observationResponse([item]))
    ).toThrow();
  });

  it('rejects a permission digest that does not cover the exact rawPermission', () => {
    const item = permission(
      'per_digest',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`
    );
    item.permissionDigest = '0'.repeat(64);

    expect(() =>
      decodeReadResponse({ kind: 'observe', sessionId }, observationResponse([item]))
    ).toThrow();
  });

  it('rejects duplicate JSON keys and mismatched retained response byte/hash facts', () => {
    const duplicate = responseFromBytes(
      Buffer.from(
        `{"schemaVersion":2,"protocol":"${protocol}","runtimeInstanceId":"${runtimeInstanceId}","runtimeInstanceId":"${runtimeInstanceId}","configGeneration":"${configGeneration}","sessionId":"${sessionId}","permissions":[]}`
      )
    );
    expect(() => decodeReadResponse({ kind: 'observe', sessionId }, duplicate)).toThrow(
      'entity_duplicate_key'
    );

    const retained = observationResponse([]);
    const mismatched = {
      ...retained,
      body: { ...retained.body, sha256: '0'.repeat(64) },
    };
    expect(() => decodeReadResponse({ kind: 'observe', sessionId }, mismatched)).toThrow(
      'read_response_retention'
    );
  });
});
