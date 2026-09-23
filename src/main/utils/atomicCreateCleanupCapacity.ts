import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { acquireGenerationBoundCleanupLock } from './atomicCreateCleanupGenerationLock';
import { withAtomicCreateCleanupLeaseLifetime } from './atomicCreateCleanupLeaseLifetime';
import {
  type AtomicCreateLeaseOwner,
  publishAdmissionOwner,
  publishLeaseOwner,
  retireStaleAdmissionOwner,
} from './atomicCreateCleanupLeasePublication';
import { reclaimExpiredAtomicCreateLeases } from './atomicCreateCleanupLeaseReclamation';
import { boundedLeaseDirectories } from './atomicCreateCleanupLeaseScanning';
import {
  allocateAtomicCreateRecoveryDirectoryAuthority,
  type AtomicCreateRecoveryDirectoryAuthority,
} from './atomicCreateCleanupRecoveryDirectory';
import {
  type AtomicCreateRecoveryBudget,
  createAtomicCreateRecoveryBudget,
  readBoundedRegularText,
  readBoundedRegularTextWithIdentity,
  withinAtomicCreateRecoveryBudget,
} from './atomicCreateCleanupRecoveryIo';
import {
  type DurableFileIdentity,
  type DurablePathIdentity,
  getDurableFileIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
  isSameDurablePathIdentity,
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
  directoryIdentity: DurablePathIdentity;
  releaseOwnerLock: () => Promise<void>;
}

type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  mkdtempWithHandle?: (
    prefix: string
  ) => Promise<{ pathname: string; directoryHandle: fs.promises.FileHandle }>;
  mkdirWithHandle?: (
    pathname: string,
    options?: { mode?: number }
  ) => Promise<{ directoryHandle: fs.promises.FileHandle }>;
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

