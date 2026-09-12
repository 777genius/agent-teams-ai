import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const STALE_TIMEOUT_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  /** Compatibility only: expiry of legacy runtime directories, never PID owners. */
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
  /** Hold ownership until physical completion; age alone cannot evict a live writer. */
  preventLiveOwnerTakeover?: boolean;
}

// Protocol must stay equivalent to agent-teams-controller/src/internal/fileLock.js.
// New gates are NEVER published empty. Private candidates may survive a crash but
// are not acquisition blockers. This is process-crash safety, not fsync durability.
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function statOrMissing(name: string): fs.Stats | null {
  try {
    return fs.lstatSync(name);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function readOrMissing(name: string): string | null {
  try {
    return fs.readFileSync(name, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function unlinkOrMissing(name: string): void {
  try {
    fs.unlinkSync(name);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

function removeEmptyGate(gate: string): void {
  try {
    fs.rmdirSync(gate);
  } catch (error) {
    // A successor's nonempty gate must survive delayed cleanup of an old token.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error) ?? '')) throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

function parsePid(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function writeComplete(name: string, content: string): void {
  const fd = fs.openSync(name, 'wx');
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`Unable to complete file lock candidate: ${name}`);
      offset += written;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function recoverGate(gate: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(gate);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0) {
    removeEmptyGate(gate);
    return;
  }
  if (entries.length !== 1) return; // Unknown state fails closed.
  const entry = entries[0];
  const match = /^owner-([1-9][0-9]*)-((?:strict:)?[a-f0-9-]{36})$/.exec(entry);
  if (!match) return;
  const pid = parsePid(match[1]);
  if (pid === null) return;
  const ownerPath = path.join(gate, entry);
  const stat = statOrMissing(ownerPath);
  if (!stat?.isFile()) return;
  if (readOrMissing(ownerPath) !== `file-lock-transition-v2\n${pid}\n${match[2]}\n`) return;
  if (isProcessAlive(pid)) return;
  // No claim on a claim: a delayed remover can address only this dead token.
  // Its rmdir cannot remove any nonempty successor, even after PID-probe pauses.
  unlinkOrMissing(ownerPath);
  removeEmptyGate(gate);
}

function acquireGate(gate: string, token: string): string | null {
  if (statOrMissing(gate)?.isDirectory()) {
    recoverGate(gate);
    return null;
  }
  const candidate = `${gate}.candidate-${process.pid}-${randomUUID()}`;
  const entry = `owner-${process.pid}-${token}`;
  fs.mkdirSync(candidate);
  let published = false;
  try {
    writeComplete(
      path.join(candidate, entry),
      `file-lock-transition-v2\n${process.pid}\n${token}\n`
    );
    try {
      fs.renameSync(candidate, gate);
      published = true;
      return entry;
    } catch (error) {
      const code = codeOf(error);
      // Windows reports EPERM for rename onto an occupied directory. Only an
      // observed destination directory qualifies; absent/other errors surface.
      // Windows may also reject rename onto an empty gate left by a dead releaser.
      const windowsOccupied =
        process.platform === 'win32' && code === 'EPERM' && statOrMissing(gate)?.isDirectory();
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && !windowsOccupied) throw error;
      recoverGate(gate);
      return null;
    }
  } finally {
    if (!published) {
      unlinkOrMissing(path.join(candidate, entry));
      fs.rmdirSync(candidate);
    }
  }
}

interface LockInfo {
  stat: fs.Stats;
  content: string | null;
}

function readLockInfo(lockPath: string): LockInfo | null {
  const stat = statOrMissing(lockPath);
  if (!stat) return null;
  return { stat, content: stat.isFile() ? readOrMissing(lockPath) : null };
}

function sameLock(left: LockInfo, right: LockInfo | null): boolean {
  return (
    right !== null &&
    left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino &&
    left.stat.birthtimeMs === right.stat.birthtimeMs &&
    left.content === right.content
  );
}

function recoverDataLock(lockPath: string, options: Required<FileLockOptions>): void {
  const observed = readLockInfo(lockPath);
  if (!observed) return;
  if (observed.stat.isDirectory()) {
    // BASELINE compatibility with proper-lockfile's empty directory protocol.
    // Its age policy does NOT protect indefinitely paused runtime holders.
    // Never extend this policy to anonymous regular locks or new PID gates.
    if (options.preventLiveOwnerTakeover) return;
    if (
      Date.now() - observed.stat.mtimeMs > options.staleTimeoutMs &&
      sameLock(observed, readLockInfo(lockPath))
    )
      removeEmptyGate(lockPath);
    return;
  }
  if (!observed.stat.isFile() || observed.content === null) return;
  // Accept complete legacy PID/time records as well as PID/time/token records.
  // A partial numeric prefix is not evidence of the initializer's full PID.
  const record = /^([1-9][0-9]*)\n[0-9]+\n(?:[^\n]+\n)?$/.exec(observed.content);
  const pid = record ? parsePid(record[1]) : null;
  // Anonymous/malformed legacy files remain explicitly unknown, even if old.
  if (pid === null || isProcessAlive(pid)) return;
  if (sameLock(observed, readLockInfo(lockPath))) unlinkOrMissing(lockPath);
}

function releaseLock(lockPath: string, token: string): void {
  const observed = readLockInfo(lockPath);
  const lines = observed?.content?.split('\n');
  if (lines?.[0] === String(process.pid) && lines[2] === token) unlinkOrMissing(lockPath);
}

function tryAcquire(lockPath: string, options: Required<FileLockOptions>, token: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const gate = `${lockPath}-transition-v2`;
  const entry = acquireGate(gate, token);
  if (entry === null) return false;
  let published = false;
  try {
    try {
      recoverDataLock(lockPath, options);
      if (statOrMissing(lockPath)) return false;
      const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
      try {
        writeComplete(candidate, `${process.pid}\n${Date.now()}\n${token}\n`);
        try {
          // Hard link is no-replace publication of complete bytes, including on
          // Windows. Unsupported filesystems fail; never fall back to canonical wx.
          fs.linkSync(candidate, lockPath);
          published = true;
        } catch (error) {
          if (codeOf(error) !== 'EEXIST') throw error;
        }
      } finally {
        unlinkOrMissing(candidate);
      }
      return published;
    } finally {
      // All protected mutations have ended BEFORE making the gate empty.
      unlinkOrMissing(path.join(gate, entry));
      removeEmptyGate(gate);
    }
  } catch (error) {
    // A cleanup error after publication must not strand a live owner whose
    // callback was never entered. Release needs no gate: live PIDs cannot be stolen.
    if (published) releaseLock(lockPath, token);
    throw error;
  }
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous callers need the same cross-process lock as controller writes.
  }
}

function resolveLockOptions(options: FileLockOptions): Required<FileLockOptions> {
  return {
    acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
    staleTimeoutMs: options.staleTimeoutMs ?? STALE_TIMEOUT_MS,
    retryIntervalMs: options.retryIntervalMs ?? RETRY_INTERVAL_MS,
    preventLiveOwnerTakeover: options.preventLiveOwnerTakeover ?? false,
  };
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  const resolvedOptions = resolveLockOptions(options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + resolvedOptions.acquireTimeoutMs;
  const token = resolvedOptions.preventLiveOwnerTakeover ? `strict:${randomUUID()}` : randomUUID();

  while (!tryAcquire(lockPath, resolvedOptions, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    sleepSync(Math.min(resolvedOptions.retryIntervalMs, Math.max(0, deadline - Date.now())));
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const resolvedOptions = resolveLockOptions(options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + resolvedOptions.acquireTimeoutMs;
  const token = resolvedOptions.preventLiveOwnerTakeover ? `strict:${randomUUID()}` : randomUUID();

  while (!tryAcquire(lockPath, resolvedOptions, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, resolvedOptions.retryIntervalMs));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
