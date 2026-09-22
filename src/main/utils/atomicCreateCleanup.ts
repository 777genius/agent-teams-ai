import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  allocateAtomicCreateRecoveryDirectoryWithAuthority,
  withAtomicCreateCleanupCapacity,
} from './atomicCreateCleanupCapacity';
import { withAtomicCreateDirectoryAuthority } from './atomicCreateDirectoryAuthority';
import {
  canMoveOwnedPrivateChild,
  claimOwnedPrivateDirectory,
  moveOwnedPrivateChild,
  retireOwnedPrivateChild,
  retireOwnedPrivateDirectory,
} from './atomicCreateCleanupIdentity';
import {
  type AtomicCreateRecoveryRecord,
  parseAtomicCreateDirectoryRetirementJournal,
  parseAtomicCreateRecoveryRecord,
} from './atomicCreateCleanupRecord';
import {
  aggregateCleanupError,
  boundedMatchingEntries,
  createRecoveryRecord,
  directoryOpenFlags,
  errorCode,
  readBoundedRegularText,
  syncRecoveryDirectory,
  syncRecoveryRecord,
} from './atomicCreateCleanupRecoveryIo';
import { lstatOrNull } from './atomicWriteRecovery';
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

const ATOMIC_CREATE_TEMP_LINK_PATTERN = /^\.review-create\.[a-f0-9-]+\.tmp$/i;
const ATOMIC_CREATE_CLEANUP_DIRECTORY_PATTERN = /^\.review-create-cleanup-[a-z0-9-]+$/i;
const ATOMIC_CREATE_RETIRED_DIRECTORY_PATTERN = /^\.review-create-cleanup-retired-[a-f0-9-]{36}$/i;
const RECOVERY_RECORD_NAME = '.atomic-create-recovery.json';
const RECOVERY_RECORD_PENDING_NAME = '.atomic-create-recovery.pending.json';
const DIRECTORY_RETIREMENT_JOURNAL_NAME = '.atomic-create-directory-retirement.json';
const RETIRED_DIRECTORY_RETIREMENT_JOURNAL_PATTERN =
  /^\.atomic-create-directory-retirement-retired-[a-f0-9-]{36}$/i;
const RECOVERY_RETIRED_NAME_PATTERN = /^\.atomic-create-retired-[a-f0-9-]{36}$/i;
const MAX_RECOVERY_RECORDS = 64;
const MAX_PUBLIC_GUARDS = MAX_RECOVERY_RECORDS;
const MAX_RECOVERY_RECORD_BYTES = 16 * 1024;