function recoveryMetadata<T>(
  budget: AtomicCreateRecoveryBudget | undefined,
  operation: string,
  work: () => Promise<T>
): Promise<T> {
  return budget ? withinAtomicCreateRecoveryBudget(budget, operation, work) : work();
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

async function capacityLeases(
  directory: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<string[]> {
  return boundedLeaseDirectories(directory, [LEASE_PREFIX, RETIRED_LEASE_PREFIX], CAPACITY, budget);
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
  operation: (admission: AdmissionLease) => Promise<T>,
  budget?: AtomicCreateRecoveryBudget
): Promise<T> {
  const admissionPath = path.join(directory, `${ADMISSION_LOCK_NAME}.lock`);
  for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt++) {
    const acquire = () =>
      acquireGenerationBoundCleanupLock(path.join(directory, ADMISSION_LOCK_NAME), {
        realpath: false,
        stale: LEASE_MAX_AGE_MS,
        update: LEASE_HEARTBEAT_MS,
        retries: LOCK_RETRIES,
      });
    const release = budget
      ? await withinAtomicCreateRecoveryBudget(budget, 'admission-lock', acquire, (pending) => {
          void pending.then(
            (lateRelease) => lateRelease().catch(() => undefined),
            () => undefined
          );
        })
      : await acquire();
    let waitForLivePredecessor = false;
    let ownerIdentity: DurableFileIdentity | null = null;
    let primaryError: unknown = null;
    const ownerFence = randomUUID();
    try {
      // A stale lock directory can be taken over while its old JavaScript
      // callback is merely paused. Keep a separate live-process fence until
      // that callback exits: a successor waits rather than admitting a 65th
      // authority from a scan concurrent with the old callback's mkdir.
      const priorRecord = await readBoundedRegularTextWithIdentity(
        admissionOwnerPath(directory),
        MAX_OWNER_RECORD_BYTES,
        budget
      ).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      // Empty and malformed EEXIST records are not absence. They must travel
      // through the same authenticated exact-generation reaper as a dead
      // parsed owner; age alone never authorizes their removal.
      const priorRaw = priorRecord?.text ?? null;
      const prior = priorRaw === null ? null : parseOwner(priorRaw);
      const priorState = priorRaw === null ? null : await classifyAdmissionOwner(prior);
      if (!prior?.released && priorState === 'live') {
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
        if (!priorRecord) throw new Error('Atomic-create cleanup admission owner disappeared');
        // A parsed record reaches this branch only after ESRCH or a readable
        // incarnation mismatch. Empty/malformed bytes have no owner identity,
        // but their no-replace hardlink is still authenticated before exact
        // retirement while the admission lock is held.
        const retirement = await retireStaleAdmissionOwner(
          directory,
          priorRaw,
          priorRecord.identity,
          budget
        );
        if (retirement !== 'retired') continue;
        // The exact release checked this already, but publish only after a
        // second observation at this admission boundary. A successor causes a
        // fresh loop and is never consumed by the stale reaper.
        const successor = await readBoundedRegularTextWithIdentity(
          admissionOwnerPath(directory),
          MAX_OWNER_RECORD_BYTES,
          budget
        ).catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (successor !== null) continue;
      }
      const releasedOwnerIdentity = prior?.released === true ? priorRecord?.identity : undefined;
      const publishedOwnerIdentity = await publishAdmissionOwner(
        directory,
        owner,
        prior?.released === true,
        releasedOwnerIdentity,
        budget
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
        recoveryMetadata(budget, 'admission-lock-lstat', () => fs.promises.lstat(admissionPath)),
        recoveryMetadata(budget, 'admission-owner-lstat', () =>
          fs.promises.lstat(admissionOwnerPath(directory))
        ),
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
            recoveryMetadata(budget, 'admission-lock-lstat', () =>
              fs.promises.lstat(admissionPath)
            ),
            readBoundedRegularText(admissionOwnerPath(directory), MAX_OWNER_RECORD_BYTES, budget),
            recoveryMetadata(budget, 'admission-owner-lstat', () =>
              fs.promises.lstat(admissionOwnerPath(directory))
            ),
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
      // Admission work may legitimately consume its whole operation budget.
      // Releasing the live-process fence gets an independent finite allowance
      // so a successful callback cannot strand a process-live predecessor.
      const retirementBudget = budget ? createAtomicCreateRecoveryBudget() : undefined;
      try {
        const authenticatedOwnerIdentity = ownerIdentity;
        const currentRecord = await readBoundedRegularTextWithIdentity(
          admissionOwnerPath(directory),
          MAX_OWNER_RECORD_BYTES,
          retirementBudget
        );
        const current = parseOwner(currentRecord.text);
        if (
          current?.fence === ownerFence &&
          current.pid === process.pid &&
          authenticatedOwnerIdentity !== null &&
          isSameDurableFileIdentity(currentRecord.identity, authenticatedOwnerIdentity)
        ) {
          if (
            !(await publishAdmissionOwner(
              directory,
              { ...current, released: true },
              true,
              authenticatedOwnerIdentity,
              retirementBudget
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

async function isLiveLease(
  directory: string,
  lease: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<boolean> {
  try {
    const raw = await readBoundedRegularText(
      ownerPath(directory, lease),
      MAX_OWNER_RECORD_BYTES,
      budget
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
  assertOwnership: () => Promise<void>,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  await reclaimExpiredAtomicCreateLeases(
    directory,
    () => capacityLeases(directory, budget),
    (lease) => isLiveLease(directory, lease, budget),
    (lease) => ownerPath(directory, lease),
    LEASE_MAX_AGE_MS,
    (lease) => retireLeaseWithoutExactGeneration(directory, lease),
    assertOwnership,
    budget
  );
}

async function claimLease(
  directory: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<ClaimedLease> {
  const { unlinkExactGeneration, rmdirExactGeneration, mkdtempWithHandle, mkdirWithHandle } =
    exactGenerationOperations();
  if (!unlinkExactGeneration || !rmdirExactGeneration || !mkdtempWithHandle || !mkdirWithHandle) {
    throw new Error('Atomic-create cleanup lease admission requires exact-generation primitives');
  }
  for (let attempt = 0; attempt < MAX_LEASE_CLAIM_ATTEMPTS; attempt++) {
    const lease = await withLeaseAdmission(
      directory,
      async ({ assertOwnership }) => {
        await reclaimExpiredLeases(directory, assertOwnership, budget);
        await assertOwnership();
        if ((await capacityLeases(directory, budget)).length >= CAPACITY) return null;
        await assertOwnership();
        const namePrefix = path.join(directory, LEASE_PREFIX);
        const owner: AtomicCreateLeaseOwner = {
          version: 1,
          fence: randomUUID(),
          pid: process.pid,
          incarnation: await processIncarnation(process.pid),
        };
        // The lease directory is A only when captured from the creation handle.
        // A post-mkdir pathname lstat could instead grant B release authority.
        const createLeaseDirectory = () => mkdtempWithHandle(namePrefix);
        const { pathname: leasePath, directoryHandle: leaseHandle } = budget
          ? await withinAtomicCreateRecoveryBudget(
              budget,
              'lease-directory-create',
              createLeaseDirectory,
              (pending) => {
                void pending.then(
                  ({ directoryHandle }) => directoryHandle.close().catch(() => undefined),
                  () => undefined
                );
              }
            )
          : await createLeaseDirectory();
        const name = path.basename(leasePath);
        let leaseHandleOpen = true;
        let closeAfterPendingStat = false;
        let leaseIdentity: DurablePathIdentity | null = null;
        let ownerIdentity: DurableFileIdentity | null = null;
        let releaseOwnerLock: (() => Promise<void>) | null = null;
        try {
          const leaseStats = budget
            ? await withinAtomicCreateRecoveryBudget(
                budget,
                'lease-directory-fstat',
                () => leaseHandle.stat(),
                (pending) => {
                  closeAfterPendingStat = true;
                  leaseHandleOpen = false;
                  void pending
                    .catch(() => undefined)
                    .then(() => leaseHandle.close().catch(() => undefined));
                }
              )
            : await leaseHandle.stat();
          const capturedLeaseIdentity = getDurablePathIdentity(leaseStats);
          if (
            !leaseStats.isDirectory() ||
            leaseStats.isSymbolicLink() ||
            !hasTrustworthyDurablePathIdentity(capturedLeaseIdentity)
          ) {
            throw new Error('Atomic-create cleanup lease directory cannot be authenticated');
          }
          leaseIdentity = capturedLeaseIdentity;
          // Do not let a stale admission holder write an owner record after its
          // successor has scanned capacity. The unowned directory is recoverable.
          await assertOwnership();
          // publishLeaseOwner returns the exact identity before resolving, so
          // any later failure has cleanup authority from its first visible await.
          const publishedOwnerIdentity = await publishLeaseOwner(directory, name, owner, budget);
          ownerIdentity = publishedOwnerIdentity;
          const acquiredReleaseOwnerLock = await acquireGenerationBoundCleanupLock(
            ownerPath(directory, name),
            {
              realpath: false,
              stale: LEASE_MAX_AGE_MS,
              update: LEASE_HEARTBEAT_MS,
              retries: 0,
            }
          );
          releaseOwnerLock = acquiredReleaseOwnerLock;
          await assertOwnership();
          await leaseHandle.close();
          leaseHandleOpen = false;
          return {
            name,
            owner,
            ownerIdentity: publishedOwnerIdentity,
            directoryIdentity: capturedLeaseIdentity,
            releaseOwnerLock: acquiredReleaseOwnerLock,
          };
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          try {
            await releaseOwnerLock?.();
          } catch (releaseError) {
            cleanupErrors.push(releaseError);
          }
          const cleanupOwnerIdentity = ownerIdentity;
          if (cleanupOwnerIdentity) {
            try {
              await retryOnTransientFsError(
                () => unlinkExactGeneration(ownerPath(directory, name), cleanupOwnerIdentity),
                RENAME_PUBLISH_RETRY
              );
            } catch (cleanupError) {
              if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
            }
          }
          // proper-lockfile owns its lock directory. Do not inspect a final
          // pathname and turn a replacement lock generation into our cleanup
          // authority after the owner release above.
          try {
            const cleanupLeaseIdentity = leaseIdentity;
            if (!cleanupLeaseIdentity) {
              throw new Error('Atomic-create cleanup lease identity is unknown');
            }
            await retryOnTransientFsError(
              () => rmdirExactGeneration(leasePath, cleanupLeaseIdentity),
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
        } finally {
          if (leaseHandleOpen && !closeAfterPendingStat) {
            await leaseHandle.close().catch(() => undefined);
          }
        }
      },
      budget
    );
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
  countExisting: () => Promise<number>,
  budget?: AtomicCreateRecoveryBudget
): Promise<string> {
  if (!safeCapacityReservationAvailable())
    throw new Error('Atomic-create capacity requires operator reconciliation');
  const created = await allocateAtomicCreateRecoveryDirectoryAuthority(
    directory,
    prefix,
    countExisting,
    CAPACITY,
    (operation) => withLeaseAdmission(directory, operation, budget),
    (assertOwnership) => reclaimExpiredLeases(directory, assertOwnership, budget),
    budget
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
  countExisting: () => Promise<number>,
  budget?: AtomicCreateRecoveryBudget
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  if (!safeCapacityReservationAvailable())
    throw new Error('Atomic-create capacity requires operator reconciliation');
  return allocateAtomicCreateRecoveryDirectoryAuthority(
    directory,
    prefix,
    countExisting,
    CAPACITY,
    (operation) => withLeaseAdmission(directory, operation, budget),
    (assertOwnership) => reclaimExpiredLeases(directory, assertOwnership, budget),
    budget
  );
}

async function heartbeatLease(directory: string, lease: ClaimedLease): Promise<void> {
  const pathname = ownerPath(directory, lease.name);
  const ownerRecord = await readBoundedRegularTextWithIdentity(pathname, MAX_OWNER_RECORD_BYTES);
  const current = parseOwner(ownerRecord.text);
  if (
    !current ||
    current.fence !== lease.owner.fence ||
    current.pid !== process.pid ||
    !isSameDurableFileIdentity(ownerRecord.identity, lease.ownerIdentity)
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
    const ownerRecord = await readBoundedRegularTextWithIdentity(pathname, MAX_OWNER_RECORD_BYTES);
    const current = parseOwner(ownerRecord.text);
    if (
      !current ||
      current.fence !== lease.owner.fence ||
      current.pid !== process.pid ||
      !isSameDurableFileIdentity(ownerRecord.identity, lease.ownerIdentity)
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
  // The lock release owns only the lock generation it acquired. A final
  // pathname reread could observe a successor B, so this layer never removes
  // an owner-lock directory itself.
  const leasePath = path.join(directory, lease.name);
  await retryOnTransientFsError(
    () =>
      exactGenerationOperations().rmdirExactGeneration!(
        leasePath,
        // This identity was captured at this lease's creation, before the
        // owner was published. It remains the sole directory-release token.
        lease.directoryIdentity
      ),
    RENAME_PUBLISH_RETRY
  );
}

/** Caps cleanup transactions across processes and recovers only dead leases. */
export async function withAtomicCreateCleanupCapacity<T>(
  stableDirectoryPath: string,
  operation: () => Promise<T>,
  budget?: AtomicCreateRecoveryBudget
): Promise<T> {
  if (!safeCapacityReservationAvailable())
    throw new Error('Atomic-create capacity requires operator reconciliation');
  return withAtomicCreateCleanupLeaseLifetime(
    operation,
    () => claimLease(stableDirectoryPath, budget),
    (lease) => heartbeatLease(stableDirectoryPath, lease),
    (lease) => releaseLease(stableDirectoryPath, lease),
    LEASE_HEARTBEAT_MS
  );
}

function safeCapacityReservationAvailable(): boolean {
  return false;
}
