import {
  exec,
  execFile,
  type ExecFileOptions,
  type ExecOptions,
  spawn,
  type SpawnOptions,
} from 'child_process';

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

  // attempt the normal execFile path first
  if (!needsShell(target)) {
    try {
      const result = await execFileAsync(target, args, options);
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
  const shellResult = await execShellAsync(cmd, options as unknown as ExecOptions);
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
  if (process.platform === 'win32' && needsShell(binaryPath)) {
    const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
    // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
    return spawn(cmd, { ...options, shell: true });
  }

  try {
    return spawn(binaryPath, args, options);
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (process.platform === 'win32' && code === 'EINVAL') {
      const cmd = [binaryPath, ...args].map(quoteArg).join(' ');
      // eslint-disable-next-line sonarjs/os-command -- cmd from known binaryPath+args, not user input (Windows EINVAL fallback)
      return spawn(cmd, { ...options, shell: true });
    }
    throw err;
  }
}
