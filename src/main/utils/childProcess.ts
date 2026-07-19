import {
  type ChildProcess,
  execFile,
  type ExecFileOptions,
  spawn,
  type SpawnOptions,
  spawnSync,
} from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const EXEC_CLI_TIMEOUT_OUTPUT_BUFFER_LIMIT = 128 * 1024;
const EXEC_CLI_NATIVE_MAX_BUFFER_HEADROOM_BYTES = 1024 * 1024;
const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 10_000;

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
      void killProcessTreeAndWait(child, timeoutSignal).then(
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
    child = execFile(cmd, args, execOptions, (err, stdout, stderr) => {
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
        if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
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
        }, timeoutMs);
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

interface DirectWindowsLauncher {
  command: string;
  argsPrefix: string[];
}

function isWindowsBatchLauncher(binaryPath: string): boolean {
  const extension = path.extname(binaryPath).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

function resolveCmdPathTemplate(template: string, launcherDir: string): string {
  const dirWithSep = launcherDir.endsWith(path.sep) ? launcherDir : `${launcherDir}${path.sep}`;
  return path.resolve(
    template
      .replace(/%SCRIPT_DIR%/gi, dirWithSep)
      .replace(/%~dp0/gi, dirWithSep)
      .replace(/%dp0%/gi, dirWithSep)
      .replace(/\\/g, path.sep)
  );
}

function resolveGeneratedBunLauncher(
  content: string,
  launcherDir: string
): DirectWindowsLauncher | null {
  if (!/\bbun\s+"%TARGET%"\s+%\*/i.test(content)) {
    return null;
  }
  const targetMatch = /set\s+"TARGET=([^"]+)"/i.exec(content);
  const targetTemplate = targetMatch?.[1];
  if (!targetTemplate) {
    return null;
  }

  const target = resolveCmdPathTemplate(targetTemplate, launcherDir);
  if (!existsSync(target)) {
    return null;
  }
  return { command: 'bun', argsPrefix: [target] };
}

function resolveNpmNodeShim(content: string, launcherDir: string): DirectWindowsLauncher | null {
  const scriptMatch = /"%_prog%"\s+"([^"]+(?:\.(?:cjs|mjs|js))?)"\s+%\*/i.exec(content);
  const scriptTemplate = scriptMatch?.[1];
  if (!scriptTemplate) {
    return null;
  }

  const scriptPath = resolveCmdPathTemplate(scriptTemplate, launcherDir);
  if (!existsSync(scriptPath)) {
    return null;
  }

  const localNode = path.join(launcherDir, 'node.exe');
  return {
    command: existsSync(localNode) ? localNode : 'node',
    argsPrefix: [scriptPath],
  };
}

function resolveNpmNativeShim(content: string, launcherDir: string): DirectWindowsLauncher | null {
  const nativeTarget = /(?:^|[&|])\s*"([^"]+\.(?:exe|com))"\s+%\*/im.exec(content)?.[1];
  if (!nativeTarget) {
    return null;
  }

  const target = resolveCmdPathTemplate(nativeTarget, launcherDir);
  if (!existsSync(target)) {
    return null;
  }

  return { command: target, argsPrefix: [] };
}

/**
 * Some Windows launchers are thin wrappers around a real JS entrypoint.
 * Running that entrypoint directly with an argv array avoids cmd.exe's
 * percent expansion, which cannot safely represent args like `%PATH%`.
 */
function resolveDirectWindowsLauncher(binaryPath: string): DirectWindowsLauncher | null {
  if (process.platform !== 'win32' || !isWindowsBatchLauncher(binaryPath)) {
    return null;
  }

  try {
    const content = readFileSync(binaryPath, 'utf8');
    const launcherDir = path.dirname(binaryPath);
    return (
      resolveGeneratedBunLauncher(content, launcherDir) ??
      resolveNpmNodeShim(content, launcherDir) ??
      resolveNpmNativeShim(content, launcherDir)
    );
  } catch {
    return null;
  }
}

/**
 * Quote an argument for cmd.exe shell invocation on Windows.
 *
 * cmd.exe rules:
 * - Double-quote args containing spaces or special characters
 * - Inside double quotes, escape literal `"` as `\"` for the target argv parser
 * - Double trailing backslashes so they do not escape the closing quote
 * - `%` is expanded as env var even inside double quotes. Keep it outside
 *   quoted chunks and escape it as `^%`.
 * - `^`, `&`, `|`, `<`, `>` are safe inside double quotes
 *
 * Our callers only pass controlled strings (binary paths, CLI flags),
 * NOT arbitrary user input.
 */
