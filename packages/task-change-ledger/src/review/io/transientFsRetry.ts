/**
 * One home for "this filesystem error is worth retrying, and this is how long
 * to wait before trying again".
 *
 * Windows refuses a rename while any process still holds a handle on the path
 * or anywhere inside the tree - a file watcher, antivirus, the search indexer,
 * or a child that was just killed but whose handles the kernel has not
 * reclaimed yet. The refusal surfaces as EPERM, EACCES or EBUSY depending on
 * which layer said no (EACCES is at least as common as EPERM for a file another
 * process has open), and it usually clears within a few hundred milliseconds.
 *
 * This module is deliberately a leaf: it imports nothing, so both
 * atomicWrite.ts and durablePathOperations.ts can depend on it even though
 * atomicWrite.ts re-exports durablePathOperations.ts.
 */

const TRANSIENT_FS_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const PUBLISH_MAX_ATTEMPTS = 20;
const PUBLISH_BASE_DELAY_MS = 40;
const PUBLISH_MAX_DELAY_MS = 250;
const PUBLISH_JITTER_MS = 25;

const TREE_MAX_ATTEMPTS = 6;
const TREE_BASE_DELAY_MS = 150;
const TREE_MAX_DELAY_MS = 1_000;

export function isTransientFsErrorCode(code: string | undefined | null): boolean {
  return typeof code === 'string' && TRANSIENT_FS_ERROR_CODES.has(code);
}

export interface TransientFsRetryPolicy {
  /** Total number of attempts, the first one included. */
  maxAttempts: number;
  /** How long to wait after the given 1-based attempt failed. */
  delayMs: (attempt: number) => number;
}

/**
 * Publishing one file over another. Many short attempts, jittered so that
 * concurrent publishers of neighbouring files do not line up on the same
 * retry beat.
 */
export const RENAME_PUBLISH_RETRY: TransientFsRetryPolicy = {
  maxAttempts: PUBLISH_MAX_ATTEMPTS,
  delayMs: (attempt) =>
    Math.min(PUBLISH_BASE_DELAY_MS * attempt, PUBLISH_MAX_DELAY_MS) +
    Math.floor(Math.random() * (PUBLISH_JITTER_MS + 1)),
};

/**
 * Detaching a whole directory tree from its public name, or renaming it back.
 * Fewer, longer attempts: the caller is a user-visible destructive action, so
 * the total wait is bounded at 2.25 s and then the error is reported rather
 * than retried into a hang.
 */
export const RENAME_TREE_RETRY: TransientFsRetryPolicy = {
  maxAttempts: TREE_MAX_ATTEMPTS,
  delayMs: (attempt) => Math.min(TREE_BASE_DELAY_MS * attempt, TREE_MAX_DELAY_MS),
};

/**
 * Run an operation, retrying only while it fails with a transient code and
 * attempts remain. The error that reaches the caller is always the last one the
 * operation produced, never a wrapper, so existing ENOENT/EEXIST branches at
 * the call site keep working.
 */
export async function retryOnTransientFsError<T>(
  operation: () => Promise<T>,
  policy: TransientFsRetryPolicy
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isTransientFsErrorCode(code) || attempt >= policy.maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, policy.delayMs(attempt)));
    }
  }
}
