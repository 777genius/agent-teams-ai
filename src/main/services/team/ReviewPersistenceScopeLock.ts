import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ReviewDecisionPersistenceScope } from '@shared/types/review';

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 25;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const PROCESS_START_CACHE_TTL_MS = 5_000;
const PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);
const LOGICAL_SCOPE_LOCK_TOKEN = 'review-persistence-logical-scope:v1';

interface ReviewPersistenceScopeLockOptions {
  acquireTimeoutMs?: number;
  retryIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

interface ReviewScopeLockRow {
  owner_token: string;
  owner_pid: number;
  owner_started_at: number;
}

interface ReviewScopeLockLease {
  database: DatabaseSync;
  scopeId: string;
  ownerToken: string;
}

const lockDatabases = new Map<string, DatabaseSync>();
const activeOwnerTokens = new Set<string>();
const observedProcessStarts = new Map<number, { startedAt: number | null; expiresAt: number }>();

function getLockDatabasePath(): string {
  return path.join(getTeamsBasePath(), '.review-persistence-locks.sqlite3');
}

function openLockDatabase(): DatabaseSync {
  const databasePath = getLockDatabasePath();
  const cached = lockDatabases.get(databasePath);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS review_scope_locks (
        scope_id TEXT PRIMARY KEY NOT NULL,
        owner_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_started_at INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      ) STRICT
    `);
    fs.chmodSync(databasePath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.chmodSync(`${databasePath}${suffix}`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
  lockDatabases.set(databasePath, database);
  return database;
}

function assertSafeScope(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope
): void {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error('Invalid review persistence lock team name');
  }
  if (!SCOPE_KEY_PATTERN.test(persistenceScope.scopeKey)) {
    throw new Error('Invalid review persistence lock scope key');
  }
  if (
    !persistenceScope.scopeToken ||
    persistenceScope.scopeToken.length > 32 * 1024 * 1024 ||
    persistenceScope.scopeToken.includes('\0')
  ) {
    throw new Error('Invalid review persistence lock scope token');
  }
}

function buildScopeId(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope
): string {
  return createHash('sha256')
    .update(teamName)
    .update('\0')
    .update(persistenceScope.scopeKey)
    .update('\0')
    .update(persistenceScope.scopeToken)
    .digest('hex');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function getProcessStartedAt(pid: number): number | null {
  if (pid === process.pid) return PROCESS_STARTED_AT;
  const cached = observedProcessStarts.get(pid);
  if (cached && cached.expiresAt > Date.now()) return cached.startedAt;
  let startedAt: number | null = null;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', timeout: 1_000, windowsHide: true }
      );
      if (result.status === 0) {
        const parsed = Date.parse(result.stdout.trim());
        startedAt = Number.isFinite(parsed) ? parsed : null;
      }
    } else {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      });
      if (result.status === 0) {
        const parsed = Date.parse(result.stdout.trim());
        startedAt = Number.isFinite(parsed) ? parsed : null;
      }
    }
  } catch {
    // If process identity cannot be observed, keep the live PID owner conservatively.
  }
  observedProcessStarts.set(pid, {
    startedAt,
    expiresAt: Date.now() + PROCESS_START_CACHE_TTL_MS,
  });
  return startedAt;
}

function isStaleOwner(row: ReviewScopeLockRow): boolean {
  if (!isProcessAlive(row.owner_pid)) return true;
  // A recycled PID must not keep a crash-left row forever. The same process can
  // import this module more than once, so tolerate small uptime rounding drift.
  const observedProcessStart = getProcessStartedAt(row.owner_pid);
  if (
    observedProcessStart !== null &&
    Math.abs(row.owner_started_at - observedProcessStart) > 10_000
  ) {
    return true;
  }
  return row.owner_pid === process.pid && !activeOwnerTokens.has(row.owner_token);
}

function rollbackBestEffort(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // BEGIN may itself have failed, or SQLite may already have rolled back.
  }
}

function tryAcquireLease(
  database: DatabaseSync,
  scopeId: string,
  ownerToken: string
): boolean {
  const observed = database
    .prepare(
      'SELECT owner_token, owner_pid, owner_started_at FROM review_scope_locks WHERE scope_id = ?'
    )
    .get(scopeId) as unknown as ReviewScopeLockRow | undefined;
  const observedIsStale =
    !observed || observed.owner_token === ownerToken || isStaleOwner(observed);

  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database
      .prepare(
        'SELECT owner_token, owner_pid, owner_started_at FROM review_scope_locks WHERE scope_id = ?'
      )
      .get(scopeId) as unknown as ReviewScopeLockRow | undefined;
    const observedOwnerIsUnchanged =
      !!observed &&
      !!row &&
      observed.owner_token === row.owner_token &&
      observed.owner_pid === row.owner_pid &&
      observed.owner_started_at === row.owner_started_at;
    if (
      row &&
      row.owner_token !== ownerToken &&
      (!observedOwnerIsUnchanged || !observedIsStale)
    ) {
      database.exec('COMMIT');
      return false;
    }

    const now = Date.now();
    database
      .prepare(
        `INSERT INTO review_scope_locks (
          scope_id, owner_token, owner_pid, owner_started_at, acquired_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET
          owner_token = excluded.owner_token,
          owner_pid = excluded.owner_pid,
          owner_started_at = excluded.owner_started_at,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at`
      )
      .run(scopeId, ownerToken, process.pid, PROCESS_STARTED_AT, now, now);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    rollbackBestEffort(database);
    throw error;
  }
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:busy|locked)/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLease(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  options: Required<ReviewPersistenceScopeLockOptions>
): Promise<ReviewScopeLockLease> {
  const database = openLockDatabase();
  const scopeId = buildScopeId(teamName, persistenceScope);
  const ownerToken = randomUUID();
  const deadline = Date.now() + options.acquireTimeoutMs;

  while (true) {
    try {
      if (tryAcquireLease(database, scopeId, ownerToken)) {
        activeOwnerTokens.add(ownerToken);
        return { database, scopeId, ownerToken };
      }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error('Review changes are busy in another app process; retry shortly.');
    }
    await sleep(Math.min(options.retryIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function heartbeatLease(lease: ReviewScopeLockLease): boolean {
  const result = lease.database
    .prepare(
      'UPDATE review_scope_locks SET heartbeat_at = ? WHERE scope_id = ? AND owner_token = ?'
    )
    .run(Date.now(), lease.scopeId, lease.ownerToken);
  return Number(result.changes) === 1;
}

function assertLeaseOwner(lease: ReviewScopeLockLease): void {
  const row = lease.database
    .prepare('SELECT owner_token FROM review_scope_locks WHERE scope_id = ?')
    .get(lease.scopeId) as unknown as { owner_token: string } | undefined;
  if (row?.owner_token !== lease.ownerToken) {
    throw new Error('Review persistence lock ownership was lost during the operation');
  }
}

async function releaseLease(lease: ReviewScopeLockLease): Promise<void> {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      lease.database
        .prepare('DELETE FROM review_scope_locks WHERE scope_id = ? AND owner_token = ?')
        .run(lease.scopeId, lease.ownerToken);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      await sleep(10);
    }
  }
}

export async function withReviewPersistenceScopeLock<T>(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  operation: () => Promise<T>,
  options: ReviewPersistenceScopeLockOptions = {}
): Promise<T> {
  assertSafeScope(teamName, persistenceScope);
  const resolvedOptions: Required<ReviewPersistenceScopeLockOptions> = {
    acquireTimeoutMs: options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    retryIntervalMs: options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  };
  const lease = await acquireLease(teamName, persistenceScope, resolvedOptions);
  let ownershipLost = false;
  const heartbeat = setInterval(() => {
    try {
      ownershipLost ||= !heartbeatLease(lease);
    } catch {
      // A final owner check distinguishes a transient busy database from a lost lease.
    }
  }, resolvedOptions.heartbeatIntervalMs);
  heartbeat.unref();

  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation();
    if (ownershipLost) {
      throw new Error('Review persistence lock ownership was lost during the operation');
    }
    assertLeaseOwner(lease);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  clearInterval(heartbeat);
  let releaseError: unknown;
  try {
    await releaseLease(lease);
  } catch (error) {
    releaseError = error;
  }
  activeOwnerTokens.delete(lease.ownerToken);
  if (operationFailed) throw operationError;
  if (releaseError) throw releaseError;
  return result as T;
}

/**
 * Serializes retention and recovery discovery across every exact fingerprint of one
 * logical task/agent scope. Callers should acquire this before the exact-scope lock.
 */
export async function withReviewPersistenceLogicalScopeLock<T>(
  teamName: string,
  scopeKey: string,
  operation: () => Promise<T>,
  options: ReviewPersistenceScopeLockOptions = {}
): Promise<T> {
  return withReviewPersistenceScopeLock(
    teamName,
    { scopeKey, scopeToken: LOGICAL_SCOPE_LOCK_TOKEN },
    operation,
    options
  );
}

export function closeReviewPersistenceScopeLockDatabasesForTests(): void {
  for (const database of lockDatabases.values()) database.close();
  lockDatabases.clear();
  activeOwnerTokens.clear();
  observedProcessStarts.clear();
}
