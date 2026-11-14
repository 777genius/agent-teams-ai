import {
  buildWindowsShellFallbackCommand,
  isWindowsBatchLauncher,
  resolveDirectWindowsLauncher,
} from '@agent-teams/legacy-agent-host/owned-process';
import {
  type ChildProcess,
  execFile,
  type ExecFileOptions,
  spawn,
  type SpawnOptions,
} from 'child_process';
import path from 'path';

export { quoteWindowsCmdArg } from '@agent-teams/legacy-agent-host/owned-process';

import {
  getOwnedUnixProcessGroup,
  recordOwnedUnixProcessGroup,
  recordVerifiedCliProcessRelease,
} from './cliProcessCustody';
import { withCliProcessDefaults } from './cliProcessDefaults';
import { classifyCliSpawnError } from './cliWorkingDirectory';
import { execFileWithLinuxChildLaunch, remainingLinuxChildLaunchTime, spawnWithLinuxChildLaunch } from './linuxChildLaunch';
import { isLinuxChildLaunchFailure } from './linuxChildLaunchSelection';
import {
  isSameUnixProcessIdentity,
  readUnixProcessTable,
  tryReadUnixProcessTable,
  type UnixProcessIdentity,
} from './unixProcessTable';

const EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT = 128 * 1024;
const EXEC_CLI_NATIVE_MAX_BUFFER_HEADROOM_BYTES = 1024 * 1024;
const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 10_000;
const UNIX_PROCESS_TREE_EXIT_TIMEOUT_MS = 5_000;
const UNIX_PROCESS_TREE_EXIT_POLL_MS = 25;

function boundExecCliTimeoutOutput(text: string): string {
  if (text.length <= EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT) {
    return text;
  }
  const marker = '...[truncated execCli timeout output]';
  if (EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT <= marker.length) {
    return text.slice(-EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT);
  }
  const retainedChars = EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT - marker.length;
  const headChars = Math.floor(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

/**
 * Promise wrapper for execFile that always returns { stdout, stderr }.
 * Unlike promisify(execFile), this works correctly with mocked execFile
 * (promisify relies on a custom symbol that mocks don't have).
 */
function execFileAsync(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {},
  outputLimits: { stdoutMaxBuffer?: number; stderrMaxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const entered = performance.now();
    const { timeout, killSignal, signal, maxBuffer, ...baseExecOptions } = options;
    const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout : 0;
    const legacyOutputLimitBytes =
      typeof maxBuffer === 'number' && Number.isFinite(maxBuffer) && maxBuffer > 0
        ? Math.trunc(maxBuffer)
        : 0;
    const normalizeOutputLimit = (value: number | undefined): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : legacyOutputLimitBytes;
    const stdoutLimitBytes = normalizeOutputLimit(outputLimits.stdoutMaxBuffer);
    const stderrLimitBytes = normalizeOutputLimit(outputLimits.stderrMaxBuffer);
    const nativeOutputLimitBytes = Math.max(stdoutLimitBytes, stderrLimitBytes);
    // Node kills only the immediate execFile child when its native maxBuffer is
    // exceeded. Keep bounded headroom and enforce the caller's limit ourselves
    // while the launcher PID is still available for process-tree cleanup.
    const execOptions: ExecFileOptions =
      nativeOutputLimitBytes > 0
        ? {
            ...baseExecOptions,
            maxBuffer: Math.min(
              Number.MAX_SAFE_INTEGER,
              Math.max(
                nativeOutputLimitBytes * 2,
                nativeOutputLimitBytes + EXEC_CLI_NATIVE_MAX_BUFFER_HEADROOM_BYTES
              )
            ),
          }
        : maxBuffer === undefined
          ? baseExecOptions
          : { ...baseExecOptions, maxBuffer };
    const timeoutSignal = normalizeKillSignal(killSignal);
    let child: ChildProcess | null = null;
    let handoffCleanup: Promise<void> | undefined;
    let settled = false;
    let stdoutText = '';
    let stderrText = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      timeoutHandle = cleanupTimedCliProcess(child, timeoutHandle);
      signal?.removeEventListener('abort', handleAbort);
    };
    const rejectAfterProcessTreeTermination = (error: Error): void => {
      void (handoffCleanup ?? killProcessTreeAndWait(child, timeoutSignal)).then(
        () => reject(error),
        (terminationError) => {
          Object.assign(error, {
            processTerminationError:
              terminationError instanceof Error
                ? terminationError.message
                : String(terminationError),
          });
          reject(error);
        }
      );
    };
    const rejectAborted = (): void => {
      const error = new Error(`Command aborted: ${cmd} ${args.join(' ')}`);
      error.name = 'AbortError';
      Object.assign(error, {
        killed: true,
        signal: timeoutSignal,
        stdout: stdoutText,
        stderr: stderrText,
      });
      rejectAfterProcessTreeTermination(error);
    };
    const handleAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectAborted();
    };
    const rejectOutputOverflow = (stream: 'stdout' | 'stderr'): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const error = new RangeError(`${stream} maxBuffer length exceeded`);
      Object.assign(error, {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
        signal: timeoutSignal,
        processOutcomeUnknown: true,
        stdout: stdoutText,
        stderr: stderrText,
      });
      rejectAfterProcessTreeTermination(error);
    };
    if (signal?.aborted) {
      settled = true;
      rejectAborted();
      return;
    }
    child = execFileWithLinuxChildLaunch(cmd, args, execOptions, (err, stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (err) {
        const normalizedError =
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
        Object.assign(normalizedError, {
          stdout: String(stdout),
          stderr: String(stderr),
        });
        if (isLinuxChildLaunchFailure(err) ||
            (err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          Object.assign(normalizedError, {
            killed: true,
            signal: timeoutSignal,
            processOutcomeUnknown: true,
          });
          rejectAfterProcessTreeTermination(normalizedError);
        } else {
          reject(normalizedError);
        }
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    }, timeoutMs > 0 ? entered + timeoutMs : undefined, (originalChild) => {
      handoffCleanup ??= killProcessTreeAndWait(originalChild, timeoutSignal);
      return handoffCleanup;
    });
    if (!settled) {
      trackCliProcess(child);
      signal?.addEventListener('abort', handleAbort, { once: true });
      if (timeoutMs > 0 || signal || stdoutLimitBytes > 0 || stderrLimitBytes > 0) {
        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (settled) {
            return;
          }
          const text = chunk.toString();
          stdoutBytes += Buffer.byteLength(text);
          stdoutText = boundExecCliTimeoutOutput(stdoutText + text);
          if (stdoutLimitBytes > 0 && stdoutBytes > stdoutLimitBytes) {
            rejectOutputOverflow('stdout');
          }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (settled) {
            return;
          }
          const text = chunk.toString();
          stderrBytes += Buffer.byteLength(text);
          stderrText = boundExecCliTimeoutOutput(stderrText + text);
          if (stderrLimitBytes > 0 && stderrBytes > stderrLimitBytes) {
            rejectOutputOverflow('stderr');
          }
        });
      }
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          const error = new Error(
            `Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`
          );
          Object.assign(error, {
            killed: true,
            signal: timeoutSignal,
            stdout: stdoutText,
            stderr: stderrText,
          });
          rejectAfterProcessTreeTermination(error);
        }, remainingLinuxChildLaunchTime(child, timeoutMs, entered));
        timeoutHandle.unref?.();
      }
    }
  });
}

