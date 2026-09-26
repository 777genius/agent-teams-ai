/**
 * Node reports a spawn with a missing `cwd` as `spawn <binary> ENOENT`, which
 * reads exactly like a missing executable. This module turns that case into an
 * explicit working-directory error so callers can tell "the project folder is
 * gone" apart from "the runtime is not installed".
 */
import { isMissingDirectory } from './directoryPresence';

/** Shared prefix; the renderer preflight summary already recognizes it. */
export const WORKING_DIRECTORY_MISSING_MESSAGE_PREFIX = 'Working directory does not exist:';

export class WorkingDirectoryMissingError extends Error {
  /** Kept as ENOENT so existing errno-based handling keeps working. */
  readonly code = 'ENOENT';
  readonly reason = 'working_directory_missing';

  constructor(
    readonly cwd: string,
    options?: { cause?: unknown }
  ) {
    super(`${WORKING_DIRECTORY_MISSING_MESSAGE_PREFIX} ${cwd}`, options);
    this.name = 'WorkingDirectoryMissingError';
  }
}

export function isWorkingDirectoryMissingError(
  error: unknown
): error is WorkingDirectoryMissingError {
  return (
    error instanceof WorkingDirectoryMissingError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { reason?: unknown }).reason === 'working_directory_missing')
  );
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Returns a `WorkingDirectoryMissingError` when a spawn ENOENT was caused by a
 * missing `cwd`; any other error is returned unchanged.
 */
export async function classifyCliSpawnError(
  error: unknown,
  cwd: string | URL | undefined
): Promise<unknown> {
  if (getErrnoCode(error) !== 'ENOENT' || typeof cwd !== 'string' || !cwd.trim()) {
    return error;
  }
  if (isWorkingDirectoryMissingError(error)) {
    return error;
  }
  try {
    if (!(await isMissingDirectory(cwd))) {
      return error;
    }
  } catch {
    // An unreadable folder is not evidence that the project is gone.
    return error;
  }
  return new WorkingDirectoryMissingError(cwd, { cause: error });
}
