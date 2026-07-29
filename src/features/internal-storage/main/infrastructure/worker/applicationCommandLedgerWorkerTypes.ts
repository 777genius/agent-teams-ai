import {
  type ApplicationCommandLedgerBeginRequest,
  type ApplicationCommandLedgerBeginResult,
  type ApplicationCommandLedgerRecord,
} from '@features/application-command-ledger/contracts';

export type AppCommandRecord = ApplicationCommandLedgerRecord<string>;
export type AppCommandBeginRequest = ApplicationCommandLedgerBeginRequest<string>;
export type AppCommandBeginResult = ApplicationCommandLedgerBeginResult<string>;

export interface DurableCommandRow {
  commandId: string;
  deploymentId: string;
  stableActorId: string;
  commandKind: string;
  idempotencyKey: string;
  descriptorId: string;
  descriptorVersion: number;
  inputSchemaVersion: number;
  fingerprintVersion: string;
  effectPlanVersion: number;
  fingerprintKeyVersion: string;
  fingerprintDigest: string;
  attemptGeneration: number;
  attemptId: string;
  attemptOwnerId: string;
  attemptLeaseToken: string;
  attemptClaimedAt: string;
  attemptLeaseExpiresAt: string;
  state: string;
  retentionClass: string;
  auditSessionId: string | null;
  coordinationAttributionJson: string;
  outcomeJson: string | null;
  errorCode: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface DurableEffectRow {
  commandId: string;
  ordinal: number;
  effectId: string;
  effectVersion: number;
  recoveryClass: string;
  evidenceSchemaVersion: number;
  state: string;
  updatedAt: string;
}

export interface DurableEffectEvidenceRow {
  commandId: string;
  ordinal: number;
  sequence: number;
  outcome: string;
  evidenceSchemaVersion: number;
  evidenceJson: string;
  recordedAt: string;
}

export interface DurableOutboxRow {
  sequence: number;
  eventId: string;
  commandId: string;
  deploymentId: string;
  eventType: string;
  scopeKind: string;
  scopeId: string;
  schemaVersion: number;
  semanticRevision: number;
  payloadJson: string;
  createdAt: string;
  deliveryGeneration: number;
  deliveryOwnerId: string | null;
  deliveryLeaseToken: string | null;
  deliveryClaimedAt: string | null;
  deliveryLeaseExpiresAt: string | null;
  deliveryAcknowledgedAt: string | null;
}

export interface DurableConsumerApplicationRow {
  consumerId: string;
  eventId: string;
  semanticRevision: number;
  projectionKey: string;
  stateJson: string;
  appliedAt: string;
}

export interface DurableConsumerProjectionRow {
  consumerId: string;
  projectionKey: string;
  semanticRevision: number;
  lastEventId: string;
  stateJson: string;
  applicationCount: number;
  updatedAt: string;
}

export const MAX_IDENTIFIER_LENGTH = 512;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024;
export const MAX_SAFE_JSON_BYTES = 64 * 1_024;
export const MAX_OUTBOX_PAGE_SIZE = 1_000;
