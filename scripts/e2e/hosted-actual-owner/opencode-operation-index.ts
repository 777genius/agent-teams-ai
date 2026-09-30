import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from './contracts';
import {
  appliedHttpReceipt,
  assertSubmittedCondition,
  decodeConditionalRequest,
  decodeReadResponse,
  type ValidatedObservationResult,
} from './http-entity';
import type { NativeCaptureRecord, NativeCaptureShard } from './native-captures';
import { httpCheck } from './raw-http';
import type { HttpRequestObservation, HttpResponseObservation } from './raw-http-types';

export interface OpenCodeApprovalOperationTuple {
  readonly runtimeInstanceId: string;
  readonly configGeneration: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly sessionIncarnation: string;
  readonly requestIncarnation: string;
  readonly permissionDigest: string;
}

export interface OpenCodeApprovalOperationBinding {
  readonly key: string;
  readonly tuple: OpenCodeApprovalOperationTuple;
  /** Exact Slice A response bytes and their independently checked length/hash commitment. */
  readonly responseBody: ValidatedObservationResult['responseBody'];
}

export interface OpenCodeApprovalOperationIndex {
  readonly size: number;
  readonly entries: readonly OpenCodeApprovalOperationBinding[];
  readonly get: (
    tuple: OpenCodeApprovalOperationTuple
  ) => OpenCodeApprovalOperationBinding | null;
}

const approvalTupleFields = [
  'runtimeInstanceId',
  'configGeneration',
  'sessionId',
  'requestId',
  'sessionIncarnation',
  'requestIncarnation',
  'permissionDigest',
] as const;

function approvalTuple(
  value: OpenCodeApprovalOperationTuple
): OpenCodeApprovalOperationTuple {
  const tuple = Object.fromEntries(
    approvalTupleFields.map((field) => {
      httpCheck(typeof value[field] === 'string' && value[field].length > 0, 'approval_tuple');
      return [field, value[field]];
    })
  ) as unknown as OpenCodeApprovalOperationTuple;
  return Object.freeze(tuple);
}

export function openCodeApprovalOperationKey(
  value: OpenCodeApprovalOperationTuple
): string {
  return canonicalJson(approvalTuple(value));
}

function openCodeApprovalIdentityKey(value: OpenCodeApprovalOperationTuple): string {
  const { permissionDigest: _permissionDigest, ...identity } = approvalTuple(value);
  return canonicalJson(identity);
}

function revalidateApprovalObservation(
  observation: ValidatedObservationResult
): ValidatedObservationResult {
  httpCheck(
    Object.keys(observation.responseBody).length === 3 &&
      ['byteLength', 'sha256', 'bodyBase64'].every((field) => field in observation.responseBody),
    'approval_response_commitment'
  );
  // Only the body and the expected route session participate in Slice A decoding. The remaining
  // response fields are inert carrier fields and are deliberately unavailable to the index.
  const decoded = decodeReadResponse(
    { kind: 'observe', sessionId: observation.sessionId },
    {
      phase: 'response-retained',
      ownerExchangeNonce: 'approval-operation-index',
      requestRecordId: 'approval-operation-index',
      status: 200,
      responseHeaders: [],
      peerOperationNonce: null,
      nonceStatus: 'missing',
      connectedPeer: {
        localAddress: '127.0.0.1',
        localPort: 1,
        remoteAddress: '127.0.0.1',
        remotePort: 1,
      },
      body: observation.responseBody,
      complete: true,
    }
  );
  httpCheck(
    decoded.kind === 'observation' && isDeepStrictEqual(observation, decoded),
    'approval_observation_disagreement'
  );
  return decoded;
}

/**
 * Indexes only Slice A validated observation tuples. Metadata and surrounding fixture/record IDs
 * are deliberately absent from both keys. This binds operations but confers no P1 admission and
 * exposes no manual-approval decision surface.
 */
