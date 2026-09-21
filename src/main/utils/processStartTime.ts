import {
  observeProcessProbe,
  processProbeDiagnostic,
  type ProcessProbeObserver,
} from '@main/utils/processProbeDiagnostics';
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
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  onDiagnostic?: ProcessProbeObserver
): Promise<number | null> {
  const probeEnv = createProcessProbeEnvironment(platform);
  return platform === 'win32'
    ? readWindowsProcessStartTimeMs(pid, timeoutMs, probeEnv, onDiagnostic)
    : readNativeProcessStartTimeMs(pid, timeoutMs, probeEnv, onDiagnostic);
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
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onDiagnostic?: ProcessProbeObserver
): Promise<number | null> {
  return execProcessProbeText(
    'ps',
    ['-p', String(pid), '-o', 'lstart='],
    timeoutMs,
    env,
    onDiagnostic,
    // `ps lstart` has no offset. The probe forces its clock to UTC, so make
    // that offset explicit before parsing rather than letting the parent
    // process's TZ reinterpret the child output as local time.
    (output) => Date.parse(`${output.trim()} UTC`)
  );
}

async function readWindowsProcessStartTimeMs(
  pid: number,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onDiagnostic?: ProcessProbeObserver
): Promise<number | null> {
  const normalizedPid = Math.trunc(pid);
  // The pid is interpolated into a PowerShell script, so anything that is not a
  // plain positive integer is refused here rather than quoted downstream.
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    observeProcessProbe(
      onDiagnostic,
      processProbeDiagnostic(
        'process_start_time:powershell.exe',
        performance.now(),
        timeoutMs,
        'invalid pid'
      )
    );
    return null;
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    `$process = Get-Process -Id ${normalizedPid} -ErrorAction Stop`,
    '$process.StartTime.ToUniversalTime().ToString("o")',
  ].join('; ');
  return execProcessProbeText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeoutMs,
    env,
    onDiagnostic
  );
}

/**
 * A process probe does not need application configuration, provider runtime
 * variables, or credentials. Inheriting those can change the child runtime
 * (for example through NODE_OPTIONS), so pass only the OS lookup/runtime
 * values and deterministic locale required by the commands we invoke.
 */
function createProcessProbeEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return {
    // Omit PATH when it is absent. Supplying an empty PATH prevents Node from
    // using the platform's command-search fallback and makes `ps` unresolvable.
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    LC_ALL: 'C',
    LANG: 'C',
    // POSIX `ps lstart` renders a timezone-less local timestamp. Keep the
    // command's timezone stable and parse that output as UTC above.
    ...(platform === 'win32' ? {} : { TZ: 'UTC' }),
    ...(platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
  };
}

function execProcessProbeText(
  command: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv,
  onDiagnostic?: ProcessProbeObserver,
  parse: (output: string) => number = (output) => Date.parse(output.trim())
): Promise<number | null> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
        windowsHide: true,
        env,
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        const output = String(stdout);
        const parsed = error ? Number.NaN : parse(output);
        if (!Number.isFinite(parsed)) {
          observeProcessProbe(
            onDiagnostic,
            processProbeDiagnostic(
              `process_start_time:${command}`,
              startedAt,
              timeout,
              error ? 'probe failed' : output.trim() ? 'invalid start time' : 'empty start time',
              error,
              stderr === undefined ? undefined : String(stderr)
            )
          );
        }
        resolve(Number.isFinite(parsed) ? parsed : null);
      }
    );
  });
}
