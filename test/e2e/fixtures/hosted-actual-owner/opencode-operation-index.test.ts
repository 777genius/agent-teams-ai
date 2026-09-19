import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  decodeReadResponse,
  type ValidatedObservationResult,
} from '../../../../scripts/e2e/hosted-actual-owner/http-entity';
import {
  buildOpenCodeApprovalOperationIndex,
  type OpenCodeApprovalOperationTuple,
} from '../../../../scripts/e2e/hosted-actual-owner/opencode-operation-index';
import type { HttpResponseObservation } from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';

const runtimeInstanceId = `runtime_instance_${'1'.repeat(32)}`;
const configGeneration = `config_generation_${'2'.repeat(32)}`;
const sessionId = 'ses_operation_index';

function observation(
  permissions: readonly Readonly<{
    requestId: string;
    sessionIncarnation: string;
    requestIncarnation: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>[]
): ValidatedObservationResult {
  const body = {
    schemaVersion: 2,
    protocol: 'agent-teams-hosted-approval-v2',
    runtimeInstanceId,
    configGeneration,
    sessionId,
    permissions: permissions.map((permission) => {
      const rawPermission = {
        id: permission.requestId,
        sessionID: sessionId,
        permission: 'read',
        patterns: ['src/**'],
        metadata: permission.metadata ?? {},
        always: [],
      };
      return {
        sessionId,
        requestId: permission.requestId,
        sessionIncarnation: permission.sessionIncarnation,
        requestIncarnation: permission.requestIncarnation,
        permissionDigest: sha256(canonicalJson(rawPermission)),
        rawPermission,
      };
    }),
  };
  const bytes = Buffer.from(JSON.stringify(body));
  const response: HttpResponseObservation = {
    phase: 'response-retained',
    ownerExchangeNonce: 'owner-exchange-index',
    requestRecordId: 'fixture-record-not-authority',
    status: 200,
    responseHeaders: [],
    peerOperationNonce: null,
    nonceStatus: 'missing',
    connectedPeer: {
      localAddress: '127.0.0.1',
      localPort: 45001,
      remoteAddress: '127.0.0.1',
      remotePort: 45002,
    },
    body: {
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      bodyBase64: bytes.toString('base64'),
    },
    complete: true,
  };
  return decodeReadResponse({ kind: 'observe', sessionId }, response) as ValidatedObservationResult;
}

function tuple(
  result: ValidatedObservationResult,
  index = 0
): OpenCodeApprovalOperationTuple {
  const permission = result.permissions[index]!;
  return {
    runtimeInstanceId: permission.runtimeInstanceId,
    configGeneration: permission.configGeneration,
    sessionId: permission.sessionId,
    requestId: permission.requestId,
    sessionIncarnation: permission.sessionIncarnation,
    requestIncarnation: permission.requestIncarnation,
    permissionDigest: permission.permissionDigest,
  };
}

describe('authoritative OpenCode approval operation index', () => {
  it('binds every tuple component and preserves immutable response byte evidence', () => {
    const result = observation([
      {
        requestId: 'per_bound',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);

    const index = buildOpenCodeApprovalOperationIndex([result]);
    // This is the exact tuple shape a later native-http join can construct without carrying any
    // fixture, metadata, approval or record identifier into the authority lookup.
    const nativeHttpTuple = Object.freeze({ ...tuple(result) });
    const binding = index.get(nativeHttpTuple);

    expect(binding).toMatchObject({ tuple: tuple(result), responseBody: result.responseBody });
    expect(binding).not.toHaveProperty('admission');
    expect(binding).not.toHaveProperty('decision');
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.entries)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding!.tuple)).toBe(true);
    expect(Object.isFrozen(binding!.responseBody)).toBe(true);
  });

  it('redecodes retained bytes and rejects a supplied tuple field mutation', () => {
    const result = observation([
      {
        requestId: 'per_mutated',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);
    const mutated = {
      ...result,
      permissions: [
        {
          ...result.permissions[0]!,
          requestIncarnation: `request_incarnation_${'5'.repeat(32)}`,
        },
      ],
    } as ValidatedObservationResult;

    expect(() => buildOpenCodeApprovalOperationIndex([mutated])).toThrow(
      'approval_observation_disagreement'
    );
  });

  it.each([
    [
      'bytes',
      (_result: ValidatedObservationResult) => {
        const bytes = Buffer.from('{"not":"an observation"}');
        return {
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
          bodyBase64: bytes.toString('base64'),
        };
      },
      'p3c_http_read_keys',
    ],
    [
      'length',
      (result: ValidatedObservationResult) => ({
        ...result.responseBody,
        byteLength: result.responseBody.byteLength + 1,
      }),
      'p3c_http_read_response_retention',
    ],
    [
      'hash',
      (result: ValidatedObservationResult) => ({
        ...result.responseBody,
        sha256: 'f'.repeat(64),
      }),
      'p3c_http_read_response_retention',
    ],
  ] as const)(
    'rejects an invalid retained response %s commitment',
    (_case, mutateBody, expectedError) => {
      const result = observation([
        {
          requestId: 'per_retention',
          sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
          requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        },
      ]);
      const mutated = {
        ...result,
        responseBody: mutateBody(result),
      } as ValidatedObservationResult;

      expect(() => buildOpenCodeApprovalOperationIndex([mutated])).toThrow(expectedError);
    }
  );

  it('keeps ABA-reused raw request IDs distinct by their complete incarnation tuples', () => {
    const result = observation([
      {
        requestId: 'per_reused',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
      {
        requestId: 'per_reused',
        sessionIncarnation: `session_incarnation_${'5'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'6'.repeat(32)}`,
      },
    ]);

    const index = buildOpenCodeApprovalOperationIndex([result]);

    expect(index.size).toBe(2);
    expect(index.get(tuple(result, 0))?.tuple.requestIncarnation).toBe(
      `request_incarnation_${'4'.repeat(32)}`
    );
    expect(index.get(tuple(result, 1))?.tuple.requestIncarnation).toBe(
      `request_incarnation_${'6'.repeat(32)}`
    );
  });

  it.each([
    ['runtimeInstanceId', `runtime_instance_${'a'.repeat(32)}`],
    ['configGeneration', `config_generation_${'b'.repeat(32)}`],
    ['sessionId', 'ses_other'],
    ['requestId', 'per_other'],
    ['sessionIncarnation', `session_incarnation_${'c'.repeat(32)}`],
    ['requestIncarnation', `request_incarnation_${'d'.repeat(32)}`],
    ['permissionDigest', 'e'.repeat(64)],
  ] as const)('fails closed for a mismatched %s', (field, value) => {
    const result = observation([
      {
        requestId: 'per_exact',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);
    const index = buildOpenCodeApprovalOperationIndex([result]);

    expect(index.get({ ...tuple(result), [field]: value })).toBeNull();
  });

  it('rejects duplicate tuples, including duplicates repeated by another response', () => {
    const first = observation([
      {
        requestId: 'per_duplicate',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);
    const duplicate = observation([
      {
        requestId: 'per_duplicate',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);

    expect(() => buildOpenCodeApprovalOperationIndex([first, duplicate])).toThrow(
      'approval_tuple_duplicate'
    );
  });

  it('rejects an ambiguous digest for the same runtime/session/request incarnation', () => {
    const first = observation([
      {
        requestId: 'per_ambiguous',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { digestVersion: 1 },
      },
    ]);
    const conflicting = observation([
      {
        requestId: 'per_ambiguous',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { digestVersion: 2 },
      },
    ]);

    expect(() => buildOpenCodeApprovalOperationIndex([first, conflicting])).toThrow(
      'approval_tuple_ambiguous'
    );
  });

  it('never lets metadata or fixture/record IDs override tuple authority', () => {
    const result = observation([
      {
        requestId: 'per_authoritative',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: {
          approvalId: 'approval-spoofed',
          fixtureId: 'fixture-spoofed',
          recordId: 'record-spoofed',
          requestId: 'per_spoofed',
          requestIncarnation: `request_incarnation_${'f'.repeat(32)}`,
        },
      },
    ]);
    const index = buildOpenCodeApprovalOperationIndex([result]);

    expect(index.get(tuple(result))?.tuple.requestId).toBe('per_authoritative');
    expect(index.entries[0]).not.toHaveProperty('rawPermission');
    expect(index.get({ ...tuple(result), requestId: 'per_spoofed' })).toBeNull();
  });

  it('orders bindings deterministically regardless of observation input order', () => {
    const first = observation([
      {
        requestId: 'per_z',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      },
    ]);
    const second = observation([
      {
        requestId: 'per_a',
        sessionIncarnation: `session_incarnation_${'5'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'6'.repeat(32)}`,
      },
    ]);

    expect(buildOpenCodeApprovalOperationIndex([first, second]).entries).toEqual(
      buildOpenCodeApprovalOperationIndex([second, first]).entries
    );
  });
});