export function buildOpenCodeApprovalOperationIndex(
  observations: readonly ValidatedObservationResult[]
): OpenCodeApprovalOperationIndex {
  const byKey = new Map<string, OpenCodeApprovalOperationBinding>();
  const digestByIdentity = new Map<string, string>();
  for (const suppliedObservation of observations) {
    const observation = revalidateApprovalObservation(suppliedObservation);
    for (const permission of observation.permissions) {
      const tuple = approvalTuple(permission);
      const key = canonicalJson(tuple);
      httpCheck(!byKey.has(key), 'approval_tuple_duplicate');
      const identityKey = openCodeApprovalIdentityKey(tuple);
      const existingDigest = digestByIdentity.get(identityKey);
      httpCheck(
        existingDigest === undefined || existingDigest === tuple.permissionDigest,
        'approval_tuple_ambiguous'
      );
      digestByIdentity.set(identityKey, tuple.permissionDigest);
      byKey.set(
        key,
        Object.freeze({
          key,
          tuple,
          responseBody: Object.freeze({
            byteLength: observation.responseBody.byteLength,
            sha256: observation.responseBody.sha256,
            bodyBase64: observation.responseBody.bodyBase64,
          }),
        })
      );
    }
  }
  const entries = Object.freeze(
    [...byKey.values()].sort((a, b) => Buffer.from(a.key).compare(Buffer.from(b.key)))
  );
  return Object.freeze({
    size: entries.length,
    entries,
    get: (value: OpenCodeApprovalOperationTuple) =>
      byKey.get(openCodeApprovalOperationKey(value)) ?? null,
  });
}

export interface NativeFactLocator {
  readonly captureSha256: string;
  readonly shardIndex: number;
  readonly stream: NativeCaptureRecord['stream'];
  readonly sequence: number;
  readonly lineSha256: string;
}

export interface OpenCodeFact {
  readonly locator: NativeFactLocator;
  readonly record: NativeCaptureRecord;
}

export interface OpenCodeOperationGroup {
  readonly key: string;
  readonly producer: NativeCaptureRecord['producer'];
  readonly activation: NativeCaptureRecord['activation'];
  readonly operationNonce: string;
  readonly facts: readonly OpenCodeFact[];
  readonly outcome: string;
  readonly problem: string | null;
}

export function operationKey(
  producer: NativeCaptureRecord['producer'],
  activation: NativeCaptureRecord['activation'],
  operationNonce: string
): string {
  return canonicalJson({ producer, activation, operationNonce });
}

const identityKeys = [
  'runtimeInstanceId',
  'configGeneration',
  'sessionId',
  'requestId',
  'sessionIncarnation',
  'requestIncarnation',
];

function equalFields(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  for (const key of keys) httpCheck(a[key] === b[key], `native_field_${key}`);
}

