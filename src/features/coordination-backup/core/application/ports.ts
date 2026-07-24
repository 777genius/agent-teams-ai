import type {
  BackupAcceptedCommandDrain,
  BackupCommitMarker,
  BackupCoordinationBarrier,
  BackupExclusion,
  BackupFenceCompletionDisposition,
  BackupFenceEvidence,
  BackupIdentityInventory,
  BackupManifest,
  BackupManifestBody,
  BackupManifestEntry,
  BackupParticipantDescriptor,
  BackupPublicationInspection,
  BackupRunId,
  BackupRunRecord,
  BackupRunTransitionRequest,
  BackupVerificationPlan,
  CommittedBackupPublication,
  FlushedBackupParticipant,
  ImmutableBackupVerification,
  OnlineBackupSnapshot,
  PreparedBackupParticipant,
  RequestCoordinationBackup,
  Sha256Digest,
  SqliteIntegrityEvidence,
} from '../../contracts';

export interface CreateBackupRunRequest extends RequestCoordinationBackup {
  readonly requestedAt: string;
  readonly participantDescriptors: readonly BackupParticipantDescriptor[];
}

export interface SaveBackupVerificationPlanRequest {
  readonly backupRunId: BackupRunId;
  readonly expectedRevision: number;
  readonly plan: BackupVerificationPlan;
  readonly at: string;
}

export interface MarkBackupFenceCompletedRequest {
  readonly backupRunId: BackupRunId;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly disposition: BackupFenceCompletionDisposition;
  readonly completedAt: string;
}

/**
 * Implementations must persist create, transition, and verification-plan writes transactionally.
 * Transition is compare-and-set on both state and revision; it never reports success before durable
 * storage has committed. listRecoverable includes active runs and terminal runs whose durable fence
 * completion is still pending.
 */
export interface BackupRunRepository {
  create(request: CreateBackupRunRequest): Promise<BackupRunRecord>;
  get(backupRunId: BackupRunId): Promise<BackupRunRecord | null>;
  listRecoverable(): Promise<readonly BackupRunRecord[]>;
  transition(request: BackupRunTransitionRequest): Promise<BackupRunRecord>;
  saveVerificationPlan(request: SaveBackupVerificationPlanRequest): Promise<BackupRunRecord>;
  markFenceCompleted(request: MarkBackupFenceCompletedRequest): Promise<BackupRunRecord>;
}

export interface BackupWriterFenceLease {
  readonly leaseId: string;
  readonly evidence: BackupFenceEvidence;
}

export interface AcquireBackupWriterFenceRequest {
  readonly backupRunId: BackupRunId;
  readonly expectedGeneration: number | null;
}

export interface CompleteBackupWriterFenceRequest {
  readonly lease: BackupWriterFenceLease;
  /** operator_required relinquishes ownership but must leave mutation admission durably closed. */
  readonly disposition: BackupFenceCompletionDisposition;
}

export type AcquireBackupWriterFenceResult =
  | { readonly status: 'acquired'; readonly lease: BackupWriterFenceLease }
  | { readonly status: 'busy'; readonly activeRunId: BackupRunId };

export interface BackupWriterFencePort {
  /**
   * Exactly one exclusive lease may be acquired for a deployment fence at a time. Reacquiring for
   * the same run and expected generation returns the same durable lease identity.
   */
  acquire(request: AcquireBackupWriterFenceRequest): Promise<AcquireBackupWriterFenceResult>;
  /** Idempotent for the durable lease identity, including after a prior successful completion. */
  complete(request: CompleteBackupWriterFenceRequest): Promise<void>;
}

export interface PrepareBackupParticipantRequest {
  readonly backupRunId: BackupRunId;
  readonly fence: BackupFenceEvidence;
}

export interface FlushBackupParticipantRequest<
  TParticipantId extends string = string,
  TKind extends string = string,
> extends PrepareBackupParticipantRequest {
  readonly prepared: PreparedBackupParticipant<TParticipantId, TKind>;
}

export interface StageBackupParticipantRequest<
  TParticipantId extends string = string,
  TKind extends string = string,
> extends PrepareBackupParticipantRequest {
  readonly flushed: FlushedBackupParticipant<TParticipantId, TKind>;
}

export interface StagedBackupParticipant {
  readonly participantId: string;
  readonly entries: readonly BackupManifestEntry[];
  readonly exclusions: readonly BackupExclusion[];
}

export interface VerifyBackupParticipantRequest<
  TParticipantId extends string = string,
  TKind extends string = string,
> extends StageBackupParticipantRequest<TParticipantId, TKind> {
  readonly stagedEntries: readonly BackupManifestEntry[];
}

export type BackupParticipantVerification =
  | { readonly status: 'verified' }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Feature-owned participants expose typed lifecycle evidence, never roots or filesystem paths.
 * Every method is idempotent for the tuple (BackupRunId, descriptor, sourceGeneration).
 */
