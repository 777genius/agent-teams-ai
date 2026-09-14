export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_EVENT_TYPE_LENGTH = 256;
export const MAX_REVISION_VECTOR_LENGTH = 10_000;
export const MAX_DOMAIN_REPLAY_BATCH_SIZE = 10_000;
export const MAX_COORDINATION_SNAPSHOT_DEPTH = 128;
export const MAX_COORDINATION_SNAPSHOT_NODES = 100_000;
export const MAX_RECONCILIATION_PROCESSED_EVENT_IDS = 10_000;
export const MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES = 256 * 1_024;
export const MAX_COORDINATION_EVENT_PAYLOAD_DEPTH = 64;
export const MAX_COORDINATION_EVENT_PAYLOAD_NODES = 10_000;

export type SnapshotEventHandoffErrorCode =
  | 'unsupported_snapshot_version'
  | 'unsupported_event_version'
  | 'unsupported_recovery_point_version'
  | 'invalid_snapshot_metadata'
  | 'invalid_snapshot_data'
  | 'invalid_coordination_event'
  | 'invalid_replay_limit'
  | 'event_sequence_discontinuity'
  | 'resource_revision_discontinuity'
  | 'resource_revision_regression'
  | 'duplicate_event'
  | 'event_cursor_mismatch'
  | 'journal_watermark_mismatch'
  | 'journal_watermark_regression'
  | 'invalid_recovery_point';

export class SnapshotEventHandoffError extends Error {
  constructor(
    readonly code: SnapshotEventHandoffErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'SnapshotEventHandoffError';
  }
}