function groupOutcome(facts: readonly OpenCodeFact[]): string {
  const types = facts
    .map(({ record }) => record.recordType)
    .sort()
    .join(',');
  if (types === 'hosted-capability') {
    const native = facts[0]!.record.native;
    httpCheck(native.outcome === 'ok' && native.status === 200, 'native_capability');
    return 'capability';
  }
  if (types === 'hosted-observe') {
    const native = facts[0]!.record.native;
    httpCheck(
      (native.outcome === 'ok' && native.status === 200) ||
        (native.outcome === 'overflow' && native.status === 500),
      'native_observe'
    );
    return native.outcome === 'ok' ? 'observe' : 'overflow';
  }
  const raw = facts.find(({ record }) => record.recordType === 'hosted-reply-raw');
  httpCheck(raw, 'native_group_cardinality');
  const outcome = raw.record.native.outcome as string;
  const early = ['unavailable', 'body-read-failed', 'invalid-json', 'invalid-schema'].includes(
    outcome
  );
  const applied = outcome === 'applied';
  httpCheck(
    types ===
      (early
        ? 'hosted-reply-raw'
        : applied
          ? 'conditional-reply-effect,hosted-reply,hosted-reply-raw'
          : 'hosted-reply,hosted-reply-raw'),
    'native_group_cardinality'
  );
  if (early) return outcome;
  const typed = facts.find(({ record }) => record.recordType === 'hosted-reply')!;
  // Only this pair has comparable sequence numbers. The effect stream has its own sequence.
  httpCheck(
    raw.locator.captureSha256 === typed.locator.captureSha256 &&
      raw.locator.shardIndex === typed.locator.shardIndex &&
      raw.record.sequence < typed.record.sequence,
    'native_raw_before_typed'
  );
  equalFields(raw.record.native, typed.record.native, ['outcome', 'status']);
  if (!applied) {
    httpCheck(
      ['bad-request', 'conflict', 'precondition-failed'].includes(outcome),
      'native_outcome'
    );
    // URL IDs in raw and submitted IDs in typed need not match on bad-request.
    if (outcome !== 'bad-request')
      equalFields(raw.record.native, typed.record.native, ['sessionId', 'requestId']);
    return outcome;
  }
  equalFields(raw.record.native, typed.record.native, [...identityKeys, 'responseSha256']);
  const effect = facts.find(({ record }) => record.recordType === 'conditional-reply-effect')!;
  equalFields(typed.record.native, effect.record.native, [
    ...identityKeys,
    'permissionDigest',
    'outcome',
  ]);
  httpCheck(
    effect.record.native.decision ===
      (typed.record.native.decision === 'allow_once' ? 'once' : 'reject'),
    'native_effect_decision'
  );
  return outcome;
}

/** Input is the output of the shared capture/kernel pass, never verifier-authored envelopes. */
export function buildOpenCodeOperationIndex(
  shards: readonly NativeCaptureShard[]
): ReadonlyMap<string, OpenCodeOperationGroup> {
  const factsByKey = new Map<string, OpenCodeFact[]>();
  const physical = new Set<string>();
  const captures = new Set<string>();
  for (const shard of shards) {
    httpCheck(
      ['openCodeTimelinePath', 'protectedEffectLedgerPath'].includes(shard.name),
      'native_stream'
    );
    const capture = `${shard.name}:${shard.shardIndex}`;
    httpCheck(!captures.has(capture), 'native_duplicate_capture');
    captures.add(capture);
    for (const record of shard.parsed.records.slice(1, -1)) {
      httpCheck(
        record.producer.role === 'opencode' && record.operationNonce !== null,
        'native_producer'
      );
      httpCheck(
        record.stream ===
          (shard.name === 'openCodeTimelinePath' ? 'openCodeTimeline' : 'protectedEffectLedger'),
        'native_stream'
      );
      // The old schema admits a mismatch shape; the actual selected producer never emits it.
      const locator = Object.freeze({
        captureSha256: shard.captureSha256,
        shardIndex: shard.shardIndex,
        stream: record.stream,
        sequence: record.sequence,
        lineSha256: record.lineSha256,
      });
      const id = canonicalJson(locator);
      httpCheck(!physical.has(id), 'native_fact_reused');
      physical.add(id);
      const key = operationKey(record.producer, record.activation, record.operationNonce);
      const facts = factsByKey.get(key) ?? [];
      facts.push(Object.freeze({ locator, record }));
      factsByKey.set(key, facts);
    }
  }
  const groups = new Map<string, OpenCodeOperationGroup>();
  for (const [key, facts] of factsByKey) {
    const first = facts[0]!.record;
    let outcome = 'invalid-native-group';
    let problem: string | null = null;
    try {
      httpCheck(
        facts.every(
          ({ record }) =>
            record.recordType !== 'conditional-reply-effect' || record.native.outcome === 'applied'
        ),
        'native_effect_outcome'
      );
      outcome = groupOutcome(facts);
    } catch (error) {
      problem = error instanceof Error ? error.message : 'p3c_http_native_group';
    }
    groups.set(
      key,
      Object.freeze({
        key,
        producer: first.producer,
        activation: first.activation,
        operationNonce: first.operationNonce!,
        facts: Object.freeze(facts),
        outcome,
        problem,
      })
    );
  }
  return groups;
}