/**
 * With `/s`, cmd.exe parses its /c argument by stripping only the first and
 * last quote characters of the whole string (not the matching pair around
 * the executable name). For a command like `"C:\path with space\a.exe" arg`
 * that strips both quotes entirely, leaving the path's embedded space
 * unprotected and causing cmd to split on it. Wrapping the whole command in
 * one more quote pair makes the outer strip remove that wrapper instead,
 * leaving the inner `"exe" args` quoting intact. See `cmd /?` for the /s
 * quote-stripping rules.
 */
function wrapForCmdSlashS(cmd: string): string {
  return `"${cmd}"`;
}

/**
 * cmd.exe fallback implemented through execFile so Node does not invoke an
 * additional shell around the guarded command string.
 */
function execShellAsync(
  cmd: string,
  options: ExecFileOptions = {},
  outputLimits: { stdoutMaxBuffer?: number; stderrMaxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  // windowsVerbatimArguments prevents Node from re-quoting `cmd`, which is
  // already quoted for cmd.exe by buildWindowsShellFallbackCommand. Without
  // this, Node wraps the pre-quoted string in another layer of quotes,
  // corrupting the command cmd.exe sees (e.g. "not recognized as an
  // internal or external command").
  return execFileAsync(
    getWindowsCmdPath(),
    ['/d', '/s', '/v:off', '/c', wrapForCmdSlashS(cmd)],
    {
      ...options,
      windowsVerbatimArguments: true,
    },
    outputLimits
  );
}

function cleanupTimedCliProcess(
  child: ChildProcess | null,
  timeoutHandle: ReturnType<typeof setTimeout> | null
): null {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  untrackCliProcess(child);
  return null;
}

/**
 * Returns true if the string contains any non-ASCII character.
 */
function containsNonAscii(str: string): boolean {
  return [...str].some((c) => c.charCodeAt(0) > 127);
}

/**
 * On Windows, batch launchers need cmd.exe, and creating a process whose
 * path contains non-ASCII characters will often fail with `spawn EINVAL`.
 * Detect both cases so callers can launch through a shell when needed.
 */
function needsShell(binaryPath: string): boolean {
  if (process.platform !== 'win32') return false;
  if (!binaryPath) return false;
  const extension = path.extname(binaryPath).toLowerCase();
  return extension === '.cmd' || extension === '.bat' || containsNonAscii(binaryPath);
}

function getWindowsCmdPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

function spawnWindowsShellFallback(
  cmd: string,
  options: ReturnType<typeof withCliProcessDefaults<SpawnOptions>>
): ReturnType<typeof spawn> {
  // See execShellAsync/wrapForCmdSlashS above: windowsVerbatimArguments
  // avoids double-quoting the already-quoted `cmd` string, and the extra
  // quote wrapper survives cmd.exe's /s quote-stripping.
  return spawn(getWindowsCmdPath(), ['/d', '/s', '/v:off', '/c', wrapForCmdSlashS(cmd)], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

const activeCliProcesses = new Set<ChildProcess>();

export function untrackCliProcess(child: ChildProcess | null): void {
  if (child) {
    activeCliProcesses.delete(child);
  }
}

function trackCliProcess<T extends ChildProcess>(child: T): T {
  activeCliProcesses.add(child);
  if (process.platform !== 'win32' && child.pid) {
    const rootIdentity = tryReadUnixProcessTable()?.get(child.pid);
    if (rootIdentity) {
      recordOwnedUnixProcessGroup(child, rootIdentity);
    }
  }
  const cleanup = (): void => {
    activeCliProcesses.delete(child);
  };
  child.once?.('exit', cleanup);
  child.once?.('close', cleanup);
  child.once?.('error', cleanup);
  return child;
}

export function killTrackedCliProcesses(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const child of Array.from(activeCliProcesses)) {
    try {
      killProcessTree(child, signal);
    } catch {
      // Best effort during shutdown.
    }
  }
}

/**
 * Execute a CLI binary, falling back to running the command through a
 * shell on Windows if the normal path-based spawn fails.
 *
 * The return value matches the shape of Node's `execFile` promise: an
 * object with `stdout` and `stderr` strings.
 */
export interface ExecCliOptions extends ExecFileOptions {
  /**
   * Some generated Windows launchers are safe to run directly, but callers can
   * force the .cmd/.bat path when they need the launcher environment exactly.
   */
  preferShellForWindowsBatch?: boolean;
  /** Enforce stdout and stderr limits independently before killing the process tree. */
  stdoutMaxBuffer?: number;
  stderrMaxBuffer?: number;
}

export async function execCli(
  binaryPath: string | null,
  args: string[],
  options: ExecCliOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execCliUnclassified(binaryPath, args, options);
  } catch (error) {
    if (isLinuxChildLaunchFailure(error)) throw error;
    // A missing cwd surfaces as `spawn <binary> ENOENT`; report the real cause.
    throw await classifyCliSpawnError(error, options.cwd);
  }
}

async function execCliUnclassified(
  binaryPath: string | null,
  args: string[],
  options: ExecCliOptions
): Promise<{ stdout: string; stderr: string }> {
  if (!binaryPath) {
    throw new Error(
      'Agent runtime CLI binary path is null. Resolve the binary before calling execCli.'
    );
  }
  const target = binaryPath;
  const {
    preferShellForWindowsBatch = false,
    stdoutMaxBuffer,
    stderrMaxBuffer,
    ...execOptions
  } = options;
  const outputLimits = { stdoutMaxBuffer, stderrMaxBuffer };
  const opts = withCliProcessDefaults(execOptions);
  const directLauncher =
    preferShellForWindowsBatch && isWindowsBatchLauncher(target)
      ? null
      : resolveDirectWindowsLauncher(target);
  if (directLauncher) {
    const result = await execFileAsync(
      directLauncher.command,
      [...directLauncher.argsPrefix, ...args],
      opts,
      outputLimits
    );
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  // attempt the normal execFile path first
  if (!needsShell(target)) {
    try {
      const result = await execFileAsync(target, args, opts, outputLimits);
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (err: unknown) {
      // fall through to shell fallback only when the error matches the
      // Windows "invalid argument" problem; otherwise rethrow.
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined;
      if (isLinuxChildLaunchFailure(err) || code !== 'EINVAL') {
        throw err;
      }
    }
  }

  // shell fallback (Windows only; others shouldn't reach here)
  const cmd = buildWindowsShellFallbackCommand([target, ...args]);
  const shellResult = await execShellAsync(cmd, opts, outputLimits);
  return { stdout: String(shellResult.stdout), stderr: String(shellResult.stderr) };
}

/**
 * Spawn a child process.  If the initial `spawn()` call throws
 * synchronously with EINVAL on Windows, retry using a shell-based
 * command string.  The returned `ChildProcess` is whatever the
 * underlying call returned; listeners may safely be attached to it.
 */
export function spawnCli(
  binaryPath: string,
  args: string[],
  options: SpawnOptions = {}
): ReturnType<typeof spawn> {
  const opts = withCliProcessDefaults(options);
  const directLauncher = resolveDirectWindowsLauncher(binaryPath);
  if (directLauncher) {
    const directOpts = { ...opts };
    delete directOpts.shell;
    return trackCliProcess(
      spawn(directLauncher.command, [...directLauncher.argsPrefix, ...args], directOpts)
    );
  }

  if (process.platform === 'win32' && needsShell(binaryPath)) {
    const cmd = buildWindowsShellFallbackCommand([binaryPath, ...args]);
    return trackCliProcess(spawnWindowsShellFallback(cmd, opts));
  }

  try {
    return trackCliProcess(spawnWithLinuxChildLaunch(binaryPath, args, opts));
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (process.platform === 'win32' && code === 'EINVAL') {
      const cmd = buildWindowsShellFallbackCommand([binaryPath, ...args]);
      return trackCliProcess(spawnWindowsShellFallback(cmd, opts));
    }
    throw err;
  }
}

/**
 * Kill a child process and its entire process tree.
 *
 * On Windows with `shell: true`, `child.kill()` only kills the intermediate
 * `cmd.exe` shell, leaving the actual process (e.g. `claude.cmd`) orphaned.
 * `taskkill /T /F /PID` recursively kills the entire process tree.
 *
 * On macOS/Linux, kill the child and descendants by PID so shell wrappers
 * and spawned grandchildren do not survive a timeout or team stop.
 */
export function killProcessTree(
  child: ChildProcess | null | undefined,
  signal?: NodeJS.Signals
): void {
  void killProcessTreeAndWait(child, signal).catch(() => undefined);
}

/**
 * Kill a child process tree and wait for the bounded Windows taskkill attempt.
 * Callers handling a timeout should await this before starting replacement work.
 */
export async function killProcessTreeAndWait(
  child: ChildProcess | null | undefined,
  signal?: NodeJS.Signals
): Promise<void> {
  if (!child?.pid) {
    // Process is null, never started, or already exited
    return;
  }

  if (process.platform === 'win32') {
    // taskkill has no process-birth or runtime-handle argument. After this
    // ChildProcess has exited, its retained PID is not proof of ownership and
    // may already identify an unrelated process. Windows descendants cannot
    // be targeted safely from that stale root PID, so fail closed here.
    if (child.exitCode != null || child.signalCode != null) {
      activeCliProcesses.delete(child);
      return;
    }

    let taskkillError: unknown = null;
    try {
      const taskkillPath = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      );
      await new Promise<void>((resolve, reject) => {
        execFile(
          taskkillPath,
          ['/T', '/F', '/PID', String(child.pid)],
          {
            windowsHide: true,
            timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
          },
          (error) => {
            if (error) {
              reject(
                error instanceof Error ? error : new Error('Unknown Windows taskkill failure')
              );
              return;
            }
            resolve();
          }
        );
      });
      // A successful taskkill /T /F result is the Windows process-tree
      // termination acknowledgement. Do not probe and signal this PID again:
      // Windows may already have reused it for an unrelated process.
      activeCliProcesses.delete(child);
      return;
    } catch (error) {
      taskkillError = error;
    }

    let fallbackError: unknown = null;
    try {
      // ChildProcess.kill() uses the process handle retained by Node. Unlike
      // process.kill(pid), that handle remains bound to the process we spawned
      // if taskkill returns only after the original PID has been recycled.
      child.kill(signal ?? 'SIGTERM');
    } catch (error) {
      fallbackError = error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      ) {
        fallbackError = null;
      }
    }

    const taskkillMessage =
      taskkillError instanceof Error ? taskkillError.message : String(taskkillError);
    const fallbackMessage =
      fallbackError instanceof Error
        ? `direct termination failed (${fallbackError.message})`
        : 'direct termination targeted only the launcher; descendant outcome is unknown';
    throw new Error(
      `Failed to verify termination of Windows process tree ${child.pid}: ` +
        `taskkill failed (${taskkillMessage}); ${fallbackMessage}`
    );
  }

  const childPid = child.pid;
  const targetSignal = signal ?? 'SIGTERM';
  const identities = getOwnedUnixProcessTreeIdentities(child, childPid);
  const remainingIdentities = new Map(
    identities.map((identity) => [identity.pid, identity] as const)
  );
  for (const identity of [...identities].reverse()) {
    const currentIdentity = readUnixProcessTable(childPid).get(identity.pid);
    if (!isSameUnixProcessIdentity(identity, currentIdentity)) {
      remainingIdentities.delete(identity.pid);
      continue;
    }
    try {
      process.kill(identity.pid, targetSignal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        remainingIdentities.delete(identity.pid);
        continue;
      }
      throw error;
    }
  }
  await waitForUnixProcessIdentitiesToExit(remainingIdentities, childPid);
  recordVerifiedCliProcessRelease(child, identities);
  activeCliProcesses.delete(child);
}

async function waitForUnixProcessIdentitiesToExit(
  processIdentities: Map<number, UnixProcessIdentity>,
  rootPid: number
): Promise<void> {
  const deadline = Date.now() + UNIX_PROCESS_TREE_EXIT_TIMEOUT_MS;
  while (processIdentities.size > 0) {
    const currentProcesses = readUnixProcessTable(rootPid);
    for (const [pid, identity] of [...processIdentities]) {
      if (!isSameUnixProcessIdentity(identity, currentProcesses.get(pid))) {
        processIdentities.delete(pid);
        continue;
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          processIdentities.delete(pid);
          continue;
        }
        throw error;
      }
    }
    if (processIdentities.size === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Failed to verify termination of Unix process tree ${rootPid}; ` +
          `still observable: ${[...processIdentities.keys()].join(', ')}`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, UNIX_PROCESS_TREE_EXIT_POLL_MS));
  }
}

function normalizeKillSignal(signal: ExecFileOptions['killSignal']): NodeJS.Signals {
  return typeof signal === 'string' ? signal : 'SIGTERM';
}

function getOwnedUnixProcessTreeIdentities(
  child: ChildProcess,
  parentPid: number
): UnixProcessIdentity[] {
  const processes = readUnixProcessTable(parentPid);
  const ownedGroup = getOwnedUnixProcessGroup(child);
  const root = processes.get(parentPid);
  let roots = root ? [root] : [];
  if (ownedGroup) {
    const currentRoot = processes.get(parentPid);
    if (ownedGroup.rootStartIdentity === null) {
      throw new Error(
        `Failed to verify exited Unix process tree ${parentPid}: root birth identity was not captured`
      );
    }
    if (currentRoot && currentRoot.startIdentity !== ownedGroup.rootStartIdentity) {
      throw new Error(
        `Failed to verify Unix process tree ${parentPid}: root pid was reused after ownership capture`
      );
    }
    if (currentRoot && currentRoot.processGroupId !== ownedGroup.rootProcessGroupId) {
      throw new Error(
        `Failed to verify Unix process tree ${parentPid}: owned root changed process groups`
      );
    }
    if (ownedGroup.processGroupId !== null) {
      roots = [...processes.values()].filter(
        (identity) => identity.processGroupId === ownedGroup.processGroupId
      );
    } else if (!currentRoot) {
      throw new Error(
        `Failed to verify exited Unix process tree ${parentPid}: non-group root is no longer observable`
      );
    }
  }

  if (ownedGroup?.processGroupId == null && (child.exitCode != null || child.signalCode != null)) {
    throw new Error(
      `Failed to verify exited Unix process tree ${parentPid}: root birth identity was not captured`
    );
  }

  if (!ownedGroup && !root) {
    throw new Error(
      `Failed to verify exited Unix process tree ${parentPid}: no owned process-group identity`
    );
  }

  const childrenByParent = new Map<number, number[]>();
  for (const identity of processes.values()) {
    const children = childrenByParent.get(identity.parentPid);
    if (children) {
      children.push(identity.pid);
    } else {
      childrenByParent.set(identity.parentPid, [identity.pid]);
    }
  }
  // Detached teammates leave the launcher's group but remain owned descendants.
  const descendants = [...roots];
  const stack = roots.flatMap((identity) => childrenByParent.get(identity.pid) ?? []);
  const seen = new Set(roots.map((identity) => identity.pid));
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid) || pid === process.pid) {
      continue;
    }
    seen.add(pid);
    const identity = processes.get(pid);
    if (!identity) {
      throw new Error(`Unix process ${pid} disappeared while capturing tree ${parentPid}`);
    }
    descendants.push(identity);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}
