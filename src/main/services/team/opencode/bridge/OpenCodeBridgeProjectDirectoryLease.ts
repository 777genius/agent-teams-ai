import { execCli, killProcessTreeAndWait, spawnCli } from '@main/utils/childProcess';
import * as path from 'node:path';

import {
  resolveProjectDirectoryLeaseCwdAtProviderBoundary,
  type ProjectDirectoryLease,
} from '../../provisioning/TeamProvisioningProjectDirectoryLease';

export interface OpenCodeBridgeProcessRunInput {
  binaryPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  canDispatch?: () => boolean;
  projectDirectoryLease?: ProjectDirectoryLease;
  projectDirectoryPath?: string;
}

export interface OpenCodeBridgeProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outcomeUnknownReason?: 'transport_timeout' | 'output_limit' | 'termination_failed';
}

export interface OpenCodeBridgeProcessRunner {
  run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult>;
}

export function assertOpenCodeBridgeProcessDispatchAllowed(input: OpenCodeBridgeProcessRunInput): void {
  if (input.signal?.aborted || input.canDispatch?.() === false) {
    throw abortOpenCodeBridgeCommandDispatch();
  }
}

export function assertOpenCodeBridgeCommandDispatchAllowed(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortOpenCodeBridgeCommandDispatch();
}

export function abortOpenCodeBridgeCommandDispatch(): Error {
  const error = new Error('OpenCode bridge command was cancelled before dispatch.');
  error.name = 'AbortError';
  return error;
}

export async function resolveOpenCodeBridgeProjectDirectoryLeaseDispatch(input: {
  cwd: string;
  signal?: AbortSignal;
  projectDirectoryLease?: ProjectDirectoryLease;
}): Promise<{ cwd: string; envelopeCwd: string }> {
  assertOpenCodeBridgeCommandDispatchAllowed(input.signal);
  const cwd = input.projectDirectoryLease
    ? await resolveProjectDirectoryLeaseCwdAtProviderBoundary(input.projectDirectoryLease, input.cwd)
    : input.cwd;
  assertOpenCodeBridgeCommandDispatchAllowed(input.signal);
  return {
    cwd,
    envelopeCwd: input.projectDirectoryLease ? `/proc/self/fd/${input.projectDirectoryLease.fd}` : input.cwd,
  };
}

export class ExecCliOpenCodeBridgeProcessRunner implements OpenCodeBridgeProcessRunner {
  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    assertOpenCodeBridgeProcessDispatchAllowed(input);
    if (!input.projectDirectoryLease) return this.runWithExecCli(input);
    const lease = input.projectDirectoryLease;
    const cwd = await resolveProjectDirectoryLeaseCwdAtProviderBoundary(
      lease,
      input.projectDirectoryPath ?? input.cwd
    );
    assertOpenCodeBridgeProcessDispatchAllowed(input);
    const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe'];
    while (stdio.length <= lease.fd) stdio.push('ignore');
    stdio[lease.fd] = lease.fd;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminating = false;
      let timer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawnCli> | undefined;
      const onAbort = () => terminate('timeout');
      const settle = (result: OpenCodeBridgeProcessRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (reason: 'timeout' | 'output_limit'): void => {
        if (settled || terminating || !child) return;
        terminating = true;
        // Keep a validated non-null child for these asynchronous callbacks.
        // The mutable outer binding is assigned only after spawn succeeds.
        const spawnedChild = child;
        spawnedChild.stdout?.destroy();
        spawnedChild.stderr?.destroy();
        void killProcessTreeAndWait(spawnedChild, 'SIGKILL').then(
          () =>
            settle({
              stdout,
              stderr,
              exitCode: spawnedChild.exitCode,
              timedOut: true,
              outcomeUnknownReason: reason === 'timeout' ? 'transport_timeout' : 'output_limit',
            }),
          (error: unknown) =>
            settle({
              stdout,
              stderr: [stderr, `Process tree termination failed: ${errorMessage(error)}`]
                .filter(Boolean)
                .join('\n'),
              exitCode: spawnedChild.exitCode,
              timedOut: true,
              outcomeUnknownReason: 'termination_failed',
            })
        );
      };
      try {
        child = spawnCli(input.binaryPath, input.args, { cwd, env: input.env, stdio });
      } catch (error) {
        settle({ stdout, stderr: errorMessage(error), exitCode: null, timedOut: false });
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const limit = stream === 'stdout' ? input.stdoutLimitBytes : input.stderrLimitBytes;
        if (stream === 'stdout') {
          stdoutBytes += Buffer.byteLength(chunk);
          stdout = appendBoundedOutput(stdout, chunk, limit);
          if (stdoutBytes > limit) terminate('output_limit');
        } else {
          stderrBytes += Buffer.byteLength(chunk);
          stderr = appendBoundedOutput(stderr, chunk, limit);
          if (stderrBytes > limit) terminate('output_limit');
        }
      };
      child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
      child.once('error', (error) => {
        if (!terminating) {
          settle({
            stdout,
            stderr: [stderr, error.message].filter(Boolean).join('\n'),
            exitCode: null,
            timedOut: false,
          });
        }
      });
      child.once('close', (code) => {
        if (!terminating) settle({ stdout, stderr, exitCode: code, timedOut: false });
      });
      timer = setTimeout(() => terminate('timeout'), input.timeoutMs);
      timer.unref?.();
    });
  }

  private async runWithExecCli(
    input: OpenCodeBridgeProcessRunInput
  ): Promise<OpenCodeBridgeProcessRunResult> {
    try {
      const result = await execCli(input.binaryPath, input.args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        stdoutMaxBuffer: input.stdoutLimitBytes,
        stderrMaxBuffer: input.stderrLimitBytes,
        env: input.env,
        preferShellForWindowsBatch: shouldPreferShellForOpenCodeBridgeCommand(input.binaryPath, input.args),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        killed?: boolean;
        signal?: string;
        processOutcomeUnknown?: boolean;
        processTerminationError?: string;
      };
      const message = failure.message ?? '';
      const outputLimitExceeded =
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.processOutcomeUnknown === true;
      const timedOut =
        outputLimitExceeded ||
        failure.killed === true ||
        failure.signal === 'SIGTERM' ||
        /timed out|timeout/i.test(message);
      const stderr = [stringFromBuffer(failure.stderr) || message, failure.processTerminationError
        ? `Process termination failed: ${failure.processTerminationError}`
        : ''].filter(Boolean).join('\n');
      return {
        stdout: stringFromBuffer(failure.stdout),
        stderr,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        timedOut,
        outcomeUnknownReason: failure.processTerminationError
          ? 'termination_failed'
          : outputLimitExceeded
            ? 'output_limit'
            : timedOut
              ? 'transport_timeout'
              : undefined,
      };
    }
  }
}

function appendBoundedOutput(existing: string, chunk: Buffer | string, limitBytes: number): string {
  const retained = Buffer.byteLength(existing);
  if (retained >= limitBytes) return existing;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let appended = bytes.subarray(0, limitBytes - retained).toString();
  while (appended && Buffer.byteLength(existing) + Buffer.byteLength(appended) > limitBytes) {
    appended = appended.slice(0, -1);
  }
  return `${existing}${appended}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringFromBuffer(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function shouldPreferShellForOpenCodeBridgeCommand(binaryPath: string, args: string[]): boolean {
  if (process.platform !== 'win32') return false;
  const extension = path.win32.extname(binaryPath).toLowerCase();
  return (
    ['.cmd', '.bat'].includes(extension) &&
    args[0] === 'runtime' &&
    args[1] === 'opencode-command'
  );
}
