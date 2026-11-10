/**
 * An RPC failure does not prove that the database operation stopped. This is
 * main-process metadata, never part of the serialized worker protocol.
 */
export class InternalStorageOperationInterruptedError extends Error {
  constructor(
    message: string,
    readonly execution: 'unknown' | 'not_started',
    /** Resolves only when the failed writer can no longer change the database. */
    readonly settled: Promise<void>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'InternalStorageOperationInterruptedError';
  }
}
