import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as lockfile from 'proper-lockfile';

import {
  allocateAtomicCreateRecoveryDirectoryAuthority,
  type AtomicCreateRecoveryDirectoryAuthority,
} from './atomicCreateCleanupRecoveryDirectory';
import { withAtomicCreateCleanupLeaseLifetime } from './atomicCreateCleanupLeaseLifetime';
import {
  type AtomicCreateLeaseOwner,
  publishAdmissionOwner,
  publishLeaseOwner,
  retireStaleAdmissionOwner,
} from './atomicCreateCleanupLeasePublication';
import { reclaimExpiredAtomicCreateLeases } from './atomicCreateCleanupLeaseReclamation';
import { readBoundedRegularText } from './atomicCreateCleanupRecoveryIo';
import { boundedLeaseDirectories } from './atomicCreateCleanupLeaseScanning';
import { lstatOrNull } from './atomicWriteRecovery';
import {
  getDurableFileIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
  isSameDurablePathIdentity,
  type DurableFileIdentity,
  type DurablePathIdentity,
} from './durablePathIdentity';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

const CAPACITY = 64;
const LEASE_PREFIX = '.atomic-create-cleanup-lease-';
const RETIRED_LEASE_PREFIX = '.atomic-create-cleanup-retired-lease-';
const LEASE_OWNER_NAME = 'owner.json';
const LEASE_MAX_AGE_MS = 30_000;
const LEASE_HEARTBEAT_MS = 5_000;
const RETRY_DELAY_MS = 12;
const ADMISSION_LOCK_NAME = '.atomic-create-cleanup-admission';
const ADMISSION_OWNER_NAME = '.atomic-create-cleanup-admission-owner.json';
const LOCK_RETRIES = { retries: 40, factor: 1.25, minTimeout: 5, maxTimeout: 100 };
const MAX_ADMISSION_ATTEMPTS = 80;
const MAX_LEASE_CLAIM_ATTEMPTS = 160;
const MAX_OWNER_RECORD_BYTES = 4 * 1024;

interface ClaimedLease {
  name: string;
  owner: AtomicCreateLeaseOwner;
  ownerIdentity: DurableFileIdentity;
  releaseOwnerLock: () => Promise<void>;
}

type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

function ownerPath(directory: string, lease: string): string {
  return path.join(directory, lease, LEASE_OWNER_NAME);
}

function admissionOwnerPath(directory: string): string {
  return path.join(directory, ADMISSION_OWNER_NAME);
}

function parseOwner(value: string): AtomicCreateLeaseOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<AtomicCreateLeaseOwner>;
    if (
      owner.version !== 1 ||
      typeof owner.fence !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(owner.fence) ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      (owner.incarnation !== null && typeof owner.incarnation !== 'string') ||
      (owner.released !== undefined && owner.released !== true)
    )
      return null;
    return owner as AtomicCreateLeaseOwner;
  } catch {
    return null;
  }
}

