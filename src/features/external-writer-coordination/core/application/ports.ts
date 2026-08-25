import type {
  ExternalFileReconciliationId,
  ExternalFileReconciliationRequest,
  ExternalFileReconciliationResult,
  ExternalFileRegistration,
  ExternalFileStat,
  ExternalWriterScope,
  ExternalWriterWatchCallbacks,
  FileObservationStateCheckpoint,
  VerifiedRunActor,
} from '../../contracts';

export interface ExternalWriterWatchHandle {
  close(): Promise<void>;
}

export interface ExternalWriterWatchPort {
  start(callbacks: ExternalWriterWatchCallbacks): Promise<ExternalWriterWatchHandle>;
}

/** Catalogues only feature-owned identities. It does not expose a global root scan. */
export interface ExternalFileObservationCatalog {
  listScopes(): Promise<readonly ExternalWriterScope[]>;
  listRegistrations(scope: ExternalWriterScope): Promise<readonly ExternalFileRegistration[]>;
}

/**
 * Filesystem mechanics belong in a later adapter. Core receives already scoped
 * registrations and never resolves paths or recursively scans a root.
 */
export interface ExternalFileObservationSource {
  stat(registration: ExternalFileRegistration): Promise<ExternalFileStat>;
  read(registration: ExternalFileRegistration, maxBytes: number): Promise<Uint8Array>;
  confirmAbsentByParentRescan(registration: ExternalFileRegistration): Promise<boolean>;
}

export interface ExternalContentChecksumPort {
  checksum(content: Uint8Array): Promise<string> | string;
}

export interface ExternalFileReconciliationPort {
  /**
   * Return the durable result for an earlier reconciliation. `null` is a proof
   * from the same atomic store that the id never committed, not a cache miss.
   */
  getResult(
    reconciliationId: ExternalFileReconciliationId
  ): Promise<ExternalFileReconciliationResult | null>;
  /**
   * Parse, validate, and atomically commit the id, normalized input,
   * projection, source/event evidence, and result. Reusing an id with the same
   * input returns that result; reusing it with different input fails closed.
   */
  reconcile(request: ExternalFileReconciliationRequest): Promise<ExternalFileReconciliationResult>;
}

export interface VerifiedRunEvidenceRequest {
  registration: ExternalFileRegistration;
  content: Uint8Array | null;
  checksum: string | null;
  observationSequence: number;
  fileWriterEpoch: number;
}

export interface VerifiedRunEvidencePort {
  /** Returns null unless provider evidence independently proves the exact run actor. */
  verify(request: VerifiedRunEvidenceRequest): Promise<VerifiedRunActor | null>;
}

export interface ExternalWriterObservationStateStore {
  load(): Promise<FileObservationStateCheckpoint | null>;
  /** Consumes a previously sealed catalog handoff before any new watcher starts. */
  consumeCleanHandoffEligibility(): Promise<FileObservationStateCheckpoint | null>;
  /** Returns only the bounded hot identities from the current checkpoint. */
  listHotTeamIds(): Promise<readonly ExternalWriterScope['teamId'][]>;
  save(checkpoint: FileObservationStateCheckpoint): Promise<void>;
  saveCleanHandoffEligibility(
    checkpoint: FileObservationStateCheckpoint,
    plan: ExternalWriterCleanHandoffEligibilityPlan
  ): Promise<void>;
}
export interface ExternalWriterRetiredTeamProof {
  readonly teamId: FileObservationStateCheckpoint['fileWriterEpochs'][number]['teamId'];
  readonly identityChecksum: string;
  readonly tombstonedAt: string;
}

export interface ExternalWriterCleanHandoffEligibilityPlan {
  readonly handoffId: string;
  readonly oldCatalogToken: string;
  readonly nextCatalogToken: string;
  readonly retainedRegistrations: readonly {
    readonly scope: ExternalWriterScope;
    readonly fileKey: string;
  }[];
  readonly retirementProofs: readonly ExternalWriterRetiredTeamProof[];
  readonly createdAt: string;
}

export interface ExternalWriterObserverClock {
  nowMs(): number;
  sleep(delayMs: number): Promise<void>;
}
