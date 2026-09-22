import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { durablePathComponent } from './durablePathComponent';
import { getDurablePathIdentity } from './durablePathIdentity';
import {
  type DetachedRemovalPublicReservationRecord,
  getDetachedRemovalPublicReservationRecordPath,
  persistDetachedRemovalPublicReservationRecord,
} from './durableDetachedRemoval';
import { withDurableReservationRecordLock } from './durableReservationRecordLock';
import {
  isSameTrustedDurableFilesystemIdentity,
  moveToOwnedCapture,
  syncDirectory,
  unlinkDurablePathIfIdentityMatchesAsync,
} from './durablePathOperationSupport';

const MAX_TOMBSTONE_PREPARATION_ATTEMPTS = 8;

interface TombstoneContext {
  readonly dir: string;
  readonly targetPath: string;
  readonly detachedPath: string;
  readonly durability?: 'best-effort' | 'strict';
  readonly isOwnedMarker: (markerPath: string, nonce: string) => Promise<boolean>;
  readonly createOwnedMarker: (markerPath: string, nonce: string) => Promise<boolean>;
  readonly setRecord: (record: DetachedRemovalPublicReservationRecord) => void;
}

export function createEnsureTombstone(context: TombstoneContext): (
  initialRecord: DetachedRemovalPublicReservationRecord
) => Promise<DetachedRemovalPublicReservationRecord | null> {
  const { dir, targetPath, detachedPath, isOwnedMarker, createOwnedMarker } = context;
  const options = { durability: context.durability };
  return async (initialRecord: DetachedRemovalPublicReservationRecord): Promise<DetachedRemovalPublicReservationRecord | null> => {
    let record = initialRecord;
    let tombstonePath = record.tombstonePath;
    let tombstoneMarkerPath = tombstonePath && record.tombstoneMarkerPath;
    let tombstoneCapturePath = tombstonePath && record.tombstoneCapturePath;

    // A new tombstone is fully private and receipt-bound before its pathname
    // is written to the transaction record. A crash in preparation leaves an
    // unreachable unique orphan, not a record which names an unidentifiable
    // directory. Once a record names a tombstone it always carries both
    // durable identities needed by recovery.
    if (!tombstonePath) {
      let prepared: DetachedRemovalPublicReservationRecord | null = null;
      for (let attempt = 0; attempt < MAX_TOMBSTONE_PREPARATION_ATTEMPTS; attempt += 1) {
        const tombstoneNonce = randomUUID();
        const candidatePath = path.join(
          dir,
          durablePathComponent(
            `.${path.basename(targetPath)}`,
            `.reservation-link.${record.reservationNonce}.${tombstoneNonce}.tombstone`
          )
        );
        const candidateMarkerPath = path.join(
          candidatePath,
          `.review-tombstone.${record.reservationNonce}.owner`
        );
        const candidateCapturePath = path.join(candidatePath, 'captured');
        try {
          await fs.promises.mkdir(candidatePath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        if (!(await createOwnedMarker(candidateMarkerPath, record.reservationNonce))) {
          continue;
        }
        try {
          await fs.promises.mkdir(candidateCapturePath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        const [tombstoneStats, captureStats] = await Promise.all([
          fs.promises.lstat(candidatePath),
          fs.promises.lstat(candidateCapturePath),
        ]);
        if (
          !tombstoneStats.isDirectory() || tombstoneStats.isSymbolicLink() ||
          !captureStats.isDirectory() || captureStats.isSymbolicLink()
        ) {
          return null;
        }
        await syncDirectory(candidateCapturePath, options.durability === 'strict');
        await syncDirectory(candidatePath, options.durability === 'strict');
        await syncDirectory(dir, options.durability === 'strict');
        prepared = {
          ...record,
          tombstoneNonce,
          tombstonePath: candidatePath,
          tombstoneMarkerPath: candidateMarkerPath,
          tombstoneCapturePath: candidateCapturePath,
          tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
          tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
          tombstoneState: 'prepared',
        };
        break;
      }
      if (!prepared) return null;
      await persistDetachedRemovalPublicReservationRecord({
        record: prepared,
        parentDirectory: dir,
        syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
        allowPhaseAdvance: true,
      });
      context.setRecord(prepared);
      record = prepared;
      tombstonePath = record.tombstonePath!;
      tombstoneMarkerPath = record.tombstoneMarkerPath!;
      tombstoneCapturePath = record.tombstoneCapturePath!;
    }
    // v1 planned records named the deterministic tombstone before the private
    // marker/capture protocol existed.  Keep that recovery route ahead of the
    // new-shape requirements: otherwise an empty legacy reservation is left
    // permanently pinned merely because its record has no fields it could not
    // have written.
    if (
      tombstonePath &&
      !record.tombstoneMarkerPath &&
      !record.tombstoneCapturePath &&
      !record.tombstoneIdentity &&
      !record.tombstoneCaptureIdentity
    ) {
      // Legacy records predate a private capture parent. Serialize their
      // link/unlink transition with a separate operation lease (the record
      // writer uses its own lock below), so a second recovery cannot publish
      // a successor between this recovery's captured-link check and unlink.
      return withDurableReservationRecordLock(
        `${getDetachedRemovalPublicReservationRecordPath(detachedPath)}.legacy-transition`,
        async () => {
          const finalCapturePath = `${tombstonePath}.legacy-final.${record.reservationNonce}.capture`;
          const isSameLegacyReservationLink = async (): Promise<boolean> => {
        try {
          const [publicStats, tombstoneStats] = await Promise.all([
            fs.promises.lstat(targetPath),
            fs.promises.lstat(tombstonePath),
          ]);
          if (
            !publicStats.isSymbolicLink() ||
            !tombstoneStats.isSymbolicLink() ||
            !isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(publicStats),
              getDurablePathIdentity(tombstoneStats)
            ) ||
            publicStats.birthtimeMs !== tombstoneStats.birthtimeMs
          ) {
            return false;
          }
          const referent = await fs.promises.readlink(targetPath);
          const confirmed = await fs.promises.lstat(targetPath);
          return (
            confirmed.isSymbolicLink() &&
            isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(publicStats),
              getDurablePathIdentity(confirmed)
            ) &&
            publicStats.birthtimeMs === confirmed.birthtimeMs &&
            path.resolve(dir, referent) === record.reservationPath
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      };
          const unlinkLegacyPublicLinkIfCaptured = async (): Promise<boolean> => {
        // The new hard-link name must be durable before the public name can
        // disappear. Otherwise a power loss can lose both names even though
        // the planned record is recoverable in memory.
        await syncDirectory(dir, options.durability === 'strict');
        // Never finish this old-format transition with lstat(target)+unlink:
        // a same-name successor can arrive between those two syscalls.  Detach
        // into a transaction-private name, then compare the *moved* entry to
        // the hard-link capture. If it is a successor, atomically link it back
        // without replacing anything; it is therefore never deleted merely
        // because an old observer happened to see the prior entry.
        const moved = await moveToOwnedCapture(targetPath, finalCapturePath);
        if (moved !== 'moved') return false;
        let movedStats: fs.Stats;
        let tombstoneStats: fs.Stats;
        try {
          [movedStats, tombstoneStats] = await Promise.all([
            fs.promises.lstat(finalCapturePath),
            fs.promises.lstat(tombstonePath),
          ]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
        const capturedOriginal =
          movedStats.isSymbolicLink() &&
          tombstoneStats.isSymbolicLink() &&
          isSameTrustedDurableFilesystemIdentity(
            getDurablePathIdentity(movedStats),
            getDurablePathIdentity(tombstoneStats)
          ) &&
          movedStats.birthtimeMs === tombstoneStats.birthtimeMs;
        if (capturedOriginal) {
          await unlinkDurablePathIfIdentityMatchesAsync(
            finalCapturePath,
            getDurablePathIdentity(movedStats)
          );
          return true;
        }
        try {
          await fs.promises.link(finalCapturePath, targetPath);
          await unlinkDurablePathIfIdentityMatchesAsync(
            finalCapturePath,
            getDurablePathIdentity(movedStats)
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // A second successor won the no-replace restoration. Keep this
          // deterministic private capture instead of deleting either entry.
        }
        return false;
      };
          const recoverLegacyFinalCapture = async (): Promise<'absent' | 'original' | 'restored' | 'conflict'> => {
            let capturedStats: fs.Stats;
            try {
              capturedStats = await fs.promises.lstat(finalCapturePath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
              throw error;
            }
            try {
              const tombstoneStats = await fs.promises.lstat(tombstonePath);
              if (
                capturedStats.isSymbolicLink() &&
                tombstoneStats.isSymbolicLink() &&
                isSameTrustedDurableFilesystemIdentity(
                  getDurablePathIdentity(capturedStats),
                  getDurablePathIdentity(tombstoneStats)
                ) &&
                capturedStats.birthtimeMs === tombstoneStats.birthtimeMs
              ) {
                await unlinkDurablePathIfIdentityMatchesAsync(
                  finalCapturePath,
                  getDurablePathIdentity(capturedStats)
                );
                return 'original';
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              return 'conflict';
            }
            // A power loss after the no-replace move can leave a foreign
            // regular file or directory at the deterministic final capture.
            // It is not the reservation link, so restore it without replacing
            // anything at the public name before this legacy transaction can
            // advance or clean its tombstone.
            try {
              if (capturedStats.isFile()) {
                await fs.promises.link(finalCapturePath, targetPath);
                await unlinkDurablePathIfIdentityMatchesAsync(
                  finalCapturePath,
                  getDurablePathIdentity(capturedStats)
                );
              } else if (capturedStats.isDirectory() && !capturedStats.isSymbolicLink()) {
                await fs.promises.symlink(
                  finalCapturePath,
                  targetPath,
                  process.platform === 'win32' ? 'junction' : 'dir'
                );
              } else {
                return 'conflict';
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict';
              throw error;
            }
            await syncDirectory(dir, options.durability === 'strict');
            return 'restored';
          };
          const isLegacyReservationLink = async (candidatePath: string): Promise<boolean> => {
        try {
          const stats = await fs.promises.lstat(candidatePath);
          return (
            stats.isSymbolicLink() &&
            path.resolve(dir, await fs.promises.readlink(candidatePath)) === record.reservationPath
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
          };
          const finalCaptureRecovery = await recoverLegacyFinalCapture();
          if (finalCaptureRecovery === 'restored' || finalCaptureRecovery === 'conflict') return null;
          if (record.tombstoneState === 'moved') {
        if (!(await isLegacyReservationLink(tombstonePath))) return null;
        try {
          await fs.promises.lstat(targetPath);
          return null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return record;
        }
      }
          if (record.tombstoneState === 'planned') {
        try {
          await fs.promises.lstat(tombstonePath);
          // The old mover could crash after publishing the legacy tombstone
          // link but before advancing its record.  Finish only when the
          // public name is still absent; a visible successor wins unchanged.
          if (!(await isLegacyReservationLink(tombstonePath))) return null;
          try {
            await fs.promises.lstat(targetPath);
            // A crash after link(tombstone) but before unlink(public) is an
            // owned intermediate, not a permanent conflict.  Resume it only
            // when both names still identify the exact captured link.
            if (!(await isSameLegacyReservationLink())) return null;
            if (!(await unlinkLegacyPublicLinkIfCaptured())) return null;
            await syncDirectory(dir, options.durability === 'strict');
          } catch (targetError) {
            if ((targetError as NodeJS.ErrnoException).code !== 'ENOENT') throw targetError;
          }
          const moved = { ...record, tombstoneState: 'moved' as const };
          await persistDetachedRemovalPublicReservationRecord({
            record: moved,
            parentDirectory: dir,
            syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
            allowPhaseAdvance: true,
          });
          context.setRecord(moved);
          return moved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // `link` publishes the legacy symlink at the deterministic tombstone
        // without replacing an occupant.  It is intentionally retained only
        // for records written by the old format; new records always use the
        // receipt-bound private directory above.
        try {
          await fs.promises.link(targetPath, tombstonePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return record;
          throw error;
        }
        if (!(await isLegacyReservationLink(tombstonePath))) return null;
        if (!(await unlinkLegacyPublicLinkIfCaptured())) return null;
        await syncDirectory(dir, options.durability === 'strict');
        const moved = { ...record, tombstoneState: 'moved' as const };
        await persistDetachedRemovalPublicReservationRecord({
          record: moved,
          parentDirectory: dir,
          syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
          allowPhaseAdvance: true,
        });
        context.setRecord(moved);
        return moved;
      }
          return null;
        }
      );
    }
    if (!tombstonePath || !tombstoneMarkerPath || !tombstoneCapturePath) return null;
    const tombstoneCaptureEntryPath = path.join(tombstoneCapturePath, 'entry');
    // The captured object is always a child of an already-owned private
    // directory. That parent is prepared before the public name is moved, so
    // a capture never uses a public/deterministic destination as scratch.
    // v1 records used the tombstone pathname itself as a symlink. Preserve
    // their fail-closed recovery behavior instead of trying to retrofit a
    // directory receipt onto an already moved namespace entry.
    if (
      record.tombstoneState === 'moved' &&
      !record.tombstoneIdentity &&
      !record.tombstoneMarkerPath &&
      !record.tombstoneCapturePath
    ) {
      try {
        const legacyStats = await fs.promises.lstat(tombstonePath);
        if (
          !legacyStats.isSymbolicLink() ||
          path.resolve(dir, await fs.promises.readlink(tombstonePath)) !== record.reservationPath
        ) {
          return null;
        }
        try {
          await fs.promises.lstat(targetPath);
          return null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return record;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    if (
      record.tombstonePath !== tombstonePath ||
      record.tombstoneState === undefined ||
      record.tombstoneMarkerPath === undefined ||
      record.tombstoneCapturePath === undefined
    ) {
      // This fsynced intent is written before a foreign successor can be
      // displaced.  It gives a restart the exact owned location to restore,
      // rather than guessing that a plausible tombstone belongs to us.
      const next = {
        ...record,
        tombstonePath,
        tombstoneMarkerPath,
        tombstoneCapturePath,
        tombstoneState: 'planned' as const,
      };
      await persistDetachedRemovalPublicReservationRecord({
        record: next,
        parentDirectory: dir,
        syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
        allowPhaseAdvance: true,
      });
      context.setRecord(next);
      record = next;
    }
    const ownsTombstone = async (): Promise<boolean> => {
      if (
        !record.tombstoneIdentity ||
        !record.tombstoneMarkerPath ||
        !record.tombstoneCaptureIdentity
      ) return false;
      try {
        const [stats, captureStats] = await Promise.all([
          fs.promises.lstat(tombstonePath),
          fs.promises.lstat(tombstoneCapturePath),
        ]);
        return (
          stats.isDirectory() &&
          !stats.isSymbolicLink() &&
          isSameTrustedDurableFilesystemIdentity(
            getDurablePathIdentity(stats),
            record.tombstoneIdentity
          ) &&
          stats.birthtimeMs === record.tombstoneIdentity.birthtimeMs &&
          captureStats.isDirectory() &&
          !captureStats.isSymbolicLink() &&
          isSameTrustedDurableFilesystemIdentity(
            getDurablePathIdentity(captureStats),
            record.tombstoneCaptureIdentity
          ) &&
          captureStats.birthtimeMs === record.tombstoneCaptureIdentity.birthtimeMs &&
          await isOwnedMarker(record.tombstoneMarkerPath, record.reservationNonce)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const capturedMatchesReservation = async (): Promise<boolean> => {
      try {
        const capturedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
        if (!capturedStats.isSymbolicLink()) return false;
        const capturedIdentity = getDurablePathIdentity(capturedStats);
        const capturedReferent = await fs.promises.readlink(tombstoneCaptureEntryPath);
        // readlink is not an identity-bound operation.  Re-observe the exact
        // captured object before using its bytes so a source swap between the
        // old public observation and capture cannot make us classify a newer
        // object as the reservation link.
        const confirmedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
        return (
          confirmedStats.isSymbolicLink() &&
          isSameTrustedDurableFilesystemIdentity(
            capturedIdentity,
            getDurablePathIdentity(confirmedStats)
          ) &&
          capturedStats.birthtimeMs === confirmedStats.birthtimeMs &&
          (record.publicLinkIdentity === undefined ||
            (isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(capturedStats),
              record.publicLinkIdentity
            ) && capturedStats.birthtimeMs === record.publicLinkIdentity.birthtimeMs)) &&
          path.resolve(
            path.dirname(targetPath),
            capturedReferent
          ) === record.reservationPath
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const capturePublicLinkAuthority = async (): Promise<Pick<
      DetachedRemovalPublicReservationRecord,
      'tombstoneCaptureLinkReferent' | 'tombstoneCaptureLinkType' | 'tombstoneCaptureLinkIdentity'
    > | null> => {
      let sourceStats: fs.Stats;
      try {
        sourceStats = await fs.promises.lstat(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (!sourceStats.isSymbolicLink()) return null;
      const sourceIdentity = getDurablePathIdentity(sourceStats);
      const rawReferent = await fs.promises.readlink(targetPath);
      let linkType: 'file' | 'dir' | 'junction' | undefined;
      if (process.platform === 'win32') {
        try {
          linkType = (await fs.promises.stat(targetPath)).isDirectory()
            ? (path.isAbsolute(rawReferent) ? 'junction' : 'dir')
            : 'file';
        } catch {
          // lstat/readlink do not encode whether a dangling Windows link was
          // created as `file` or `dir`. Do not manufacture authority from its
          // spelling: leaving the public link in place is safer than moving a
          // successor we could later recreate with the wrong type.
          return null;
        }
      }
      const confirmedStats = await fs.promises.lstat(targetPath);
      if (
        !confirmedStats.isSymbolicLink() ||
        !isSameTrustedDurableFilesystemIdentity(
          sourceIdentity,
          getDurablePathIdentity(confirmedStats)
        ) ||
        sourceStats.birthtimeMs !== confirmedStats.birthtimeMs
      ) {
        return null;
      }
      return {
        tombstoneCaptureLinkReferent: rawReferent,
        ...(linkType === undefined ? {} : { tombstoneCaptureLinkType: linkType }),
        tombstoneCaptureLinkIdentity: sourceIdentity,
      };
    };
    const bindMovedCaptureAuthority = async (): Promise<void> => {
      let capturedStats: fs.Stats;
      try {
        capturedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!capturedStats.isSymbolicLink()) return;
      const capturedIdentity = getDurablePathIdentity(capturedStats);
      const capturedReferent = await fs.promises.readlink(tombstoneCaptureEntryPath);
      const confirmedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
      if (
        !confirmedStats.isSymbolicLink() ||
        !isSameTrustedDurableFilesystemIdentity(
          capturedIdentity,
          getDurablePathIdentity(confirmedStats)
        ) ||
        capturedStats.birthtimeMs !== confirmedStats.birthtimeMs
      ) return;
      // The type was observed while this same entry was still at the public
      // parent.  In particular, do not stat a relative link after moving it:
      // its referent is relative to a different directory there.  When a
      // replacement won immediately before rename, record the entry that was
      // actually moved as a distinct recovery authority; recovery can then
      // restore that entry rather than leaving it privately stranded.
      const capturedWasObservedAuthority =
        record.tombstoneCaptureLinkIdentity !== undefined &&
        record.tombstoneCaptureLinkReferent !== undefined &&
        isSameTrustedDurableFilesystemIdentity(
          capturedIdentity,
          record.tombstoneCaptureLinkIdentity
        ) &&
        capturedStats.birthtimeMs === record.tombstoneCaptureLinkIdentity.birthtimeMs &&
        capturedReferent === record.tombstoneCaptureLinkReferent;
      const bound = {
        ...record,
        tombstoneCapturedEntryIdentity: capturedIdentity,
        tombstoneCapturedEntryLinkReferent: capturedReferent,
        // A Windows creation type is authority only for the entry whose
        // identity and raw referent were observed before the move.  Never
        // transfer a type hint from a displaced public link to a foreign
        // replacement which happened to be captured instead.
        tombstoneCapturedEntryLinkType: capturedWasObservedAuthority
          ? record.tombstoneCaptureLinkType
          : undefined,
      };
      await persistDetachedRemovalPublicReservationRecord({
        record: bound,
        parentDirectory: dir,
        syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
        allowPhaseAdvance: true,
      });
      context.setRecord(bound);
      record = bound;
    };
    const restoreCapturedSuccessor = async (): Promise<boolean> => {
      let capturedStats: fs.Stats;
      try {
        capturedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      try {
        if (!capturedStats.isFile() && !capturedStats.isDirectory() && !capturedStats.isSymbolicLink()) {
          return false;
        }
        // A resumed directory capture may have crashed before its original
        // mover reached the parent fsyncs. Make both rename parents durable
        // before exposing the captured tree through a public symlink.
        await syncDirectory(tombstoneCapturePath, options.durability === 'strict');
        await syncDirectory(dir, options.durability === 'strict');
        if (capturedStats.isFile()) {
          // A Windows hard link restores a regular file as a regular file;
          // constructing a junction here would turn a file successor into a
          // different object type.  `link` is also no-replace.
          await fs.promises.link(tombstoneCaptureEntryPath, targetPath);
        } else if (capturedStats.isSymbolicLink()) {
          const capturedIdentity = getDurablePathIdentity(capturedStats);
          const rawReferent = await fs.promises.readlink(tombstoneCaptureEntryPath);
          const confirmedStats = await fs.promises.lstat(tombstoneCaptureEntryPath);
          if (
            !confirmedStats.isSymbolicLink() ||
            !isSameTrustedDurableFilesystemIdentity(
              capturedIdentity,
              getDurablePathIdentity(confirmedStats)
            ) ||
            capturedStats.birthtimeMs !== confirmedStats.birthtimeMs
          ) {
            return false;
          }
          // Relative referents must remain relative to the public parent. On
          // Windows their target must never be statted at the tombstone path:
          // that would follow a different (often dangling) relative name.
          let linkType: fs.symlink.Type | undefined;
          if (process.platform === 'win32') {
            const postMoveAuthority =
              record.tombstoneCapturedEntryIdentity !== undefined &&
              record.tombstoneCapturedEntryLinkReferent !== undefined &&
              record.tombstoneCapturedEntryLinkType !== undefined;
            const movedIdentity = postMoveAuthority
              ? record.tombstoneCapturedEntryIdentity
              : record.tombstoneCaptureLinkIdentity;
            const movedReferent = postMoveAuthority
              ? record.tombstoneCapturedEntryLinkReferent
              : record.tombstoneCaptureLinkReferent;
            const movedType = postMoveAuthority
              ? record.tombstoneCapturedEntryLinkType
              : record.tombstoneCaptureLinkType;
            if (
              movedIdentity &&
              movedReferent !== undefined &&
              movedType !== undefined &&
              isSameTrustedDurableFilesystemIdentity(
                getDurablePathIdentity(capturedStats),
                movedIdentity
              ) &&
              capturedStats.birthtimeMs === movedIdentity.birthtimeMs &&
              rawReferent === movedReferent
            ) {
              linkType = movedType;
            } else {
              // A crash can fall between rename and the post-move receipt.
              // The pre-move receipt is usable only when its identity and raw
              // referent authenticate this exact captured object; otherwise
              // keep the capture private rather than borrowing type authority
              // from a different public successor.
              return false;
            }
          }
          await fs.promises.symlink(rawReferent, targetPath, linkType);
        } else {
          // A directory successor remains privately captured.  Publishing a
          // no-replace directory junction/symlink preserves it without a
          // destructive rename over a last-mile successor.
          await fs.promises.symlink(
            tombstoneCaptureEntryPath,
            targetPath,
            process.platform === 'win32' ? 'junction' : 'dir'
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    };
    let tombstoneAlreadyOwned = await ownsTombstone();
    if (!tombstoneAlreadyOwned) {
      try {
        // mkdir is the no-clobber publication primitive.  Unlike the former
        // lstat+rename target->tombstone sequence, an occupant which arrives
        // at this last instruction wins with EEXIST and is never replaced.
        await fs.promises.lstat(tombstonePath);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await fs.promises.mkdir(tombstonePath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw error;
      }
      if (!(await createOwnedMarker(tombstoneMarkerPath, record.reservationNonce))) return null;
      try {
        await fs.promises.mkdir(tombstoneCapturePath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw error;
      }
      const tombstoneStats = await fs.promises.lstat(tombstonePath);
      const captureStats = await fs.promises.lstat(tombstoneCapturePath);
      if (
        !tombstoneStats.isDirectory() || tombstoneStats.isSymbolicLink() ||
        !captureStats.isDirectory() || captureStats.isSymbolicLink()
      ) return null;
      // A directory move has two parents. The private capture parent is made
      // durable first, followed by the public/source parent, before a public
      // symlink or marker can be (re)published.
      await syncDirectory(tombstoneCapturePath, options.durability === 'strict');
      await syncDirectory(tombstonePath, options.durability === 'strict');
      await syncDirectory(dir, options.durability === 'strict');
      const prepared = {
        ...record,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'prepared' as const,
      };
      await persistDetachedRemovalPublicReservationRecord({
        record: prepared,
        parentDirectory: dir,
        syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
        allowPhaseAdvance: true,
      });
      context.setRecord(prepared);
      record = prepared;
      tombstoneAlreadyOwned = true;
    }
    if (!tombstoneAlreadyOwned) return null;
    if (!(await capturedMatchesReservation())) {
      try {
        await fs.promises.lstat(tombstoneCaptureEntryPath);
        await restoreCapturedSuccessor();
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const linkAuthority = await capturePublicLinkAuthority();
      if (process.platform === 'win32' && !linkAuthority) {
        // A dangling link has no authoritative creation type. Leave it at the
        // public name rather than creating a capture that cannot be restored
        // without guessing whether it was a file or directory link.
        return null;
      }
      if (linkAuthority) {
        const captureIntent = { ...record, ...linkAuthority };
        await persistDetachedRemovalPublicReservationRecord({
          record: captureIntent,
          parentDirectory: dir,
          syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
          allowPhaseAdvance: true,
        });
        context.setRecord(captureIntent);
        record = captureIntent;
      }
      const moveResult = await moveToOwnedCapture(targetPath, tombstoneCaptureEntryPath);
      if (moveResult === 'missing') return record;
      if (moveResult === 'occupied') return null;
      await bindMovedCaptureAuthority();
      // The pre-move record above is the restore intent for the crash between
      // capture and this state advancement.
      if (!(await capturedMatchesReservation())) {
        await restoreCapturedSuccessor();
        return null;
      }
    }
    // Persist both rename-parent directory entries before exposing a public
    // successor. This makes a captured directory recoverable after power loss.
    await syncDirectory(tombstoneCapturePath, options.durability === 'strict');
    await syncDirectory(dir, options.durability === 'strict');
    const moved = { ...record, tombstonePath, tombstoneState: 'moved' as const };
    await persistDetachedRemovalPublicReservationRecord({
      record: moved,
      parentDirectory: dir,
      syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
      allowPhaseAdvance: true,
    });
    context.setRecord(moved);
    return moved;
  };
}
