import * as fs from 'node:fs';

import {
  getSqliteTransactionLockDatabasePath,
  withSqliteTransactionLock,
  withSqliteTransactionLockSync,
} from '@main/services/infrastructure/SqliteTransactionLock';

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  /** Retained for caller compatibility; OS ownership has no wall-clock expiry. */
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
}

function resolveLockOptions(filePath: string, options: FileLockOptions) {
  return {
    acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
    retryIntervalMs: options.retryIntervalMs ?? RETRY_INTERVAL_MS,
    timeoutMessage: `File lock timeout: ${filePath}`,
    ownershipLostMessage: `File lock ownership was lost: ${filePath}`,
  };
}

function assertNoLegacyLock(filePath: string): void {
  try {
    // A simultaneously running pre-migration Desktop process does not know the
    // SQLite namespace. Fence its exact legacy path instead of guessing stale
    // ownership and recreating the original ABA removal hazard.
    fs.lstatSync(`${filePath}.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Legacy file lock ownership is uncertain: ${filePath}`);
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  assertNoLegacyLock(filePath);
  return withSqliteTransactionLockSync(
    getSqliteTransactionLockDatabasePath(filePath),
    fn,
    resolveLockOptions(filePath, options)
  );
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  assertNoLegacyLock(filePath);
  return withSqliteTransactionLock(
    getSqliteTransactionLockDatabasePath(filePath),
    fn,
    resolveLockOptions(filePath, options)
  );
}