function quoteCmdChunk(chunk: string): string {
  const escaped = chunk
    .replace(/(\\*)"/g, (_match, backslashes: string) => `${backslashes}${backslashes}\\"`)
    .replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

export function quoteWindowsCmdArg(arg: string): string {
  if (/[^A-Za-z0-9_\-/.]/.test(arg)) {
    return arg.split('%').map(quoteCmdChunk).join('^%');
  }
  return arg;
}

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdMetaCharacters(value: string): string {
  return value.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}

/**
 * Escape the executable token for a command line that cmd.exe will parse.
 * The executable and argv use different encodings: quoting the command as an
 * argv value changes how cmd locates paths that contain spaces.
 */
function escapeWindowsCmdCommand(command: string): string {
  // Unlike argv, the executable token must retain real quote characters so
  // cmd.exe groups a path containing spaces as one command. Caret-escaping
  // those quotes/spaces makes cmd pass the tail of the path as argv instead.
  return quoteWindowsCmdArg(command);
}

/**
 * Encode one argv value through both cmd.exe parsing and the target process'
 * Windows argv parser. Caret-escaping the quotes and shell metacharacters is
 * essential once windowsVerbatimArguments disables Node's escaping.
 */
function escapeWindowsCmdFallbackArg(arg: string, doubleEscapeMetaCharacters: boolean): string {
  const quoted = `"${arg
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/g, '$1$1')}"`;
  let escaped = escapeWindowsCmdMetaCharacters(quoted);
  if (doubleEscapeMetaCharacters) {
    escaped = escapeWindowsCmdMetaCharacters(escaped);
  }
  return escaped;
}

/** Batch launchers that forward %* parse cmd metacharacters a second time. */
function windowsBatchLauncherReparsesArgs(binaryPath: string): boolean {
  if (!isWindowsBatchLauncher(binaryPath)) {
    return false;
  }
  try {
    return /%\*/.test(readFileSync(binaryPath, 'utf8'));
  } catch {
    // A launcher that cannot be inspected is safer with the additional escape
    // layer than with metacharacters becoming active during a second parse.
    return true;
  }
}

/** `%1`/`%~1` substitution can reactivate shell syntax embedded in argv. */
function windowsBatchLauncherUsesPositionalArgs(binaryPath: string): boolean {
  if (!isWindowsBatchLauncher(binaryPath)) {
    return false;
  }
  try {
    return /%(?:[1-9]|~[^\s%]*[1-9])/.test(readFileSync(binaryPath, 'utf8'));
  } catch {
    return false;
  }
}

function assertSafeWindowsBatchPositionalArgs(command: string, args: string[]): void {
  if (!windowsBatchLauncherUsesPositionalArgs(command)) {
    return;
  }
  if (args.some((arg) => /[()\][%!^"`<>&|;,]/.test(arg))) {
    throw new Error(
      'Unsafe Windows batch positional argument: launcher reparses %1..%9 shell syntax'
    );
  }
}

function containsWindowsShellUnsafeControlChar(part: string): boolean {
  for (let index = 0; index < part.length; index += 1) {
    const code = part.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function assertSafeWindowsShellFallbackPart(part: string): void {
  if (containsWindowsShellUnsafeControlChar(part)) {
    throw new Error('Unsafe Windows shell fallback argument: control characters are not allowed');
  }
}

function buildWindowsShellFallbackCommand(parts: string[]): string {
  for (const part of parts) {
    assertSafeWindowsShellFallbackPart(part);
  }
  const [command, ...args] = parts;
  if (command === undefined) {
    return '';
  }
  assertSafeWindowsBatchPositionalArgs(command, args);
  const doubleEscapeMetaCharacters = windowsBatchLauncherReparsesArgs(command);
  return [
    escapeWindowsCmdCommand(command),
    ...args.map((arg) => escapeWindowsCmdFallbackArg(arg, doubleEscapeMetaCharacters)),
  ].join(' ');
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

/** Env vars injected into every spawned agent runtime CLI process. */
const CLI_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_HOOK_JUDGE_MODE: 'true',
};

const activeCliProcesses = new Set<ChildProcess>();

export function untrackCliProcess(child: ChildProcess | null): void {
  if (child) {
    activeCliProcesses.delete(child);
  }
}

function trackCliProcess<T extends ChildProcess>(child: T): T {
  activeCliProcesses.add(child);
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

/** Apply shared CLI process defaults without overriding explicit caller choices. */
function withCliProcessDefaults<
  T extends {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    windowsHide?: boolean;
  },
>(options: T): T & { windowsHide: boolean } {
  return {
    ...options,
    windowsHide: options.windowsHide ?? true,
    env: { ...(options.env ?? process.env), ...CLI_ENV_DEFAULTS },
  };
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
      if (code !== 'EINVAL') {
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
    return trackCliProcess(spawn(binaryPath, args, opts));
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
      return;
    } catch (error) {
      taskkillError = error;
    }

    let fallbackError: unknown = null;
    try {
      process.kill(child.pid, signal ?? 'SIGTERM');
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
  const descendants = getDescendantProcessIds(childPid);
  const targetSignal = signal ?? 'SIGTERM';
  for (const pid of [childPid, ...descendants.reverse()]) {
    try {
      process.kill(pid, targetSignal);
    } catch {
      // Best-effort - process may have already exited.
    }
  }
}

function normalizeKillSignal(signal: ExecFileOptions['killSignal']): NodeJS.Signals {
  return typeof signal === 'string' ? signal : 'SIGTERM';
}

function getDescendantProcessIds(parentPid: number): number[] {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      return [];
    }

    const childrenByParent = new Map<number, number[]>();
    for (const line of result.stdout.split('\n')) {
      const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const children = childrenByParent.get(ppid);
      if (children) {
        children.push(pid);
      } else {
        childrenByParent.set(ppid, [pid]);
      }
    }

    const descendants: number[] = [];
    const stack = [...(childrenByParent.get(parentPid) ?? [])];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop();
      if (!pid || seen.has(pid) || pid === process.pid) {
        continue;
      }
      seen.add(pid);
      descendants.push(pid);
      stack.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}
