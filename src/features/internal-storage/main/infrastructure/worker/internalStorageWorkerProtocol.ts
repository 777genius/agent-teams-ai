import type {
  CommentJournalEntryRecord,
  StallJournalEntryRecord,
} from '../../../contracts/internalStorageContracts';
import type { TeamRosterSnapshotRecord } from '../../../contracts/teamRosterStorageContracts';
import type {
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandPersistClaimRequest,
} from '@features/application-command-ledger';
import type {
  BackupFenceCompletionDisposition,
  BackupRunRecord,
  BackupRunState,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotRequest } from '@features/coordination-events';
import type {
  CoordinationEventActor,
  CoordinationEventDraft,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';
import type { TeamId } from '@shared/contracts/hosted';

export interface InternalStorageWorkerData {
  databasePath: string;
}

export type ApplicationCommandLedgerWorkerOp =
  | 'appCommandLedger.begin'
  | 'appCommandLedger.markCompleted'
  | 'appCommandLedger.markFailed'
  | 'appCommandLedger.getByCommandId'
  | 'appCommandLedger.getByIdempotencyKey'
  | 'appCommandLedger.listByScope'
  | 'appCommandLedger.durable.claim'
  | 'appCommandLedger.durable.getStatus'
  | 'appCommandLedger.durable.getByClaim'
  | 'appCommandLedger.durable.renewAttemptLease'
  | 'appCommandLedger.durable.transitionCommand'
  | 'appCommandLedger.durable.transitionEffect'
  | 'appCommandLedger.durable.commit'
  | 'appCommandLedger.durable.listOutbox'
  | 'appCommandLedger.durable.claimOutbox'
  | 'appCommandLedger.durable.acknowledgeOutboxDelivery'
  | 'appCommandLedger.durable.applyConsumerEvent'
  | 'appCommandLedger.durable.getConsumerProjection';

/** Payloads whose durable envelope semantics must remain typed across IPC. */
export interface ApplicationCommandLedgerWorkerPayloadByOp {
  'appCommandLedger.durable.claim': DurableApplicationCommandPersistClaimRequest & {
    /**
     * Internal trusted attribution supplied by an owning command composition.
     * Existing public command DTOs remain unchanged; absent values are stored
     * with explicit recovery/legacy provenance and never promoted to operator.
     */
    readonly coordinationAttribution?: StoredCommandCoordinationAttribution;
  };
  'appCommandLedger.durable.commit': DurableApplicationCommandCommitRequest;
  'appCommandLedger.durable.applyConsumerEvent': DurableApplicationCommandConsumerApplyRequest;
  'appCommandLedger.durable.getConsumerProjection': DurableApplicationCommandConsumerProjectionRequest;
}

export interface StoredCommandCoordinationAttribution {
  readonly actor: Exclude<CoordinationEventActor, { readonly kind: 'external_file' }>;
  readonly runId?: string;
  readonly provenance: 'trusted_context_v1' | 'legacy_recovery_v1';
}

type TypedApplicationCommandLedgerWorkerRequest = {
  [TOp in keyof ApplicationCommandLedgerWorkerPayloadByOp]: {
    id: string;
    op: TOp;
    payload: ApplicationCommandLedgerWorkerPayloadByOp[TOp];
  };
}[keyof ApplicationCommandLedgerWorkerPayloadByOp];

interface UntypedApplicationCommandLedgerWorkerRequest {
  id: string;
  op: Exclude<ApplicationCommandLedgerWorkerOp, keyof ApplicationCommandLedgerWorkerPayloadByOp>;
  payload: unknown;
}

export interface StoredEventJournalMetadata {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly retentionFloorSequence: number;
  readonly highWatermarkSequence: number;
}

export interface StoredCoordinationEventRow {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventSequence: number;
  readonly eventId: string;
  readonly bodyJson: string;
}

export interface StoredSnapshotRetentionLease {
  readonly leaseId: string;
  readonly watermark: StoredEventJournalMetadata;
  readonly deadlineAtMs: number;
}

export interface StoredSnapshotRetentionLeaseUse {
  readonly active: boolean;
  readonly watermark: StoredEventJournalMetadata;
}

export interface CoordinationDrainStorageEvidence {
  readonly backupRunId: string;
  readonly fenceGeneration: number;
  readonly throughCommandSequence: number;
  readonly throughEventSequence: number;
  readonly eventEpoch: string;
  readonly durableBarrier: string;
}

export interface SqliteOnlineBackupStorageResult {
  readonly status: 'completed' | 'busy_timeout' | 'deadline_exceeded' | 'source_corrupt';
  readonly applicationId?: number;
  readonly userVersion?: number;
  readonly byteLength?: number;
  readonly mode?: number;
  readonly sha256?: string;
}

export interface SqliteBackupChunkStorageResult {
  readonly offset: number;
  readonly totalByteLength: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

export type SqliteSnapshotVerificationStorageResult =
  | {
      readonly status: 'valid';
      readonly applicationId: number;
      readonly userVersion: number;
      readonly requiredTables: readonly string[];
    }
  | {
      readonly status: 'invalid';
      readonly reason:
        | 'integrity_check_failed'
        | 'application_id_mismatch'
        | 'schema_mismatch'
        | 'migration_incomplete'
        | 'required_identity_missing';
    };

export interface CoordinationDurabilityWorkerPayloadByOp {
  'coordinationEvents.initialize': {
    readonly deploymentId: string;
    readonly eventEpoch?: string;
    readonly nowIso: string;
  };
  'coordinationEvents.getWatermark': { readonly deploymentId: string };
  'coordinationEvents.read': {
    readonly deploymentId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  };
  'coordinationEvents.append': {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly draft: CoordinationEventDraft<CoordinationJsonValue>;
    readonly bodyJson: string;
    readonly nowIso: string;
  };
  'coordinationEvents.prune': {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly throughSequence: number;
    readonly nowMs: number;
    readonly nowIso: string;
  };
  'coordinationEvents.lease.acquire': {
    readonly deploymentId: string;
    readonly leaseId: string;
    readonly request: CoordinationSnapshotRequest;
    readonly nowMs: number;
    readonly deadlineAtMs: number;
  };
  'coordinationEvents.lease.beginUse': {
    readonly leaseId: string;
    readonly useToken: string;
    readonly nowMs: number;
  };
  'coordinationEvents.lease.endUse': {
    readonly leaseId: string;
    readonly useToken: string;
  };
  'coordinationEvents.lease.release': { readonly leaseId: string };
  'coordinationBackupRuns.create': { readonly record: BackupRunRecord };
  'coordinationBackupRuns.get': { readonly backupRunId: string };
  'coordinationBackupRuns.listRecoverable': Record<string, never>;
  'coordinationBackupRuns.compareAndSet': {
    readonly backupRunId: string;
    readonly expectedRevision: number;
    readonly expectedState: BackupRunState;
    readonly record: BackupRunRecord;
  };
  'coordinationBackupFence.acquire': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly expectedGeneration: number | null;
    readonly leaseId: string;
    readonly acquiredAt: string;
  };
  'coordinationBackupFence.complete': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly disposition: BackupFenceCompletionDisposition;
    readonly completedAt: string;
  };
  'coordinationBackupFlush.drain': {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  };
  'coordinationBackupFlush.capture': {
    readonly deploymentId: string;
    readonly evidence: CoordinationDrainStorageEvidence;
  };
  'coordinationBackup.sqlite.online': {
    readonly backupRunId: string;
    readonly deadlineAtMs: number;
    readonly busyRetryMs: number;
    readonly pagesPerStep: number;
  };
  'coordinationBackup.sqlite.verify': {
    readonly backupRunId: string;
  };
  'coordinationBackup.sqlite.readChunk': {
    readonly backupRunId: string;
    readonly offset: number;
    readonly maximumBytes: number;
  };
  'coordinationBackup.sqlite.discard': { readonly backupRunId: string };
}

