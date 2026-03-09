const fs = require('fs');
const path = require('path');

const STALE_TIMEOUT_MS = 30000;
const ACQUIRE_TIMEOUT_MS = 5000;
const SPIN_INTERVAL_MS = 20;

function readLockAge(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const ts = parseInt(content.split('\n')[1] || '', 10);
    if (Number.isFinite(ts)) return Date.now() - ts;
  } catch {
    /* lock may have been released concurrently */
  }
  return null;
}

function tryAcquire(lockPath) {
  try {
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const age = readLockAge(lockPath);
      if (age !== null && age > STALE_TIMEOUT_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another process may have cleaned it */
        }
      }
      return false;
    }
    throw err;
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released or cleaned up */
  }
}

function spinWait(deadlineMs) {
  while (Date.now() < deadlineMs) {
    const waitUntil = Date.now() + SPIN_INTERVAL_MS;
    while (Date.now() < waitUntil) {
      /* busy-wait — intentionally synchronous */
    }
    return;
  }
}

function withFileLockSync(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    spinWait(Math.min(Date.now() + SPIN_INTERVAL_MS, deadline));
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = { withFileLockSync };
