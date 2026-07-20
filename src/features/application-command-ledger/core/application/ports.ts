import type {
  ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerFailRequest,
  ApplicationCommandLedgerListScopeRequest,
  ApplicationCommandLedgerReadByCommandIdRequest,
  ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerRecord,
  CommandClaimRecord,
  CommandClaimResolution,
  CommandClaimScope,
  CommandFingerprintRecord,
  DurableCommandDescriptorIdentity,
  DurableCommandState,
  DurableEffectPlanItem,
  DurableEffectState,
  ValidatedDurableEffectEvidence,
} from '../../contracts';

export interface DurableApplicationCommandAttemptReference {
  readonly generation: number;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
}

export interface DurableApplicationCommandAttemptClaim {
  readonly attemptId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly claimedAtIso: string;
  readonly leaseExpiresAtIso: string;
}

export interface DurableApplicationCommandAttemptRecord extends DurableApplicationCommandAttemptReference {
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface DurableApplicationCommandEffectEvidenceRecord extends ValidatedDurableEffectEvidence {
  readonly sequence: number;
  readonly evidenceJson: string;
  readonly recordedAt: string;
}

export interface DurableApplicationCommandEffectRecord extends DurableEffectPlanItem {
  readonly updatedAt: string;
  readonly evidence: readonly DurableApplicationCommandEffectEvidenceRecord[];
}

export interface DurableApplicationCommandRecord<TCommandKind extends string = string> {
  readonly commandId: string;
  readonly claim: CommandClaimRecord<TCommandKind>;
  readonly descriptor: DurableCommandDescriptorIdentity<TCommandKind>;
  readonly attempt: DurableApplicationCommandAttemptRecord;
  readonly state: DurableCommandState;
  readonly retentionClass: string;
  readonly auditSessionId: string | null;
  readonly outcomeJson: string | null;
  readonly errorCode: string | null;
  readonly errorJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
  readonly effects: readonly DurableApplicationCommandEffectRecord[];
}

export interface DurableApplicationCommandClaimRequest<TCommandKind extends string = string> {
  readonly commandId: string;
  readonly scope: CommandClaimScope<TCommandKind>;
  readonly fingerprint: CommandFingerprintRecord;
  readonly attempt: DurableApplicationCommandAttemptClaim;
  readonly auditSessionId: string | null;
  readonly createdAtIso: string;
}

export interface DurableApplicationCommandPersistClaimRequest<
  TCommandKind extends string = string,
> extends DurableApplicationCommandClaimRequest<TCommandKind> {
  readonly descriptor: DurableCommandDescriptorIdentity<TCommandKind>;
  readonly retentionClass: string;
  readonly effectPlan: readonly DurableEffectPlanItem[];
}

export interface DurableApplicationCommandClaimResult<TCommandKind extends string = string> {
  readonly resolution: CommandClaimResolution<TCommandKind>;
  readonly attemptAcquired: boolean;
  readonly command: DurableApplicationCommandRecord<TCommandKind>;
}

export interface DurableApplicationCommandStatusRequest {
  readonly deploymentId: string;
  readonly commandId: string;
}

export interface DurableApplicationCommandClaimStatusRequest<TCommandKind extends string = string> {
  readonly scope: CommandClaimScope<TCommandKind>;
}

export interface DurableApplicationCommandAttemptLeaseRequest extends DurableApplicationCommandStatusRequest {
  readonly attempt: DurableApplicationCommandAttemptReference;
  readonly renewedAtIso: string;
  readonly leaseExpiresAtIso: string;
}

export interface DurableApplicationCommandTransitionRequest extends DurableApplicationCommandStatusRequest {
  readonly attempt: DurableApplicationCommandAttemptReference;
  readonly expectedState: DurableCommandState;
  readonly nextState: Exclude<DurableCommandState, 'committed'>;
  readonly errorCode: string | null;
  readonly errorJson: string | null;
  readonly transitionedAtIso: string;
}

export interface DurableApplicationCommandEffectTransitionRequest extends DurableApplicationCommandStatusRequest {
  readonly attempt: DurableApplicationCommandAttemptReference;
  readonly ordinal: number;
  readonly expectedState: DurableEffectState;
  readonly nextState: DurableEffectState;
  readonly evidence: ValidatedDurableEffectEvidence | null;
  readonly evidenceJson: string | null;
  readonly transitionedAtIso: string;
}

/** Positive safe integer validated at every storage boundary. */
export type DurableApplicationCommandSemanticRevision = number;

export interface DurableApplicationCommandOutboxInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly schemaVersion: number;
  /**
   * Monotonic domain revision of the projection changed by this event. This
   * is envelope metadata, not an optional convention inside payloadJson.
   */
  readonly semanticRevision: DurableApplicationCommandSemanticRevision;
  readonly payloadJson: string;
  readonly createdAtIso: string;
}

