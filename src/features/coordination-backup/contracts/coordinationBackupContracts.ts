import type { DeploymentId, TeamId, WorkspaceId } from '@shared/contracts/hosted/identifiers';

declare const backupRunIdBrand: unique symbol;
declare const sha256DigestBrand: unique symbol;

export type BackupRunId = string & { readonly [backupRunIdBrand]: 'BackupRunId' };
export type Sha256Digest = string & { readonly [sha256DigestBrand]: 'Sha256Digest' };

const BACKUP_RUN_ID_PATTERN = /^backup_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function parseBackupRunId(value: unknown): BackupRunId {
  if (typeof value !== 'string' || !BACKUP_RUN_ID_PATTERN.test(value)) {
    throw new TypeError('coordination-backup-run-id-invalid');
  }
  return value as BackupRunId;
}

export function parseSha256Digest(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError('coordination-backup-sha256-invalid');
  }
  return value as Sha256Digest;
}

export const COORDINATION_BACKUP_FORMAT = 'coordination-backup/v2' as const;
export const COORDINATION_BACKUP_COMMIT_MARKER_FORMAT =
  'coordination-backup-commit-marker/v1' as const;
export const SQLITE_ONLINE_BACKUP_METHOD = 'sqlite_online_backup_api' as const;
export const COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION = 1 as const;
export const COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION = 1 as const;
export const COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION = 3 as const;
export const COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION = 1 as const;

export const BACKUP_RUN_STATES = Object.freeze([
  'requested',
  'fencing',
  'quiescing',
  'sqlite_snapshot',
  'file_stage',
  'verifying',
  'committed',
  'failed',
  'operator_required',
  'artifact_source',
] as const);

export type BackupRunState = (typeof BACKUP_RUN_STATES)[number];
export type ActiveBackupRunState = Exclude<
  BackupRunState,
  'committed' | 'failed' | 'operator_required' | 'artifact_source'
>;
export type TerminalBackupRunState = Extract<
  BackupRunState,
  'committed' | 'failed' | 'operator_required' | 'artifact_source'
>;

export type BackupProductKind = 'coordination_backup';
export type CoordinationBackupPurpose = 'app_migration' | 'coordination_repair';

export interface BackupParticipantDescriptor<
  TParticipantId extends string = string,
  TKind extends string = string,
> {
  readonly participantId: TParticipantId;
  readonly kind: TKind;
  readonly contractVersion: typeof COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION;
  readonly schemaVersion: typeof COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION;
  readonly required: boolean;
}

export interface PreparedBackupParticipant<
  TParticipantId extends string = string,
  TKind extends string = string,
> {
  readonly descriptor: BackupParticipantDescriptor<TParticipantId, TKind>;
  readonly sourceGeneration: string;
}

export interface FlushedBackupParticipant<
  TParticipantId extends string = string,
  TKind extends string = string,
> extends PreparedBackupParticipant<TParticipantId, TKind> {
  readonly durableBarrier: string;
}

export interface StateCompatibilityManifestRef {
  readonly manifestId: string;
  readonly schemaVersion: typeof COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION;
  readonly sha256: Sha256Digest;
}

export interface BackupFenceEvidence {
  readonly generation: number;
  readonly admittedRunId: BackupRunId;
}

export type BackupFenceCompletionDisposition = 'committed' | 'aborted' | 'operator_required';

export type BackupFenceCompletion =
  | {
      readonly generation: number;
      readonly disposition: BackupFenceCompletionDisposition;
      readonly status: 'pending';
      readonly completedAt: null;
    }
  | {
      readonly generation: number;
      readonly disposition: BackupFenceCompletionDisposition;
      readonly status: 'completed';
      readonly completedAt: string;
    };

export type PendingBackupFenceCompletion = Extract<BackupFenceCompletion, { status: 'pending' }>;

export interface BackupAcceptedCommandDrain {
  readonly admittedRunId: BackupRunId;
  readonly fenceGeneration: number;
  readonly throughCommandCursor: string;
  readonly durableBarrier: string;
}

export interface BackupParticipantRecoveryPoint {
  readonly participantId: string;
  readonly sourceGeneration: string;
  readonly durableBarrier: string;
}

export interface BackupCoordinationBarrier {
  readonly stateCompatibilityManifest: StateCompatibilityManifestRef;
  readonly acceptedCommandDrain: BackupAcceptedCommandDrain;
  readonly participantRecoveryPoints: readonly BackupParticipantRecoveryPoint[];
  readonly eventCursor: string;
  readonly eventEpoch: string;
  readonly journalCursors: Readonly<Record<string, string>>;
}

export type BackupIdentityKind = 'deployment' | 'team' | 'member';
export type BackupIdentityState = 'active' | 'tombstoned';

