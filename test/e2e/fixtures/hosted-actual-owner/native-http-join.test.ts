import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  decodeReadResponse,
  type ValidatedObservationResult,
} from '../../../../scripts/e2e/hosted-actual-owner/http-entity';
import {
  correlateNativeHttpApprovalEvidence,
  type NativeHttpApprovalCapture,
} from '../../../../scripts/e2e/hosted-actual-owner/native-http-join';
import {
  buildOpenCodeApprovalOperationIndex,
  openCodeApprovalOperationKey,
  type OpenCodeApprovalOperationIndex,
  type OpenCodeApprovalOperationTuple,
} from '../../../../scripts/e2e/hosted-actual-owner/opencode-operation-index';
import type {
  HttpResponseObservation,
  RetainedHttpBody,
} from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';

const protocol = 'agent-teams-hosted-approval-v2';
const runtimeInstanceId = `runtime_instance_${'1'.repeat(32)}`;
const configGeneration = `config_generation_${'2'.repeat(32)}`;
const sessionId = 'ses_native_join';

function retained(bytes: Buffer): RetainedHttpBody {
  return {
    byteLength: bytes.length,
    sha256: sha256(bytes),
    bodyBase64: bytes.toString('base64'),
  };
}

function validatedObservation(
  permissions: readonly Readonly<{
    requestId: string;
    sessionIncarnation: string;
    requestIncarnation: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>[]
): ValidatedObservationResult {
  const body = {
    schemaVersion: 2,
    protocol,
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
        requestId: permission.requestId,
        sessionId,
        sessionIncarnation: permission.sessionIncarnation,
        requestIncarnation: permission.requestIncarnation,
        permissionDigest: sha256(canonicalJson(rawPermission)),
        rawPermission,
      };
    }),
  };
  const response: HttpResponseObservation = {
    phase: 'response-retained',
    ownerExchangeNonce: 'slice-a-observation',
    requestRecordId: 'slice-a-record-is-not-authority',
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
    body: retained(Buffer.from(JSON.stringify(body))),
    complete: true,
  };
  return decodeReadResponse({ kind: 'observe', sessionId }, response) as ValidatedObservationResult;
}

function tuple(
  observation: ValidatedObservationResult,
  offset = 0
): OpenCodeApprovalOperationTuple {
  const permission = observation.permissions[offset]!;
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

function capture(
  approval: OpenCodeApprovalOperationTuple,
  decision: 'allow_once' | 'reject' = 'allow_once'
): NativeHttpApprovalCapture {
  const requestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      protocol,
      runtimeInstanceId: approval.runtimeInstanceId,
      expectedConfigGeneration: approval.configGeneration,
      requestId: approval.requestId,
      sessionId: approval.sessionId,
      sessionIncarnation: approval.sessionIncarnation,
      requestIncarnation: approval.requestIncarnation,
      expectedPermissionDigest: approval.permissionDigest,
      decision,
    })
  );
  const responseBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      protocol,
      status: 'applied',
      runtimeInstanceId: approval.runtimeInstanceId,
      configGeneration: approval.configGeneration,
      requestId: approval.requestId,
      sessionId: approval.sessionId,
      sessionIncarnation: approval.sessionIncarnation,
      requestIncarnation: approval.requestIncarnation,
      permissionDigest: approval.permissionDigest,
      decision,
    })
  );
  const ownerExchangeNonce = sha256(`native-http:${approval.requestIncarnation}`);
  return {
    request: {
      phase: 'request-retained',
      ownerExchangeNonce,
      operation: { kind: 'reply', ...approval, decision },
      method: 'POST',
      path:
        `/experimental/agent-teams/hosted-approval/session/${approval.sessionId}/` +
        `permission/${approval.requestId}/reply`,
      body: retained(requestBytes),
    },
    response: {
      phase: 'response-retained',
      ownerExchangeNonce,
      requestRecordId: 'native-record-is-only-a-locator',
      status: 200,
      responseHeaders: [],
      peerOperationNonce: null,
      nonceStatus: 'missing',
      connectedPeer: {
        localAddress: '127.0.0.1',
        localPort: 45003,
        remoteAddress: '127.0.0.1',
        remotePort: 45004,
      },
      body: retained(responseBytes),
      complete: true,
    },
  };
}

function approval(
  requestId = 'per_native',
  sessionIncarnation = `session_incarnation_${'3'.repeat(32)}`,
  requestIncarnation = `request_incarnation_${'4'.repeat(32)}`,
  metadata?: Readonly<Record<string, unknown>>
) {
  const observation = validatedObservation([
    { requestId, sessionIncarnation, requestIncarnation, metadata },
  ]);
  return {
    observation,
    tuple: tuple(observation),
    index: buildOpenCodeApprovalOperationIndex([observation]),
  };
}

