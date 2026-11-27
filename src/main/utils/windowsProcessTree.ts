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
  const rawRows = Array.isArray(data) ? data : [data];
  if (!rawRows.length || rawRows.length > MAX_CENSUS_ROWS)
    throw new Error('Invalid Windows process census size');
  // Win32_Process includes System Idle Process (PID 0), which is not killable.
  const rows = rawRows.filter(raw => !(raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (raw as Record<string, unknown>).pid === 0));
  if (!rows.length) throw new Error('Invalid Windows process census size');
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

/**
 * Keep every descendant identity observed across successive censuses, even if
 * its parent later exits. Otherwise a surviving grandchild may become invisible
 * to the last retirement check when its intermediate parent has disappeared.
 */
export function extendObservedWindowsProcessTree(
  originals: readonly WindowsProcessIdentity[], now: readonly WindowsProcessIdentity[]
): WindowsProcessIdentity[] {
  const byParent = new Map<number, WindowsProcessIdentity[]>();
  for (const row of now) {
    const siblings = byParent.get(row.parentPid) ?? [];
    siblings.push(row);
    byParent.set(row.parentPid, siblings);
  }
  const observed = [...originals];
  const known = new Set(observed.map(row => row.pid + ':' + row.birth));
  for (let i = 0; i < observed.length; i++) {
    const parent = observed[i]!;
    if (!parent.birth) throw new Error('Windows observed parent identity unavailable');
    for (const child of byParent.get(parent.pid) ?? []) {
      // A reused PID is not the same original birth; fail conservatively if
      // a current child cannot be authenticated by its creation timestamp.
      if (!child.birth) throw new Error('Windows observed descendant identity unavailable');
      if (BigInt(child.birth) < BigInt(parent.birth)) continue;
      const key = child.pid + ':' + child.birth;
      if (known.has(key)) continue;
      known.add(key);
      observed.push(child);
      if (observed.length > 512) throw new Error('Windows observed process tree too large');
    }
  }
  return observed;
}


/**
 * A process can create a child which creates another child, then exit before
 * any follow-up census. The surviving grandchild's parent PID was never seen.
 * Do not mistake a missing original root for proof that its descendants are
 * gone. A process predating the original root cannot be its descendant.
 * A younger process needs a verified older parent chain in the baseline
 * (for unchanged births) or the current census. Baseline membership alone
 * does not establish ancestry. Unknown parents remain unconfirmed.
 */
export function unattributableWindowsProcessBirths(
  initial: readonly WindowsProcessIdentity[],
  now: readonly WindowsProcessIdentity[],
  originalTree: readonly WindowsProcessIdentity[]
): WindowsProcessIdentity[] {
  const baseline = new Map(initial.map(row => [row.pid, row]));
  const live = new Map(now.map(row => [row.pid, row]));
  const originals = new Set(originalTree.map(row => row.pid + ':' + row.birth));
  const rootBirth = originalTree[0]?.birth;
  if (!rootBirth) return [...now];
  function foreign(entry: WindowsProcessIdentity, seen: Set<number>): boolean {
    if (!entry.birth || originals.has(entry.pid + ':' + entry.birth) ||
        seen.has(entry.pid) || seen.size >= 512) return false;
    if (BigInt(entry.birth) < BigInt(rootBirth)) return true;
    const original = baseline.get(entry.pid);
    const parent = original?.birth === entry.birth
      ? baseline.get(entry.parentPid) : live.get(entry.parentPid);
    if (!parent?.birth || BigInt(parent.birth) > BigInt(entry.birth)) return false;
    const next = new Set(seen);
    next.add(entry.pid);
    return foreign(parent, next);
  }
  return now.filter(row => !foreign(row, new Set()));
}

/** Raced taskkill is a success only if all potentially owned births retired. */
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
  let initial: WindowsProcessIdentity[] | null = null;
  try {
    initial = await census();
    originals = captureWindowsProcessTree(initial, child.pid);
  }
  catch { /* An unreadable census cannot later qualify a failed taskkill. */ }
  if (child.exitCode !== null || child.signalCode !== null) {
    if (originals) {
      try {
        const now = await census();
        originals = extendObservedWindowsProcessTree(originals, now);
        if (windowsProcessTreeRetired(originals, now) &&
            unattributableWindowsProcessBirths(initial ?? [], now, originals).length === 0) return;
      } catch { /* Unknown original descendant state. */ }
    }
    throw new Error('Windows original root exited during census; descendants unconfirmed');
  }
  // Preserve the evidence across attempts. Any unreadable follow-up census
  // permanently disqualifies a raced taskkill; a later clean read is not proof.
  let observed = originals;
  let censusTrusted = true;
  async function observedTreeRetired(): Promise<boolean> {
    if (!observed || !censusTrusted) return false;
    try {
      const now = await census();
      observed = extendObservedWindowsProcessTree(observed, now);
      return windowsProcessTreeRetired(observed, now) &&
        unattributableWindowsProcessBirths(initial ?? [], now, observed).length === 0;
    } catch {
      censusTrusted = false;
      return false;
    }
  }
  let taskkillError: unknown;
  try {
    await execute(windowsBinary('taskkill.exe'),
      ['/T', '/F', '/PID', String(child.pid)], TASKKILL_TIMEOUT_MS);
    return;
  } catch (error) { taskkillError = error; }
  if (await observedTreeRetired()) return;
  let fallbackError: unknown = null;
  try { child.kill(signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fallbackError = error;
  }
  // Handle-bound fallback may finish after taskkill reported a raced child.
  if (!fallbackError && await observedTreeRetired()) return;
  const message = taskkillError instanceof Error ? taskkillError.message : String(taskkillError);
  throw new Error('Failed to verify termination of Windows process tree ' + child.pid +
    ': taskkill failed (' + message + '); ' +
    (fallbackError ? 'original process handle kill also failed' :
      'original descendant retirement remains unconfirmed'));
}