export interface BackupIdentityInventoryEntry {
  readonly kind: BackupIdentityKind;
  readonly identityId: string;
  readonly parentIdentityId: string | null;
  readonly state: BackupIdentityState;
  readonly checksum: Sha256Digest;
  /** Active identities require an anchor; row-only tombstones intentionally use null. */
  readonly fileEntryId: string | null;
}

export interface BackupWorkspaceRegistrationEntry {
  readonly workspaceId: WorkspaceId;
  readonly registrationKey: string;
  readonly state: 'registered' | 'disabled';
}

export interface BackupIdentityInventory {
  readonly schemaVersion: typeof COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION;
  readonly deploymentId: DeploymentId;
  readonly identities: readonly BackupIdentityInventoryEntry[];
  /** Mount generation is intentionally excluded: restore rotates mount authority. */
  readonly workspaceRegistrations: readonly BackupWorkspaceRegistrationEntry[];
}

export type BackupManifestEntryKind = 'sqlite_snapshot' | 'participant_file' | 'identity_anchor';

export interface BackupManifestEntry {
  readonly entryId: string;
  readonly participantId: string;
  readonly kind: BackupManifestEntryKind;
  readonly logicalOwner: string;
  readonly logicalType: string;
  readonly schemaVersion: number;
  readonly byteLength: number;
  readonly mode: number;
  readonly sha256: Sha256Digest;
  readonly sourceGeneration: string;
}

export interface BackupExclusion {
  readonly participantId: string;
  readonly logicalType: string;
  readonly reason:
    | 'credential'
    | 'session_or_ticket'
    | 'ephemeral_runtime'
    | 'rebuildable_cache'
    | 'secret_diagnostic'
    | 'outside_coordination_scope';
}

export interface OnlineBackupSnapshot {
  readonly method: typeof SQLITE_ONLINE_BACKUP_METHOD;
  readonly entry: BackupManifestEntry & { readonly kind: 'sqlite_snapshot' };
  readonly applicationId: number;
  readonly userVersion: number;
  readonly sourceRunId: BackupRunId;
}

export interface SqliteIntegrityEvidence {
  readonly integrityCheck: 'ok';
  readonly applicationId: number;
  readonly userVersion: number;
  readonly requiredInvariants: Readonly<Record<string, true>>;
}

export interface BackupManifestBody {
  readonly format: typeof COORDINATION_BACKUP_FORMAT;
  readonly backupRunId: BackupRunId;
  readonly sourceBackupRunId: BackupRunId;
  readonly productKind: BackupProductKind;
  readonly purpose: CoordinationBackupPurpose;
  readonly deploymentId: DeploymentId;
  readonly requestedAt: string;
  readonly sealedAt: string;
  readonly fenceGeneration: number;
  readonly coordinationBarrier: BackupCoordinationBarrier;
  readonly identityInventory: BackupIdentityInventory;
  readonly participants: readonly FlushedBackupParticipant[];
  readonly sqliteSnapshot: OnlineBackupSnapshot;
  readonly sqliteIntegrity: SqliteIntegrityEvidence;
  readonly entries: readonly BackupManifestEntry[];
  readonly exclusions: readonly BackupExclusion[];
}

export interface BackupManifest extends BackupManifestBody {
  readonly manifestHash: Sha256Digest;
}

export interface BackupCommitMarker {
  readonly format: typeof COORDINATION_BACKUP_COMMIT_MARKER_FORMAT;
  readonly backupRunId: BackupRunId;
  readonly deploymentId: DeploymentId;
  readonly manifestHash: Sha256Digest;
  readonly sealedAt: string;
}

export interface BackupVerificationPlan {
  readonly manifest: BackupManifest;
  readonly marker: BackupCommitMarker;
}

export interface CommittedBackupPublication {
  readonly backupRunId: BackupRunId;
  readonly manifestHash: Sha256Digest;
  readonly immutableGeneration: string;
}

export interface BackupRunFailure {
  readonly code: string;
  readonly phase: ActiveBackupRunState;
  readonly safeMessage: string;
}

export interface BackupRunRecord {
  readonly backupRunId: BackupRunId;
  readonly deploymentId: DeploymentId;
  readonly productKind: BackupProductKind;
  readonly purpose: CoordinationBackupPurpose;
  readonly state: BackupRunState;
  readonly revision: number;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly participantDescriptors: readonly BackupParticipantDescriptor[];
  readonly fence: BackupFenceEvidence | null;
  readonly fenceLeaseId: string | null;
  readonly fenceCompletion: BackupFenceCompletion | null;
  readonly preparedParticipants: readonly PreparedBackupParticipant[] | null;
  readonly flushedParticipants: readonly FlushedBackupParticipant[] | null;
  readonly coordinationBarrier: BackupCoordinationBarrier | null;
  readonly identityInventory: BackupIdentityInventory | null;
  readonly sqliteSnapshot: OnlineBackupSnapshot | null;
  readonly stagedEntries: readonly BackupManifestEntry[] | null;
  readonly exclusions: readonly BackupExclusion[] | null;
  readonly verificationPlan: BackupVerificationPlan | null;
  readonly publication: CommittedBackupPublication | null;
  readonly failure: BackupRunFailure | null;
}

