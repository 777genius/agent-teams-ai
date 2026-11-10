import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
/** Original storage exception identity is interpreted only by its consuming Main composition. */
export function internalStorageInterruption(error: unknown) {
  return error instanceof InternalStorageOperationInterruptedError
    ? { execution: error.execution, settled: error.settled }
    : undefined;
}
