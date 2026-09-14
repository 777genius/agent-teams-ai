import { DatabaseSync } from 'node:sqlite';

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { readProcessStartTimeMs } from '@main/utils/processStartTime';
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
// A probe that could not observe the owner must expire, or one slow probe becomes a
// permanent "owner is alive" verdict, but it must not expire per retry: at the 25ms
// retry cadence a miss shorter than the loop keeps a powershell.exe spawn running for
// the whole acquire window. A miss therefore covers a stretch of retries, with a floor
// so a fast loop cannot drive the spawn rate on its own.
const PROCESS_START_MISS_CACHE_RETRY_INTERVALS = 20;
const MIN_PROCESS_START_MISS_CACHE_TTL_MS = 1_000;
// Reading a start time shells out to powershell.exe on Windows, whose startup alone
// costs the better part of a second on a loaded machine; the margin has to cover
// that, not the query itself. What is left of the acquire budget caps it, so a probe
// cannot keep an acquire running seconds past the deadline it promised.
const PROCESS_START_PROBE_TIMEOUT_MS = 5_000;
// The cap still has to leave a probe room to answer at all: a short acquire budget
// that starves every probe could never reclaim a crash-left lease from a recycled pid,
// and the answer outlives this acquire in the cache anyway. What the acquire itself
// waits for is its own budget, never this floor: see settleOwnerProbeWithinBudget.
const MIN_PROCESS_START_PROBE_TIMEOUT_MS = 1_000;
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

/** What one acquire attempt may still spend on observing the current owner. */
interface OwnerProbeBudget {
  deadline: number;
  retryIntervalMs: number;
}

const lockDatabases = new Map<string, DatabaseSync>();
const activeOwnerTokens = new Set<string>();
const observedProcessStarts = new Map<number, { startedAt: number | null; expiresAt: number }>();
const pendingProcessStartProbes = new Map<number, Promise<number | null>>();

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

function assertSafeScope(teamName: string, persistenceScope: ReviewDecisionPersistenceScope): void {
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

function buildScopeId(teamName: string, persistenceScope: ReviewDecisionPersistenceScope): string {
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

function startOrJoinProcessStartProbe(
  pid: number,
  budget: OwnerProbeBudget,
  remainingBudgetMs: number
): Promise<number | null> {
  const inFlight = pendingProcessStartProbes.get(pid);
  // Concurrent acquires of different scopes routinely inspect the same owner PID;
  // joining the in-flight probe keeps that to one process spawn.
  if (inFlight) return inFlight;
  const missCacheTtlMs = Math.max(
    MIN_PROCESS_START_MISS_CACHE_TTL_MS,
    budget.retryIntervalMs * PROCESS_START_MISS_CACHE_RETRY_INTERVALS
  );
  const probe = readProcessStartTimeMs(
    pid,
    process.platform,
    Math.min(
      PROCESS_START_PROBE_TIMEOUT_MS,
      Math.max(remainingBudgetMs, MIN_PROCESS_START_PROBE_TIMEOUT_MS)
    )
  )
    // If process identity cannot be observed, keep the live PID owner conservatively.
    .catch(() => null)
    .then((startedAt) => {
      observedProcessStarts.set(pid, {
        startedAt,
        expiresAt: Date.now() + (startedAt === null ? missCacheTtlMs : PROCESS_START_CACHE_TTL_MS),
      });
      return startedAt;
    })
    .finally(() => {
      if (pendingProcessStartProbes.get(pid) === probe) pendingProcessStartProbes.delete(pid);
    });
  pendingProcessStartProbes.set(pid, probe);
  return probe;
}

/**
 * The probe's clock and the acquire's budget are two different clocks, and this is
 * where they are kept apart.
 *
 * A probe this acquire starts keeps a floor of MIN_PROCESS_START_PROBE_TIMEOUT_MS so
 * the spawn can answer at all, and a probe joined from another acquire answers on the
 * timeout whoever started it chose. Either can outlive the acquire waiting here, so
 * what this acquire waits on is its own remaining budget: an acquire that promised
 * 100ms must not return a second late because a probe was still thinking.
 *
 * An expired budget reads exactly like a probe that could not answer - "start time
 * unobservable", keep the live owner - which is the conservative direction this
 * module already takes everywhere. Nothing is cancelled: the probe runs on and files
 * its answer in `observedProcessStarts`, so the next retry of this acquire, or the
 * next acquire of any scope with the same owner, reads an answer nobody waited for.
 */
function settleOwnerProbeWithinBudget(
  probe: Promise<number | null>,
  remainingBudgetMs: number
): Promise<number | null> {
  return new Promise((resolve) => {
    const budgetExpiry = setTimeout(() => resolve(null), remainingBudgetMs);
    const settle = (startedAt: number | null): void => {
      clearTimeout(budgetExpiry);
      resolve(startedAt);
    };
    void probe.then(settle, () => settle(null));
  });
}

function getProcessStartedAt(pid: number, budget: OwnerProbeBudget): Promise<number | null> {
  if (pid === process.pid) return Promise.resolve(PROCESS_STARTED_AT);
  const cached = observedProcessStarts.get(pid);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.startedAt);
  const remainingBudgetMs = budget.deadline - Date.now();
  // The acquire is already over: a spawn started now could only outlive it, so answer
  // the same "unobservable" the caller would have to assume anyway.
  if (remainingBudgetMs <= 0) return Promise.resolve(null);
  return settleOwnerProbeWithinBudget(
    startOrJoinProcessStartProbe(pid, budget, remainingBudgetMs),
    remainingBudgetMs
  );
}

async function isStaleOwner(row: ReviewScopeLockRow, budget: OwnerProbeBudget): Promise<boolean> {
  if (!isProcessAlive(row.owner_pid)) return true;
  // A recycled PID must not keep a crash-left row forever. The same process can
  // import this module more than once, so tolerate small uptime rounding drift.
  const observedProcessStart = await getProcessStartedAt(row.owner_pid, budget);
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

async function tryAcquireLease(
  database: DatabaseSync,
  scopeId: string,
  ownerToken: string,
  budget: OwnerProbeBudget
): Promise<boolean> {
  const observed = database
    .prepare(
      'SELECT owner_token, owner_pid, owner_started_at FROM review_scope_locks WHERE scope_id = ?'
    )
    .get(scopeId) as unknown as ReviewScopeLockRow | undefined;
  // The owner probe must settle before BEGIN IMMEDIATE: awaiting inside the
  // transaction would hold the write lock across a process spawn. The row is
  // re-read below because this pre-read can go stale while the probe runs.
  const observedIsStale =
    !observed || observed.owner_token === ownerToken || (await isStaleOwner(observed, budget));

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
    if (row && row.owner_token !== ownerToken && (!observedOwnerIsUnchanged || !observedIsStale)) {
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
  const budget: OwnerProbeBudget = { deadline, retryIntervalMs: options.retryIntervalMs };

  while (true) {
    try {
      if (await tryAcquireLease(database, scopeId, ownerToken, budget)) {
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
  let releaseError: Error | undefined;
  try {
    await releaseLease(lease);
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error));
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
  pendingProcessStartProbes.clear();
}
