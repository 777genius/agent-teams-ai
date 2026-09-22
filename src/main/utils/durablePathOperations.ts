import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { durablePathComponent } from './durablePathComponent';
import { removeDurablePathExactAsync } from './durableExactRemoval';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
} from './durablePathIdentity';
import {
  type DetachedRemovalPublicReservationRecord,
  getDetachedRemovalPublicReservationPhase,
  persistDetachedRemovalPublicReservationRecord,
  readDetachedRemovalPublicReservationRecord,
  removeDetachedRemovalPublicReservationRecord,
  resumeDeterministicDetachedRemoval,
} from './durableDetachedRemoval';
import { createEnsureTombstone } from './durableReservationTombstone';
import { createRemoveOwnedTombstone } from './durableReservationTombstoneCleanup';
import {
  type AtomicPathRemovalResult,
  type DurablePathRemovalProofHooks,
  hasTrustworthyDurableFilesystemIdentity,
  isSameTrustedDurableFilesystemIdentity,
  renameWithTransientRetry,
  readBoundedFileHandleUtf8Async,
  rmdirDurablePathIfIdentityMatchesAsync,
  syncDirectory,
  durablePathStillHasIdentityAsync,
  unlinkDurablePathIfIdentityMatchesAsync,
  withIdentityStableDirectoryPathAsync,
} from './durablePathOperationSupport';

export * from './durablePathOperationSupport';

