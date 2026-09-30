import { stableJsonStringify } from '@features/application-command-ledger';

import type {
  HostedAuthorityProjectionCommitResult,
  HostedAuthorityProjectionPersistRequest,
  HostedAuthorityProjectionReadRequest,
  HostedAuthorityProjectionReceiptRecord,
  HostedAuthorityProjectionRecord,
} from '@features/application-command-ledger';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024;
const MAX_JSON_BYTES = 64 * 1_024;
export const HOSTED_AUTHORITY_PROJECTION_RECEIPT_CODEC_VERSION = 1 as const;

type UnknownRecord = Record<string, unknown>;

export interface HostedAuthorityProjectionReceiptEnvelope {
  readonly codecVersion: typeof HOSTED_AUTHORITY_PROJECTION_RECEIPT_CODEC_VERSION;
  readonly deploymentId: string;
  readonly commandId: string;
  readonly projectionKind: string;
  readonly projectionKey: string;
  readonly expectedGeneration: number;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly revision: number;
  readonly stateJson: string;
  readonly eventId: string;
  readonly receiptJson: string;
  readonly committedAt: string;
}

export function parseHostedAuthorityProjectionPersistRequest(
  value: unknown
): HostedAuthorityProjectionPersistRequest {
  const input = exactRecord(
    value,
    [
      'commandId',
      'scope',
      'fingerprint',
      'auditSessionId',
      'projection',
      'receiptJson',
      'outbox',
      'attribution',
      'committedAtIso',
      'deadlineAtMs',
      'descriptor',
      'retentionClass',
      'effectPlan',
    ],
    'request'
  );
  boundedIdentifier(input.commandId, 'command-id');
  boundedIdentifier(input.retentionClass, 'retention-class');
  if (input.auditSessionId !== null) boundedIdentifier(input.auditSessionId, 'audit-session-id');
  finiteTimestamp(input.committedAtIso, 'committed-at');
  positiveInteger(input.deadlineAtMs, 'deadline');

  const scope = exactRecord(
    input.scope,
    ['deploymentId', 'stableActorId', 'commandKind', 'idempotencyKey'],
    'scope'
  );
  boundedIdentifier(scope.deploymentId, 'deployment-id');
  boundedIdentifier(scope.stableActorId, 'stable-actor-id');
  boundedIdentifier(scope.commandKind, 'command-kind');
  boundedIdentifier(scope.idempotencyKey, 'idempotency-key', MAX_IDEMPOTENCY_KEY_LENGTH);

  const fingerprint = exactRecord(
    input.fingerprint,
    [
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'keyVersion',
      'digest',
    ],
    'fingerprint'
  );
  boundedIdentifier(fingerprint.descriptorId, 'fingerprint-descriptor-id');
  positiveInteger(fingerprint.descriptorVersion, 'fingerprint-descriptor-version');
  positiveInteger(fingerprint.schemaVersion, 'fingerprint-schema-version');
  boundedIdentifier(fingerprint.fingerprintVersion, 'fingerprint-version');
  positiveInteger(fingerprint.effectPlanVersion, 'fingerprint-effect-plan-version');
  boundedIdentifier(fingerprint.keyVersion, 'fingerprint-key-version');
  if (typeof fingerprint.digest !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint.digest)) {
    throw new TypeError('hosted-authority-projection-fingerprint-digest-invalid');
  }

  const descriptor = exactRecord(
    input.descriptor,
    [
      'descriptorId',
      'descriptorVersion',
      'commandKind',
      'inputSchemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
    ],
    'descriptor'
  );
  boundedIdentifier(descriptor.descriptorId, 'descriptor-id');
  positiveInteger(descriptor.descriptorVersion, 'descriptor-version');
  boundedIdentifier(descriptor.commandKind, 'descriptor-command-kind');
  positiveInteger(descriptor.inputSchemaVersion, 'descriptor-input-schema-version');
  boundedIdentifier(descriptor.fingerprintVersion, 'descriptor-fingerprint-version');
  positiveInteger(descriptor.effectPlanVersion, 'descriptor-effect-plan-version');

  if (!Array.isArray(input.effectPlan) || input.effectPlan.length === 0) {
    throw new TypeError('hosted-authority-projection-effect-plan-invalid');
  }
  input.effectPlan.forEach((effect, ordinal) => {
    const parsed = exactRecord(
      effect,
      ['effectId', 'effectVersion', 'recoveryClass', 'evidenceSchemaVersion', 'ordinal', 'state'],
      `effect-${ordinal}`
    );
    boundedIdentifier(parsed.effectId, `effect-${ordinal}-id`);
    positiveInteger(parsed.effectVersion, `effect-${ordinal}-version`);
    boundedIdentifier(parsed.recoveryClass, `effect-${ordinal}-recovery-class`);
    positiveInteger(parsed.evidenceSchemaVersion, `effect-${ordinal}-evidence-schema-version`);
    nonNegativeInteger(parsed.ordinal, `effect-${ordinal}-ordinal`);
    boundedIdentifier(parsed.state, `effect-${ordinal}-state`);
  });

  parseProjectionMutation(input.projection);
  canonicalJson(input.receiptJson, 'receipt-json');
  parseOutbox(input.outbox, input.projection, input.committedAtIso);
  parseAttribution(input.attribution);
  return value as HostedAuthorityProjectionPersistRequest;
}