type TypedCoordinationDurabilityWorkerRequest = {
  [TOp in keyof CoordinationDurabilityWorkerPayloadByOp]: {
    id: string;
    op: TOp;
    payload: CoordinationDurabilityWorkerPayloadByOp[TOp];
  };
}[keyof CoordinationDurabilityWorkerPayloadByOp];

export type InternalStorageWorkerRequest =
  | { id: string; op: 'ping'; payload: Record<string, never> }
  | { id: string; op: 'stallJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'stallJournal.replace';
      payload: { teamName: string; entries: StallJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.load'; payload: { teamName: string } }
  | {
      id: string;
      op: 'commentJournal.replace';
      payload: { teamName: string; entries: CommentJournalEntryRecord[] };
    }
  | { id: string; op: 'commentJournal.exists'; payload: { teamName: string } }
  | { id: string; op: 'commentJournal.ensureInitialized'; payload: { teamName: string } }
  | {
      id: string;
      op: 'storeImports.record';
      payload: { storeId: string; teamName: string; entryCount: number };
    }
  | {
      id: string;
      op: 'storeImports.has';
      payload: { storeId: string; teamName: string };
    }
  | { id: string; op: 'teamIdentity.list'; payload: Record<string, never> }
  | { id: string; op: 'teamIdentity.get'; payload: { teamId: TeamId } }
  | { id: string; op: 'teamRoster.get'; payload: { teamId: TeamId } }
  | { id: string; op: 'teamRoster.adopt'; payload: { roster: TeamRosterSnapshotRecord } }
  // Member-work-sync ops share one wire shape; the typed client methods and
  // the worker-side dispatcher (memberWorkSyncWorkerOps) own the payloads.
  | TypedApplicationCommandLedgerWorkerRequest
  | TypedCoordinationDurabilityWorkerRequest
  | UntypedApplicationCommandLedgerWorkerRequest
  | { id: string; op: `mws.${string}`; payload: unknown }
  | { id: string; op: 'close'; payload: Record<string, never> };

export type InternalStorageWorkerOp = InternalStorageWorkerRequest['op'];

interface JournalReplacePayloadByOp {
  'stallJournal.replace': { teamName: string; entries: StallJournalEntryRecord[] };
  'commentJournal.replace': { teamName: string; entries: CommentJournalEntryRecord[] };
}

/**
 * Runtime-checks the team-isolation invariant before a replace operation can
 * delete any rows. TypeScript cannot guarantee that every entry's embedded
 * teamName agrees with the payload teamName after the worker-thread hop.
 */
export function parseJournalReplacePayload<TOp extends keyof JournalReplacePayloadByOp>(
  op: TOp,
  payload: unknown
): JournalReplacePayloadByOp[TOp] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Invalid ${op} payload: expected an object`);
  }

  const candidate = payload as { teamName?: unknown; entries?: unknown };
  if (typeof candidate.teamName !== 'string') {
    throw new Error(`Invalid ${op} payload: teamName must be a string`);
  }
  if (!Array.isArray(candidate.entries)) {
    throw new Error(`Invalid ${op} payload: entries must be an array`);
  }

  for (const [index, entry] of candidate.entries.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid ${op} payload: entries[${index}] must be an object`);
    }
    const entryTeamName = (entry as { teamName?: unknown }).teamName;
    if (entryTeamName !== candidate.teamName) {
      throw new Error(
        `Invalid ${op} payload: entries[${index}].teamName must match payload teamName`
      );
    }
  }

  return candidate as JournalReplacePayloadByOp[TOp];
}

export type InternalStorageWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
