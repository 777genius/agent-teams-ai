import { isOwnedWindowsTeamRuntimeWrapperProcess } from './TeamProvisioningWindowsRuntimeLauncher';

import type { ChildProcess } from 'node:child_process';

/** Native Windows process-stop adapter wired by the provisioning composition root. */
const WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS = 15_000;

/**
 * The separately staged teammate.exe owns a KILL_ON_JOB_CLOSE Windows Job.
 * Killing the original wrapper through libuv's process HANDLE closes that Job,
 * retiring its descendants. PID-only taskkill /T /PID can race PID reuse and
 * terminate an unrelated process tree; never use it as kill authority.
 */
function verifyOwnedWindowsMemberTree(child: ChildProcess): Promise<void> {
  // Exit alone does not establish tree containment for a never-wrapped runtime.
  if (!isOwnedWindowsTeamRuntimeWrapperProcess(child)) {
    return Promise.reject(new Error('Original Windows teammate lacks verified owned Job wrapper'));
  }
  return Promise.resolve();
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
      // An already-terminating native handle still needs its exit event or a
      // bounded timeout; a refused signal alone proves no termination.
      child.kill('SIGKILL');
    } catch {
      finish(new Error('Original Windows teammate handle signal failed'));
    }
  });
}

/**
 * Verify owned Job custody before signalling the original handle.
 * On missing custody, still retire the direct handle but fail closed:
 * descendant cleanup cannot be reported successful.
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
  if (treeError instanceof Error) throw treeError;
  if (treeError) throw new Error('Windows teammate custody check failed', { cause: treeError });
  if (handleError instanceof Error) throw handleError;
  if (handleError) throw new Error('Windows teammate handle stop failed', { cause: handleError });
}

/** Independent stop attempts: one uncooperative member must not spare another. */
export async function stopOriginalWindowsDirectMembers(
  processes: ReadonlySet<ChildProcess> | undefined,
  platform: NodeJS.Platform = process.platform,
  stopTree: (child: ChildProcess) => Promise<void> = verifyOwnedWindowsMemberTree
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
