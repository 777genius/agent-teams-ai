export type ReferenceLoadErrorCode =
  | 'reference_count_exceeded'
  | 'reference_item_bytes_exceeded'
  | 'reference_total_bytes_exceeded'
  | 'reference_load_cancelled'
  | 'reference_source_failed'
  | 'reference_source_result_invalid';

export class ReferenceLoadError extends Error {
  readonly name = 'ReferenceLoadError';

  constructor(
    readonly code: ReferenceLoadErrorCode,
    readonly limit?: number,
    readonly observed?: number
  ) {
    super(code);
  }
}

export class OperationsRecordingCancelledError extends Error {
  readonly name = 'OperationsRecordingCancelledError';
  readonly code = 'operation_recording_cancelled' as const;

  constructor() {
    super('operation_recording_cancelled');
  }
}