function structuralIndex(...supplied: readonly Readonly<{
  tuple: OpenCodeApprovalOperationTuple;
  responseBody: RetainedHttpBody;
}>[]): OpenCodeApprovalOperationIndex {
  const entries = Object.freeze(
    supplied
      .map(({ tuple, responseBody }) =>
        Object.freeze({ key: openCodeApprovalOperationKey(tuple), tuple, responseBody })
      )
      .sort((left, right) => Buffer.from(left.key).compare(Buffer.from(right.key)))
  );
  return Object.freeze({
    size: entries.length,
    entries,
    get: (candidate: OpenCodeApprovalOperationTuple) =>
      entries.find(({ key }) => openCodeApprovalOperationKey(candidate) === key) ?? null,
  });
}

describe('native HTTP approval evidence correlation', () => {
  it('joins only the complete tuple and retains immutable bytes without opening admission', () => {
    const accepted = approval();
    const native = capture(accepted.tuple);

    const result = correlateNativeHttpApprovalEvidence({
      operationIndex: accepted.index,
      captures: [native],
    });

    expect(result).toMatchObject({
      status: 'correlated-unverified',
      admission: 'unverified',
      correlations: [
        {
          tuple: accepted.tuple,
          sourceObservationResponseBody: accepted.observation.responseBody,
          nativeRequestBody: native.request.body,
          nativeResponseBody: native.response!.body,
          nativeResponseStatus: 200,
        },
      ],
    });
    expect(result).not.toHaveProperty('decision');
    expect(result).not.toHaveProperty('manualApproval');
    expect(result.correlations[0]).not.toHaveProperty('requestRecordId');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.correlations)).toBe(true);
    expect(Object.isFrozen(result.correlations[0])).toBe(true);
    expect(Object.isFrozen(result.correlations[0]!.nativeResponseBody)).toBe(true);
  });

  it('keeps ABA-reused raw IDs distinct and rejects an incarnation splice', () => {
    const observation = validatedObservation([
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
    const index = buildOpenCodeApprovalOperationIndex([observation]);
    const first = tuple(observation, 0);
    const second = tuple(observation, 1);

    const correlated = correlateNativeHttpApprovalEvidence({
      operationIndex: index,
      captures: [capture(second), capture(first)],
    });
    expect(correlated.correlations).toHaveLength(2);
    expect(new Set(correlated.correlations.map(({ key }) => key)).size).toBe(2);

    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: index,
        captures: [
          capture({
            ...first,
            requestIncarnation: second.requestIncarnation,
          }),
        ],
      })
    ).toThrow('native_approval_operation_missing');
  });

  it.each([
    [
      'request length',
      (item: NativeHttpApprovalCapture) => ({
        ...item,
        request: {
          ...item.request,
          body: { ...item.request.body, byteLength: item.request.body.byteLength + 1 },
        },
      }),
      'native_approval_request_retention',
    ],
    [
      'response hash',
      (item: NativeHttpApprovalCapture) => ({
        ...item,
        response: {
          ...item.response!,
          body: { ...item.response!.body, sha256: 'f'.repeat(64) },
        },
      }),
      'native_approval_response_retention',
    ],
  ] as const)('rejects a native %s disagreement', (_label, mutate, error) => {
    const accepted = approval();
    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: accepted.index,
        captures: [mutate(capture(accepted.tuple))],
      })
    ).toThrow(error);
  });

  it('rejects missing, incomplete, truncated and tuple-mismatched responses', () => {
    const accepted = approval();
    const native = capture(accepted.tuple);
    const invoke = (item: NativeHttpApprovalCapture) =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: accepted.index,
        captures: [item],
      });

    expect(() => invoke({ ...native, response: null })).toThrow(
      'native_approval_response_missing'
    );
    expect(() =>
      invoke({ ...native, response: { ...native.response!, complete: false } })
    ).toThrow('native_approval_response_incomplete');

    const responseBytes = Buffer.from(native.response!.body.bodyBase64, 'base64');
    expect(() =>
      invoke({
        ...native,
        response: {
          ...native.response!,
          body: retained(responseBytes.subarray(0, responseBytes.length - 1)),
        },
      })
    ).toThrow('native_approval_response_mismatch');

    const other = approval(
      'per_other',
      `session_incarnation_${'5'.repeat(32)}`,
      `request_incarnation_${'6'.repeat(32)}`
    );
    expect(() =>
      invoke({
        ...native,
        response: {
          ...capture(other.tuple).response!,
          ownerExchangeNonce: native.request.ownerExchangeNonce,
        },
      })
    ).toThrow('native_approval_response_mismatch');
  });

  it('rejects duplicate capture ambiguity even when locator IDs differ', () => {
    const accepted = approval();
    const first = capture(accepted.tuple);
    const duplicate = {
      ...capture(accepted.tuple),
      response: {
        ...capture(accepted.tuple).response!,
        requestRecordId: 'different-record-id-is-not-authority',
      },
    };

    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: accepted.index,
        captures: [first, duplicate],
      })
    ).toThrow('native_approval_capture_duplicate');
  });

  it('rejects hidden identity-digest ambiguity in all retained permissions', () => {
    const observation = validatedObservation([
      {
        requestId: 'per_hidden_conflict',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { generation: 'first' },
      },
      {
        requestId: 'per_hidden_conflict',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { generation: 'conflicting' },
      },
    ]);
    const selected = tuple(observation);

    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: structuralIndex(
          { tuple: Object.freeze(selected), responseBody: observation.responseBody }
        ),
        captures: [capture(selected)],
      })
    ).toThrow('native_approval_observation_ambiguous');
  });

  it('rejects identity-digest ambiguity split across two retained observations', () => {
    const first = validatedObservation([
      {
        requestId: 'per_selected_first',
        sessionIncarnation: `session_incarnation_${'5'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'6'.repeat(32)}`,
      },
      {
        requestId: 'per_cross_observation_conflict',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { generation: 'first' },
      },
    ]);
    const second = validatedObservation([
      {
        requestId: 'per_selected_second',
        sessionIncarnation: `session_incarnation_${'7'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'8'.repeat(32)}`,
      },
      {
        requestId: 'per_cross_observation_conflict',
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        metadata: { generation: 'conflicting' },
      },
    ]);
    const selectedFirst = Object.freeze(tuple(first));
    const selectedSecond = Object.freeze(tuple(second));

    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: structuralIndex(
          { tuple: selectedFirst, responseBody: first.responseBody },
          { tuple: selectedSecond, responseBody: second.responseBody }
        ),
        captures: [capture(selectedFirst), capture(selectedSecond)],
      })
    ).toThrow('native_approval_observation_ambiguous');
  });

  it('copies exactly seven tuple fields so nested caller extras cannot mutate output', () => {
    const accepted = approval();
    const attackerExtra = { nested: { fixtureId: 'before' } };
    const suppliedTuple = Object.freeze({
      ...accepted.tuple,
      attackerExtra,
    }) as OpenCodeApprovalOperationTuple;
    const result = correlateNativeHttpApprovalEvidence({
      operationIndex: structuralIndex({
        tuple: suppliedTuple,
        responseBody: accepted.observation.responseBody,
      }),
      captures: [capture(accepted.tuple)],
    });
    const before = canonicalJson(result);

    attackerExtra.nested.fixtureId = 'after';

    expect(Object.keys(result.correlations[0]!.tuple).sort()).toEqual(
      [
        'runtimeInstanceId',
        'configGeneration',
        'sessionId',
        'requestId',
        'sessionIncarnation',
        'requestIncarnation',
        'permissionDigest',
      ].sort()
    );
    expect(result.correlations[0]!.tuple).not.toBe(suppliedTuple);
    expect(canonicalJson(result)).toBe(before);
  });

  it('does not let metadata, approval, record or fixture IDs redirect authority', () => {
    const accepted = approval(
      'per_authoritative',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`,
      {
        approvalId: 'approval-spoofed',
        fixtureId: 'fixture-spoofed',
        recordId: 'record-spoofed',
        requestId: 'per_spoofed',
        requestIncarnation: `request_incarnation_${'9'.repeat(32)}`,
      }
    );
    const spoofed = {
      ...accepted.tuple,
      requestId: 'per_spoofed',
      requestIncarnation: `request_incarnation_${'9'.repeat(32)}`,
    };

    expect(() =>
      correlateNativeHttpApprovalEvidence({
        operationIndex: accepted.index,
        captures: [capture(spoofed)],
      })
    ).toThrow('native_approval_operation_missing');
    expect(
      correlateNativeHttpApprovalEvidence({
        operationIndex: accepted.index,
        captures: [capture(accepted.tuple)],
      }).correlations[0]!.tuple.requestId
    ).toBe('per_authoritative');
  });

  it('returns byte-identical deterministic output for reversed capture order', () => {
    const first = approval(
      'per_z',
      `session_incarnation_${'3'.repeat(32)}`,
      `request_incarnation_${'4'.repeat(32)}`
    );
    const second = approval(
      'per_a',
      `session_incarnation_${'5'.repeat(32)}`,
      `request_incarnation_${'6'.repeat(32)}`
    );
    const index = buildOpenCodeApprovalOperationIndex([
      first.observation,
      second.observation,
    ]);

    const forward = correlateNativeHttpApprovalEvidence({
      operationIndex: index,
      captures: [capture(first.tuple), capture(second.tuple)],
    });
    const reverse = correlateNativeHttpApprovalEvidence({
      operationIndex: index,
      captures: [capture(second.tuple), capture(first.tuple)],
    });
    expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
  });
});