export interface DurableApplicationCommandCommitRequest extends DurableApplicationCommandStatusRequest {
  readonly attempt: DurableApplicationCommandAttemptReference;
  readonly expectedState: 'running' | 'recovering';
  readonly outcomeJson: string;
  readonly committedAtIso: string;
  readonly outbox: DurableApplicationCommandOutboxInput;
}

export interface DurableApplicationCommandOutboxDeliveryLeaseRecord {
  readonly generation: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface DurableApplicationCommandOutboxRecord extends Omit<
  DurableApplicationCommandOutboxInput,
  'createdAtIso'
> {
  readonly sequence: number;
  readonly commandId: string;
  readonly deploymentId: string;
  readonly createdAt: string;
  readonly deliveryLease: DurableApplicationCommandOutboxDeliveryLeaseRecord | null;
  readonly deliveryAcknowledgedAt: string | null;
}

export interface DurableApplicationCommandOutboxListRequest {
  readonly afterSequence: number;
  readonly limit: number;
}

export interface DurableApplicationCommandOutboxClaimRequest {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly claimedAtIso: string;
  readonly leaseExpiresAtIso: string;
  readonly limit: number;
}

export interface DurableApplicationCommandConsumerProjectionRequest {
  readonly consumerId: string;
  readonly projectionKey: string;
}

export interface DurableApplicationCommandConsumerApplyRequest extends DurableApplicationCommandConsumerProjectionRequest {
  readonly eventId: string;
  readonly semanticRevision: DurableApplicationCommandSemanticRevision;
  /** Durable projection state written in the same transaction as the event fence. */
  readonly stateJson: string;
  readonly appliedAtIso: string;
}

export interface DurableApplicationCommandConsumerApplicationRecord extends DurableApplicationCommandConsumerProjectionRequest {
  readonly eventId: string;
  readonly semanticRevision: DurableApplicationCommandSemanticRevision;
  readonly stateJson: string;
  readonly appliedAt: string;
}

export interface DurableApplicationCommandConsumerProjectionRecord extends DurableApplicationCommandConsumerProjectionRequest {
  readonly semanticRevision: DurableApplicationCommandSemanticRevision;
  readonly lastEventId: string;
  readonly stateJson: string;
  /** Number of distinct semantic events atomically applied to this projection. */
  readonly applicationCount: number;
  readonly updatedAt: string;
}

export interface DurableApplicationCommandConsumerApplyResult {
  readonly outcome: 'applied' | 'duplicate';
  readonly application: DurableApplicationCommandConsumerApplicationRecord;
  readonly projection: DurableApplicationCommandConsumerProjectionRecord;
}

/**
 * Records only that the current fenced lease completed delivery. A crash after
 * external delivery but before this acknowledgement intentionally replays the
 * same eventId/sequence/semanticRevision/payload. This is delivery bookkeeping,
 * not publication proof or proof that a consumer applied the event.
 */
export interface DurableApplicationCommandOutboxDeliveryAcknowledgementRequest {
  readonly eventId: string;
  readonly deliveryGeneration: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly acknowledgedAtIso: string;
}

export interface ApplicationCommandLedgerStore {
  begin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>>;
  markCompleted(request: ApplicationCommandLedgerCompleteRequest): Promise<void>;
  markFailed(request: ApplicationCommandLedgerFailRequest): Promise<void>;
  getByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  getByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  listByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]>;
}

/**
 * Worker-facing persistence operations. The application-command-ledger feature
 * owns this port; internal-storage supplies the concrete SQLite implementation.
 */
