import { execFile } from 'child_process';
import path from 'path';

/**
 * Kill a process by PID in a cross-platform manner.
 *
 * On Unix: sends SIGTERM, which allows the process to handle the signal gracefully.
 * On Windows: uses `taskkill /T /F /PID` to kill the entire process tree.
 *   - `process.kill(pid, 'SIGTERM')` on Windows does NOT actually send a signal —
 *     it calls TerminateProcess() which is equivalent to SIGKILL (immediate, ungraceful).
 *   - `taskkill /T` also kills child processes, preventing orphaned process trees.
 *
 * Throws if the process cannot be killed (except ESRCH — process already dead).
 */
export function killProcessByPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const taskkillPath = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      );
      execFile(taskkillPath, ['/T', '/F', '/PID', String(pid)], () => {
        // Best-effort — ignore errors (process may have already exited)
      });
    } catch {
      // taskkill failed to spawn, fall through to process.kill()
      process.kill(pid, 'SIGTERM');
    }
  } else {
    process.kill(pid, 'SIGTERM');
  }
}
