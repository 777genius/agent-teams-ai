/**
 * An RPC failure does not prove that the database operation stopped. This is
 * main-process metadata, never part of the serialized worker protocol.
 */
export interface InternalStorageOperationInterruptedError extends Error {
  readonly execution: 'unknown' | 'not_started';
  readonly settled: Promise<void>;
}

type InternalStorageOperationInterruptedErrorConstructor = new (
    message: string,
    execution: 'unknown' | 'not_started',
    settled: Promise<void>,
    cause?: unknown
  ) => InternalStorageOperationInterruptedError;

const internalStorageErrorRegistry = globalThis as typeof globalThis & {
  __agentTeamsInternalStorageOperationInterruptedError?: InternalStorageOperationInterruptedErrorConstructor;
};

/**
 * This error crosses independently loaded main-process modules. Keep one
 * constructor identity even when a test or runtime reloads a feature module.
 */
class InternalStorageOperationInterruptedErrorImplementation extends Error {
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

export const InternalStorageOperationInterruptedError =
  internalStorageErrorRegistry.__agentTeamsInternalStorageOperationInterruptedError ??
  InternalStorageOperationInterruptedErrorImplementation;

internalStorageErrorRegistry.__agentTeamsInternalStorageOperationInterruptedError =
  InternalStorageOperationInterruptedError;
