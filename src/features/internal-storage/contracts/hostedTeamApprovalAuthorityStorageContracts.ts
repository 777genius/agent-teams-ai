/**
 * Storage-only durable approval authority contracts. They deliberately use
 * opaque delivery references instead of runtime/provider APIs so the storage
 * worker cannot become a lifecycle or provider owner.
 */

/** Durable terminal outcome; `timeout` is lifecycle-owned and never accepted from a browser. */
export type HostedTeamApprovalStorageDecision = 'allow' | 'deny' | 'timeout';

export interface HostedTeamApprovalAuthorityScope {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly authorityGeneration: string;
  readonly restoreGeneration: number;
}

export interface HostedTeamApprovalPreviewStorageRecord {
  readonly previewRef: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly isBinary: boolean;
}

/** Trusted runtime observation submitted by the external lifecycle owner. */
export interface HostedTeamApprovalPendingStorageRecord {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly approvalId: string;
  readonly approvalGeneration: string;
  readonly category: 'file_change' | 'command' | 'network' | 'other';
  readonly summary: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly preview: HostedTeamApprovalPreviewStorageRecord | null;
  /** Opaque runtime-owned target; it is never a filesystem path. */
  readonly deliveryRef: string;
  readonly observedAtMs: number;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalPendingReadRequest {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly afterApprovalId: string | null;
  readonly afterApprovalGenerationHash: string | null;
  readonly limit: number;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalPendingReadRecord {
  readonly approvalId: string;
  readonly approvalGeneration: string;
  readonly category: 'file_change' | 'command' | 'network' | 'other';
  readonly summary: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly previewRef: string | null;
}

export interface HostedTeamApprovalPendingReadResult {
  readonly records: readonly HostedTeamApprovalPendingReadRecord[];
  readonly hasMore: boolean;
}

export interface HostedTeamApprovalPreviewReadRequest {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly approvalId: string;
  readonly expectedApprovalGeneration: string;
  readonly previewRef: string;
  readonly deadlineAtMs: number;
}

export type HostedTeamApprovalPreviewReadResult =
  | { readonly kind: 'found'; readonly preview: HostedTeamApprovalPreviewStorageRecord }
  | { readonly kind: 'stale_generation'; readonly currentApprovalGeneration: string }
  | { readonly kind: 'not_found' };

export interface HostedTeamApprovalDecisionAudit {
  readonly auditId: string;
  readonly principalId: string;
  readonly sessionId: string;
}

export interface HostedTeamApprovalDeliveryIntent {
  readonly deliveryId: string;
}

export interface HostedTeamApprovalDecisionStorageRequest {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly approvalId: string;
  readonly expectedApprovalGeneration: string;
  readonly idempotencyKey: string;
  readonly decision: HostedTeamApprovalStorageDecision;
  /** SHA-256 of the canonical redacted decision intent. */
  readonly payloadHash: string;
  readonly audit: HostedTeamApprovalDecisionAudit;
  readonly delivery: HostedTeamApprovalDeliveryIntent;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalDecisionStorageReceipt {
  readonly approvalGeneration: string;
  readonly decision: HostedTeamApprovalStorageDecision;
  readonly revision: number;
}

export type HostedTeamApprovalDecisionStorageResult =
  | { readonly kind: 'committed'; readonly receipt: HostedTeamApprovalDecisionStorageReceipt }
  | {
      readonly kind: 'idempotent_replay';
      readonly receipt: HostedTeamApprovalDecisionStorageReceipt;
    }
  | {
      readonly kind: 'already_resolved';
      readonly approvalGeneration: string;
      readonly decision: HostedTeamApprovalStorageDecision;
    }
  | { readonly kind: 'stale_generation'; readonly currentApprovalGeneration: string }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_found' };

export interface HostedTeamApprovalDeliveryClaimRequest {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly ownerId: string;
  readonly leaseToken: string;
  /** Requested duration only; the storage clock owns both lease timestamps. */
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalDeliveryRecord {
  readonly deliveryId: string;
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly approvalId: string;
  readonly approvalGeneration: string;
  readonly decision: HostedTeamApprovalStorageDecision;
  readonly payloadHash: string;
  readonly deliveryRef: string;
  readonly deliveryGeneration: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly claimedAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly createdAtMs: number;
}

export interface HostedTeamApprovalDeliveryAcknowledgeRequest {
  readonly scope: HostedTeamApprovalAuthorityScope;
  readonly deliveryId: string;
  readonly deliveryGeneration: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly deadlineAtMs: number;
}

/** Production scheduler audit. `nextAuditTimeMs` is retained across timer callbacks to survive wall-clock rollback. */
export interface HostedTeamApprovalTimeoutAuditRequest {
  readonly nextAuditTimeMs: number;
  readonly deadlineAtMs: number;
}

export interface HostedTeamApprovalTimeoutAuditResult {
  readonly resolvedCount: number;
  readonly nextAuditTimeMs: number | null;
}

export interface HostedTeamApprovalAuthorityStorageGateway {
  hostedTeamApprovalObserve(
    record: HostedTeamApprovalPendingStorageRecord
  ): Promise<HostedTeamApprovalPendingReadRecord>;
  hostedTeamApprovalReadPending(
    request: HostedTeamApprovalPendingReadRequest
  ): Promise<HostedTeamApprovalPendingReadResult>;
  hostedTeamApprovalReadPreview(
    request: HostedTeamApprovalPreviewReadRequest
  ): Promise<HostedTeamApprovalPreviewReadResult>;
  hostedTeamApprovalDecide(
    request: HostedTeamApprovalDecisionStorageRequest
  ): Promise<HostedTeamApprovalDecisionStorageResult>;
  hostedTeamApprovalClaimDeliveries(
    request: HostedTeamApprovalDeliveryClaimRequest
  ): Promise<readonly HostedTeamApprovalDeliveryRecord[]>;
  hostedTeamApprovalAcknowledgeDelivery(
    request: HostedTeamApprovalDeliveryAcknowledgeRequest
  ): Promise<void>;
  hostedTeamApprovalAuditTimeouts(
    request: HostedTeamApprovalTimeoutAuditRequest
  ): Promise<HostedTeamApprovalTimeoutAuditResult>;
}
