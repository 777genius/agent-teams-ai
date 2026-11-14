import { execFile, type ChildProcess } from 'child_process';
import path from 'path';

/** Original Win32 PID plus creation time; numeric PID alone is not ownership. */
export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  birth: string;
}

const CENSUS_TIMEOUT_MS = 8_000;
const TASKKILL_TIMEOUT_MS = 10_000;
const MAX_CENSUS_ROWS = 8_192;
const CENSUS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {',
  "    $birth = if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }",
  '    [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; birth = $birth }',
  '  })',
  '  ConvertTo-Json -InputObject $rows -Compress -Depth 3',
  "} catch { [Console]::Error.WriteLine('Windows process census failed'); exit 1 }",
].join('\n');

function windowsBinary(name: string): string {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

function execute(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true, timeout, maxBuffer: 2_097_152, encoding: 'utf8',
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

export function parseWindowsProcessCensus(value: string): WindowsProcessIdentity[] {
  const data: unknown = JSON.parse(value);
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length || rows.length > MAX_CENSUS_ROWS)
    throw new Error('Invalid Windows process census size');
  const visited = new Set<number>();
  return rows.map((raw: unknown) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const pid = item.pid, parentPid = item.parentPid, birth = item.birth;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || visited.has(Number(pid)) ||
        !Number.isSafeInteger(parentPid) || Number(parentPid) < 0 ||
        typeof birth !== 'string' || (birth !== '' && !/^\d{15,20}$/.test(birth))) {
      throw new Error('Invalid Windows process identity');
    }
    visited.add(Number(pid));
    return { pid: Number(pid), parentPid: Number(parentPid), birth };
  });
}

async function census(): Promise<WindowsProcessIdentity[]> {
  const script = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return parseWindowsProcessCensus(
    await execute(script, ['-NoProfile', '-NonInteractive', '-Command', CENSUS_SCRIPT], CENSUS_TIMEOUT_MS)
  );
}

/** Capture only descendants born no earlier than their recorded original parent. */
export function captureWindowsProcessTree(
  rows: readonly WindowsProcessIdentity[], originalPid: number
): WindowsProcessIdentity[] {
  const root = rows.find(row => row.pid === originalPid);
  if (!root?.birth) throw new Error('Windows original root identity unavailable');
  const byParent = new Map<number, WindowsProcessIdentity[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentPid) ?? [];
    siblings.push(row);
    byParent.set(row.parentPid, siblings);
  }
  const captured = [root], seen = new Set([root.pid]);
  for (let i = 0; i < captured.length; i++) {
    const parent = captured[i]!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (!child.birth) throw new Error('Windows descendant identity unavailable');
      if (BigInt(child.birth) < BigInt(parent.birth)) continue;
      seen.add(child.pid);
      captured.push(child);
      if (captured.length > 512) throw new Error('Windows process tree too large');
    }
  }
  return captured;
}

/** Raced taskkill is a success only if every original birth identity retired. */
export function windowsProcessTreeRetired(
  originals: readonly WindowsProcessIdentity[], now: readonly WindowsProcessIdentity[]
): boolean {
  if (!originals.length || originals.some(row => !row.birth)) return false;
  const byPid = new Map(now.map(row => [row.pid, row]));
  for (const row of originals) {
    if (byPid.get(row.pid)?.birth === row.birth) return false;
  }
  // Refuse an original parent's late child, even if root already exited.
  const births = new Map(originals.map(row => [row.pid, BigInt(row.birth)]));
  return !now.some(row => {
    const parentBirth = births.get(row.parentPid);
    return parentBirth !== undefined && (!row.birth || BigInt(row.birth) >= parentBirth);
  });
}

/**
 * Strict native Windows team Stop: preserve taskkill's successful behavior,
 * but re-check original Win32 birth identities if a child races out during
 * /T traversal and taskkill returns nonzero. Unknown census never passes.
 */
export async function killWindowsProcessTreeAndWait(
  child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let originals: WindowsProcessIdentity[] | null = null;
  try { originals = captureWindowsProcessTree(await census(), child.pid); }
  catch { /* An unreadable census cannot later qualify a failed taskkill. */ }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (originals) {
      try { if (windowsProcessTreeRetired(originals, await census())) return; }
      catch { /* Unknown original descendant state. */ }
    }
    throw new Error('Windows original root exited during census; descendants unconfirmed');
  }
  let taskkillError: unknown;
  try {
    await execute(windowsBinary('taskkill.exe'),
      ['/T', '/F', '/PID', String(child.pid)], TASKKILL_TIMEOUT_MS);
    return;
  } catch (error) { taskkillError = error; }
  if (originals) {
    try { if (windowsProcessTreeRetired(originals, await census())) return; }
    catch { /* Unverified retirement remains a failure. */ }
  }
  let fallbackError: unknown = null;
  try { child.kill(signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fallbackError = error;
  }
  // Handle-bound fallback may finish after taskkill reported a raced child.
  if (!fallbackError && originals) {
    try { if (windowsProcessTreeRetired(originals, await census())) return; }
    catch { /* Never turn failed process inspection into success. */ }
  }
  const message = taskkillError instanceof Error ? taskkillError.message : String(taskkillError);
  throw new Error('Failed to verify termination of Windows process tree ' + child.pid +
    ': taskkill failed (' + message + '); ' +
    (fallbackError ? 'original process handle kill also failed' :
      'original descendant retirement remains unconfirmed'));
}
