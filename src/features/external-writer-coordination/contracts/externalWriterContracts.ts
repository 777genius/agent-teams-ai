import type { TeamId } from '@shared/contracts/hosted/identifiers';

export const EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION = 2 as const;

// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract names distinguish persistence coordinates.
export type ObservationSequence = number;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract names distinguish persistence coordinates.
export type ObservationWatermark = number;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract names distinguish persistence coordinates.
export type FileWriterEpoch = number;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract name distinguishes a catalog key from arbitrary text.
export type ExternalWriterFeatureKey = string;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract name distinguishes a registered identity from a path.
export type ExternalFileKey = string;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract name distinguishes a digest from content or metadata.
export type ExternalContentChecksum = string;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public contract name distinguishes a durable deduplication coordinate from arbitrary text.
export type ExternalFileReconciliationId = string;

export interface ExternalWriterScope {
  teamId: TeamId;
  featureKey: ExternalWriterFeatureKey;
}

export interface ExternalFileRegistration {
  scope: ExternalWriterScope;
  fileKey: ExternalFileKey;
  maxBytes: number;
  attributionPolicy: 'external_file_only' | 'verified_run_evidence';
}

export type ExternalWriterNotificationKind = 'change' | 'rename' | 'delete';

export interface ExternalWriterNotification {
  kind: ExternalWriterNotificationKind;
  scope: ExternalWriterScope;
  fileKey: ExternalFileKey;
}

export interface ExternalWriterOverflowNotification {
  scopes: readonly ExternalWriterScope[];
}

export interface ExternalWriterWatchCallbacks {
  onNotification(notification: ExternalWriterNotification): void;
  onOverflow(notification: ExternalWriterOverflowNotification): void;
}

export type ExternalObservationCause =
  | ExternalWriterNotificationKind
  | 'startup_scan'
  | 'periodic_scan'
  | 'dirty_scope_rescan';

export type ExternalWriterDirtyReason =
  | 'catalog_changed'
  | 'corrupt'
  | 'drain_budget_exhausted'
  | 'notification_overflow'
  | 'outside_containment'
  | 'oversized'
  | 'reconciliation_conflict'
  | 'shutdown_handoff'
  | 'unstable'
  | 'unsupported_file_type';

export interface PendingFileObservation {
  id: string;
  scope: ExternalWriterScope;
  fileKey: ExternalFileKey;
  cause: ExternalObservationCause;
  earliestSequence: ObservationSequence;
  latestSequence: ObservationSequence;
  fileWriterEpoch: FileWriterEpoch;
  attempts: number;
  reconciliation: PendingFileReconciliation | null;
}

export interface PendingFileReconciliation {
  reconciliationId: ExternalFileReconciliationId;
  throughSequence: ObservationSequence;
  fingerprint: ExternalFileSourceFingerprint;
  actor: ExternalObservationActor;
}

export interface DirtyObservationScope {
  scope: ExternalWriterScope;
  reasons: readonly ExternalWriterDirtyReason[];
  earliestSequence: ObservationSequence;
  latestSequence: ObservationSequence;
}

export interface ExternalFileStat {
  kind: 'directory' | 'file' | 'missing' | 'other' | 'symlink';
  contained: boolean;
  byteLength: number;
  device: string | null;
  inode: string | null;
  modifiedTimeNs: string | null;
  changedTimeNs: string | null;
}

export interface ExternalFileStatIdentity {
  byteLength: number;
  device: string;
  inode: string;
  modifiedTimeNs: string;
  changedTimeNs: string;
}

export interface ExternalFileSourceFingerprint {
  exists: boolean;
  checksum: ExternalContentChecksum | null;
  statIdentity: ExternalFileStatIdentity | null;
}

export interface ObservedExternalFile {
  scope: ExternalWriterScope;
  fileKey: ExternalFileKey;
  fingerprint: ExternalFileSourceFingerprint;
  sourceGeneration: number;
  fileWriterEpoch: FileWriterEpoch;
  observationSequence: ObservationSequence;
}

export interface ExternalSelfWriteIntent {
  intentId: string;
  scope: ExternalWriterScope;
  fileKey: ExternalFileKey;
  expectedChecksum: ExternalContentChecksum | null;
  sourceGeneration: number;
  fileWriterEpoch: FileWriterEpoch;
  expiresAtMs: number;
}