export function parseHostedAuthorityProjectionReadRequest(
  value: unknown
): HostedAuthorityProjectionReadRequest {
  const input = exactRecord(
    value,
    ['deploymentId', 'projectionKind', 'projectionKey', 'deadlineAtMs'],
    'read-request'
  );
  boundedIdentifier(input.deploymentId, 'deployment-id');
  boundedIdentifier(input.projectionKind, 'projection-kind');
  boundedIdentifier(input.projectionKey, 'projection-key');
  positiveInteger(input.deadlineAtMs, 'deadline');
  return value as HostedAuthorityProjectionReadRequest;
}

export function parseHostedAuthorityProjectionRecord(
  value: unknown
): HostedAuthorityProjectionRecord {
  const record = exactRecord(
    value,
    [
      'deploymentId',
      'projectionKind',
      'projectionKey',
      'generation',
      'revision',
      'stateJson',
      'lastCommandId',
      'updatedAt',
    ],
    'record'
  );
  boundedIdentifier(record.deploymentId, 'deployment-id');
  boundedIdentifier(record.projectionKind, 'projection-kind');
  boundedIdentifier(record.projectionKey, 'projection-key');
  positiveInteger(record.generation, 'generation');
  positiveInteger(record.revision, 'revision');
  canonicalJson(record.stateJson, 'state-json');
  boundedIdentifier(record.lastCommandId, 'last-command-id');
  finiteTimestamp(record.updatedAt, 'updated-at');
  return Object.freeze({ ...record }) as unknown as HostedAuthorityProjectionRecord;
}

export function parseHostedAuthorityProjectionCommitResult(
  value: unknown
): HostedAuthorityProjectionCommitResult {
  const result = looseRecord(value, 'result');
  if (result.outcome === 'fingerprint_conflict') {
    exactKeys(result, ['outcome'], 'result');
    return Object.freeze({ outcome: 'fingerprint_conflict' });
  }
  if (result.outcome === 'stale_generation' || result.outcome === 'stale_revision') {
    exactKeys(result, ['outcome', 'currentGeneration', 'currentRevision'], 'result');
    nonNegativeInteger(result.currentGeneration, 'current-generation');
    nonNegativeInteger(result.currentRevision, 'current-revision');
    return Object.freeze({
      outcome: result.outcome,
      currentGeneration: result.currentGeneration,
      currentRevision: result.currentRevision,
    });
  }
  if (result.outcome !== 'committed' && result.outcome !== 'idempotent_replay') {
    throw new TypeError('hosted-authority-projection-result-outcome-invalid');
  }
  exactKeys(result, ['outcome', 'projection', 'receipt'], 'result');
  return Object.freeze({
    outcome: result.outcome,
    projection: parseHostedAuthorityProjectionRecord(result.projection),
    receipt: parseHostedAuthorityProjectionReceiptRecord(result.receipt),
  });
}

