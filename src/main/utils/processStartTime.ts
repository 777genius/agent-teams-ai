import { execFile, type ExecFileException } from 'child_process';

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;

/**
 * Process start time is the only ownership signal a pid-based guard can trust:
 * a pid can be recycled and a command line can be copied, but the instant a
 * process began cannot be forged by whatever inherits its pid afterwards.
 *
 * Reading it costs a child process on every platform, and each spelling has its
 * own trap - a shell-quoted pid on Windows, a locale-dependent timestamp
 * everywhere else - so the readers that need the signal share one
 * implementation here rather than each carrying their own.
 *
 * `platform` and `timeoutMs` are parameters rather than ambient reads so both
 * branches stay reachable from a test on any host, and so a caller working
 * against a deadline can cap what the probe is allowed to spend. A probe that
 * cannot answer resolves `null`, which every caller must read as "start time
 * unobservable" and never as "different process".
 */
export async function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<number | null> {
  return platform === 'win32'
    ? readWindowsProcessStartTimeMs(pid, timeoutMs)
    : readNativeProcessStartTimeMs(pid, timeoutMs);
}

/**
 * Memoizes a start-time reader for the lifetime of a single sweep.
 *
 * A sweep asks about the same pid more than once - a process can be both a tree
 * root and the parent of another candidate - and every ask costs a child
 * process: on Windows a whole PowerShell, on an already busy cold start. The
 * cache is deliberately per-sweep and not per-process: a start time is only
 * stable while the pid is, and a cache that outlived the sweep would hand a
 * recycled pid the identity of its predecessor.
 *
 * A failed read is cached as `null` rather than re-thrown, so one unreadable
 * pid is one "start time unobservable" answer instead of an exception that ends
 * the sweep for every pid behind it. A reader is a plain function and not
 * necessarily an async one, so it can fail before it returns a promise at all;
 * that is the same answer and never an escaping exception.
 */
export function createProcessStartTimeCache(
  read: (pid: number) => Promise<number | null>
): (pid: number) => Promise<number | null> {
  const cache = new Map<number, Promise<number | null>>();
  return (pid) => {
    const cached = cache.get(pid);
    if (cached) {
      return cached;
    }
    const pending = readStartTimeOrNull(read, pid);
    cache.set(pid, pending);
    return pending;
  };
}

/**
 * One probe, and every way it can fail answers `null`. The reader is called
 * before the first `await`, so it is still started the moment the first caller
 * asks for it and a second caller joins that one probe rather than starting
 * another.
 */
async function readStartTimeOrNull(
  read: (pid: number) => Promise<number | null>,
  pid: number
): Promise<number | null> {
  try {
    return await read(pid);
  } catch {
    return null;
  }
}

async function readNativeProcessStartTimeMs(
  pid: number,
  timeoutMs: number
): Promise<number | null> {
  const output = await execProcessProbeText('ps', ['-p', String(pid), '-o', 'lstart='], timeoutMs);
  if (!output) {
    return null;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function readWindowsProcessStartTimeMs(
  pid: number,
  timeoutMs: number
): Promise<number | null> {
  const normalizedPid = Math.trunc(pid);
  // The pid is interpolated into a PowerShell script, so anything that is not a
  // plain positive integer is refused here rather than quoted downstream.
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return null;
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    `$process = Get-Process -Id ${normalizedPid} -ErrorAction Stop`,
    '$process.StartTime.ToUniversalTime().ToString("o")',
  ].join('; ');
  const output = await execProcessProbeText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeoutMs
  );
  if (!output) {
    return null;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function execProcessProbeText(
  command: string,
  args: string[],
  timeout: number
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
        windowsHide: true,
        // POSIX `ps` renders `lstart=` in the caller's LC_TIME, and Date.parse only
        // understands the C spelling of it. On a non-English desktop the probe would
        // otherwise parse to NaN, read as "start time unobservable", and leave a
        // recycled pid owning whatever the caller guards. The probe environment is an
        // override of the app environment, not a replacement: dropping PATH here would
        // break the `ps` lookup on some hosts.
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        resolve(error ? null : String(stdout));
      }
    );
  });
}
