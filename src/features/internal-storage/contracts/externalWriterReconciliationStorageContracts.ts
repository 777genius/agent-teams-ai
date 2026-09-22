import type { CoordinationEventDraft, CoordinationJsonValue } from '@features/coordination-events';

export interface ExternalWriterReconciliationReceipt {
  readonly reconciliationId: string;
  readonly inputSha256: string;
  readonly eventId: string;
  readonly sourceGeneration: number;
  readonly featureRevision: number;
  readonly eventBodyJson: string;
  readonly committedAt: string;
}

export interface ExternalWriterReconciliationCommitRequest {
  readonly deploymentId: string;
  readonly receipt: ExternalWriterReconciliationReceipt;
  readonly event: CoordinationEventDraft<CoordinationJsonValue>;
}

export interface ExternalWriterReconciliationStorageGateway {
  getExternalWriterReconciliation(input: {
    readonly deploymentId: string;
    readonly reconciliationId: string;
  }): Promise<ExternalWriterReconciliationReceipt | null>;
  commitExternalWriterReconciliation(
    input: ExternalWriterReconciliationCommitRequest
  ): Promise<{
    readonly outcome: 'committed' | 'idempotent_replay' | 'input_conflict';
    readonly receipt: ExternalWriterReconciliationReceipt | null;
  }>;
}