export function encodeHostedAuthorityProjectionReceiptEnvelope(
  value: HostedAuthorityProjectionReceiptEnvelope
): string {
  return stableJsonStringify(value);
}

export function parseHostedAuthorityProjectionReceiptEnvelope(
  value: unknown
): HostedAuthorityProjectionReceiptEnvelope {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) {
    throw new TypeError('hosted-authority-projection-receipt-envelope-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError('hosted-authority-projection-receipt-envelope-invalid');
  }
  const envelope = exactRecord(
    parsed,
    [
      'codecVersion',
      'deploymentId',
      'commandId',
      'projectionKind',
      'projectionKey',
      'expectedGeneration',
      'expectedRevision',
      'generation',
      'revision',
      'stateJson',
      'eventId',
      'receiptJson',
      'committedAt',
    ],
    'receipt-envelope'
  );
  if (envelope.codecVersion !== HOSTED_AUTHORITY_PROJECTION_RECEIPT_CODEC_VERSION) {
    throw new TypeError('hosted-authority-projection-receipt-codec-invalid');
  }
  boundedIdentifier(envelope.deploymentId, 'deployment-id');
  boundedIdentifier(envelope.commandId, 'command-id');
  boundedIdentifier(envelope.projectionKind, 'projection-kind');
  boundedIdentifier(envelope.projectionKey, 'projection-key');
  positiveInteger(envelope.expectedGeneration, 'expected-generation');
  nonNegativeInteger(envelope.expectedRevision, 'expected-revision');
  positiveInteger(envelope.generation, 'generation');
  positiveInteger(envelope.revision, 'revision');
  canonicalJson(envelope.stateJson, 'state-json');
  boundedIdentifier(envelope.eventId, 'event-id');
  canonicalJson(envelope.receiptJson, 'receipt-json');
  finiteTimestamp(envelope.committedAt, 'committed-at');
  if (stableJsonStringify(envelope) !== value) {
    throw new TypeError('hosted-authority-projection-receipt-envelope-noncanonical');
  }
  return Object.freeze({ ...envelope }) as unknown as HostedAuthorityProjectionReceiptEnvelope;
}

function parseProjectionMutation(value: unknown): void {
  const projection = exactRecord(
    value,
    [
      'projectionKind',
      'projectionKey',
      'expectedGeneration',
      'expectedRevision',
      'nextGeneration',
      'nextRevision',
      'stateJson',
    ],
    'projection'
  );
  boundedIdentifier(projection.projectionKind, 'projection-kind');
  boundedIdentifier(projection.projectionKey, 'projection-key');
  positiveInteger(projection.expectedGeneration, 'expected-generation');
  nonNegativeInteger(projection.expectedRevision, 'expected-revision');
  positiveInteger(projection.nextGeneration, 'next-generation');
  positiveInteger(projection.nextRevision, 'next-revision');
  if (
    projection.nextRevision !== projection.expectedRevision + 1 ||
    (projection.nextGeneration !== projection.expectedGeneration &&
      projection.nextGeneration !== projection.expectedGeneration + 1)
  ) {
    throw new TypeError('hosted-authority-projection-monotonicity-invalid');
  }
  canonicalJson(projection.stateJson, 'state-json');
}

