import {
  type CommandClaimScope,
  type CommandFingerprintRecord,
  commitDurableCommand,
  type DurableApplicationCommandEffectEvidenceRecord,
  type DurableApplicationCommandEffectRecord,
  type DurableEffectPlanItem,
  type EffectDescriptor,
} from '@features/application-command-ledger';
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
} from './ports';

export function readCommittedAcknowledgement(
  command: RuntimeIngressDurableCommandRecord,
  descriptor: RuntimeIngressCommandDescriptor,
  claimScope: CommandClaimScope<RuntimeIngressVerb>,
  fingerprint: CommandFingerprintRecord,
  replayKey: RuntimeIngressReplayKey
): RuntimeIngressEffectAcknowledgement | null {
  if (
    !areClaimScopesExact(command.claim.scope, claimScope) ||
    !areCommandFingerprintsExact(command.claim.fingerprint, fingerprint) ||
    command.state !== 'committed' ||
    command.outcomeJson === null
  ) {
    return null;
  }
  try {
    const effectPlan = command.effects.map(
      (effect): DurableEffectPlanItem => ({
        effectId: effect.effectId,
        effectVersion: effect.effectVersion,
        recoveryClass: effect.recoveryClass,
        evidenceSchemaVersion: effect.evidenceSchemaVersion,
        ordinal: effect.ordinal,
        state: effect.state,
      })
    );
    commitDurableCommand('running', descriptor, command.descriptor, effectPlan);
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
  effect: DurableApplicationCommandEffectRecord,
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
  evidence: DurableApplicationCommandEffectEvidenceRecord,
  effect: DurableApplicationCommandEffectRecord,
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
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
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