export interface FileWriterEpochRecord {
  teamId: TeamId;
  epoch: FileWriterEpoch;
}

export interface TeamObservationWatermarkRecord {
  teamId: TeamId;
  lastObservationSequence: ObservationSequence;
  observationWatermark: ObservationWatermark;
}

export interface FileObservationStateCheckpoint {
  schemaVersion: typeof EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION;
  lastObservationSequence: ObservationSequence;
  observationWatermark: ObservationWatermark;
  fileWriterEpochs: readonly FileWriterEpochRecord[];
  teamObservationWatermarks: readonly TeamObservationWatermarkRecord[];
  pendingObservations: readonly PendingFileObservation[];
  dirtyScopes: readonly DirtyObservationScope[];
  selfWriteIntents: readonly ExternalSelfWriteIntent[];
  observedFiles: readonly ObservedExternalFile[];
}

export interface ExternalFileActor {
  kind: 'external_file';
  teamId: TeamId;
  featureKey: ExternalWriterFeatureKey;
  fileKey: ExternalFileKey;
  checksum: ExternalContentChecksum | null;
  observationSequence: ObservationSequence;
}

/**
 * This actor may be returned only by a provider-specific verifier. Generic file
 * content, selected UI state, and claimed JSON fields are never sufficient.
 */
export interface VerifiedRunActor {
  kind: 'verified_run';
  teamId: TeamId;
  runId: string;
  runGeneration: number;
  memberId: string | null;
  evidenceRef: string;
}

export type ExternalObservationActor = ExternalFileActor | VerifiedRunActor;

export interface ExternalFileReconciliationRequest {
  reconciliationId: ExternalFileReconciliationId;
  registration: ExternalFileRegistration;
  content: Uint8Array | null;
  fingerprint: ExternalFileSourceFingerprint;
  observationSequence: ObservationSequence;
  fileWriterEpoch: FileWriterEpoch;
  actor: ExternalObservationActor;
}

export type ExternalFileReconciliationResult =
  | {
      outcome: 'accepted_change';
      sourceGeneration: number;
      featureRevision: number;
    }
  | {
      outcome: 'semantic_noop';
      sourceGeneration: number;
    }
  | {
      outcome: 'invalid';
      diagnosticCode: string;
      blocksDependentMutations: boolean;
    }
  | {
      outcome: 'conflict';
      diagnosticCode: string;
    };

export interface ExternalWriterObserverOptions {
  maxPendingObservations: number;
  maxSelfWriteIntents: number;
  maxScopes: number;
  maxObservedFiles: number;
  maxFilesPerScope: number;
  maxReadBytes: number;
  maxStableReadAttempts: number;
  maxObservationAttempts: number;
  maxDrainPassObservations: number;
  maxQuiescenceAttempts: number;
  stableReadDeadlineMs: number;
  retryDelayMs: number;
  atomicReplaceDebounceMs: number;
  shutdownDrainDeadlineMs: number;
}

export type ExternalWriterObserverPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface ExternalWriterObserverSnapshot {
  phase: ExternalWriterObserverPhase;
  acceptingNotifications: boolean;
  readiness: 'clean' | 'dirty';
  checkpoint: FileObservationStateCheckpoint;
}

export interface ExternalWriterShutdownHandoff {
  status: 'clean' | 'dirty' | 'deadline_exceeded';
  capturedSequence: ObservationSequence;
  persistedWatermark: ObservationWatermark;
  dirtyScopes: readonly DirtyObservationScope[];
  pendingObservationCount: number;
}

export interface ExternalWriterQuiescenceProof {
  teamId: TeamId;
  fileWriterEpoch: FileWriterEpoch;
  observationWatermark: ObservationWatermark;
}

export type ExternalWriterQuiescenceResult =
  | {
      outcome: 'quiesced';
      proof: ExternalWriterQuiescenceProof;
    }
  | {
      outcome: 'external_writer_busy';
      capturedSequence: ObservationSequence;
      observationWatermark: ObservationWatermark;
      dirtyScopes: readonly DirtyObservationScope[];
    };
