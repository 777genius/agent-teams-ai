export type BackupRunInvariantErrorCode =
  | 'invalid_state'
  | 'invalid_transition'
  | 'missing_transition_evidence'
  | 'invalid_record'
  | 'invalid_artifact_source';

export class BackupRunInvariantError extends Error {
  constructor(
    readonly code: BackupRunInvariantErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'BackupRunInvariantError';
  }
}