export interface CoordinationBackupParticipant<
  TParticipantId extends string = string,
  TKind extends string = string,
> {
  readonly descriptor: BackupParticipantDescriptor<TParticipantId, TKind>;
  prepare(
    request: PrepareBackupParticipantRequest
  ): Promise<PreparedBackupParticipant<TParticipantId, TKind>>;
  flush(
    request: FlushBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<FlushedBackupParticipant<TParticipantId, TKind>>;
  stage(
    request: StageBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<StagedBackupParticipant>;
  verify(
    request: VerifyBackupParticipantRequest<TParticipantId, TKind>
  ): Promise<BackupParticipantVerification>;
}

export interface DrainAcceptedBackupCommandsRequest {
  readonly backupRunId: BackupRunId;
  readonly fence: BackupFenceEvidence;
}

export interface CaptureCoordinationBarrierRequest extends DrainAcceptedBackupCommandsRequest {
  readonly acceptedCommandDrain: BackupAcceptedCommandDrain;
  readonly participants: readonly FlushedBackupParticipant[];
}

/** Fences/drains accepted commands before participants flush, then binds all durable barriers. */
export interface BackupCoordinationFlushPort {
  drainAcceptedCommands(
    request: DrainAcceptedBackupCommandsRequest
  ): Promise<BackupAcceptedCommandDrain>;
  captureBarrier(request: CaptureCoordinationBarrierRequest): Promise<BackupCoordinationBarrier>;
}

export interface CaptureBackupIdentityInventoryRequest {
  readonly backupRunId: BackupRunId;
  readonly fence: BackupFenceEvidence;
  readonly barrier: BackupCoordinationBarrier;
}

export interface BackupIdentityInventoryPort {
  capture(request: CaptureBackupIdentityInventoryRequest): Promise<BackupIdentityInventory>;
}

export type OnlineBackupResult =
  | { readonly status: 'completed'; readonly snapshot: OnlineBackupSnapshot }
  | {
      readonly status: 'failed';
      readonly reason: 'busy_timeout' | 'deadline_exceeded' | 'source_corrupt';
    };

/**
 * The only SQLite snapshot port. Adapters must invoke the driver's Online Backup API, bound BUSY and
 * deadline handling, remove partial output on failure, and never substitute raw db/WAL/SHM copying.
 */
export interface SqliteOnlineBackupPort {
  createOnlineSnapshot(request: {
    readonly backupRunId: BackupRunId;
    readonly fence: BackupFenceEvidence;
    readonly coordinationBarrier: BackupCoordinationBarrier;
    readonly participants: readonly FlushedBackupParticipant[];
  }): Promise<OnlineBackupResult>;
}

export type SqliteIntegrityResult =
  | { readonly status: 'valid'; readonly evidence: SqliteIntegrityEvidence }
  | {
      readonly status: 'invalid';
      readonly reason:
        | 'integrity_check_failed'
        | 'application_id_mismatch'
        | 'schema_mismatch'
        | 'migration_incomplete'
        | 'required_identity_missing';
    };

/** Reopens the staged snapshot through an independent connection before publication. */
export interface SqliteSnapshotIntegrityPort {
  reopenAndCheck(request: {
    readonly backupRunId: BackupRunId;
    readonly snapshot: OnlineBackupSnapshot;
  }): Promise<SqliteIntegrityResult>;
}

export interface BackupManifestHashPort {
  hashCanonicalManifest(body: BackupManifestBody): Promise<Sha256Digest>;
}

export interface BackupPublicationPort {
  preparePrivateStage(backupRunId: BackupRunId): Promise<void>;
  inspect(backupRunId: BackupRunId): Promise<BackupPublicationInspection>;
  writeRootManifest(request: {
    readonly backupRunId: BackupRunId;
    readonly manifest: BackupManifest;
  }): Promise<void>;
  /** This is the final content write. It also fsyncs the stage and its parent before returning. */
  writeCommitMarkerLast(request: {
    readonly backupRunId: BackupRunId;
    readonly marker: BackupCommitMarker;
  }): Promise<void>;
  /** Atomically renames the sealed private stage to its immutable committed name. */
  commitSealedStage(request: {
    readonly backupRunId: BackupRunId;
    readonly manifestHash: Sha256Digest;
  }): Promise<CommittedBackupPublication>;
  abortUncommittedStage(backupRunId: BackupRunId): Promise<void>;
}

export interface ImmutableBackupVerifierPort {
  verify(request: {
    readonly backupRunId: BackupRunId;
    readonly location: 'staging' | 'committed';
    readonly expectedPlan: BackupVerificationPlan;
  }): Promise<ImmutableBackupVerification>;
}

export interface CoordinationBackupClock {
  nowIso(): string;
}
