import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOSTED_V1_PROCESS_GROUP_TERM_GRACE_MS = 5_000;
const HOSTED_V1_PROCESS_GROUP_KILL_GRACE_MS = 5_000;
const HOSTED_V1_PROCESS_GROUP_POLL_MS = 25;

type HostedV1ProcessGroupSignal = 'SIGKILL' | 'SIGTERM';

export interface HostedV1ForegroundChild {
  readonly pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
}

export type HostedV1ForegroundSpawn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    detached: true;
    env: NodeJS.ProcessEnv;
    stdio: 'inherit';
  }>
) => HostedV1ForegroundChild;

export interface HostedV1ProcessGroupDrainOperations {
  readonly exists: () => boolean;
  readonly send: (signal: HostedV1ProcessGroupSignal) => boolean;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function assertHostedV1ProcessGroupDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`hosted_e2e_process_group_${name}_invalid`);
  }
}

async function waitForHostedV1ProcessGroupExit(input: {
  readonly graceMs: number;
  readonly operations: HostedV1ProcessGroupDrainOperations;
  readonly pollMs: number;
}): Promise<boolean> {
  const now = input.operations.now ?? (() => performance.now());
  const wait =
    input.operations.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error('hosted_e2e_process_group_clock_invalid');
  const deadline = startedAt + input.graceMs;
  if (!Number.isFinite(deadline)) throw new Error('hosted_e2e_process_group_clock_invalid');

  for (;;) {
    if (!input.operations.exists()) return true;
    const observedAt = now();
    if (!Number.isFinite(observedAt)) throw new Error('hosted_e2e_process_group_clock_invalid');
    const remainingMs = Math.max(0, Math.floor(deadline - observedAt));
    if (remainingMs === 0) return false;
    await wait(Math.min(input.pollMs, remainingMs));
  }
}

/**
 * Terminates the complete test-owned process group and does not return until every member has
 * disappeared. This keeps Playwright workers and Chromium descendants from surviving an aborted
 * package-manager wrapper.
 */
export async function drainHostedV1ProcessGroup(input: {
  readonly operations: HostedV1ProcessGroupDrainOperations;
  readonly killGraceMs?: number;
  readonly pollMs?: number;
  readonly termGraceMs?: number;
}): Promise<void> {
  const termGraceMs = input.termGraceMs ?? HOSTED_V1_PROCESS_GROUP_TERM_GRACE_MS;
  const killGraceMs = input.killGraceMs ?? HOSTED_V1_PROCESS_GROUP_KILL_GRACE_MS;
  const pollMs = input.pollMs ?? HOSTED_V1_PROCESS_GROUP_POLL_MS;
  assertHostedV1ProcessGroupDuration(termGraceMs, 'term_grace');
  assertHostedV1ProcessGroupDuration(killGraceMs, 'kill_grace');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error('hosted_e2e_process_group_poll_invalid');
  }

  if (!input.operations.send('SIGTERM')) return;
  if (
    await waitForHostedV1ProcessGroupExit({
      graceMs: termGraceMs,
      operations: input.operations,
      pollMs,
    })
  ) {
    return;
  }
  if (!input.operations.send('SIGKILL')) return;
  if (
    !(await waitForHostedV1ProcessGroupExit({
      graceMs: killGraceMs,
      operations: input.operations,
      pollMs,
    }))
  ) {
    throw new Error('hosted_e2e_process_group_cleanup_failed');
  }
}

function isMissingHostedV1ProcessGroup(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ESRCH'
  );
}

function hostedV1ProcessGroupOperations(
  processGroupId: number
): HostedV1ProcessGroupDrainOperations {
  const signal = (requestedSignal: HostedV1ProcessGroupSignal | 0): boolean => {
    try {
      process.kill(-processGroupId, requestedSignal);
      return true;
    } catch (error) {
      if (isMissingHostedV1ProcessGroup(error)) return false;
      throw error;
    }
  };
  return Object.freeze({
    exists: () => signal(0),
    send: (requestedSignal: HostedV1ProcessGroupSignal) => signal(requestedSignal),
  });
}

function hostedV1SubprocessAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('hosted_e2e_foreground_subprocess_aborted');
}

/** Runs one foreground command in a private POSIX process group with bounded descendant cleanup. */
export function runHostedV1ForegroundSubprocess(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly drainProcessGroup?: (processGroupId: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly spawnProcess?: HostedV1ForegroundSpawn;
  readonly timeoutMs: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    return Promise.reject(new Error('hosted_e2e_subprocess_timeout_invalid'));
  }
  if (input.signal?.aborted === true) {
    return Promise.reject(hostedV1SubprocessAbortReason(input.signal));
  }

  return new Promise<void>((resolveRun, rejectRun) => {
    const spawnProcess: HostedV1ForegroundSpawn =
      input.spawnProcess ??
      ((command, args, options) => spawn(command, [...args], options) as HostedV1ForegroundChild);
    const child = spawnProcess(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      env: input.environment,
      stdio: 'inherit',
    });
    let settled = false;
    let terminationStarted = false;

    const removeListeners = (): void => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const settle = (error: unknown): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      if (error === null) resolveRun();
      else rejectRun(error);
    };
    const drainAndSettle = (result: Error | null): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      const processGroupId = child.pid;
      if (!Number.isSafeInteger(processGroupId) || (processGroupId ?? 0) < 1) {
        settle(result);
        return;
      }
      const drainProcessGroup =
        input.drainProcessGroup ??
        ((groupId: number) =>
          drainHostedV1ProcessGroup({ operations: hostedV1ProcessGroupOperations(groupId) }));
      void drainProcessGroup(processGroupId as number).then(
        () => settle(result),
        (cleanupError: unknown) =>
          settle(
            new AggregateError(
              [result, cleanupError].filter((value) => value !== null),
              'hosted_e2e_foreground_subprocess_cleanup_failed'
            )
          )
      );
    };
    const onAbort = (): void => drainAndSettle(hostedV1SubprocessAbortReason(input.signal!));
    const onError = (error: Error): void => drainAndSettle(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (terminationStarted) return;
      drainAndSettle(
        code === 0 ? null : new Error(`${input.command} exited with ${code ?? signal ?? 'unknown'}`)
      );
    };

    child.once('error', onError);
    child.once('exit', onExit);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => drainAndSettle(new Error(`${input.command} exceeded timeout ${input.timeoutMs}ms`)),
      input.timeoutMs
    );
    if (input.signal?.aborted === true) onAbort();
  });
}
