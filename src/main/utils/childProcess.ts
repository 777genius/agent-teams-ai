import {
  type ChildProcess,
  exec,
  execFile,
  type ExecFileOptions,
  type ExecOptions,
  spawn,
  type SpawnOptions,
} from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Promise wrapper for execFile that always returns { stdout, stderr }.
 * Unlike promisify(execFile), this works correctly with mocked execFile
 * (promisify relies on a custom symbol that mocks don't have).
 */
function execFileAsync(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null;
    let settled = false;
    const cleanup = (): void => {
      untrackCliProcess(child);
    };
    child = execFile(cmd, args, options, (err, stdout, stderr) => {
      settled = true;
      cleanup();
      if (err) {
        const normalizedError =
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
        Object.assign(normalizedError, {
          stdout: String(stdout),
          stderr: String(stderr),
        });
        reject(normalizedError);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (!settled) {
      trackCliProcess(child);
    }
  });
}

/**
 * Promise wrapper for exec.  Used exclusively as a Windows shell fallback
 * when execFile fails with EINVAL on non-ASCII binary paths.  The command
 * string is built from a known binary path + args, NOT from user input.
 */
function execShellAsync(
  cmd: string,
  options: ExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null;
    let settled = false;
    const cleanup = (): void => {
      untrackCliProcess(child);
    };
    // eslint-disable-next-line sonarjs/os-command, security/detect-child-process -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
    child = exec(cmd, options, (err, stdout, stderr) => {
      settled = true;
      cleanup();
      if (err)
        reject(
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error')
        );
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (!settled) {
      trackCliProcess(child);
    }
  });
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
  const scriptMatch = /"%_prog%"\s+"([^"]+\.(?:cjs|mjs|js))"\s+%\*/i.exec(content);
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
      resolveGeneratedBunLauncher(content, launcherDir) ?? resolveNpmNodeShim(content, launcherDir)
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

function quoteArg(arg: string): string {
  return quoteWindowsCmdArg(arg);
}

/** Env vars injected into every spawned Claude CLI process. */
const CLI_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_HOOK_JUDGE_MODE: 'true',
};

const activeCliProcesses = new Set<ChildProcess>();

function untrackCliProcess(child: ChildProcess | null): void {
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

/** Merge CLI_ENV_DEFAULTS into spawn/exec options.env (or process.env if absent). */
function withCliEnv<T extends { env?: NodeJS.ProcessEnv | Record<string, string | undefined> }>(
  options: T
): T {
  return {
    ...options,
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
export async function execCli(
  binaryPath: string | null,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!binaryPath) {
    throw new Error(
      'Claude CLI binary path is null. Resolve the binary via ClaudeBinaryResolver before calling execCli.'
    );
  }
  const target = binaryPath;
  const opts = withCliEnv(options);
  const directLauncher = resolveDirectWindowsLauncher(target);
  if (directLauncher) {
    const result = await execFileAsync(
      directLauncher.command,
      [...directLauncher.argsPrefix, ...args],
      opts
    );
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  // attempt the normal execFile path first
  if (!needsShell(target)) {
    try {
      const result = await execFileAsync(target, args, opts);
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
  const cmd = [target, ...args].map(quoteArg).join(' ');
  const shellResult = await execShellAsync(cmd, opts as unknown as ExecOptions);
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
  const opts = withCliEnv(options);
  const directLauncher = resolveDirectWindowsLauncher(binaryPath);
  if (directLauncher) {
    const directOpts = { ...opts };
    delete directOpts.shell;
    return trackCliProcess(
      spawn(directLauncher.command, [...directLauncher.argsPrefix, ...args], directOpts)
    );
  }

  if (process.platform === 'win32' && needsShell(binaryPath)) {
    const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
    // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
    return trackCliProcess(spawn(cmd, { ...opts, shell: true }));
  }

  try {
    return trackCliProcess(spawn(binaryPath, args, opts));
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (process.platform === 'win32' && code === 'EINVAL') {
      const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
      // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
      return trackCliProcess(spawn(cmd, { ...opts, shell: true }));
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
 * On macOS/Linux, processes are killed directly (no shell wrapper), so
 * the standard `child.kill(signal)` works correctly.
 */
export function killProcessTree(
  child: ChildProcess | null | undefined,
  signal?: NodeJS.Signals
): void {
  if (!child?.pid) {
    // Process is null, never started, or already exited
    return;
  }

  if (process.platform === 'win32') {
    try {
      const taskkillPath = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      );
      execFile(taskkillPath, ['/T', '/F', '/PID', String(child.pid)], () => {
        // Best-effort — ignore errors (process may have already exited)
      });
      return;
    } catch {
      // taskkill failed, fall through to standard kill
    }
  }

  child.kill(signal);
}