async function processIncarnation(pid: number): Promise<string | null> {
  // /proc/<pid>/stat field 22 is the kernel process start time.  Other
  // platforms do not expose a comparable primitive through Node, so they
  // conservatively retain a live PID rather than guessing after reuse.
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

type AdmissionOwnerState = 'live' | 'dead' | 'incarnation-mismatch' | 'unknown';

/**
 * A readable owner is never stale merely because one of its supporting
 * observations is unavailable.  In particular, /proc can be transiently
 * unreadable while a process is alive.  Only ESRCH or a different, readable
 * incarnation authorizes the exact-generation retirement path.
 */
async function classifyAdmissionOwner(
  owner: AtomicCreateLeaseOwner | null
): Promise<AdmissionOwnerState> {
  if (!owner) return 'unknown';
  if (!processIsAlive(owner.pid)) return 'dead';
  if (owner.incarnation === null) return 'live';
  const currentIncarnation = await processIncarnation(owner.pid);
  if (currentIncarnation === null || currentIncarnation === owner.incarnation) return 'live';
  return 'incarnation-mismatch';
}

async function capacityLeases(directory: string): Promise<string[]> {
  return boundedLeaseDirectories(directory, [LEASE_PREFIX, RETIRED_LEASE_PREFIX], CAPACITY);
}

interface AdmissionLease {
  assertOwnership: () => Promise<void>;
}

/**
 * The directory incarnation produced by mkdtemp while this caller still has
 * admission.  It must travel with the allocation until the post-mutation
 * fence has been checked: a later pathname observation could instead
 * authenticate a successor installed by the new admission owner.
 */
export type { AtomicCreateRecoveryDirectoryAuthority };

/**
 * proper-lockfile is the portable filesystem lock implementation supported by
 * Node on Linux, macOS, and Windows. A lock acquisition error is never an
 * acknowledgement: failing to acquire the admission lock fails this cleanup
 * closed, rather than allowing two capacity scans to race.
 */
async function withLeaseAdmission<T>(
  directory: string,
  operation: (admission: AdmissionLease) => Promise<T>
): Promise<T> {
  const admissionPath = path.join(directory, `${ADMISSION_LOCK_NAME}.lock`);
  for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt++) {
    const release = await lockfile.lock(path.join(directory, ADMISSION_LOCK_NAME), {
      realpath: false,
      stale: LEASE_MAX_AGE_MS,
      update: LEASE_HEARTBEAT_MS,
      retries: LOCK_RETRIES,
    });
    let waitForLivePredecessor = false;
    let ownerIdentity: DurableFileIdentity | null = null;
    let primaryError: unknown = null;
    const ownerFence = randomUUID();
    try {
      // A stale lock directory can be taken over while its old JavaScript
      // callback is merely paused. Keep a separate live-process fence until
      // that callback exits: a successor waits rather than admitting a 65th
      // authority from a scan concurrent with the old callback's mkdir.
      const priorRawRead = await readBoundedRegularText(
        admissionOwnerPath(directory),
        MAX_OWNER_RECORD_BYTES
      )
        .catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
      // Empty and malformed EEXIST records are not absence. They must travel
      // through the same authenticated exact-generation reaper as a dead
      // parsed owner; age alone never authorizes their removal.
      const priorRaw = priorRawRead;
      const prior = priorRaw === null ? null : parseOwner(priorRaw);
      const priorState = priorRaw === null ? null : await classifyAdmissionOwner(prior);
      if (prior?.released) {
      } else if (priorState === 'live') {
        // An unreadable or malformed owner is a barrier, not evidence of
        // death. Retiring it could let a stale lock callback overlap a new
        // capacity scan.
        waitForLivePredecessor = true;
        continue;
      }
      const owner: AtomicCreateLeaseOwner = {
        version: 1,
        fence: ownerFence,
        pid: process.pid,
        incarnation: await processIncarnation(process.pid),
      };
      if (priorRaw !== null && !prior?.released) {
        // A parsed record reaches this branch only after ESRCH or a readable
        // incarnation mismatch. Empty/malformed bytes have no owner identity,
        // but their no-replace hardlink is still authenticated before exact
        // retirement while the admission lock is held.
        const retirement = await retireStaleAdmissionOwner(directory, priorRaw);
        if (retirement === 'unavailable') {
          // A failed stale reaper is not a transient empty-owner observation.
          // Retrying publication would either spin behind the retained exact
          // generation or, worse, treat a successor as permission to admit a
          // 65th recovery authority.
          throw new Error('Atomic-create cleanup admission owner cannot be retired atomically');
        }
        if (retirement !== 'retired') continue;
        // The exact release checked this already, but publish only after a
        // second observation at this admission boundary. A successor causes a
        // fresh loop and is never consumed by the stale reaper.
        const successor = await readBoundedRegularText(
          admissionOwnerPath(directory),
          MAX_OWNER_RECORD_BYTES
        )
          .catch((error) => {
            if (isMissing(error)) return null;
            throw error;
          });
        if (successor !== null) continue;
      }
      let releasedOwnerIdentity: DurableFileIdentity | undefined;
      if (prior?.released === true) {
        const releasedOwnerStats = await fs.promises.lstat(admissionOwnerPath(directory));
        if (
          !releasedOwnerStats.isFile() ||
          releasedOwnerStats.isSymbolicLink() ||
          !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(releasedOwnerStats))
        ) {
          throw new Error('Atomic-create cleanup released admission owner cannot be authenticated');
        }
        releasedOwnerIdentity = getDurableFileIdentity(releasedOwnerStats);
      }
      const publishedOwnerIdentity = await publishAdmissionOwner(
        directory,
        owner,
        prior?.released === true,
        releasedOwnerIdentity
      );
      if (!publishedOwnerIdentity) {
        // A no-clobber publication race leaves its private complete record for
        // recovery. Retrying would create one fresh pending authority per
        // iteration, so fail closed after this single authenticated election.
        throw new Error('Atomic-create cleanup admission owner publication raced');
      }
      // publishAdmissionOwner has already authenticated this exact public
      // generation and removed its private publication pin. Assign it before
      // any further await so admission-finally can never strand it.
      ownerIdentity = publishedOwnerIdentity;
      const [initial, initialOwner] = await Promise.all([
        fs.promises.lstat(admissionPath),
        fs.promises.lstat(admissionOwnerPath(directory)),
      ]);
      const identity = getDurablePathIdentity(initial);
      if (
        !initialOwner.isFile() ||
        initialOwner.isSymbolicLink() ||
        !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(initialOwner))
      ) {
        throw new Error('Atomic-create cleanup admission owner cannot be authenticated');
      }
      const initialOwnerIdentity = getDurableFileIdentity(initialOwner);
      if (!isSameDurableFileIdentity(initialOwnerIdentity, publishedOwnerIdentity)) {
        throw new Error('Atomic-create cleanup admission owner changed after publication');
      }
      const assertOwnership = async (): Promise<void> => {
        let current: fs.Stats;
        let currentOwner: string;
        let currentOwnerStats: fs.Stats;
        try {
          [current, currentOwner, currentOwnerStats] = await Promise.all([
            fs.promises.lstat(admissionPath),
            readBoundedRegularText(admissionOwnerPath(directory), MAX_OWNER_RECORD_BYTES),
            fs.promises.lstat(admissionOwnerPath(directory)),
          ]);
        } catch (error) {
          if (isMissing(error)) throw new Error('Atomic-create cleanup admission fence was lost');
          throw error;
        }
        const ownerNow = parseOwner(currentOwner);
        if (
          !isSameDurablePathIdentity(getDurablePathIdentity(current), identity) ||
          !currentOwnerStats.isFile() ||
          currentOwnerStats.isSymbolicLink() ||
          !isSameDurableFileIdentity(
            getDurableFileIdentity(currentOwnerStats),
            initialOwnerIdentity
          ) ||
          !ownerNow ||
          ownerNow.released === true ||
          ownerNow.fence !== ownerFence ||
          ownerNow.pid !== process.pid
        )
          throw new Error('Atomic-create cleanup admission fence was lost');
      };
      await assertOwnership();
      return await operation({ assertOwnership });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        const authenticatedOwnerIdentity = ownerIdentity;
        const ownerStats = await fs.promises.lstat(admissionOwnerPath(directory));
        const current = parseOwner(
          await readBoundedRegularText(admissionOwnerPath(directory), MAX_OWNER_RECORD_BYTES)
        );
        if (
          current?.fence === ownerFence &&
          current.pid === process.pid &&
          ownerStats.isFile() &&
          !ownerStats.isSymbolicLink() &&
          authenticatedOwnerIdentity !== null &&
          isSameDurableFileIdentity(getDurableFileIdentity(ownerStats), authenticatedOwnerIdentity)
        ) {
          if (
            !(await publishAdmissionOwner(
              directory,
              { ...current, released: true },
              true,
              authenticatedOwnerIdentity
            ))
          ) {
            throw new Error('Atomic-create admission completion cannot be published atomically');
          }
        }
      } catch (error) {
        if (!isMissing(error)) cleanupErrors.push(error);
      }
      try {
        await release();
        if (waitForLivePredecessor) await sleep();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (primaryError && cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          'Atomic-create admission failed and admission cleanup also failed'
        );
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Atomic-create admission cleanup failed');
      }
    }
  }
  throw new Error(`Atomic-create cleanup admission retries (${MAX_ADMISSION_ATTEMPTS}) exhausted`);
}

