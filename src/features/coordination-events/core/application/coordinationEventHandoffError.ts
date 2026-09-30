export type CoordinationEventHandoffErrorCode =
  | 'invalid_handoff_options'
  | 'snapshot_retry'
  | 'journal_protocol_error';

export class CoordinationEventHandoffError extends Error {
  constructor(
    readonly code: CoordinationEventHandoffErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CoordinationEventHandoffError';
  }
}
