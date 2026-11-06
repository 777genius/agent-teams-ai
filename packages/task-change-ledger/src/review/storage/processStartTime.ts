import { execFile, type ExecFileException } from 'child_process';

/** Node-only process identity probe; diagnostics are optional consumer-owned observations. */
export interface ProcessStartProbeOutcome {
  readonly code?: string | number;
  readonly errno?: string | number;
  readonly signal?: string;
  readonly killed?: boolean;
}
export interface ProcessStartProbeDiagnostic {
  readonly operation: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly reason: string;
  /** Only primitive outcome fields; never Error.message, command, arguments or stdout. */
  readonly outcome?: ProcessStartProbeOutcome;
  /** Bounded exec stderr for the consumer's existing redactor; never logged here. */
  readonly stderr?: string;
}
export type ProcessStartProbeObserver = (
  diagnostic: ProcessStartProbeDiagnostic
) => void | Promise<void>;
function processStartProbeDiagnostic(
  operation: string,
  startedAt: number,
  timeoutMs: number,
  reason: string,
  error?: unknown,
  stderr?: string
): ProcessStartProbeDiagnostic {
  const source = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const outcome: {
    code?: string | number;
    errno?: string | number;
    signal?: string;
    killed?: boolean;
  } = {};
  for (const key of ['code', 'errno'] as const) {
    const value = source[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      outcome[key] = value;
  }
  if (typeof source.signal === 'string') outcome.signal = source.signal;
  if (typeof source.killed === 'boolean') outcome.killed = source.killed;
  return {
    operation,
    startedAt,
    timeoutMs,
    reason,
    ...(Object.keys(outcome).length ? { outcome } : {}),
    ...(stderr === undefined ? {} : { stderr }),
  };
}
function observeProcessStartProbe(
  observer: ProcessStartProbeObserver | undefined,
  diagnostic: ProcessStartProbeDiagnostic
): void {
  try {
    void Promise.resolve(observer?.(diagnostic)).catch(() => undefined);
  } catch {
    /* Observation never changes identity. */
  }
}

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
  onDiagnostic?: ProcessStartProbeObserver
): Promise<number | null> {
  return platform === 'win32'
    ? readWindowsProcessStartTimeMs(pid, timeoutMs, onDiagnostic)
    : readNativeProcessStartTimeMs(pid, timeoutMs, onDiagnostic);
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
  onDiagnostic?: ProcessStartProbeObserver
): Promise<number | null> {
  return execProcessProbeText('ps', ['-p', String(pid), '-o', 'lstart='], timeoutMs, onDiagnostic);
}

async function readWindowsProcessStartTimeMs(
  pid: number,
  timeoutMs: number,
  onDiagnostic?: ProcessStartProbeObserver
): Promise<number | null> {
  const normalizedPid = Math.trunc(pid);
  // The pid is interpolated into a PowerShell script, so anything that is not a
  // plain positive integer is refused here rather than quoted downstream.
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    observeProcessStartProbe(
      onDiagnostic,
      processStartProbeDiagnostic(
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
  // UTF-16LE Base64 carries the identical script without shell quote reinterpretation.
  return execProcessProbeText(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    timeoutMs,
    onDiagnostic
  );
}

function execProcessProbeText(
  command: string,
  args: string[],
  timeout: number,
  onDiagnostic?: ProcessStartProbeObserver
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
        // POSIX `ps` renders `lstart=` in the caller's LC_TIME, and Date.parse only
        // understands the C spelling of it. On a non-English desktop the probe would
        // otherwise parse to NaN, read as "start time unobservable", and leave a
        // recycled pid owning whatever the caller guards. The probe environment is an
        // override of the app environment, not a replacement: dropping PATH here would
        // break the `ps` lookup on some hosts.
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        const output = String(stdout);
        const parsed = error ? Number.NaN : Date.parse(output.trim());
        if (!Number.isFinite(parsed)) {
          observeProcessStartProbe(
            onDiagnostic,
            processStartProbeDiagnostic(
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
