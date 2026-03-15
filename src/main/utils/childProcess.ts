import {
  type ChildProcess,
  exec,
  execFile,
  type ExecFileOptions,
  type ExecOptions,
  spawn,
  type SpawnOptions,
} from 'child_process';
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
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err)
        reject(
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error')
        );
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
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
    // eslint-disable-next-line sonarjs/os-command, security/detect-child-process -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
    exec(cmd, options, (err, stdout, stderr) => {
      if (err)
        reject(
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error')
        );
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Returns true if the string contains any non-ASCII character.
 */
function containsNonAscii(str: string): boolean {
  return [...str].some((c) => c.charCodeAt(0) > 127);
}

/**
 * On Windows, creating a process whose *path* contains non-ASCII
 * characters will often fail with `spawn EINVAL`.  Detect that case so
 * callers can automatically fall back to launching via a shell.
 */
function needsShell(binaryPath: string): boolean {
  if (process.platform !== 'win32') return false;
  if (!binaryPath) return false;
  return containsNonAscii(binaryPath);
}

/**
 * Quote an argument for cmd.exe shell invocation on Windows.
 *
 * cmd.exe rules:
 * - Double-quote args containing spaces or special characters
 * - Inside double quotes, escape literal `"` as `""`
 * - `%` is expanded as env var even inside double quotes — escape as `%%`
 * - `^`, `&`, `|`, `<`, `>` are safe inside double quotes
 *
 * Our callers only pass controlled strings (binary paths, CLI flags),
 * NOT arbitrary user input.
 */
function quoteArg(arg: string): string {
  if (/[^A-Za-z0-9_\-/.]/.test(arg)) {
    const escaped = arg.replace(/%/g, '%%').replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return arg;
}

/** Env vars injected into every spawned Claude CLI process. */
const CLI_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_HOOK_JUDGE_MODE: 'true',
};

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
 * shell on Windows if the normal path-based spawn fails.  `binaryPath`
 * may be `null` which causes `claude` (lookup via PATH) to be used.
 *
 * The return value matches the shape of Node's `execFile` promise: an
 * object with `stdout` and `stderr` strings.
 */
export async function execCli(
  binaryPath: string | null,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const target = binaryPath || 'claude';
  const opts = withCliEnv(options);

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

  if (process.platform === 'win32' && needsShell(binaryPath)) {
    const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
    // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
    return spawn(cmd, { ...opts, shell: true });
  }

  try {
    return spawn(binaryPath, args, opts);
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (process.platform === 'win32' && code === 'EINVAL') {
      const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
      // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
      return spawn(cmd, { ...opts, shell: true });
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
