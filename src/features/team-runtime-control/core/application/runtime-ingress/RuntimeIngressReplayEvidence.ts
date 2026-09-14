import {
  type CommandClaimScope,
  type CommandFingerprintRecord,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  type EffectRecoveryClass,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger/contracts';
import { parseMemberId } from '@shared/contracts/hosted';

import {
  areRuntimeIngressAuthoritiesExact,
  isRuntimeIngressIsoInstant,
  parseRuntimeIngressAcknowledgementId,
  parseRuntimeIngressCommandId,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressEffectRef,
  parseRuntimeIngressRuntimeInstanceId,
  parseRuntimeIngressSessionId,
  type RuntimeIngressAuthority,
  type RuntimeIngressEffectAcknowledgement,
  type RuntimeIngressReplayKey,
  type RuntimeIngressVerb,
} from '../../domain/runtime-ingress';

import type {
  RuntimeIngressCommandDescriptor,
  RuntimeIngressDurableCommandRecord,
  RuntimeIngressDurableEffectEvidence,
  RuntimeIngressDurableEffectEvidenceRecord,
  RuntimeIngressDurableEffectRecord,
} from './ports';

export function readCommittedAcknowledgement(
  command: RuntimeIngressDurableCommandRecord,
  descriptor: RuntimeIngressCommandDescriptor,
  claimScope: CommandClaimScope<RuntimeIngressVerb>,
  fingerprint: CommandFingerprintRecord,
  replayKey: RuntimeIngressReplayKey
): RuntimeIngressEffectAcknowledgement | null {
  if (!isCommittedReplayRecordStructurallyValid(command)) return null;
  if (
    !areClaimScopesExact(command.claim.scope, claimScope) ||
    !areCommandFingerprintsExact(command.claim.fingerprint, fingerprint) ||
    command.state !== 'committed' ||
    command.outcomeJson === null
  ) {
    return null;
  }
  try {
    if (!isCommittedPlanExact(descriptor, command)) return null;
    const acknowledgement = JSON.parse(command.outcomeJson) as unknown;
    if (!isExactReplayAcknowledgement(acknowledgement, replayKey, fingerprint)) {
      return null;
    }
    return isCommittedCommandEvidenceExact(
      command,
      descriptor,
      claimScope,
      fingerprint,
      acknowledgement
    )
      ? acknowledgement
      : null;
  } catch {
    return null;
  }
}

function isCommittedPlanExact(
  descriptor: RuntimeIngressCommandDescriptor,
  command: RuntimeIngressDurableCommandRecord
): boolean {
  const persisted = command.descriptor;
  return (
    persisted.descriptorId === descriptor.descriptorId &&
    persisted.descriptorVersion === descriptor.descriptorVersion &&
    persisted.commandKind === descriptor.commandKind &&
    persisted.inputSchemaVersion === descriptor.inputSchemaVersion &&
    persisted.fingerprintVersion === descriptor.fingerprintVersion &&
    persisted.effectPlanVersion === descriptor.effectPlanVersion &&
    command.effects.length === descriptor.effects.length &&
    command.effects.every((effect, ordinal) => {
      const expected = descriptor.effects[ordinal];
      return (
        expected !== undefined &&
        effect.effectId === expected.effectId &&
        effect.effectVersion === expected.effectVersion &&
        effect.recoveryClass === expected.recoveryClass &&
        effect.evidenceSchemaVersion === expected.evidenceSchemaVersion &&
        effect.ordinal === ordinal &&
        effect.state === 'observed_succeeded'
      );
    })
  );
}

const DURABLE_COMMAND_KEYS = Object.freeze([
  'attempt',
  'auditSessionId',
  'claim',
  'commandId',
  'committedAt',
  'createdAt',
  'descriptor',
  'effects',
  'errorCode',
  'errorJson',
  'outcomeJson',
  'retentionClass',
  'state',
  'updatedAt',
] as const);
const COMMAND_CLAIM_KEYS = Object.freeze(['fingerprint', 'scope'] as const);
const COMMAND_CLAIM_SCOPE_KEYS = Object.freeze([
  'commandKind',
  'deploymentId',
  'idempotencyKey',
  'stableActorId',
] as const);
const COMMAND_FINGERPRINT_KEYS = Object.freeze([
  'descriptorId',
  'descriptorVersion',
  'digest',
  'effectPlanVersion',
  'fingerprintVersion',
  'keyVersion',
  'schemaVersion',
] as const);
const COMMAND_DESCRIPTOR_IDENTITY_KEYS = Object.freeze([
  'commandKind',
  'descriptorId',
  'descriptorVersion',
  'effectPlanVersion',
  'fingerprintVersion',
  'inputSchemaVersion',
] as const);
const COMMAND_ATTEMPT_KEYS = Object.freeze([
  'attemptId',
  'claimedAt',
  'generation',
  'leaseExpiresAt',
  'leaseToken',
  'ownerId',
] as const);
const EFFECT_RECORD_KEYS = Object.freeze([
  'effectId',
  'effectVersion',
  'evidence',
  'evidenceSchemaVersion',
  'ordinal',
  'recoveryClass',
  'state',
  'updatedAt',
] as const);
const EFFECT_EVIDENCE_RECORD_KEYS = Object.freeze([
  'effectId',
  'effectVersion',
  'evidenceJson',
  'evidenceSchemaVersion',
  'outcome',
  'recordedAt',
  'recoveryClass',
  'sequence',
] as const);

function isCommittedReplayRecordStructurallyValid(
  value: unknown
): value is RuntimeIngressDurableCommandRecord {
  if (!hasExactKeys(value, DURABLE_COMMAND_KEYS)) return false;
  if (
    !hasExactKeys(value.claim, COMMAND_CLAIM_KEYS) ||
    !hasExactKeys(value.claim.scope, COMMAND_CLAIM_SCOPE_KEYS) ||
    !hasExactKeys(value.claim.fingerprint, COMMAND_FINGERPRINT_KEYS) ||
    !hasExactKeys(value.descriptor, COMMAND_DESCRIPTOR_IDENTITY_KEYS) ||
    !hasExactKeys(value.attempt, COMMAND_ATTEMPT_KEYS) ||
    !hasCanonicalCommittedCommandMetadata(value) ||
    !hasCanonicalClaimMetadata(value.claim) ||
    !hasCanonicalDescriptorMetadata(value.descriptor) ||
    !isDenseDataArray(value.effects)
  ) {
    return false;
  }
  return value.effects.every(
    (effect) =>
      hasExactKeys(effect, EFFECT_RECORD_KEYS) &&
      hasCanonicalCommittedEffectMetadata(effect) &&
      isDenseDataArray(effect.evidence) &&
      effect.evidence.every(
        (evidence) =>
          hasExactKeys(evidence, EFFECT_EVIDENCE_RECORD_KEYS) &&
          hasCanonicalCommittedEvidenceMetadata(evidence)
      )
  );
}

function hasCanonicalCommittedCommandMetadata(value: Record<string, unknown>): boolean {
  return (
    isCanonicalMetadataIdentifier(value.commandId) &&
    value.state === 'committed' &&
    isCanonicalMetadataIdentifier(value.retentionClass) &&
    (value.auditSessionId === null || isCanonicalMetadataIdentifier(value.auditSessionId)) &&
    typeof value.outcomeJson === 'string' &&
    value.errorCode === null &&
    value.errorJson === null &&
    isRuntimeIngressIsoInstant(value.createdAt) &&
    isRuntimeIngressIsoInstant(value.updatedAt) &&
    isRuntimeIngressIsoInstant(value.committedAt) &&
    hasCanonicalAttemptMetadata(value.attempt as Record<string, unknown>)
  );
}

function hasCanonicalClaimMetadata(value: Record<string, unknown>): boolean {
  const scope = value.scope as Record<string, unknown>;
  const fingerprint = value.fingerprint as Record<string, unknown>;
  return (
    isCanonicalMetadataIdentifier(scope.deploymentId) &&
    isCanonicalMetadataIdentifier(scope.stableActorId) &&
    isCanonicalMetadataIdentifier(scope.commandKind) &&
    isCanonicalMetadataIdentifier(scope.idempotencyKey) &&
    isCanonicalMetadataIdentifier(fingerprint.descriptorId) &&
    isPositiveSafeInteger(fingerprint.descriptorVersion) &&
    isPositiveSafeInteger(fingerprint.schemaVersion) &&
    fingerprint.fingerprintVersion === HMAC_SHA256_LD_V1 &&
    isPositiveSafeInteger(fingerprint.effectPlanVersion) &&
    isCanonicalMetadataIdentifier(fingerprint.keyVersion) &&
    isCanonicalMetadataIdentifier(fingerprint.digest)
  );
}

function hasCanonicalDescriptorMetadata(value: Record<string, unknown>): boolean {
  return (
    isCanonicalMetadataIdentifier(value.descriptorId) &&
    isPositiveSafeInteger(value.descriptorVersion) &&
    isCanonicalMetadataIdentifier(value.commandKind) &&
    isPositiveSafeInteger(value.inputSchemaVersion) &&
    value.fingerprintVersion === HMAC_SHA256_LD_V1 &&
    isPositiveSafeInteger(value.effectPlanVersion)
  );
}

function hasCanonicalAttemptMetadata(
  value: Record<string, unknown>
): value is RuntimeIngressDurableCommandRecord['attempt'] {
  return (
    isPositiveSafeInteger(value.generation) &&
    isCanonicalMetadataIdentifier(value.attemptId) &&
    isCanonicalMetadataIdentifier(value.ownerId) &&
    isCanonicalMetadataIdentifier(value.leaseToken) &&
    isRuntimeIngressIsoInstant(value.claimedAt) &&
    isRuntimeIngressIsoInstant(value.leaseExpiresAt)
  );
}

function hasCanonicalCommittedEffectMetadata(value: Record<string, unknown>): boolean {
  return (
    hasCanonicalEffectDescriptorMetadata(value) &&
    Number.isSafeInteger(value.ordinal) &&
    (value.ordinal as number) >= 0 &&
    value.state === 'observed_succeeded' &&
    isRuntimeIngressIsoInstant(value.updatedAt)
  );
}

function hasCanonicalCommittedEvidenceMetadata(value: Record<string, unknown>): boolean {
  return (
    hasCanonicalEffectDescriptorMetadata(value) &&
    value.outcome === 'observed_succeeded' &&
    isPositiveSafeInteger(value.sequence) &&
    typeof value.evidenceJson === 'string' &&
    isRuntimeIngressIsoInstant(value.recordedAt)
  );
}

function hasCanonicalEffectDescriptorMetadata(value: Record<string, unknown>): boolean {
  return (
    isCanonicalMetadataIdentifier(value.effectId) &&
    isPositiveSafeInteger(value.effectVersion) &&
    isEffectRecoveryClass(value.recoveryClass) &&
    isPositiveSafeInteger(value.evidenceSchemaVersion)
  );
}

function isEffectRecoveryClass(value: unknown): value is EffectRecoveryClass {
  return EFFECT_RECOVERY_CLASSES.includes(value as EffectRecoveryClass);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalMetadataIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isExactReplayAcknowledgement(
  value: unknown,
  replayKey: RuntimeIngressReplayKey,
  fingerprint: CommandFingerprintRecord
): value is RuntimeIngressEffectAcknowledgement {
  if (
    !hasExactKeys(value, [
      'acknowledgementVersion',
      'acknowledgementId',
      'effectRef',
      'replayKey',
      'acceptedAtIso',
    ]) ||
    !isExactReplayKey(value.replayKey, replayKey)
  ) {
    return false;
  }
  try {
    parseRuntimeIngressAcknowledgementId(value.acknowledgementId);
    parseRuntimeIngressEffectRef(value.effectRef);
  } catch {
    return false;
  }
  return (
    value.acknowledgementVersion === 1 &&
    value.acknowledgementId === acknowledgementIdFor(fingerprint) &&
    value.effectRef === effectRefFor(fingerprint) &&
    isRuntimeIngressIsoInstant(value.acceptedAtIso)
  );
}

function isCommittedCommandEvidenceExact(
  command: RuntimeIngressDurableCommandRecord,
  descriptor: RuntimeIngressCommandDescriptor,
  claimScope: CommandClaimScope<RuntimeIngressVerb>,
  fingerprint: CommandFingerprintRecord,
  acknowledgement: RuntimeIngressEffectAcknowledgement
): boolean {
  if (
    command.commandId !== acknowledgement.replayKey.commandId ||
    command.retentionClass !== descriptor.retentionClass ||
    command.auditSessionId !== acknowledgement.replayKey.sessionId ||
    command.errorCode !== null ||
    command.errorJson !== null ||
    command.committedAt !== acknowledgement.acceptedAtIso ||
    command.effects.length !== descriptor.effects.length
  ) {
    return false;
  }
  return command.effects.every((effect, ordinal) =>
    isCommittedEffectEvidenceExact(
      effect,
      descriptor.effects[ordinal],
      ordinal,
      command,
      claimScope,
      fingerprint,
      acknowledgement
    )
  );
}

function isCommittedEffectEvidenceExact(
  effect: RuntimeIngressDurableEffectRecord,
  expectedEffect: EffectDescriptor,
  ordinal: number,
  command: RuntimeIngressDurableCommandRecord,
  claimScope: CommandClaimScope<RuntimeIngressVerb>,
  fingerprint: CommandFingerprintRecord,
  acknowledgement: RuntimeIngressEffectAcknowledgement
): boolean {
  if (
    effect.updatedAt !== acknowledgement.acceptedAtIso ||
    effect.evidence.length !== 1 ||
    !isEffectDescriptorExact(effect, expectedEffect, ordinal)
  ) {
    return false;
  }
  const evidence = effect.evidence[0];
  if (
    evidence.sequence !== 1 ||
    evidence.outcome !== 'observed_succeeded' ||
    evidence.recordedAt !== acknowledgement.acceptedAtIso ||
    !isEffectDescriptorExact(evidence, expectedEffect)
  ) {
    return false;
  }
  return isExactEffectEvidenceJson(
    evidence,
    effect,
    command,
    claimScope,
    fingerprint,
    acknowledgement
  );
}

function isExactEffectEvidenceJson(
  evidence: RuntimeIngressDurableEffectEvidenceRecord,
  effect: RuntimeIngressDurableEffectRecord,
  command: RuntimeIngressDurableCommandRecord,
  claimScope: CommandClaimScope<RuntimeIngressVerb>,
  fingerprint: CommandFingerprintRecord,
  acknowledgement: RuntimeIngressEffectAcknowledgement
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(evidence.evidenceJson) as unknown;
  } catch {
    return false;
  }
  if (
    !hasExactKeys(value, [
      'evidenceVersion',
      'durableCommandId',
      'acknowledgementId',
      'effectRef',
      'replayKey',
      'claimScope',
      'fingerprint',
      'transaction',
      'effect',
      'acceptedAtIso',
    ])
  ) {
    return false;
  }
  const expected: RuntimeIngressDurableEffectEvidence = {
    evidenceVersion: 1,
    durableCommandId: command.commandId,
    acknowledgementId: acknowledgement.acknowledgementId,
    effectRef: acknowledgement.effectRef,
    replayKey: acknowledgement.replayKey,
    claimScope,
    fingerprint,
    transaction: {
      generation: command.attempt.generation,
      attemptId: command.attempt.attemptId,
    },
    effect: {
      effectId: effect.effectId,
      effectVersion: effect.effectVersion,
      recoveryClass: effect.recoveryClass,
      evidenceSchemaVersion: effect.evidenceSchemaVersion,
      ordinal: effect.ordinal,
    },
    acceptedAtIso: acknowledgement.acceptedAtIso,
  };
  return (
    value.evidenceVersion === expected.evidenceVersion &&
    value.durableCommandId === expected.durableCommandId &&
    value.acknowledgementId === expected.acknowledgementId &&
    value.effectRef === expected.effectRef &&
    isExactReplayKey(value.replayKey, expected.replayKey) &&
    isExactClaimScope(value.claimScope, expected.claimScope) &&
    isExactFingerprint(value.fingerprint, expected.fingerprint) &&
    isExactTransaction(value.transaction, expected.transaction) &&
    isExactEffectBinding(value.effect, expected.effect) &&
    value.acceptedAtIso === expected.acceptedAtIso
  );
}

function isExactReplayKey(value: unknown, expected: RuntimeIngressReplayKey): boolean {
  if (
    !hasExactKeys(value, [
      'authority',
      'credentialId',
      'sessionId',
      'runtimeInstanceId',
      'deliveryOwnerId',
      'commandId',
      'sequence',
      'observedAtIso',
    ]) ||
    !hasExactKeys(value.authority, [
      'deploymentId',
      'teamId',
      'runId',
      'planGeneration',
      'laneId',
      'providerId',
      'credentialGeneration',
      'verb',
    ])
  ) {
    return false;
  }
  try {
    parseRuntimeIngressCredentialId(value.credentialId);
    parseRuntimeIngressSessionId(value.sessionId);
    parseRuntimeIngressCommandId(value.commandId);
    parseRuntimeIngressRuntimeInstanceId(value.runtimeInstanceId);
    parseMemberId(value.deliveryOwnerId);
  } catch {
    return false;
  }
  return (
    value.credentialId === expected.credentialId &&
    value.sessionId === expected.sessionId &&
    value.runtimeInstanceId === expected.runtimeInstanceId &&
    value.deliveryOwnerId === expected.deliveryOwnerId &&
    value.commandId === expected.commandId &&
    value.sequence === expected.sequence &&
    value.observedAtIso === expected.observedAtIso &&
    areRuntimeIngressAuthoritiesExact(
      value.authority as unknown as RuntimeIngressAuthority,
      expected.authority
    )
  );
}

function isExactClaimScope(
  value: unknown,
  expected: CommandClaimScope<RuntimeIngressVerb>
): boolean {
  return (
    hasExactKeys(value, ['deploymentId', 'stableActorId', 'commandKind', 'idempotencyKey']) &&
    value.deploymentId === expected.deploymentId &&
    value.stableActorId === expected.stableActorId &&
    value.commandKind === expected.commandKind &&
    value.idempotencyKey === expected.idempotencyKey
  );
}

function isExactFingerprint(value: unknown, expected: CommandFingerprintRecord): boolean {
  return (
    hasExactKeys(value, [
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'keyVersion',
      'digest',
    ]) && areCommandFingerprintsExact(value as unknown as CommandFingerprintRecord, expected)
  );
}

function isExactTransaction(
  value: unknown,
  expected: RuntimeIngressDurableEffectEvidence['transaction']
): boolean {
  return (
    hasExactKeys(value, ['generation', 'attemptId']) &&
    value.generation === expected.generation &&
    value.attemptId === expected.attemptId
  );
}

function isExactEffectBinding(
  value: unknown,
  expected: RuntimeIngressDurableEffectEvidence['effect']
): boolean {
  return (
    hasExactKeys(value, [
      'effectId',
      'effectVersion',
      'recoveryClass',
      'evidenceSchemaVersion',
      'ordinal',
    ]) &&
    value.effectId === expected.effectId &&
    value.effectVersion === expected.effectVersion &&
    value.recoveryClass === expected.recoveryClass &&
    value.evidenceSchemaVersion === expected.evidenceSchemaVersion &&
    value.ordinal === expected.ordinal
  );
}

function isEffectDescriptorExact(
  value: {
    readonly effectId: string;
    readonly effectVersion: number;
    readonly recoveryClass: string;
    readonly evidenceSchemaVersion: number;
    readonly ordinal?: number;
  },
  expected: EffectDescriptor,
  ordinal?: number
): boolean {
  return (
    value.effectId === expected.effectId &&
    value.effectVersion === expected.effectVersion &&
    value.recoveryClass === expected.recoveryClass &&
    value.evidenceSchemaVersion === expected.evidenceSchemaVersion &&
    (ordinal === undefined || value.ordinal === ordinal)
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareCodeUnit);
  const sortedExpectedKeys = [...expectedKeys].sort(compareCodeUnit);
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]) &&
    Object.values(descriptors).every((descriptor) => descriptor.enumerable && 'value' in descriptor)
  );
}

function isDenseDataArray(value: unknown): value is readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const expectedNames = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function areClaimScopesExact(
  left: CommandClaimScope<RuntimeIngressVerb>,
  right: CommandClaimScope<RuntimeIngressVerb>
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.stableActorId === right.stableActorId &&
    left.commandKind === right.commandKind &&
    left.idempotencyKey === right.idempotencyKey
  );
}

function areCommandFingerprintsExact(
  left: CommandFingerprintRecord,
  right: CommandFingerprintRecord
): boolean {
  return (
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.fingerprintVersion === right.fingerprintVersion &&
    left.effectPlanVersion === right.effectPlanVersion &&
    left.keyVersion === right.keyVersion &&
    left.digest === right.digest
  );
}

function acknowledgementIdFor(
  fingerprint: CommandFingerprintRecord
): RuntimeIngressEffectAcknowledgement['acknowledgementId'] {
  return parseRuntimeIngressAcknowledgementId(`ack:${fingerprint.digest}`);
}

function effectRefFor(
  fingerprint: CommandFingerprintRecord
): RuntimeIngressEffectAcknowledgement['effectRef'] {
  return parseRuntimeIngressEffectRef(`effect:${fingerprint.digest}`);
}
