const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RENAME_MAX_ATTEMPTS = 8;
const RENAME_RETRY_BASE_DELAY_MS = 40;
const RENAME_RETRY_MAX_DELAY_MS = 250;
const RENAME_RETRY_JITTER_MS = 25;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getRenameRetryDelayMs(attempt) {
  const backoff = Math.min(RENAME_RETRY_BASE_DELAY_MS * attempt, RENAME_RETRY_MAX_DELAY_MS);
  return backoff + Math.floor(Math.random() * (RENAME_RETRY_JITTER_MS + 1));
}

function fsyncFileBestEffort(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
  } catch {
    // Best effort only. Some filesystems do not support fsync for these files.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function renameWithRetrySync(tempPath, filePath) {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        fs.copyFileSync(tempPath, filePath);
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best effort cleanup after cross-device fallback.
        }
        return;
      }

      if (error && RETRYABLE_RENAME_CODES.has(error.code) && attempt < RENAME_MAX_ATTEMPTS) {
        sleepSync(getRenameRetryDelayMs(attempt));
        continue;
      }

      throw error;
    }
  }
}

function atomicWriteFileSync(filePath, data, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.tmp.${crypto.randomUUID()}`);

  try {
    fs.writeFileSync(tempPath, data, options);
    fsyncFileBestEffort(tempPath);
    renameWithRetrySync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Cleanup is best effort. Preserve the original write error.
    }
    throw error;
  }
}

function writeJsonFileSync(filePath, value, options = {}) {
  const suffix = options.trailingNewline === true ? '\n' : '';
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
}

module.exports = {
  atomicWriteFileSync,
  writeJsonFileSync,
};