async function removeEmptyCleanupDirectory(
  parentDirectory: string,
  cleanupDirectoryName: string,
  expectedIdentity: DurablePathIdentity
): Promise<boolean> {
  try {
    return await retireOwnedPrivateDirectory(
      parentDirectory,
      cleanupDirectoryName,
      expectedIdentity
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

async function assertRecoveryDirectoryStillOwned(
  cleanupDirectory: string,
  expectedIdentity: DurablePathIdentity
): Promise<void> {
  if (process.platform === 'linux') return;
  const current = await lstatOrNull(cleanupDirectory);
  if (
    !current ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !isSameDurablePathIdentity(getDurablePathIdentity(current), expectedIdentity) ||
    current.birthtimeMs !== expectedIdentity.birthtimeMs
  ) {
    throw new Error(`Atomic-create recovery directory identity changed: ${cleanupDirectory}`);
  }
}

async function releaseDetachedLink(
  detachedPath: string,
  expectedAttachmentIdentity: DurableFileIdentity,
  cleanupDirectory?: string,
  expectedDirectoryIdentity?: DurablePathIdentity,
  recoveryState?: { record: AtomicCreateRecoveryRecord; recordPath: string },
  parentDirectory?: string
): Promise<boolean> {
  try {
    await retryOnTransientFsError(async () => {
      if (cleanupDirectory && expectedDirectoryIdentity) {
        await assertRecoveryDirectoryStillOwned(cleanupDirectory, expectedDirectoryIdentity);
      }
      const directory = cleanupDirectory ?? path.dirname(detachedPath);
      const removed = await retireOwnedPrivateChild(
        directory,
        recoveryState?.record.attachment.name ?? path.basename(detachedPath),
        expectedAttachmentIdentity,
        recoveryState && parentDirectory
          ? (retiredName) =>
              stageRetiredAttachment(directory, parentDirectory, recoveryState, retiredName)
          : undefined
      );
      if (!removed) {
        throw new Error(`Atomic-create detached attachment identity changed: ${detachedPath}`);
      }
    }, RENAME_PUBLISH_RETRY);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
}

async function stageRetiredAttachment(
  cleanupDirectory: string,
  parentDirectory: string,
  recoveryState: { record: AtomicCreateRecoveryRecord; recordPath: string },
  retiredName: string
): Promise<string> {
  const record = recoveryState.record;
  const staged: AtomicCreateRecoveryRecord = {
    ...record,
    attachment: { ...record.attachment, name: retiredName },
  };
  const recordPath = path.join(cleanupDirectory, RECOVERY_RECORD_PENDING_NAME);
  try {
    await fs.promises.writeFile(recordPath, JSON.stringify(staged), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const pending = await readBoundedRecoveryRecord(
      recordPath,
      record.directoryName,
      record.directoryIdentity,
      false
    );
    if (
      !pending ||
      pending.record.nonce !== record.nonce ||
      pending.record.cleanupAuthority !== record.cleanupAuthority ||
      !isSameDurableFileIdentity(pending.record.attachment.identity, record.attachment.identity) ||
      !RECOVERY_RETIRED_NAME_PATTERN.test(pending.record.attachment.name)
    )
      throw new Error(`Atomic-create pending retirement record changed: ${recordPath}`);
    recoveryState.record = pending.record;
    recoveryState.recordPath = recordPath;
    return pending.record.attachment.name;
  }
  await syncRecoveryRecord(recordPath, cleanupDirectory, parentDirectory);
  recoveryState.record = staged;
  recoveryState.recordPath = recordPath;
  return retiredName;
}

interface ValidatedRecoveryRecord {
  record: AtomicCreateRecoveryRecord;
  recordPath: string;
  identity: DurableFileIdentity;
}

async function readBoundedRecoveryRecord(
  recordPath: string,
  directoryName: string,
  directoryIdentity: DurablePathIdentity,
  allowRetiredDirectory: boolean
): Promise<ValidatedRecoveryRecord | null> {
  // lstat rejects FIFOs, devices, and symlinks before open: opening a FIFO can
  // block this startup/recovery scanner indefinitely.
  const beforeOpen = await lstatOrNull(recordPath);
  if (!beforeOpen) return null;
  if (
    !beforeOpen.isFile() ||
    beforeOpen.isSymbolicLink() ||
    !Number.isSafeInteger(beforeOpen.size) ||
    beforeOpen.size < 0 ||
    beforeOpen.size > MAX_RECOVERY_RECORD_BYTES
  ) {
    throw new Error(`Atomic-create recovery record is not a bounded regular file: ${recordPath}`);
  }
  // This shared reader holds a no-follow, nonblocking descriptor and checks
  // the lstat/open identity transition. It also gives recovery records the
  // same byte and time bounds as lease/admission owner records.
  const raw = await readBoundedRegularText(recordPath, MAX_RECOVERY_RECORD_BYTES);
  const record = parseAtomicCreateRecoveryRecord(raw, directoryName, allowRetiredDirectory);
  if (
    !record ||
    !isSameDurablePathIdentity(record.directoryIdentity, directoryIdentity) ||
    record.directoryIdentity.birthtimeMs !== directoryIdentity.birthtimeMs
  ) {
    throw new Error(`Atomic-create recovery authority validation failed: ${recordPath}`);
  }
  return { record, recordPath, identity: getDurableFileIdentity(beforeOpen) };
}

async function withValidatedRecoveryDirectory<T>(
  cleanupDirectory: string,
  cleanupDirectoryName: string,
  operation: (paths: {
    stableDirectory: string;
    records: readonly ValidatedRecoveryRecord[];
    directoryIdentity: DurablePathIdentity;
  }) => Promise<T>
): Promise<T | null> {
  // lstat gives deterministic rejection; O_NOFOLLOW closes the lstat/open race.
  const initialStats = await lstatOrNull(cleanupDirectory);
  if (!initialStats.isDirectory() || initialStats.isSymbolicLink()) {
    throw new Error(
      `Atomic-create recovery directory is not a real directory: ${cleanupDirectory}`
    );
  }
  const directoryHandle = await fs.promises.open(cleanupDirectory, directoryOpenFlags());
  try {
    const openedStats = await directoryHandle.stat();
    if (
      !openedStats.isDirectory() ||
      !isSameDurablePathIdentity(
        getDurablePathIdentity(initialStats),
        getDurablePathIdentity(openedStats)
      ) ||
      initialStats.birthtimeMs !== openedStats.birthtimeMs
    )
      throw new Error(`Atomic-create recovery directory identity changed: ${cleanupDirectory}`);
    const stableDirectory =
      process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}/.` : cleanupDirectory;
    const records: ValidatedRecoveryRecord[] = [];
    const recordNames = [
      RECOVERY_RECORD_NAME,
      RECOVERY_RECORD_PENDING_NAME,
      ...(await boundedMatchingEntries(
        stableDirectory,
        RECOVERY_RETIRED_NAME_PATTERN,
        MAX_RECOVERY_RECORDS,
        'retired-recovery-record'
      )),
    ];
    for (const recordName of recordNames) {
      try {
        const record = await readBoundedRecoveryRecord(
          path.join(stableDirectory, recordName),
          cleanupDirectoryName,
          getDurablePathIdentity(openedStats),
          ATOMIC_CREATE_RETIRED_DIRECTORY_PATTERN.test(cleanupDirectoryName)
        );
        if (record) records.push(record);
      } catch (error) {
        if (!RECOVERY_RETIRED_NAME_PATTERN.test(recordName)) throw error;
      }
    }
    const directoryIdentity = getDurablePathIdentity(openedStats);
    await assertRecoveryDirectoryStillOwned(cleanupDirectory, directoryIdentity);
    return await operation({ stableDirectory, records, directoryIdentity });
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
}

async function readRetirementJournal(
  stableDirectory: string,
  directoryIdentity: DurablePathIdentity
): Promise<{ name: string; identity: DurableFileIdentity } | null> {
  const names = [
    DIRECTORY_RETIREMENT_JOURNAL_NAME,
    ...(await boundedMatchingEntries(
      stableDirectory,
      RETIRED_DIRECTORY_RETIREMENT_JOURNAL_PATTERN,
      1,
      'retired-directory-journal'
    )),
  ];
  let journalPath: string | null = null;
  let journalName: string | null = null;
  for (const name of names) {
    const pathname = path.join(stableDirectory, name);
    if (await lstatOrNull(pathname)) {
      if (journalPath)
        throw new Error(
          `Atomic-create recovery directory has multiple journals: ${stableDirectory}`
        );
      journalPath = pathname;
      journalName = name;
    }
  }
  if (!journalPath || !journalName) return null;
  const beforeOpen = await lstatOrNull(journalPath);
  if (!beforeOpen) return null;
  if (
    !beforeOpen.isFile() ||
    beforeOpen.isSymbolicLink() ||
    !Number.isSafeInteger(beforeOpen.size) ||
    beforeOpen.size < 0 ||
    beforeOpen.size > MAX_RECOVERY_RECORD_BYTES
  ) {
    throw new Error(`Atomic-create recovery directory journal changed: ${journalPath}`);
  }
  const raw = await readBoundedRegularText(journalPath, MAX_RECOVERY_RECORD_BYTES);
  if (!parseAtomicCreateDirectoryRetirementJournal(raw, directoryIdentity)) {
    throw new Error(`Atomic-create recovery directory journal changed: ${journalPath}`);
  }
  return { name: journalName, identity: getDurableFileIdentity(beforeOpen) };
}

async function removeValidatedRecoveryRecordAndDirectory(
  cleanupDirectory: string,
  cleanupDirectoryName: string,
  parentDirectory: string
): Promise<void> {
  await withValidatedRecoveryDirectory(
    cleanupDirectory,
    cleanupDirectoryName,
    async ({ stableDirectory, records, directoryIdentity }) => {
      if (records.length === 0) {
        const journal = await readRetirementJournal(stableDirectory, directoryIdentity);
        if (
          journal &&
          !(await retireOwnedPrivateChild(stableDirectory, journal.name, journal.identity))
        )
          throw new Error(`Atomic-create recovery directory journal changed: ${stableDirectory}`);
        await removeEmptyCleanupDirectory(parentDirectory, cleanupDirectoryName, directoryIdentity);
        return;
      }
      const journalPath = path.join(stableDirectory, DIRECTORY_RETIREMENT_JOURNAL_NAME);
      try {
        await fs.promises.writeFile(
          journalPath,
          JSON.stringify({ version: 1, directoryIdentity }),
          {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          }
        );
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      // Persist intent before rename; scanner recognizes the retirement namespace.
      await syncRecoveryDirectory(stableDirectory);
      const claimed = await claimOwnedPrivateDirectory(
        parentDirectory,
        cleanupDirectoryName,
        directoryIdentity
      );
      if (!claimed)
        throw new Error(`Atomic-create recovery directory identity changed: ${cleanupDirectory}`);
      for (const { record, recordPath, identity } of records) {
        await assertRecoveryDirectoryStillOwned(stableDirectory, record.directoryIdentity);
        const removed = await retireOwnedPrivateChild(
          path.dirname(recordPath),
          path.basename(recordPath),
          identity
        );
        if (!removed)
          throw new Error(`Atomic-create recovery record identity changed: ${recordPath}`);
      }
      const journal = await readRetirementJournal(stableDirectory, directoryIdentity);
      if (
        !journal ||
        !(await retireOwnedPrivateChild(stableDirectory, journal.name, journal.identity))
      ) {
        throw new Error(`Atomic-create recovery directory journal changed: ${journalPath}`);
      }
      await syncRecoveryDirectory(stableDirectory);
      // This targets the claimed retirement name, never the original child.
      if (await retireOwnedPrivateDirectory(parentDirectory, claimed.name, directoryIdentity)) {
        await syncRecoveryDirectory(parentDirectory);
      }
    }
  );
}

async function retainActualDetachedAttachment(
  detachedPath: string,
  cleanupDirectory: string,
  record: AtomicCreateRecoveryRecord
): Promise<'missing' | 'owned' | 'foreign'> {
  const actual = await lstatOrNull(detachedPath);
  if (!actual) return 'missing';
  if (!actual.isFile() || actual.isSymbolicLink()) {
    throw new Error(`Atomic-create detached attachment validation failed: ${cleanupDirectory}`);
  }
  const identity = getDurableFileIdentity(actual);
  if (isSameDurableFileIdentity(identity, record.attachment.identity)) return 'owned';
  // B is not an authority granted by A's record. Leave both B and A's record
  // intact so a later pass cannot delete the foreign generation.
  return 'foreign';
}

/**
 * Retry only authenticated private attachments. It deliberately runs before
 * inspecting targetPath: a replaced target has no authority over an old pin.
 */
async function recoverDetachedLinks(directoryPath: string): Promise<number> {
  const errors: unknown[] = [];
  let retainedRecoveryAuthorities = 0;
  const cleanupDirectories = await boundedMatchingEntries(
    directoryPath,
    /^(?:\.review-create-cleanup-[a-z0-9-]+|\.review-create-cleanup-retired-[a-f0-9-]{36})$/i,
    MAX_RECOVERY_RECORDS,
    'recovery-record'
  );
  for (const entry of cleanupDirectories) {
    const cleanupDirectory = path.join(directoryPath, entry);
    try {
      const recovery = await withValidatedRecoveryDirectory(
        cleanupDirectory,
        entry,
        async ({ stableDirectory, records, directoryIdentity }) => {
          // A recordless directory can only be reclaimed when rmdir proves it
          // empty. Renaming it first protects a replacement; nonempty state is
          // retained and charged rather than guessed away.
          if (records.length === 0) {
            const journal = await readRetirementJournal(stableDirectory, directoryIdentity);
            if (
              journal &&
              !(await retireOwnedPrivateChild(stableDirectory, journal.name, journal.identity))
            )
              throw new Error(
                `Atomic-create recovery directory journal changed: ${cleanupDirectory}`
              );
            return {
              recordless: !(await removeEmptyCleanupDirectory(
                directoryPath,
                entry,
                directoryIdentity
              )),
              directoryIdentity,
            };
          }
          const attachment = (
            await Promise.all(
              records.map(async ({ record, recordPath }) => {
                const pathname = path.join(stableDirectory, record.attachment.name);
                return { pathname, record, recordPath, stats: await lstatOrNull(pathname) };
              })
            )
          ).find(
            ({ record, stats }) =>
              stats !== null &&
              stats.isFile() &&
              !stats.isSymbolicLink() &&
              isSameDurableFileIdentity(getDurableFileIdentity(stats), record.attachment.identity)
          );
          if (attachment) {
            await releaseDetachedLink(
              attachment.pathname,
              attachment.record.attachment.identity,
              stableDirectory,
              directoryIdentity,
              { record: attachment.record, recordPath: attachment.recordPath },
              directoryPath
            );
          }
          if (
            (
              await Promise.all(
                records.map(({ record }) =>
                  lstatOrNull(path.join(stableDirectory, record.attachment.name))
                )
              )
            ).some(Boolean)
          ) {
            throw new Error(
              `Atomic-create recovery attachment remains present: ${cleanupDirectory}`
            );
          }
          return { recordless: false, directoryIdentity };
        }
      );
      if (recovery?.recordless) {
        retainedRecoveryAuthorities++;
      } else if (recovery) {
        await removeValidatedRecoveryRecordAndDirectory(cleanupDirectory, entry, directoryPath);
        // A concurrent write can make rmdir conservatively leave a directory
        // behind after record retirement. It has no record now, but it still
        // consumes a bounded scanner slot for future creation.
        if (await lstatOrNull(cleanupDirectory)) retainedRecoveryAuthorities++;
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Atomic-create cleanup recovery remains pending');
  }
  return retainedRecoveryAuthorities;
}

async function durablyRetainRecoveryRecord(
  recordPath: string,
  cleanupDirectory: string,
  parentDirectory: string,
  primaryError: unknown,
  laterErrors: unknown[]
): Promise<unknown> {
  try {
    await syncRecoveryRecord(recordPath, cleanupDirectory, parentDirectory);
  } catch (syncError) {
    laterErrors.push(syncError);
  }
  return aggregateCleanupError(primaryError, laterErrors);
}

export async function cleanupAtomicCreateTempLinks(targetPath: string): Promise<void> {
  const publicDirectoryPath = path.dirname(targetPath);
  const targetName = path.basename(targetPath);
  await withAtomicCreateDirectoryAuthority(
    publicDirectoryPath,
    async ({ stablePath: directoryPath, assertStillOwned }) =>
      withAtomicCreateCleanupCapacity(directoryPath, async () => {
        await assertStillOwned();
        // Recordless directories remain bounded recovery state.
        await recoverDetachedLinks(directoryPath);

        const target = await fs.promises.lstat(path.join(directoryPath, targetName));
        const targetIdentity = getDurableFileIdentity(target);
        if (
          target.nlink <= 1 ||
          !target.isFile() ||
          target.isSymbolicLink() ||
          !hasTrustworthyDurablePathIdentity(targetIdentity)
        )
          return;

        const entries = await boundedMatchingEntries(
          directoryPath,
          ATOMIC_CREATE_TEMP_LINK_PATTERN,
          MAX_PUBLIC_GUARDS,
          'public-guard'
        );
        for (const entry of entries) {
          const candidatePath = path.join(directoryPath, entry);
          try {
            const candidate = await fs.promises.lstat(candidatePath);
            if (
              !candidate.isFile() ||
              candidate.isSymbolicLink() ||
              !isSameDurableFileIdentity(getDurableFileIdentity(candidate), targetIdentity)
            )
              continue;
            if (!canMoveOwnedPrivateChild()) continue;

            const nonce = randomUUID();
            const cleanupAuthority = randomUUID();
            // Allocate recovery state under the shared cross-process 64-slot quota.
            const allocatedDirectory = await allocateAtomicCreateRecoveryDirectoryWithAuthority(
              directoryPath,
              path.join(directoryPath, `.review-create-cleanup-${nonce}-${cleanupAuthority}-`),
              async () =>
                boundedMatchingEntries(
                  directoryPath,
                  /^(?:\.review-create-cleanup-[a-z0-9-]+|\.review-create-cleanup-retired-[a-f0-9-]{36})$/i,
                  MAX_RECOVERY_RECORDS,
                  'recovery-record'
                ).then((names) => names.length)
            );
            const cleanupDirectoryName = path.basename(allocatedDirectory.pathname);
            if (!ATOMIC_CREATE_CLEANUP_DIRECTORY_PATTERN.test(cleanupDirectoryName)) {
              await allocatedDirectory.directoryHandle.close().catch(() => undefined);
              throw new Error('Atomic-create cleanup directory has an invalid name');
            }
            const {
              record,
              recordPath,
              directoryHandle,
              stableDirectory: cleanupDirectory,
            } = await createRecoveryRecord(
              directoryPath,
              allocatedDirectory,
              cleanupDirectoryName,
              nonce,
              cleanupAuthority,
              entry,
              getDurableFileIdentity(candidate)
            );
            const detachedPath = path.join(cleanupDirectory, entry);
            const recoveryState = { record, recordPath };
            let detached = false;
            let cleanupError: unknown = null;
            try {
              try {
                await assertRecoveryDirectoryStillOwned(cleanupDirectory, record.directoryIdentity);
                detached = await moveOwnedPrivateChild(
                  candidatePath,
                  detachedPath,
                  getDurableFileIdentity(candidate)
                );
              } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error;
              }

              const detachedStats = detached ? await lstatOrNull(detachedPath) : null;
              if (
                detached &&
                detachedStats &&
                detachedStats.isFile() &&
                !detachedStats.isSymbolicLink() &&
                isSameDurableFileIdentity(getDurableFileIdentity(detachedStats), targetIdentity)
              ) {
                try {
                  detached = !(await releaseDetachedLink(
                    detachedPath,
                    targetIdentity,
                    cleanupDirectory,
                    record.directoryIdentity,
                    recoveryState,
                    directoryPath
                  ));
                } catch (initialError) {
                  if (errorCode(initialError) === 'ENOENT') detached = false;
                  else {
                    const laterErrors: unknown[] = [];
                    try {
                      await syncRecoveryRecord(
                        recoveryState.recordPath,
                        cleanupDirectory,
                        directoryPath
                      );
                    } catch (syncError) {
                      laterErrors.push(syncError);
                    }
                    try {
                      detached =
                        (await retainActualDetachedAttachment(
                          path.join(cleanupDirectory, recoveryState.record.attachment.name),
                          cleanupDirectory,
                          recoveryState.record
                        )) !== 'missing';
                    } catch (retentionError) {
                      laterErrors.push(retentionError);
                    }
                    cleanupError = aggregateCleanupError(initialError, laterErrors);
                  }
                }
              } else if (detachedStats) {
                detached =
                  (await retainActualDetachedAttachment(
                    path.join(cleanupDirectory, recoveryState.record.attachment.name),
                    cleanupDirectory,
                    recoveryState.record
                  )) !== 'missing';
              } else detached = false;

              if (!detached) {
                try {
                  await removeValidatedRecoveryRecordAndDirectory(
                    cleanupDirectory,
                    recoveryState.record.directoryName,
                    directoryPath
                  );
                } catch (directoryError) {
                  cleanupError = cleanupError
                    ? aggregateCleanupError(cleanupError, [directoryError])
                    : directoryError;
                }
              }
            } catch (error) {
              cleanupError = detached
                ? await durablyRetainRecoveryRecord(
                    recoveryState.recordPath,
                    cleanupDirectory,
                    directoryPath,
                    error,
                    []
                  )
                : cleanupError
                  ? aggregateCleanupError(cleanupError, [error])
                  : error;
            }
            await directoryHandle.close().catch((closeError) => {
              cleanupError = cleanupError
                ? aggregateCleanupError(cleanupError, [closeError])
                : closeError;
            });
            if (cleanupError) throw cleanupError;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        }
      })
  );
}
