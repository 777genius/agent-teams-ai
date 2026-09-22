/**
 * Check whether a process with the given PID is still alive.
 *
 * Cross-platform notes:
 * - `process.kill(pid, 0)` sends signal 0 (a no-op probe) on all platforms.
 *   On Windows, Node.js internally calls `OpenProcess()` which works correctly
 *   for same-user processes.
 * - EPERM means the process exists but we lack permission to signal it —
 *   still counts as alive.
 * - ESRCH (Unix) or ERROR_INVALID_PARAMETER (Windows, mapped to ESRCH by
 *   Node.js) means the process does not exist.
 * - On Windows, zombie/defunct processes are not a concern because Windows
 *   cleans up process handles immediately upon exit (no Unix-style zombies).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
    return false;
  }
}
