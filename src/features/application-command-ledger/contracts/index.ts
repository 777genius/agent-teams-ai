export enum ApplicationCommandLedgerStatus {
  Started = 'started',
  Completed = 'completed',
  FailedRetryable = 'failed_retryable',
  FailedTerminal = 'failed_terminal',
  UnknownAfterTimeout = 'unknown_after_timeout',
}

export enum ApplicationCommandFailureKind {
  Retryable = 'retryable',
  Terminal = 'terminal',
  UnknownAfterTimeout = 'unknown_after_timeout',
}

export enum ApplicationCommandBeginOutcome {
  Started = 'started',
  RetryStarted = 'retry_started',
  DuplicateCompleted = 'duplicate_completed',
  AlreadyStarted = 'already_started',
  FailedTerminal = 'failed_terminal',
  UnknownAfterTimeout = 'unknown_after_timeout',
  Conflict = 'conflict',
}

export enum ApplicationCommandConflictReason {
  CommandIdReused = 'command_id_reused',
  IdempotencyKeyReused = 'idempotency_key_reused',
  OperationMismatch = 'operation_mismatch',
  PayloadHashMismatch = 'payload_hash_mismatch',
}

export enum ApplicationCommandRunOutcome {
  Executed = 'executed',
  Reconciled = 'reconciled',
  Retried = 'retried',
  Replayed = 'replayed',
}

export enum ApplicationCommandLedgerErrorCode {
  AlreadyStarted = 'already_started',
  CompletedResultInvalid = 'completed_result_invalid',
  CompletedResultMissing = 'completed_result_missing',
  Conflict = 'conflict',
  FailedTerminal = 'failed_terminal',
  InvalidInput = 'invalid_input',
  RecordNotFound = 'record_not_found',
  StoreRejected = 'store_rejected',
  UnknownOutcome = 'unknown_outcome',
}

export interface ApplicationCommandIdentity<TOperation extends string = string> {
  namespace: string;
  scopeKey: string;
  commandId: string;
  idempotencyKey: string;
  operation: TOperation;
}

export interface ApplicationCommandLedgerRecord<
  TOperation extends string = string,
> extends ApplicationCommandIdentity<TOperation> {
  payloadHash: string;
  status: ApplicationCommandLedgerStatus;
  failureKind: ApplicationCommandFailureKind | null;
  retryable: boolean;
  attemptCount: number;
  resultHash: string | null;
  resultJson: string | null;
  metadataJson: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface ApplicationCommandLedgerBeginRequest<
  TOperation extends string = string,
> extends ApplicationCommandIdentity<TOperation> {
  payloadHash: string;
  metadataJson: string | null;
  nowIso: string;
  /** A matching started attempt older than this is fenced as unknown before reconciliation. */
  startedStaleAfterMs: number;
}

export type ApplicationCommandLedgerBeginResult<TOperation extends string = string> =
  | {
      outcome: ApplicationCommandBeginOutcome.Started;
      record: ApplicationCommandLedgerRecord<TOperation>;
    }
  | {
      outcome: ApplicationCommandBeginOutcome.RetryStarted;
      record: ApplicationCommandLedgerRecord<TOperation>;
    }
  | {
      outcome: ApplicationCommandBeginOutcome.DuplicateCompleted;
      record: ApplicationCommandLedgerRecord<TOperation>;
    }
  | {
      outcome:
        | ApplicationCommandBeginOutcome.AlreadyStarted
        | ApplicationCommandBeginOutcome.FailedTerminal
        | ApplicationCommandBeginOutcome.UnknownAfterTimeout;
      record: ApplicationCommandLedgerRecord<TOperation>;
    }
  | {
      outcome: ApplicationCommandBeginOutcome.Conflict;
      reason: ApplicationCommandConflictReason;
      existing: ApplicationCommandLedgerRecord<TOperation> | null;
      requested: ApplicationCommandLedgerBeginRequest<TOperation>;
    };

export interface ApplicationCommandLedgerCompleteRequest {
  namespace: string;
  scopeKey: string;
  commandId: string;
  attemptCount: number;
  resultHash: string;
  resultJson: string;
  completedAtIso: string;
}

export interface ApplicationCommandLedgerFailRequest {
  namespace: string;
  scopeKey: string;
  commandId: string;
  attemptCount: number;
  failureKind: ApplicationCommandFailureKind;
  errorMessage: string;
  completedAtIso: string;
}

export interface ApplicationCommandLedgerReadByCommandIdRequest {
  namespace: string;
  scopeKey: string;
  commandId: string;
}

export interface ApplicationCommandLedgerReadByIdempotencyKeyRequest {
  namespace: string;
  scopeKey: string;
  idempotencyKey: string;
}

export interface ApplicationCommandLedgerListScopeRequest {
  namespace: string;
  scopeKey: string;
}

export interface ApplicationCommandErrorClassification {
  failureKind: ApplicationCommandFailureKind;
  message?: string;
}

export * from './durableCommandProtocol';