export interface ApplicationCommandLedgerStorageGateway {
  applicationCommandLedgerBegin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>>;
  applicationCommandLedgerMarkCompleted(
    request: ApplicationCommandLedgerCompleteRequest
  ): Promise<void>;
  applicationCommandLedgerMarkFailed(request: ApplicationCommandLedgerFailRequest): Promise<void>;
  applicationCommandLedgerGetByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  applicationCommandLedgerGetByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  applicationCommandLedgerListByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]>;
}

export interface DurableApplicationCommandLedgerStore {
  claimDurable<TCommandKind extends string>(
    request: DurableApplicationCommandClaimRequest<TCommandKind>
  ): Promise<DurableApplicationCommandClaimResult<TCommandKind>>;
  getDurableStatus<TCommandKind extends string>(
    request: DurableApplicationCommandStatusRequest
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null>;
  getDurableByClaim<TCommandKind extends string>(
    request: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null>;
  renewDurableAttemptLease(
    request: DurableApplicationCommandAttemptLeaseRequest
  ): Promise<DurableApplicationCommandRecord>;
  transitionDurableCommand(
    request: DurableApplicationCommandTransitionRequest
  ): Promise<DurableApplicationCommandRecord>;
  transitionDurableEffect(
    request: DurableApplicationCommandEffectTransitionRequest
  ): Promise<DurableApplicationCommandRecord>;
  commitDurable(
    request: DurableApplicationCommandCommitRequest
  ): Promise<DurableApplicationCommandRecord>;
  listDurableOutbox(
    request: DurableApplicationCommandOutboxListRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]>;
  claimDurableOutbox(
    request: DurableApplicationCommandOutboxClaimRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]>;
  acknowledgeDurableOutboxDelivery(
    request: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): Promise<void>;
  applyDurableConsumerEvent(
    request: DurableApplicationCommandConsumerApplyRequest
  ): Promise<DurableApplicationCommandConsumerApplyResult>;
  getDurableConsumerProjection(
    request: DurableApplicationCommandConsumerProjectionRequest
  ): Promise<DurableApplicationCommandConsumerProjectionRecord | null>;
}

/**
 * Additive durable-command persistence port. The application core owns the
 * protocol; internal-storage supplies the concrete SQLite implementation.
 */
export interface DurableApplicationCommandLedgerStorageGateway {
  applicationCommandLedgerDurableClaim<TCommandKind extends string>(
    request: DurableApplicationCommandPersistClaimRequest<TCommandKind>
  ): Promise<DurableApplicationCommandClaimResult<TCommandKind>>;
  applicationCommandLedgerDurableGetStatus<TCommandKind extends string>(
    request: DurableApplicationCommandStatusRequest
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null>;
  applicationCommandLedgerDurableGetByClaim<TCommandKind extends string>(
    request: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null>;
  applicationCommandLedgerDurableRenewAttemptLease(
    request: DurableApplicationCommandAttemptLeaseRequest
  ): Promise<DurableApplicationCommandRecord>;
  applicationCommandLedgerDurableTransitionCommand(
    request: DurableApplicationCommandTransitionRequest
  ): Promise<DurableApplicationCommandRecord>;
  applicationCommandLedgerDurableTransitionEffect(
    request: DurableApplicationCommandEffectTransitionRequest
  ): Promise<DurableApplicationCommandRecord>;
  applicationCommandLedgerDurableCommit(
    request: DurableApplicationCommandCommitRequest
  ): Promise<DurableApplicationCommandRecord>;
  applicationCommandLedgerDurableListOutbox(
    request: DurableApplicationCommandOutboxListRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]>;
  applicationCommandLedgerDurableClaimOutbox(
    request: DurableApplicationCommandOutboxClaimRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]>;
  applicationCommandLedgerDurableAcknowledgeOutboxDelivery(
    request: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): Promise<void>;
  applicationCommandLedgerDurableApplyConsumerEvent(
    request: DurableApplicationCommandConsumerApplyRequest
  ): Promise<DurableApplicationCommandConsumerApplyResult>;
  applicationCommandLedgerDurableGetConsumerProjection(
    request: DurableApplicationCommandConsumerProjectionRequest
  ): Promise<DurableApplicationCommandConsumerProjectionRecord | null>;
}

export interface ApplicationCommandHasher {
  hashJson(value: unknown): string;
  hashString(value: string): string;
}
