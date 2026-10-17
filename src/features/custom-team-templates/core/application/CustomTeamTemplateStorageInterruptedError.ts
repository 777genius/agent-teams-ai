/**
 * Feature-owned interruption signal for the custom-team-template storage port.
 *
 * The internal-storage worker rejects an in-flight RPC when the worker dies or
 * a call times out, and that failure does not prove whether the database
 * operation ran. The upstream error class lives in the internal-storage
 * feature's runtime layer, which this feature's `core/` must not import, so
 * main-process composition translates it into this class at the port boundary.
 *
 * The fields carry the same meaning as upstream and are the only information a
 * caller needs to decide between a safe retry and reconciliation:
 * - `execution: 'not_started'` means the request never reached the database, so
 *   retrying the identical request is safe.
 * - `execution: 'unknown'` means the operation may or may not have committed,
 *   so the outcome must be reconciled by stable identity before retrying.
 */
export class CustomTeamTemplateStorageInterruptedError extends Error {
  constructor(
    message: string,
    readonly execution: 'unknown' | 'not_started',
    /** Resolves only when the failed writer can no longer change the database. */
    readonly settled: Promise<void>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'CustomTeamTemplateStorageInterruptedError';
  }
}