async function isLiveLease(directory: string, lease: string): Promise<boolean> {
  try {
    const raw = await readBoundedRegularText(
      ownerPath(directory, lease),
      MAX_OWNER_RECORD_BYTES
    );
    const owner = parseOwner(raw);
    // A partially-written owner is not permanent capacity state.  It remains
    // protected until the lease ages out and the owner lock can be claimed,
    // then reclamation below removes it just like a dead owner.
    if (!owner || !processIsAlive(owner.pid)) return false;
    if (owner.incarnation === null) return true;
    const currentIncarnation = await processIncarnation(owner.pid);
    return currentIncarnation === null || currentIncarnation === owner.incarnation;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Stock Node has no exact unlink/rmdir; it must retain rather than guess. */
async function retireLeaseWithoutExactGeneration(directory: string, lease: string): Promise<void> {
  void directory;
  void lease;
  throw new Error('Atomic-create lease retirement requires an exact-generation primitive');
}

/**
 * Reclaim only a stale *and dead* lease while admission is held. The owner
 * lock is a second fence: even PID reuse or a delayed heartbeat cannot make a
 * live callback reclaimable. A failed owner-lock acquisition is busy/unknown
 * and therefore retained, never treated as permission to remove the lease.
 */
async function reclaimExpiredLeases(
  directory: string,
  assertOwnership: () => Promise<void>
): Promise<void> {
  await reclaimExpiredAtomicCreateLeases(
    directory,
    () => capacityLeases(directory),
    (lease) => isLiveLease(directory, lease),
    (lease) => ownerPath(directory, lease),
    LEASE_MAX_AGE_MS,
    (lease) => retireLeaseWithoutExactGeneration(directory, lease),
    assertOwnership
  );
}

async function claimLease(directory: string): Promise<ClaimedLease> {
  const exact = exactGenerationOperations();
  if (!exact.unlinkExactGeneration || !exact.rmdirExactGeneration) {
    throw new Error('Atomic-create cleanup lease admission requires exact-generation primitives');
  }
  for (let attempt = 0; attempt < MAX_LEASE_CLAIM_ATTEMPTS; attempt++) {
    const lease = await withLeaseAdmission(directory, async ({ assertOwnership }) => {
      await reclaimExpiredLeases(directory, assertOwnership);
      await assertOwnership();
      if ((await capacityLeases(directory)).length >= CAPACITY) return null;
      await assertOwnership();
      const name = `${LEASE_PREFIX}${randomUUID()}`;
      const owner: AtomicCreateLeaseOwner = {
        version: 1,
        fence: randomUUID(),
        pid: process.pid,
        incarnation: await processIncarnation(process.pid),
      };
      const leasePath = path.join(directory, name);
      await fs.promises.mkdir(leasePath, { mode: 0o700 });
      const leaseStats = await fs.promises.lstat(leasePath);
      if (
        !leaseStats.isDirectory() ||
        leaseStats.isSymbolicLink() ||
        !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(leaseStats))
      ) {
        throw new Error('Atomic-create cleanup lease directory cannot be authenticated');
      }
      const leaseIdentity = getDurablePathIdentity(leaseStats);
      // Do not let a stale admission holder write an owner record after its
      // successor has scanned capacity. The unowned directory is recoverable.
      let ownerIdentity: DurableFileIdentity | null = null;
      let releaseOwnerLock: (() => Promise<void>) | null = null;
      try {
        await assertOwnership();
        // publishLeaseOwner returns the exact identity before resolving, so
        // any later failure has cleanup authority from its first visible await.
        ownerIdentity = await publishLeaseOwner(directory, name, owner);
        releaseOwnerLock = await lockfile.lock(ownerPath(directory, name), {
          realpath: false,
          stale: LEASE_MAX_AGE_MS,
          update: LEASE_HEARTBEAT_MS,
          retries: 0,
        });
        await assertOwnership();
        return {
          name,
          owner,
          ownerIdentity: ownerIdentity!,
          releaseOwnerLock: releaseOwnerLock!,
        };
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        try {
          await releaseOwnerLock?.();
        } catch (releaseError) {
          cleanupErrors.push(releaseError);
        }
        if (ownerIdentity) {
          try {
            await retryOnTransientFsError(
              () => exact.unlinkExactGeneration!(ownerPath(directory, name), ownerIdentity!),
              RENAME_PUBLISH_RETRY
            );
          } catch (cleanupError) {
            if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
          }
        }
        const ownerLockPath = `${ownerPath(directory, name)}.lock`;
        try {
          const ownerLockStats = await lstatOrNull(ownerLockPath);
          if (ownerLockStats?.isDirectory()) {
            await retryOnTransientFsError(
              () => exact.rmdirExactGeneration!(ownerLockPath, getDurablePathIdentity(ownerLockStats)),
              RENAME_PUBLISH_RETRY
            );
          }
        } catch (cleanupError) {
          if (!isMissing(cleanupError) && codeOf(cleanupError) !== 'ENOTEMPTY') {
            cleanupErrors.push(cleanupError);
          }
        }
        try {
          await retryOnTransientFsError(
            () => exact.rmdirExactGeneration!(leasePath, leaseIdentity),
            RENAME_PUBLISH_RETRY
          );
        } catch (cleanupError) {
          if (!isMissing(cleanupError) && codeOf(cleanupError) !== 'ENOTEMPTY') {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'Atomic-create lease admission failed and cleanup also failed'
          );
        }
        throw error;
      }
    });
    if (lease) return lease;
    await sleep();
  }
  throw new Error(`Atomic-create cleanup capacity retries (${MAX_LEASE_CLAIM_ATTEMPTS}) exhausted`);
}

/**
 * Compatibility entrypoint for callers that only need an empty directory.
 * Cleanup itself must use the authority-returning helper below: returning this
 * string to createRecoveryRecord would invite a post-admission pathname swap.
 */
export async function allocateAtomicCreateRecoveryDirectory(
  directory: string,
  prefix: string,
  countExisting: () => Promise<number>
): Promise<string> {
  const created = await allocateAtomicCreateRecoveryDirectoryAuthority(
    directory,
    prefix,
    countExisting,
    CAPACITY,
    (operation) => withLeaseAdmission(directory, operation),
    (assertOwnership) => reclaimExpiredLeases(directory, assertOwnership)
  );
  try {
    return created.pathname;
  } finally {
    await created.directoryHandle.close().catch(() => undefined);
  }
}

export async function allocateAtomicCreateRecoveryDirectoryWithAuthority(
  directory: string,
  prefix: string,
  countExisting: () => Promise<number>
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  return allocateAtomicCreateRecoveryDirectoryAuthority(
    directory,
    prefix,
    countExisting,
    CAPACITY,
    (operation) => withLeaseAdmission(directory, operation),
    (assertOwnership) => reclaimExpiredLeases(directory, assertOwnership)
  );
}

async function heartbeatLease(directory: string, lease: ClaimedLease): Promise<void> {
  const pathname = ownerPath(directory, lease.name);
  const [raw, stats] = await Promise.all([
    readBoundedRegularText(pathname, MAX_OWNER_RECORD_BYTES),
    fs.promises.lstat(pathname),
  ]);
  const current = parseOwner(raw);
  if (
    !current ||
    current.fence !== lease.owner.fence ||
    current.pid !== process.pid ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !isSameDurableFileIdentity(getDurableFileIdentity(stats), lease.ownerIdentity)
  ) {
    throw new Error('Atomic-create cleanup lease fence was lost');
  }
  const now = new Date();
  await fs.promises.utimes(path.join(directory, lease.name), now, now);
}

async function releaseLease(directory: string, lease: ClaimedLease): Promise<void> {
  const pathname = ownerPath(directory, lease.name);
  const canReleaseExactly = Boolean(
    exactGenerationOperations().unlinkExactGeneration &&
    exactGenerationOperations().rmdirExactGeneration
  );
  let primaryError: unknown = null;
  try {
    const [raw, stats] = await Promise.all([
      readBoundedRegularText(pathname, MAX_OWNER_RECORD_BYTES),
      fs.promises.lstat(pathname),
    ]);
    const current = parseOwner(raw);
    if (
      !current ||
      current.fence !== lease.owner.fence ||
      current.pid !== process.pid ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !isSameDurableFileIdentity(getDurableFileIdentity(stats), lease.ownerIdentity)
    ) {
      throw new Error('Atomic-create cleanup lease fence was lost before release');
    }
    if (canReleaseExactly) {
      await retryOnTransientFsError(
        () => exactGenerationOperations().unlinkExactGeneration!(pathname, lease.ownerIdentity),
        RENAME_PUBLISH_RETRY
      );
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await lease.releaseOwnerLock();
  } catch (releaseError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, releaseError],
        'Atomic-create lease release failed and owner-lock release also failed'
      );
    }
    throw releaseError;
  }
  if (primaryError) throw primaryError;
  if (!canReleaseExactly) {
    await retireLeaseWithoutExactGeneration(directory, lease.name);
    return;
  }
  const ownerLockPath = `${pathname}.lock`;
  const ownerLockStats = await lstatOrNull(ownerLockPath);
  if (ownerLockStats) {
    await retryOnTransientFsError(
      () =>
        exactGenerationOperations().rmdirExactGeneration!(
          ownerLockPath,
          getDurablePathIdentity(ownerLockStats)
        ),
      RENAME_PUBLISH_RETRY
    ).catch((error) => {
      if (!isMissing(error) && codeOf(error) !== 'ENOTEMPTY') throw error;
    });
  }
  const leasePath = path.join(directory, lease.name);
  const leaseStats = await fs.promises.lstat(leasePath);
  await retryOnTransientFsError(
    () =>
      exactGenerationOperations().rmdirExactGeneration!(
        leasePath,
        getDurablePathIdentity(leaseStats)
      ),
    RENAME_PUBLISH_RETRY
  );
}

/** Caps cleanup transactions across processes and recovers only dead leases. */
export async function withAtomicCreateCleanupCapacity<T>(
  stableDirectoryPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withAtomicCreateCleanupLeaseLifetime(
    operation,
    () => claimLease(stableDirectoryPath),
    (lease) => heartbeatLease(stableDirectoryPath, lease),
    (lease) => releaseLease(stableDirectoryPath, lease),
    LEASE_HEARTBEAT_MS
  );
}
