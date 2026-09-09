const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

// PID/token publication must stay equivalent to src/main/services/team/fileLock.ts.
// Directory policy intentionally differs: the controller retains its baseline
// fail-closed treatment of runtime directories, regardless of their age.
// New gates are NEVER published empty. Private candidates may survive a crash but
// are not acquisition blockers. This is process-crash safety, not fsync durability.
function codeOf(error) {
  return error.code;
}

function statOrMissing(name) {
  try {
    return fs.lstatSync(name);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function readOrMissing(name) {
  try {
    return fs.readFileSync(name, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function unlinkOrMissing(name) {
  try {
    fs.unlinkSync(name);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

function removeEmptyGate(gate) {
  try {
    fs.rmdirSync(gate);
  } catch (error) {
    // A successor's nonempty gate must survive delayed cleanup of an old token.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error) ?? '')) throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

function parsePid(value) {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function writeComplete(name, content) {
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

function recoverGate(gate) {
  let entries;
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
  const match = /^owner-([1-9][0-9]*)-([a-f0-9-]{36})$/.exec(entry);
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

function acquireGate(gate, token) {
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

function readLockInfo(lockPath) {
  const stat = statOrMissing(lockPath);
  if (!stat) return null;
  return { stat, content: stat.isFile() ? readOrMissing(lockPath) : null };
}

function sameLock(left, right) {
  return (
    right !== null &&
    left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino &&
    left.stat.birthtimeMs === right.stat.birthtimeMs &&
    left.content === right.content
  );
}

function recoverDataLock(lockPath) {
  const observed = readLockInfo(lockPath);
  if (!observed) return;
  if (observed.stat.isDirectory()) {
    // proper-lockfile owners do not participate in our transition gate. Age
    // cannot prove release, and even a final stat cannot fence a fresh successor
    // arriving before rmdir. Only the runtime may release its canonical directory.
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

function releaseLock(lockPath, token) {
  const observed = readLockInfo(lockPath);
  const lines = observed?.content?.split('\n');
  if (lines?.[0] === String(process.pid) && lines[2] === token) unlinkOrMissing(lockPath);
}

function tryAcquire(lockPath, token) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const gate = `${lockPath}-transition-v2`;
  const entry = acquireGate(gate, token);
  if (entry === null) return false;
  let published = false;
  try {
    try {
      recoverDataLock(lockPath);
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

function sleepSync(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous callers need the same cross-process lock as controller writes.
  }
}

function resolveLockOptions(options) {
  return {
    acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
    retryIntervalMs: options.retryIntervalMs ?? RETRY_INTERVAL_MS,
  };
}

function withFileLockSync(filePath, fn, options = {}) {
  const resolvedOptions = resolveLockOptions(options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + resolvedOptions.acquireTimeoutMs;
  const token = randomUUID();

  while (!tryAcquire(lockPath, token)) {
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

module.exports = { withFileLockSync };
