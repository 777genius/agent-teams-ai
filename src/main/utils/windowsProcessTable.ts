import { execFile, execFileSync } from 'node:child_process';

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

const PROCESS_TABLE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
].join('; ');

const PROCESS_TABLE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  PROCESS_TABLE_SCRIPT,
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
        if (error) {
          reject(error);
          return;
        }
        if (stderr?.trim()) {
          reject(new Error(stderr.trim()));
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
