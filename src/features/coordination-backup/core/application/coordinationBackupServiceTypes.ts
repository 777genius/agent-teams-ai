import type { BackupRunRecord } from '../../contracts';
import type {
  BackupCoordinationFlushPort,
  BackupIdentityInventoryPort,
  BackupManifestHashPort,
  BackupPublicationPort,
  BackupRunRepository,
  BackupWriterFencePort,
  CoordinationBackupClock,
  CoordinationBackupParticipant,
  ImmutableBackupVerifierPort,
  SqliteOnlineBackupPort,
  SqliteSnapshotIntegrityPort,
} from './ports';

export type CoordinationBackupServiceErrorCode =
  | 'run_not_found'
  | 'run_contract_invalid'
  | 'participant_contract_mismatch'
  | 'backup_fence_busy'
  | 'immutable_verification_failed'
  | 'backup_run_failed'
  | 'backup_run_operator_required'
  | 'fence_completion_failed';

export class CoordinationBackupServiceError extends Error {
  constructor(
    readonly code: CoordinationBackupServiceErrorCode,
    message: string,
    readonly terminalRecord: BackupRunRecord | null = null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'CoordinationBackupServiceError';
  }
}

export class BackupExecutionFault extends Error {
  constructor(
    readonly code: string,
    readonly disposition: 'failed' | 'operator_required',
    readonly safeMessage: string,
    options?: ErrorOptions
  ) {
    super(safeMessage, options);
    this.name = 'BackupExecutionFault';
  }
}

export interface CoordinationBackupServiceDependencies {
  readonly runs: BackupRunRepository;
  readonly writerFence: BackupWriterFencePort;
  readonly coordinationFlush: BackupCoordinationFlushPort;
  readonly identityInventory: BackupIdentityInventoryPort;
  readonly onlineBackup: SqliteOnlineBackupPort;
  readonly sqliteIntegrity: SqliteSnapshotIntegrityPort;
  readonly manifestHash: BackupManifestHashPort;
  readonly publication: BackupPublicationPort;
  readonly immutableVerifier: ImmutableBackupVerifierPort;
  readonly clock: CoordinationBackupClock;
  readonly participants: readonly CoordinationBackupParticipant[];
}
