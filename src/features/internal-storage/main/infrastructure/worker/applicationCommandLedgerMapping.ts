import {
  EFFECT_RECOVERY_CLASSES,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger/contracts';

import * as validation from './applicationCommandLedgerValidation';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './applicationCommandLedgerWorkerTypes';
import {
  canonicalCoordinationStorageJson,
  materializeCommandCoordinationAttribution,
} from './coordinationDurabilityWorkerOps';

import type {
  DurableCommandRow,
  DurableConsumerApplicationRow,
  DurableConsumerProjectionRow,
  DurableEffectEvidenceRow,
  DurableEffectRow,
  DurableOutboxRow,
} from './applicationCommandLedgerWorkerTypes';
import type { StoredCommandCoordinationAttribution } from './internalStorageWorkerProtocol';
import type {
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplicationRecord,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandEffectEvidenceRecord,
  DurableApplicationCommandOutboxRecord,
} from '@features/application-command-ledger';
import type { EffectRecoveryClass } from '@features/application-command-ledger/contracts';

export function assertKnownDurableCommandRow(row: DurableCommandRow): void {
  validation.assertIdentifier('commandId', row.commandId);
  validation.assertIdentifier('deploymentId', row.deploymentId);
  validation.assertIdentifier('stableActorId', row.stableActorId);
  validation.assertIdentifier('commandKind', row.commandKind);
  validation.assertIdentifier('idempotencyKey', row.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  validation.assertIdentifier('descriptorId', row.descriptorId);
  validation.assertPositiveVersion('descriptorVersion', row.descriptorVersion);
  validation.assertPositiveVersion('inputSchemaVersion', row.inputSchemaVersion);
  if (row.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw new Error(
      `Unsupported durable application command fingerprint version: ${row.fingerprintVersion}`
    );
  }
  validation.assertPositiveVersion('effectPlanVersion', row.effectPlanVersion);
  validation.assertIdentifier('fingerprintKeyVersion', row.fingerprintKeyVersion);
  if (!/^[a-f0-9]{64}$/.test(row.fingerprintDigest)) {
    throw new Error('Invalid persisted durable application command fingerprint digest');
  }
  validation.assertPositiveVersion('attemptGeneration', row.attemptGeneration);
  validation.assertIdentifier('attemptId', row.attemptId);
  validation.assertIdentifier('attemptOwnerId', row.attemptOwnerId);
  validation.assertIdentifier('attemptLeaseToken', row.attemptLeaseToken);
  validation.assertLeaseWindow(
    row.attemptClaimedAt,
    row.attemptLeaseExpiresAt,
    'persisted attempt'
  );
  validation.assertKnownCommandState(row.state);
  validation.assertIdentifier('retentionClass', row.retentionClass);
  if (row.auditSessionId !== null)
    validation.assertIdentifier('auditSessionId', row.auditSessionId);
  if (typeof row.coordinationAttributionJson !== 'string') {
    throw new Error('Invalid durable application command coordination attribution');
  }
  try {
    const attribution = materializeCommandCoordinationAttribution(
      JSON.parse(row.coordinationAttributionJson) as StoredCommandCoordinationAttribution
    );
    if (canonicalCoordinationStorageJson(attribution) !== row.coordinationAttributionJson) {
      throw new Error('non-canonical');
    }
  } catch (error) {
    throw new Error('Invalid durable application command coordination attribution', {
      cause: error,
    });
  }
  if (row.outcomeJson !== null) validation.assertSafeJson('outcomeJson', row.outcomeJson);
  if (row.errorCode !== null) validation.assertIdentifier('errorCode', row.errorCode);
  if (row.errorJson !== null) validation.assertSafeJson('errorJson', row.errorJson);
  validation.assertIsoTimestamp('createdAt', row.createdAt);
  validation.assertIsoTimestamp('updatedAt', row.updatedAt);
  if (row.committedAt !== null) validation.assertIsoTimestamp('committedAt', row.committedAt);
  if (row.state === 'committed') {
    if (
      row.committedAt === null ||
      row.outcomeJson === null ||
      row.errorCode !== null ||
      row.errorJson !== null
    ) {
      throw new Error(
        `Invalid persisted durable application command terminal shape: ${row.commandId}`
      );
    }
    return;
  }
  if (row.committedAt !== null || row.outcomeJson !== null) {
    throw new Error(
      `Invalid persisted durable application command terminal shape: ${row.commandId}`
    );
  }
  const requiresError = row.state === 'failed' || row.state === 'operator_required';
  if (requiresError !== (row.errorCode !== null)) {
    throw new Error(`Invalid persisted durable application command error shape: ${row.commandId}`);
  }
  if (!requiresError && row.errorJson !== null) {
    throw new Error(`Invalid persisted durable application command error shape: ${row.commandId}`);
  }
}

export function assertKnownDurableEffectRow(
  row: DurableEffectRow,
  commandId: string,
  expectedOrdinal: number
): void {
  if (row.commandId !== commandId || row.ordinal !== expectedOrdinal) {
    throw new Error(`Invalid persisted durable application command effect order: ${commandId}`);
  }
  validation.assertIdentifier('effectId', row.effectId);
  validation.assertPositiveVersion('effectVersion', row.effectVersion);
  if (!EFFECT_RECOVERY_CLASSES.includes(row.recoveryClass as EffectRecoveryClass)) {
    throw new Error(
      `Unsupported durable application command effect recovery class: ${row.recoveryClass}`
    );
  }
  validation.assertPositiveVersion('evidenceSchemaVersion', row.evidenceSchemaVersion);
  validation.assertKnownEffectState(row.state);
  validation.assertIsoTimestamp('effect.updatedAt', row.updatedAt);
}

export function mapEffectEvidence(
  row: DurableEffectEvidenceRow,
  effect: DurableEffectRow,
  expectedSequence: number
): DurableApplicationCommandEffectEvidenceRecord {
  if (
    row.commandId !== effect.commandId ||
    row.ordinal !== effect.ordinal ||
    row.sequence !== expectedSequence
  ) {
    throw new Error('Invalid persisted durable application command effect evidence identity');
  }
  if (row.outcome !== 'observed_succeeded' && row.outcome !== 'observed_absent') {
    throw new Error(
      `Unsupported durable application command effect evidence outcome: ${row.outcome}`
    );
  }
  if (row.evidenceSchemaVersion !== effect.evidenceSchemaVersion) {
    throw new Error(
      `Unsupported durable application command effect evidence schema: ${row.evidenceSchemaVersion}`
    );
  }
  validation.assertSafeJson('evidenceJson', row.evidenceJson);
  validation.assertIsoTimestamp('evidence.recordedAt', row.recordedAt);
  return {
    sequence: row.sequence,
    effectId: effect.effectId,
    effectVersion: effect.effectVersion,
    recoveryClass: effect.recoveryClass as EffectRecoveryClass,
    evidenceSchemaVersion: row.evidenceSchemaVersion,
    outcome: row.outcome,
    evidenceJson: row.evidenceJson,
    recordedAt: row.recordedAt,
  };
}

export function mapOutboxRow(row: DurableOutboxRow): DurableApplicationCommandOutboxRecord {
  if (!Number.isSafeInteger(row.sequence) || row.sequence <= 0) {
    throw new Error('Invalid durable application command outbox sequence');
  }
  validation.assertIdentifier('outbox.eventId', row.eventId);
  validation.assertIdentifier('outbox.commandId', row.commandId);
  validation.assertIdentifier('outbox.deploymentId', row.deploymentId);
  validation.assertIdentifier('outbox.eventType', row.eventType);
  validation.assertIdentifier('outbox.scopeKind', row.scopeKind);
  validation.assertIdentifier('outbox.scopeId', row.scopeId);
  validation.assertPositiveVersion('outbox.schemaVersion', row.schemaVersion);
  validation.assertPositiveVersion('outbox.semanticRevision', row.semanticRevision);
  validation.assertSafeJson('outbox.payloadJson', row.payloadJson);
  validation.assertIsoTimestamp('outbox.createdAt', row.createdAt);
  let deliveryLease: DurableApplicationCommandOutboxRecord['deliveryLease'] = null;
  if (row.deliveryGeneration === 0) {
    if (
      row.deliveryOwnerId !== null ||
      row.deliveryLeaseToken !== null ||
      row.deliveryClaimedAt !== null ||
      row.deliveryLeaseExpiresAt !== null
    ) {
      throw new Error('Invalid durable application command outbox delivery lease shape');
    }
  } else {
    validation.assertPositiveVersion('outbox.deliveryGeneration', row.deliveryGeneration);
    validation.assertIdentifier('outbox.deliveryOwnerId', row.deliveryOwnerId);
    validation.assertIdentifier('outbox.deliveryLeaseToken', row.deliveryLeaseToken);
    if (row.deliveryClaimedAt === null || row.deliveryLeaseExpiresAt === null) {
      throw new Error('Invalid durable application command outbox delivery lease shape');
    }
    validation.assertLeaseWindow(
      row.deliveryClaimedAt,
      row.deliveryLeaseExpiresAt,
      'outbox delivery'
    );
    deliveryLease = {
      generation: row.deliveryGeneration,
      ownerId: row.deliveryOwnerId,
      leaseToken: row.deliveryLeaseToken,
      claimedAt: row.deliveryClaimedAt,
      leaseExpiresAt: row.deliveryLeaseExpiresAt,
    };
  }
  if (row.deliveryAcknowledgedAt !== null) {
    validation.assertIsoTimestamp('outbox.deliveryAcknowledgedAt', row.deliveryAcknowledgedAt);
  }
  if (row.deliveryAcknowledgedAt !== null && deliveryLease === null) {
    throw new Error('Acknowledged durable application command outbox event has no delivery lease');
  }
  if (
    row.deliveryAcknowledgedAt !== null &&
    deliveryLease !== null &&
    (Date.parse(row.deliveryAcknowledgedAt) < Date.parse(deliveryLease.claimedAt) ||
      Date.parse(row.deliveryAcknowledgedAt) >= Date.parse(deliveryLease.leaseExpiresAt))
  ) {
    throw new Error(
      'Acknowledged durable application command outbox event is outside its delivery lease'
    );
  }
  return {
    sequence: row.sequence,
    eventId: row.eventId,
    commandId: row.commandId,
    deploymentId: row.deploymentId,
    eventType: row.eventType,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    schemaVersion: row.schemaVersion,
    semanticRevision: row.semanticRevision,
    payloadJson: row.payloadJson,
    createdAt: row.createdAt,
    deliveryLease,
    deliveryAcknowledgedAt: row.deliveryAcknowledgedAt,
  };
}

export function sameOutboxInput(
  row: DurableApplicationCommandOutboxRecord,
  input: DurableApplicationCommandCommitRequest['outbox']
): boolean {
  return (
    row.eventId === input.eventId &&
    row.eventType === input.eventType &&
    row.scopeKind === input.scopeKind &&
    row.scopeId === input.scopeId &&
    row.schemaVersion === input.schemaVersion &&
    row.semanticRevision === input.semanticRevision &&
    row.payloadJson === input.payloadJson &&
    row.createdAt === input.createdAtIso
  );
}

export function mapConsumerApplicationRow(
  row: DurableConsumerApplicationRow
): DurableApplicationCommandConsumerApplicationRecord {
  validation.assertIdentifier('consumer.consumerId', row.consumerId);
  validation.assertIdentifier('consumer.eventId', row.eventId);
  validation.assertPositiveVersion('consumer.semanticRevision', row.semanticRevision);
  validation.assertIdentifier('consumer.projectionKey', row.projectionKey);
  validation.assertSafeJson('consumer.stateJson', row.stateJson);
  validation.assertIsoTimestamp('consumer.appliedAt', row.appliedAt);
  return { ...row };
}

export function mapConsumerProjectionRow(
  row: DurableConsumerProjectionRow
): DurableApplicationCommandConsumerProjectionRecord {
  validation.assertIdentifier('consumer.consumerId', row.consumerId);
  validation.assertIdentifier('consumer.projectionKey', row.projectionKey);
  validation.assertPositiveVersion('consumer.semanticRevision', row.semanticRevision);
  validation.assertIdentifier('consumer.lastEventId', row.lastEventId);
  validation.assertSafeJson('consumer.stateJson', row.stateJson);
  validation.assertPositiveVersion('consumer.applicationCount', row.applicationCount);
  validation.assertIsoTimestamp('consumer.updatedAt', row.updatedAt);
  return { ...row };
}