export async function removePathWithIdentityFenceAsync(
  targetPath: string,
  options: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    validateDetached?: (detachedPath: string, identity: DurablePathIdentity) => Promise<boolean>;
    durability?: 'best-effort' | 'strict';
    /**
     * Route writes which still use the public directory name into a durable
     * reservation while the detached object is validated and removed.
     */
    reservePublicDirectory?: boolean;
    proofHooks?: DurablePathRemovalProofHooks;
  } = {}
): Promise<AtomicPathRemovalResult> {
  const dir = path.dirname(targetPath);
  const detachedPath =
    options.proofHooks?.detachedPath ??
    path.join(
      dir,
      durablePathComponent(`.${path.basename(targetPath)}`, `.deleting.${randomUUID()}`)
    );
  const removalOptions = {
    ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
  };
  let detached = false;
  let detachedIdentity: DurablePathIdentity | null = null;
  let publicReservationPath: string | null = null;
  let publicReservationPublished = false;
  let publicReservationReconciled = false;
  let publicReservationRecord: DetachedRemovalPublicReservationRecord | null = null;
  let publicReservationRecordPersisted = false;

  const persistPublicReservationPhase = async (
    phase: NonNullable<DetachedRemovalPublicReservationRecord['phase']>,
    publication: DetachedRemovalPublicReservationRecord['publication'] =
      publicReservationRecord?.publication
  ): Promise<void> => {
    if (!publicReservationRecord || !publicReservationRecordPersisted) {
      throw new Error('Public reservation is missing its durable transaction record');
    }
    const nextRecord = { ...publicReservationRecord, phase, publication };
    if (JSON.stringify(nextRecord) === JSON.stringify(publicReservationRecord)) return;
    await persistDetachedRemovalPublicReservationRecord({
      record: nextRecord,
      parentDirectory: dir,
      syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
      allowPhaseAdvance: true,
    });
    publicReservationRecord = nextRecord;
  };

  const isOwnedMarker = async (markerPath: string, nonce: string): Promise<boolean> => {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(
        markerPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      const stats = await handle.stat();
      return (
        stats.isFile() &&
        stats.size <= 512 &&
        (await readBoundedFileHandleUtf8Async(handle, 512)) === `${nonce}\n`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  /**
   * Publish the ownership receipt with link(2), not a visible O_EXCL file.
   * A stopped writer can leave a partial random temp, but the authoritative
   * pathname is either a complete, synced receipt or absent.  In particular,
   * an empty/partial pre-existing marker is never treated as our authority.
   */
  const createOwnedMarker = async (markerPath: string, nonce: string): Promise<boolean> => {
    const tempPath = path.join(
      path.dirname(markerPath),
      `.review-owner.${randomUUID()}.tmp`
    );
    let handle: fs.promises.FileHandle | null = null;
    let tempIdentity: DurablePathIdentity | null = null;
    try {
      handle = await fs.promises.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(`${nonce}\n`, 'utf8');
      await handle.sync();
      tempIdentity = getDurablePathIdentity(await handle.stat());
      await handle.close();
      handle = null;
      try {
        await fs.promises.link(tempPath, markerPath);
      } catch (error) {
        // A receipt that was already visible is never adopted.  A matching
        // byte sequence is not proof that this transaction created it.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      return true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (tempIdentity) {
        await unlinkDurablePathIfIdentityMatchesAsync(tempPath, tempIdentity).catch(() => undefined);
      }
    }
  };

  const removeOwnedMarker = async (markerPath: string, nonce: string): Promise<boolean> => {
    const access = await withIdentityStableDirectoryPathAsync(
      path.dirname(markerPath),
      async (stableParentPath) => {
        const stableMarkerPath = path.join(stableParentPath, path.basename(markerPath));
        if (!(await isOwnedMarker(stableMarkerPath, nonce))) return false;
        const identity = getDurablePathIdentity(await fs.promises.lstat(stableMarkerPath));
        return unlinkDurablePathIfIdentityMatchesAsync(stableMarkerPath, identity);
      },
      { errorPath: markerPath }
    );
    return access.state === 'opened' && access.value;
  };

  const isOwnedReservation = async (
    record: DetachedRemovalPublicReservationRecord
  ): Promise<fs.Stats | null> => {
    if (!record.reservationIdentity || !record.reservationMarkerPath) return null;
    try {
      const stats = await fs.promises.lstat(record.reservationPath);
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        !isSameTrustedDurableFilesystemIdentity(
          getDurablePathIdentity(stats),
          record.reservationIdentity
        ) ||
        stats.birthtimeMs !== record.reservationIdentity.birthtimeMs ||
        !(await isOwnedMarker(record.reservationMarkerPath, record.reservationNonce))
      ) {
        return null;
      }
      return stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  const ensureOwnedReservation = async (): Promise<DetachedRemovalPublicReservationRecord | null> => {
    const record = publicReservationRecord;
    if (!record || !record.reservationMarkerPath) return null;
    // The private directory and its complete marker are established before a
    // record can name them.  Therefore EEXIST is never a recoverable claim:
    // it is a foreign namespace occupant, even if it contains a guessed
    // marker.  Old intent records fail closed for the same reason.
    return record.reservationState === 'owned' && (await isOwnedReservation(record))
      ? record
      : null;
  };

  const ensureTombstone = createEnsureTombstone({
    dir,
    targetPath,
    detachedPath,
    durability: options.durability,
    isOwnedMarker,
    createOwnedMarker,
    setRecord: (record) => { publicReservationRecord = record; },
  });

  const removeOwnedTombstone = createRemoveOwnedTombstone({
    dir,
    durability: options.durability,
    isOwnedMarker,
    setRecord: (record) => { publicReservationRecord = record; },
  });
  const settlePublicReservation = async (): Promise<boolean> => {
    let record: DetachedRemovalPublicReservationRecord | null = null;
    const cleaningRecord = publicReservationRecord;
    if (
      cleaningRecord &&
      getDetachedRemovalPublicReservationPhase(cleaningRecord) === 'cleaning'
    ) {
      // `cleaning` was fsynced before any ownership evidence was removed. A
      // restart may therefore find any suffix of rmdir(reservation),
      // unlink(tombstone), and unlink(marker). Do not try to re-claim it; only
      // finish the exact cleanup that this record already authorized.
      if (!cleaningRecord.reservationIdentity || !cleaningRecord.tombstonePath) return false;
      let reservationMissing = false;
      try {
        const reservationStats = await fs.promises.lstat(cleaningRecord.reservationPath);
        let markerIsAbsent = false;
        try {
          await fs.promises.lstat(cleaningRecord.reservationMarkerPath!);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') markerIsAbsent = true;
          else throw error;
        }
        if (
          !reservationStats.isDirectory() ||
          reservationStats.isSymbolicLink() ||
          !isSameTrustedDurableFilesystemIdentity(
            getDurablePathIdentity(reservationStats),
            cleaningRecord.reservationIdentity
          ) ||
          reservationStats.birthtimeMs !== cleaningRecord.reservationIdentity.birthtimeMs ||
          (!markerIsAbsent &&
            !(await isOwnedMarker(cleaningRecord.reservationMarkerPath!, cleaningRecord.reservationNonce)))
        ) {
          return false;
        }
        try {
          if (!markerIsAbsent) {
            if (!(await removeOwnedMarker(
              cleaningRecord.reservationMarkerPath!,
              cleaningRecord.reservationNonce
            ))) return false;
            await syncDirectory(cleaningRecord.reservationPath, options.durability === 'strict');
          }
          if (!(await rmdirDurablePathIfIdentityMatchesAsync(
            cleaningRecord.reservationPath,
            cleaningRecord.reservationIdentity
          ))) return false;
          reservationMissing = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
          // A writer that was already inside the reservation won the race with
          // cleanup. Its data must be republished, never discarded.
          record = cleaningRecord;
          if (
            !(await isOwnedMarker(
              cleaningRecord.reservationMarkerPath!,
              cleaningRecord.reservationNonce
            )) &&
            !(await createOwnedMarker(
              cleaningRecord.reservationMarkerPath!,
              cleaningRecord.reservationNonce
            ))
          ) {
            return false;
          }
          await syncDirectory(cleaningRecord.reservationPath, options.durability === 'strict');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        reservationMissing = true;
      }

      if (!reservationMissing) {
        // Continue through the no-clobber publication flow below. The cleanup
        // phase is deliberately monotonic-but-not-terminal for this case.
        if (!record) return false;
      } else {
        if (!(await removeOwnedTombstone(cleaningRecord))) return false;
        await syncDirectory(dir, options.durability === 'strict');
        publicReservationPath = null;
        return true;
      }
    } else {
      record = await ensureOwnedReservation();
      if (!record) return publicReservationRecord === null;
    }
    if (!record) return false;
    if (!publicReservationPath) return true;
    // A crash can leave a foreign successor captured while the reservation is
    // nonempty. Restore that exact private capture before any path below is
    // allowed to republish the reservation at the deterministic public name.
    if (
      getDetachedRemovalPublicReservationPhase(record) !== 'republished' &&
      (record.tombstoneState === 'planned' ||
        record.tombstoneState === 'prepared' ||
        record.tombstoneState === 'moved')
    ) {
      const recoveredTombstone = await ensureTombstone(record);
      if (!recoveredTombstone) return false;
      record = recoveredTombstone;
      publicReservationRecord = recoveredTombstone;
    }
    if (getDetachedRemovalPublicReservationPhase(record) === 'republished') {
      try {
        const publicStats = await fs.promises.lstat(targetPath);
        if (
          !publicStats.isSymbolicLink() ||
          path.resolve(dir, await fs.promises.readlink(targetPath)) !== record.reservationPath
        ) {
          return false;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await fs.promises.symlink(record.reservationPath, targetPath, 'junction');
          await syncDirectory(dir, options.durability === 'strict');
        } catch (publishError) {
          if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError;
          return false;
        }
      }
      const markerPath = record.publication?.markerPath;
      if (markerPath && (await isOwnedMarker(markerPath, record.reservationNonce))) {
        if (!(await removeOwnedMarker(markerPath, record.reservationNonce))) return false;
        await syncDirectory(targetPath, options.durability === 'strict');
      }
      // Publication is now durably visible at the public name. The captured
      // old link can be removed only through the receipt/identity-checked
      // tombstone cleanup; arbitrary tombstones remain untouched.
      if (!(await removeOwnedTombstone(record))) return false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    }
    if (!(await isOwnedReservation(record))) return false;
    const reservationEntries = await fs.promises.readdir(record.reservationPath);
    const hasUserData = reservationEntries.some(
      (entry) => entry !== path.basename(record.reservationMarkerPath!)
    );
    if (
      hasUserData ||
      getDetachedRemovalPublicReservationPhase(record) === 'republishing'
    ) {
      // The public name already points, atomically and exclusively, to this
      // prepared private generation.  Do not replace it with a freshly mkdir'd
      // final directory: that old design had an unmarked mkdir crash window.
      // Keeping this generation published preserves concurrent writes without
      // another destructive public-name transition.
      if (getDetachedRemovalPublicReservationPhase(record) !== 'republishing') {
        await persistPublicReservationPhase('republishing');
        record = publicReservationRecord!;
      }
      try {
        const publicStats = await fs.promises.lstat(targetPath);
        if (
          !publicStats.isSymbolicLink() ||
          path.resolve(dir, await fs.promises.readlink(targetPath)) !== record.reservationPath
        ) {
          return false;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await fs.promises.symlink(record.reservationPath, targetPath, 'junction');
          publicReservationPublished = true;
          await syncDirectory(dir, options.durability === 'strict');
        } catch (publishError) {
          if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError;
          return false;
        }
      }
      await persistPublicReservationPhase('republished');
      return true;
    }
    if (getDetachedRemovalPublicReservationPhase(record) !== 'republishing') {
      if (!(await ensureTombstone(record))) return false;

      // Fsync the cleanup fence before removing the reservation, its tombstone,
      // or its marker. Without it a crash leaves an `owned` record with no
      // evidence and makes restart recovery reject its own transaction forever.
      await persistPublicReservationPhase('cleaning');
      const activeCleaningRecord = publicReservationRecord!;

      // An empty reservation can disappear without exposing a new public entry.
      try {
        if (await isOwnedMarker(
          activeCleaningRecord.reservationMarkerPath!,
          activeCleaningRecord.reservationNonce
        )) {
          if (!(await removeOwnedMarker(
            activeCleaningRecord.reservationMarkerPath!,
            activeCleaningRecord.reservationNonce
          ))) return false;
          await syncDirectory(activeCleaningRecord.reservationPath, options.durability === 'strict');
        }
        if (!(await rmdirDurablePathIfIdentityMatchesAsync(
          activeCleaningRecord.reservationPath,
          activeCleaningRecord.reservationIdentity!
        ))) return false;
        publicReservationPath = null;
        if (!(await removeOwnedTombstone(activeCleaningRecord))) return false;
        await syncDirectory(dir, options.durability === 'strict');
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }

      // A writer can race rmdir after the above directory scan.  Preserve the
      // bound public generation rather than moving it through a second public
      // directory publication.
      if (
        !(await isOwnedMarker(
          activeCleaningRecord.reservationMarkerPath!,
          activeCleaningRecord.reservationNonce
        )) &&
        !(await createOwnedMarker(
          activeCleaningRecord.reservationMarkerPath!,
          activeCleaningRecord.reservationNonce
        ))
      ) {
        return false;
      }
      await syncDirectory(activeCleaningRecord.reservationPath, options.durability === 'strict');
      await persistPublicReservationPhase('republishing');
      try {
        await fs.promises.symlink(activeCleaningRecord.reservationPath, targetPath, 'junction');
        publicReservationPublished = true;
        await syncDirectory(dir, options.durability === 'strict');
      } catch (publishError) {
        if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError;
        return false;
      }
      await persistPublicReservationPhase('republished');
      return true;
    }
    return false;
  };
  const closePublicReservation = async (): Promise<boolean> => {
    if (publicReservationReconciled) return true;
    if (!publicReservationRecord || !publicReservationRecordPersisted) {
      return !publicReservationPublished;
    }
    const settled = await settlePublicReservation();
    if (!settled) return false;
    if (
      publicReservationRecord?.reservationMarkerPath &&
      publicReservationPath === null &&
      (await isOwnedMarker(
        publicReservationRecord.reservationMarkerPath,
        publicReservationRecord.reservationNonce
      ))
    ) {
      if (!(await removeOwnedMarker(
        publicReservationRecord.reservationMarkerPath,
        publicReservationRecord.reservationNonce
      ))) return false;
      await syncDirectory(dir, options.durability === 'strict');
    }
    publicReservationPublished = false;
    publicReservationReconciled = true;
    return true;
  };
  const restoreDetached = async (): Promise<boolean> => {
    try {
      // link is an atomic no-replace restoration for regular files. Do not use
      // rename here: on Node it can overwrite a successor after any preceding
      // existence observation.
      await fs.promises.link(detachedPath, targetPath);
      if (detachedIdentity) {
        await unlinkDurablePathIfIdentityMatchesAsync(detachedPath, detachedIdentity);
      }
      detached = false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      const stats = await fs.promises.lstat(detachedPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw error;
      try {
        // Node does not expose a portable mkdir-and-open-at primitive.  A
        // pathname observed after mkdir may already name a foreign directory
        // or symlink, so copying into a supposed private claim would both
        // adopt that directory and permit a write through a replacement link.
        // Publish the detached directory itself through an atomic no-replace
        // link instead.  The original private name remains as the durable
        // backing generation; no child write is performed during rollback.
        await fs.promises.symlink(
          detachedPath,
          targetPath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw mkdirError;
      }
      detached = false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    }
  };
  const removePublicReservationRecord = async (): Promise<void> => {
    if (!publicReservationRecord) return;
    if (getDetachedRemovalPublicReservationPhase(publicReservationRecord) === 'republished') {
      return;
    }
    await removeDetachedRemovalPublicReservationRecord({
      detachedPath,
      record: publicReservationRecord,
      parentDirectory: dir,
      syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
    });
    publicReservationRecord = null;
    publicReservationRecordPersisted = false;
  };
  const resumeProofBackedRemoval = async (): Promise<AtomicPathRemovalResult> => {
    if (!options.proofHooks) return 'missing';
    let republishedReservation = false;
    let reconciledReservation = false;
    if (options.reservePublicDirectory) {
      const record = await readDetachedRemovalPublicReservationRecord({
        targetPath,
        detachedPath,
        parentDirectory: dir,
      });
      if (record) {
        publicReservationPath = record.reservationPath;
        publicReservationRecord = record;
        publicReservationRecordPersisted = true;
        publicReservationPublished = true;
        const phase = getDetachedRemovalPublicReservationPhase(record);
        if (phase === 'republished') {
          // `republished` proves public publication, not that the captured
          // old link and its owned tombstone were cleaned.  Always replay the
          // identity-bound cleanup on restart; it is deliberately idempotent.
          if (!(await closePublicReservation())) return 'changed';
          republishedReservation = true;
        } else if (!(await closePublicReservation())) {
          return 'changed';
        } else {
          reconciledReservation = true;
          republishedReservation =
            getDetachedRemovalPublicReservationPhase(publicReservationRecord) === 'republished';
        }
      }
    }
    const resumed = await resumeDeterministicDetachedRemoval({
      detachedPath,
      removalOptions,
      validateDetached: async (candidatePath, identity) =>
        hasTrustworthyDurableFilesystemIdentity(identity) &&
        (options.validateDetached
          ? await options.validateDetached(candidatePath, identity)
          : true),
      proofHooks: options.proofHooks,
      syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
    });
    if (resumed === 'missing' && (republishedReservation || reconciledReservation)) {
      await removePublicReservationRecord();
      return 'deleted';
    }
    if (resumed === 'deleted') await removePublicReservationRecord();
    return resumed;
  };
  try {
    if (options.proofHooks) {
      const resumed = await resumeProofBackedRemoval();
      if (resumed !== 'missing') return resumed;
    }
    try {
      await renameWithTransientRetry(targetPath, detachedPath);
      detached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return options.proofHooks ? resumeProofBackedRemoval() : 'missing';
      }
      throw error;
    }
    const stats = await fs.promises.lstat(detachedPath);
    const identity = getDurablePathIdentity(stats);
    detachedIdentity = identity;
    if (!hasTrustworthyDurableFilesystemIdentity(identity)) {
      if (!(await closePublicReservation())) return 'changed';
      await restoreDetached();
      await removePublicReservationRecord();
      return 'changed';
    }
    if (options.reservePublicDirectory && stats.isDirectory()) {
      const reservationNonce = randomUUID();
      publicReservationPath = path.join(
        dir,
        durablePathComponent(`.${path.basename(targetPath)}`, `.replacement.${reservationNonce}`)
      );
      const reservationMarkerPath = path.join(
        publicReservationPath,
        `.review-reservation.${reservationNonce}.owner`
      );
      // This is deliberately not an intent->mkdir->marker protocol.  mkdir's
      // EEXIST says only that somebody owns that pathname; a marker created
      // before it cannot change that fact.  Prepare a private, uniquely named
      // directory and atomically publish its complete receipt *before* the
      // durable record or public symlink can reference it.  A crash before
      // that point leaves an unreachable private orphan, never an ambiguous
      // public reservation.  EEXIST is fail-closed and never adopted.
      try {
        await fs.promises.mkdir(publicReservationPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          await restoreDetached();
          return 'changed';
        }
        throw error;
      }
      if (!(await createOwnedMarker(reservationMarkerPath, reservationNonce))) {
        await restoreDetached();
        return 'changed';
      }
      await syncDirectory(publicReservationPath, options.durability === 'strict');
      await syncDirectory(dir, options.durability === 'strict');
      const reservationStats = await fs.promises.lstat(publicReservationPath);
      if (
        !reservationStats.isDirectory() ||
        reservationStats.isSymbolicLink() ||
        !hasTrustworthyDurableFilesystemIdentity(getDurablePathIdentity(reservationStats))
      ) {
        await restoreDetached();
        return 'changed';
      }
      publicReservationRecord = {
        version: 1,
        detachedPath: path.resolve(detachedPath),
        targetPath: path.resolve(targetPath),
        reservationPath: path.resolve(publicReservationPath),
        reservationNonce,
        reservationMarkerPath,
        reservationState: 'owned',
        reservationIdentity: getDurablePathIdentity(reservationStats),
        phase: 'open',
      };
      await persistDetachedRemovalPublicReservationRecord({
        record: publicReservationRecord,
        parentDirectory: dir,
        syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
      });
      publicReservationRecordPersisted = true;
      try {
        const ownedReservation = await ensureOwnedReservation();
        if (!ownedReservation) {
          throw new Error('Public reservation ownership marker is not trustworthy');
        }
        publicReservationRecord = ownedReservation;
        // symlink is an atomic no-replace publication and binds the public
        // successor to the already-marked private generation in one step.
        await fs.promises.symlink(publicReservationPath, targetPath, 'junction');
        // The record intentionally has no link inode yet, but it is enough to
        // fence and remove this exact target on recovery.  Mark it published
        // before the fallible observation/update below so the local error path
        // cannot leave a dangling public reservation either.
        publicReservationPublished = true;
        const publicLinkStats = await fs.promises.lstat(targetPath);
        if (
          !publicLinkStats.isSymbolicLink() ||
          !hasTrustworthyDurableFilesystemIdentity(getDurablePathIdentity(publicLinkStats))
        ) {
          throw new Error('Public reservation link identity is not trustworthy');
        }
        const boundRecord = {
          ...publicReservationRecord,
          publicLinkIdentity: getDurablePathIdentity(publicLinkStats),
        };
        await persistDetachedRemovalPublicReservationRecord({
          record: boundRecord,
          parentDirectory: dir,
          syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
          allowPhaseAdvance: true,
        });
        publicReservationRecord = boundRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await settlePublicReservation();
      }
    }

    if (options.validateDetached && !(await options.validateDetached(detachedPath, identity))) {
      if (!(await closePublicReservation())) return 'changed';
      await restoreDetached();
      await removePublicReservationRecord();
      return 'changed';
    }

    if (!(await closePublicReservation())) return 'changed';
    await options.proofHooks?.onDetachedValidated(detachedPath, identity);
    const removalAccess = await withIdentityStableDirectoryPathAsync(
      dir,
      async (stableParentPath) => {
        const descriptorBoundPath = path.join(stableParentPath, path.basename(detachedPath));
        if (!(await durablePathStillHasIdentityAsync(descriptorBoundPath, identity))) return false;
        return removeDurablePathExactAsync(
          descriptorBoundPath,
          identity,
          removalOptions.recursive === true,
          { onBeforeDestructiveMutation: options.proofHooks?.onBeforeDestructiveMutation }
        );
      },
      { errorPath: detachedPath }
    );
    if (removalAccess.state !== 'opened' || !removalAccess.value) return 'changed';
    detached = false;
    await syncDirectory(dir, options.durability === 'strict');
    await options.proofHooks?.onRemovalDurable(detachedPath, identity);
    await removePublicReservationRecord();
    return 'deleted';
  } catch (error) {
    await closePublicReservation().catch(() => undefined);
    if (detached) await restoreDetached().catch(() => undefined);
    throw error;
  }
}