function parseOutbox(outboxValue: unknown, projectionValue: unknown, committedAt: unknown): void {
  const outbox = exactRecord(
    outboxValue,
    [
      'eventId',
      'eventType',
      'scopeKind',
      'scopeId',
      'schemaVersion',
      'semanticRevision',
      'payloadJson',
      'createdAtIso',
    ],
    'outbox'
  );
  boundedIdentifier(outbox.eventId, 'event-id');
  boundedIdentifier(outbox.eventType, 'event-type');
  boundedIdentifier(outbox.scopeKind, 'scope-kind');
  boundedIdentifier(outbox.scopeId, 'scope-id');
  positiveInteger(outbox.schemaVersion, 'event-schema-version');
  positiveInteger(outbox.semanticRevision, 'semantic-revision');
  canonicalJson(outbox.payloadJson, 'event-payload-json');
  finiteTimestamp(outbox.createdAtIso, 'event-created-at');
  const projection = projectionValue as { readonly nextRevision: number };
  if (outbox.semanticRevision !== projection.nextRevision || outbox.createdAtIso !== committedAt) {
    throw new TypeError('hosted-authority-projection-outbox-binding-invalid');
  }
}

function parseAttribution(value: unknown): void {
  const attribution = exactRecord(value, ['actor'], 'attribution');
  const actor = looseRecord(attribution.actor, 'actor');
  if (actor.kind === 'operator' || actor.kind === 'recovery') {
    exactKeys(actor, ['kind', 'actorRef'], 'actor');
  } else if (actor.kind === 'verified_runtime') {
    exactKeys(
      actor,
      actor.memberId === undefined
        ? ['kind', 'actorRef', 'runId']
        : ['kind', 'actorRef', 'runId', 'memberId'],
      'actor'
    );
    boundedIdentifier(actor.runId, 'actor-run-id');
    if (actor.memberId !== undefined) boundedIdentifier(actor.memberId, 'actor-member-id');
  } else {
    throw new TypeError('hosted-authority-projection-actor-kind-invalid');
  }
  boundedIdentifier(actor.actorRef, 'actor-ref');
}

function parseHostedAuthorityProjectionReceiptRecord(
  value: unknown
): HostedAuthorityProjectionReceiptRecord {
  const receipt = exactRecord(
    value,
    [
      'deploymentId',
      'projectionKind',
      'projectionKey',
      'commandId',
      'generation',
      'revision',
      'eventId',
      'receiptJson',
      'committedAt',
    ],
    'receipt'
  );
  boundedIdentifier(receipt.deploymentId, 'deployment-id');
  boundedIdentifier(receipt.projectionKind, 'projection-kind');
  boundedIdentifier(receipt.projectionKey, 'projection-key');
  boundedIdentifier(receipt.commandId, 'command-id');
  positiveInteger(receipt.generation, 'generation');
  positiveInteger(receipt.revision, 'revision');
  boundedIdentifier(receipt.eventId, 'event-id');
  canonicalJson(receipt.receiptJson, 'receipt-json');
  finiteTimestamp(receipt.committedAt, 'committed-at');
  return Object.freeze({ ...receipt }) as unknown as HostedAuthorityProjectionReceiptRecord;
}

function canonicalJson(value: unknown, reason: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
  if (stableJsonStringify(parsed) !== value) {
    throw new TypeError(`hosted-authority-projection-${reason}-noncanonical`);
  }
}

function boundedIdentifier(value: unknown, reason: string, maximum = MAX_IDENTIFIER_LENGTH): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
}

function finiteTimestamp(value: unknown, reason: string): void {
  boundedIdentifier(value, reason);
  if (!Number.isFinite(Date.parse(value as string))) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
}

function positiveInteger(value: unknown, reason: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
}

function nonNegativeInteger(value: unknown, reason: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
}

function exactRecord(value: unknown, keys: readonly string[], reason: string): UnknownRecord {
  const record = looseRecord(value, reason);
  exactKeys(record, keys, reason);
  return record;
}

function exactKeys(record: UnknownRecord, keys: readonly string[], reason: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`hosted-authority-projection-${reason}-fields-invalid`);
  }
}

function looseRecord(value: unknown, reason: string): UnknownRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )
  ) {
    throw new TypeError(`hosted-authority-projection-${reason}-invalid`);
  }
  return value as UnknownRecord;
}
