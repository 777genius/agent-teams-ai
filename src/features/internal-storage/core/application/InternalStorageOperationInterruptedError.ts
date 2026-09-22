/**
 * An RPC failure does not prove that the database operation stopped. This is
 * main-process metadata, never part of the serialized worker protocol.
 */
interface InternalStorageOperationInterruptedErrorConstructor {
  new (
    message: string,
    execution: 'unknown' | 'not_started',
    settled: Promise<void>,
    cause?: unknown
  ): Error & {
    readonly execution: 'unknown' | 'not_started';
    readonly settled: Promise<void>;
  };
}

const internalStorageErrorRegistry = globalThis as typeof globalThis & {
  __agentTeamsInternalStorageOperationInterruptedError?: InternalStorageOperationInterruptedErrorConstructor;
};

/**
 * This error crosses independently loaded main-process modules. Keep one
 * constructor identity even when a test or runtime reloads a feature module.
 */
export const InternalStorageOperationInterruptedError =
  internalStorageErrorRegistry.__agentTeamsInternalStorageOperationInterruptedError ??
  class InternalStorageOperationInterruptedError extends Error {
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
  };

internalStorageErrorRegistry.__agentTeamsInternalStorageOperationInterruptedError =
  InternalStorageOperationInterruptedError;
