import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** Native Windows process-stop adapter wired by the provisioning composition root. */
const WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS = 15_000;

/**
 * Drain the original teammate's tool descendants before signalling its root.
 * Its retained libuv ChildProcess handle prevents a recycled PID being adopted.
 */
function stopOriginalWindowsMemberTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error('Original Windows member process handle has no valid PID'));
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const taskkillPath = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe'
    );
    execFile(
      taskkillPath,
      ['/T', '/F', '/PID', String(pid)],
      { windowsHide: true, timeout: WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS },
      (error) => {
        if (error) {
          reject(
            new Error('Original Windows teammate process-tree termination not confirmed', {
              cause: error,
            })
          );
        } else {
          resolve();
        }
      }
    );
  });
}

/** Kill by the original ChildProcess handle; a recycled PID never grants authority. */
function killOriginalWindowsDirectMember(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error('Original Windows member process handle has no valid PID'));
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = () => finish(new Error('Original Windows teammate process failed on exit'));
    const timer = setTimeout(() =>
      finish(new Error('Original Windows teammate exit not confirmed')),
      WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS
    );
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      // Node/libuv targets this original process handle on Windows, never a
      // later process which might have acquired the same integer PID.
      // taskkill /T may have already terminated this process while libuv has
      // not emitted 'exit' yet. A refused handle signal must still await that
      // event or the bounded timeout; it is not evidence of a live process.
      child.kill('SIGKILL');
    } catch {
      finish(new Error('Original Windows teammate handle signal failed'));
    }
  });
}

/**
 * Await tree stop before original-handle fallback. Even when the tree attempt
 * fails, retire every owned handle and propagate the failure: an orphaned tool
 * may still be running, so Stop cannot report success.
 */
async function stopWindowsMemberTreeThenHandle(
  child: ChildProcess,
  stopTree: (child: ChildProcess) => Promise<void>
): Promise<void> {
  let treeError: unknown;
  try {
    await stopTree(child);
  } catch (error) {
    treeError = error;
  }
  let handleError: unknown;
  try {
    await killOriginalWindowsDirectMember(child);
  } catch (error) {
    handleError = error;
  }
  if (treeError && handleError) {
    throw new AggregateError([treeError, handleError], 'Windows teammate stop unconfirmed');
  }
  if (treeError) throw treeError;
  if (handleError) throw handleError;
}

/** Independent stop attempts: one uncooperative member must not spare another. */
export async function stopOriginalWindowsDirectMembers(
  processes: ReadonlySet<ChildProcess> | undefined,
  platform: NodeJS.Platform = process.platform,
  stopTree: (child: ChildProcess) => Promise<void> = stopOriginalWindowsMemberTree
): Promise<void> {
  if (platform !== 'win32' || !processes?.size) return;
  const results = await Promise.allSettled(
    [...processes].map((child) => stopWindowsMemberTreeThenHandle(child, stopTree))
  );
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (firstFailure) throw firstFailure.reason;
}

