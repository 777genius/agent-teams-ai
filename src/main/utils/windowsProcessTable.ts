import { execFile, execFileSync } from 'node:child_process';

import { processProbeDiagnostic } from '@main/utils/processProbeDiagnostics';

export interface WindowsProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ListWindowsProcessTableOptions {
  /** Run an independent fresh probe without reading, joining, or populating the shared cache. */
  bypassCache?: boolean;
}

interface RawWindowsProcessRow {
  ProcessId?: number | string | null;
  ParentProcessId?: number | string | null;
  CommandLine?: string | null;
}

export interface WindowsProcessTableFailureFacts {
  reason: 'probe_failed' | 'stderr_received';
  exitCode: number | null;
  nativeCode: string | null;
  signal: 'SIGTERM' | 'SIGKILL' | null;
  stderrFormat: 'empty' | 'clixml' | 'text';
  stderrStreams: string[];
}

/** Closed observation facts; never retains process stdout or raw native errors. */
export class WindowsProcessTableProbeError extends Error {
  constructor(message: string, readonly failureFacts: WindowsProcessTableFailureFacts) {
    super(message);
    this.name = 'WindowsProcessTableProbeError';
  }
}

function failureFacts(error: unknown, stderr: string): WindowsProcessTableFailureFacts {
  const outcome = error && typeof error === 'object' ? error as { code?: unknown; signal?: unknown } : {};
  const trimmed = stderr.trim();
  const clixml = trimmed.startsWith('#< CLIXML');
  const knownStreams = new Set(['progress', 'error', 'warning', 'verbose', 'debug', 'information', 'output']);
  return {
    reason: error ? 'probe_failed' : 'stderr_received',
    exitCode: typeof outcome.code === 'number' && Number.isInteger(outcome.code) ? outcome.code : null,
    nativeCode: typeof outcome.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(outcome.code) ? outcome.code : null,
    signal: outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL' ? outcome.signal : null,
    stderrFormat: !trimmed ? 'empty' : clixml ? 'clixml' : 'text',
    stderrStreams: clixml ? [...new Set([...trimmed.matchAll(/\bS=["']([A-Za-z]+)["']/g)]
      .map(match => match[1].toLowerCase())
      .map(stream => knownStreams.has(stream) ? stream : 'unknown'))].sort() : [],
  };
}

const PROCESS_TABLE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  // Module-loading progress is not probe data; every remaining stderr still fails closed.
  '$ProgressPreference = "SilentlyContinue"',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
].join('; ');

// Preserve the script bytes across Windows argv quoting in both Node and Bun.
const PROCESS_TABLE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(PROCESS_TABLE_SCRIPT, 'utf16le').toString('base64'),
];
const PROCESS_TABLE_CACHE_TTL_MS = 1_500;

let cachedProcessTable: { rows: WindowsProcessTableRow[]; expiresAt: number } | null = null;
let processTableRequest: Promise<WindowsProcessTableRow[]> | null = null;

function parsePositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function parseWindowsProcessTableJson(stdout: string): WindowsProcessTableRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: RawWindowsProcessRow | RawWindowsProcessRow[];
  try {
    parsed = JSON.parse(trimmed) as RawWindowsProcessRow | RawWindowsProcessRow[];
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: WindowsProcessTableRow[] = [];

  for (const row of rows) {
    const pid = parsePositiveInteger(row?.ProcessId);
    const ppid = parsePositiveInteger(row?.ParentProcessId) ?? 0;
    const command = row?.CommandLine?.trim() ?? '';
    if (!pid || !command) {
      continue;
    }
    result.push({ pid, ppid, command });
  }

  return result;
}

function readWindowsProcessTableUncached(timeoutMs: number): Promise<WindowsProcessTableRow[]> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      PROCESS_TABLE_ARGS,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error || stderr?.trim()) {
          reject(
            new WindowsProcessTableProbeError(
              processProbeDiagnostic(
                'windows_process_enumeration',
                startedAt,
                timeoutMs,
                error ? 'probe failed' : 'stderr received',
                error,
                stderr
              ),
              failureFacts(error, stderr ?? '')
            )
          );
          return;
        }
        resolve(parseWindowsProcessTableJson(String(stdout)));
      }
    );
  });
}

export async function listWindowsProcessTable(
  timeoutMs = 4_000,
  options: ListWindowsProcessTableOptions = {}
): Promise<WindowsProcessTableRow[]> {
  if (options.bypassCache === true) {
    const rows = await readWindowsProcessTableUncached(timeoutMs);
    return rows.map((row) => ({ ...row }));
  }

  const cached = cachedProcessTable;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows.map((row) => ({ ...row }));
  }

  if (processTableRequest) {
    const rows = await processTableRequest;
    return rows.map((row) => ({ ...row }));
  }

  const request = readWindowsProcessTableUncached(timeoutMs);
  processTableRequest = request;

  try {
    const rows = await request;
    cachedProcessTable = {
      rows,
      expiresAt: Date.now() + PROCESS_TABLE_CACHE_TTL_MS,
    };
    return rows.map((row) => ({ ...row }));
  } finally {
    if (processTableRequest === request) {
      processTableRequest = null;
    }
  }
}

export function listWindowsProcessTableSync(timeoutMs = 4_000): WindowsProcessTableRow[] {
  const stdout = execFileSync('powershell.exe', PROCESS_TABLE_ARGS, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseWindowsProcessTableJson(String(stdout));
}