export interface RequestCoordinationBackup {
  readonly backupRunId: BackupRunId;
  readonly deploymentId: DeploymentId;
  readonly purpose: CoordinationBackupPurpose;
}

export type BackupRunTransitionRequest =
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'requested';
      readonly to: 'fencing';
      readonly at: string;
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'fencing';
      readonly to: 'quiescing';
      readonly at: string;
      readonly fence: BackupFenceEvidence;
      readonly fenceLeaseId: string;
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'quiescing';
      readonly to: 'sqlite_snapshot';
      readonly at: string;
      readonly preparedParticipants: readonly PreparedBackupParticipant[];
      readonly flushedParticipants: readonly FlushedBackupParticipant[];
      readonly coordinationBarrier: BackupCoordinationBarrier;
      readonly identityInventory: BackupIdentityInventory;
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'sqlite_snapshot';
      readonly to: 'file_stage';
      readonly at: string;
      readonly sqliteSnapshot: OnlineBackupSnapshot;
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'file_stage';
      readonly to: 'verifying';
      readonly at: string;
      readonly stagedEntries: readonly BackupManifestEntry[];
      readonly exclusions: readonly BackupExclusion[];
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: 'verifying';
      readonly to: 'committed';
      readonly at: string;
      readonly publication: CommittedBackupPublication;
      readonly fenceCompletion: PendingBackupFenceCompletion;
    }
  | {
      readonly backupRunId: BackupRunId;
      readonly expectedRevision: number;
      readonly from: ActiveBackupRunState;
      readonly to: 'failed' | 'operator_required';
      readonly at: string;
      readonly failure: BackupRunFailure;
      readonly fence: BackupFenceEvidence | null;
      readonly fenceLeaseId: string | null;
      readonly fenceCompletion: PendingBackupFenceCompletion | null;
    };

export type BackupPublicationInspection =
  | { readonly status: 'absent' }
  | { readonly status: 'staging_unsealed' }
  | { readonly status: 'staging_sealed' }
  | { readonly status: 'committed'; readonly publication: CommittedBackupPublication }
  | { readonly status: 'ambiguous' };

export interface MeasuredBackupEntry {
  readonly entryId: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly sha256: Sha256Digest;
}

export interface CopiedSourceBackupRun {
  readonly backupRunId: BackupRunId;
  readonly deploymentId: DeploymentId;
  readonly productKind: BackupProductKind;
  readonly purpose: CoordinationBackupPurpose;
  readonly state: BackupRunState;
  readonly fenceGeneration: number;
  readonly coordinationBarrier: BackupCoordinationBarrier;
  readonly participants: readonly FlushedBackupParticipant[];
  readonly identityInventory: BackupIdentityInventory;
}

export interface ImmutableBackupInspection {
  readonly manifest: BackupManifest;
  readonly marker: BackupCommitMarker;
  readonly computedManifestHash: Sha256Digest;
  readonly measuredEntries: readonly MeasuredBackupEntry[];
  readonly observedIdentityInventory: BackupIdentityInventory;
  readonly copiedSourceRun: CopiedSourceBackupRun;
}

export type ImmutableBackupVerification =
  | { readonly status: 'verified'; readonly inspection: ImmutableBackupInspection }
  | { readonly status: 'invalid'; readonly reasons: readonly string[] };

export type BackupArtifactClassification = 'committed_v2' | 'legacy_unverified' | 'partial';
export type CoordinationBackupRestorePurpose = CoordinationBackupPurpose | 'replace_deployment';

export interface RestoreSetValidationRequest {
  readonly classification: BackupArtifactClassification;
  readonly purpose: CoordinationBackupRestorePurpose;
  readonly expectedDeploymentId: DeploymentId;
  readonly inspection: ImmutableBackupInspection | null;
}

export interface ValidatedRestoreIdentityMapping {
  readonly deploymentId: DeploymentId;
  readonly activeTeamIds: readonly TeamId[];
  readonly tombstonedIdentityIds: readonly string[];
  readonly workspaceRegistrations: Readonly<Record<string, WorkspaceId>>;
  readonly sourceRunFinalization: {
    readonly backupRunId: BackupRunId;
    readonly from: 'sqlite_snapshot';
    readonly to: 'artifact_source';
  };
}

export type RestoreSetValidationResult =
  | {
      readonly status: 'valid';
      readonly mapping: ValidatedRestoreIdentityMapping;
    }
  | {
      readonly status: 'invalid';
      readonly reasons: readonly string[];
    };