/** All comparisons are to bytes/fields the producer actually recorded, preserving native nulls. */
export function joinHttpOperationBody(
  group: OpenCodeOperationGroup,
  request: HttpRequestObservation,
  response: HttpResponseObservation,
  hosted: Readonly<{ runtimeInstanceId: string; configGeneration: string }>
): void {
  httpCheck(group.problem === null, 'native_group_incomplete');
  httpCheck(response.complete, 'incomplete_response');
  const operation = request.operation;
  httpCheck(
    operation.kind === 'capability' || operation.kind === 'observe' || operation.kind === 'reply',
    'general_operation_native_facts_unavailable'
  );
  if (operation.kind !== 'reply') {
    httpCheck(
      group.facts.length === 1 &&
        group.facts[0]!.record.recordType ===
          (operation.kind === 'capability' ? 'hosted-capability' : 'hosted-observe'),
      'native_operation'
    );
    const native = group.facts[0]!.record.native;
    const body = decodeReadResponse(operation, response);
    equalFields(native, hosted, ['runtimeInstanceId', 'configGeneration']);
    httpCheck(
      native.status === response.status && native.responseSha256 === response.body.sha256,
      'native_response'
    );
    if (operation.kind === 'observe') {
      httpCheck(native.sessionId === operation.sessionId, 'native_session');
      if (response.status === 200) {
        httpCheck(
          native.permissionCount === (body.permissions as unknown[]).length,
          'native_permission_count'
        );
      }
    }
    if (response.status === 200)
      equalFields(native, body, ['runtimeInstanceId', 'configGeneration']);
    return;
  }
  const raw = group.facts.find(({ record }) => record.recordType === 'hosted-reply-raw')?.record
    .native;
  httpCheck(raw, 'native_operation');
  equalFields(raw, operation, ['sessionId', 'requestId']);
  httpCheck(
    raw.status === response.status && raw.responseSha256 === response.body.sha256,
    'native_response'
  );
  if (raw.requestBodySha256 !== null) {
    httpCheck(raw.requestBodySha256 === request.body.sha256, 'native_request_digest');
  }
  if (group.outcome === 'applied') {
    const receipt = appliedHttpReceipt(request, response);
    httpCheck(receipt, 'applied_receipt');
    equalFields(raw, receipt, identityKeys);
    equalFields(raw, hosted, ['runtimeInstanceId', 'configGeneration']);
    const typed = group.facts.find(({ record }) => record.recordType === 'hosted-reply')!.record
      .native;
    equalFields(typed, receipt, ['permissionDigest', 'decision']);
    return;
  }
  httpCheck(response.body.byteLength === 0, 'failure_body');
  const submitted = decodeConditionalRequest(request);
  if (group.outcome === 'invalid-json' || group.outcome === 'invalid-schema') {
    httpCheck(submitted.kind === group.outcome, 'native_failure_request');
  }
  const typed = group.facts.find(({ record }) => record.recordType === 'hosted-reply')?.record
    .native;
  if (!typed) return;
  httpCheck(submitted.kind === 'valid', 'typed_request');
  assertSubmittedCondition(operation, submitted.value);
  equalFields(typed, submitted.value, ['requestId', 'sessionId', 'decision']);
  httpCheck(
    typed.permissionDigest === submitted.value.expectedPermissionDigest,
    'typed_permission_digest'
  );
  const wrongIds =
    operation.requestId !== submitted.value.requestId ||
    operation.sessionId !== submitted.value.sessionId;
  httpCheck((group.outcome === 'bad-request') === wrongIds, 'typed_bad_request_ids');
}
