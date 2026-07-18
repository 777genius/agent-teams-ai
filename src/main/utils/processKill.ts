import { execFile } from 'child_process';
import path from 'path';

const PROCESS_EXIT_WAIT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 50;

/**
 * Kill a process by PID in a cross-platform manner.
 *
 * On Unix: sends SIGTERM, which allows the process to handle the signal gracefully.
 * On Windows: uses `taskkill /T /F /PID` to kill the entire process tree.
 *   - `process.kill(pid, 'SIGTERM')` on Windows does NOT actually send a signal —
 *     it calls TerminateProcess() which is equivalent to SIGKILL (immediate, ungraceful).
 *   - `taskkill /T` also kills child processes, preventing orphaned process trees.
 *
 * On Unix, throws if the process cannot be killed (except ESRCH — process already dead).
 * On Windows, taskkill is best-effort (async fire-and-forget) to match killProcessTree() semantics.
 */
export function killProcessByPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const taskkillPath = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      );
      execFile(taskkillPath, ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => {
        // Best-effort - ignore errors (process may have already exited)
      });
    } catch {
      // taskkill failed to spawn, fall through to process.kill()
      process.kill(pid, 'SIGTERM');
    }
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }
  return !isProcessAlive(pid);
}

function runWindowsTaskkill(pid: number, timeoutMs: number): Promise<Error | null> {
  return new Promise((resolve) => {
    try {
      const taskkillPath = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      );
      execFile(
        taskkillPath,
        ['/T', '/F', '/PID', String(pid)],
        { windowsHide: true, timeout: timeoutMs },
        (error) => resolve(error instanceof Error ? error : null)
      );
    } catch (error) {
      resolve(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Terminate a process and do not report success until the PID is gone.
 * This is intentionally separate from the legacy fire-and-forget helper so
 * lifecycle cleanup can be strict without changing unrelated call sites.
 */
export async function killProcessByPidAndWait(
  pid: number,
  options: {
    signal?: NodeJS.Signals;
    timeoutMs?: number;
    pollIntervalMs?: number;
    platform?: NodeJS.Platform;
    confirmTargetIdentity?: () => boolean | Promise<boolean>;
  } = {}
): Promise<void> {
  const normalizedPid = Math.trunc(pid);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0 || !isProcessAlive(normalizedPid)) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? PROCESS_EXIT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PROCESS_EXIT_POLL_INTERVAL_MS;
  const platform = options.platform ?? process.platform;
  let taskkillError: Error | null = null;

  if (platform === 'win32') {
    taskkillError = await runWindowsTaskkill(normalizedPid, timeoutMs);
    if (!isProcessAlive(normalizedPid)) {
      return;
    }
  }

  if (options.confirmTargetIdentity && !(await options.confirmTargetIdentity())) {
    throw new Error(
      `Process ${normalizedPid} identity changed during cleanup; refusing unsafe direct termination`
    );
  }

  let directKillError: Error | null = null;
  try {
    process.kill(normalizedPid, options.signal ?? 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    directKillError = error instanceof Error ? error : new Error(String(error));
  }

  if (!directKillError && (await waitForProcessExit(normalizedPid, timeoutMs, pollIntervalMs))) {
    return;
  }

  const diagnostics = [
    taskkillError ? `taskkill failed (${taskkillError.message})` : null,
    directKillError ? `direct termination failed (${directKillError.message})` : null,
  ].filter((value): value is string => Boolean(value));
  throw new Error(
    `Process ${normalizedPid} remained alive after cleanup` +
      (diagnostics.length > 0 ? `: ${diagnostics.join('; ')}` : '')
  );
}
