import * as fs from 'fs';
import * as path from 'path';

import {
  type DetachedRemovalPublicReservationRecord,
  persistDetachedRemovalPublicReservationRecord,
} from './durableDetachedRemoval';
import { getDurablePathIdentity } from './durablePathIdentity';
import {
  isSameTrustedDurableFilesystemIdentity,
  moveToOwnedCapture,
  rmdirDurablePathIfIdentityMatchesAsync,
  syncDirectory,
  unlinkDurablePathIfIdentityMatchesAsync,
  withIdentityStableDirectoryPathAsync,
} from './durablePathOperationSupport';

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

interface TombstoneCleanupContext {
  readonly dir: string;
  readonly durability?: 'best-effort' | 'strict';
  readonly isOwnedMarker: (markerPath: string, nonce: string) => Promise<boolean>;
  readonly setRecord: (record: DetachedRemovalPublicReservationRecord) => void;
}

export function createRemoveOwnedTombstone(context: TombstoneCleanupContext): (
  record: DetachedRemovalPublicReservationRecord
) => Promise<boolean> {
  const { dir, isOwnedMarker } = context;
  const options = { durability: context.durability };
  const removeOwnedMarker = async (markerPath: string, nonce: string): Promise<boolean> => {
    if (!(await isOwnedMarker(markerPath, nonce))) return false;
    return unlinkDurablePathIfIdentityMatchesAsync(
      markerPath,
      getDurablePathIdentity(await fs.promises.lstat(markerPath))
    );
  };
  return async (record: DetachedRemovalPublicReservationRecord): Promise<boolean> => {
    if (!record.tombstonePath) return false;
    // Read legacy symlink tombstones but never infer ownership for a new
    // directory-shaped occupant. New records require both the persisted inode
    // and receipt before any cleanup touches them.
    if (
      !record.tombstoneIdentity ||
      !record.tombstoneMarkerPath ||
      !record.tombstoneCapturePath ||
      !record.tombstoneCaptureIdentity
    ) {
      try {
        const stats = await fs.promises.lstat(record.tombstonePath);
        if (
          !stats.isSymbolicLink() ||
          path.resolve(dir, await fs.promises.readlink(record.tombstonePath)) !== record.reservationPath
        ) {
          return false;
        }
        return unlinkDurablePathIfIdentityMatchesAsync(
          record.tombstonePath,
          getDurablePathIdentity(stats)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return true;
    }
    try {
      const stats = await fs.promises.lstat(record.tombstonePath);
      const markerOwned = await isOwnedMarker(record.tombstoneMarkerPath, record.reservationNonce);
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        !isSameTrustedDurableFilesystemIdentity(
          getDurablePathIdentity(stats),
          record.tombstoneIdentity
        ) ||
        stats.birthtimeMs !== record.tombstoneIdentity.birthtimeMs
      ) {
        return false;
      }
      if (!markerOwned) {
        try {
          await fs.promises.lstat(record.tombstoneMarkerPath);
          // A present but untrusted marker means this namespace changed; do
          // not adopt it. A missing marker is an expected cleanup crash tail,
          // still bound by the persisted tombstone inode below.
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // Detach the complete capture directory before looking at an entry in
      // it. The former directory-local finalization spelling is migrated here
      // when possible; it is never used as a mutable cleanup ancestor again.
      let activeRecord = record;
      const finalizationPath = path.join(
        activeRecord.tombstonePath!,
        `captured.finalizing.${activeRecord.reservationNonce}`
      );
        const finalizationEntryPath = path.join(finalizationPath, 'entry');
        const cleanupPath = path.join(
          finalizationPath,
          `entry.cleanup.${activeRecord.reservationNonce}`
        );
        const cleanupDetachedPath = path.join(
          finalizationPath,
          `entry.cleanup.${activeRecord.reservationNonce}.deleting.${activeRecord.reservationNonce}`
        );
        const cleanupFinalEntryPath = path.join(
          finalizationPath,
          `entry.cleanup.${activeRecord.reservationNonce}.final`
        );
        const persist = async (next: DetachedRemovalPublicReservationRecord): Promise<void> => {
          if (JSON.stringify(next) === JSON.stringify(activeRecord)) return;
          await persistDetachedRemovalPublicReservationRecord({
            record: next,
            parentDirectory: dir,
            syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
            allowPhaseAdvance: true,
          });
          activeRecord = next;
          context.setRecord(next);
        };
        await persist({ ...activeRecord, tombstoneCleanupFinalizationPath: finalizationPath });
        let finalizationStats: fs.Stats;
        try {
          finalizationStats = await fs.promises.lstat(finalizationPath);
          const finalizationIdentity = activeRecord.tombstoneCleanupFinalizationIdentity;
          if (
            !finalizationStats.isDirectory() ||
            finalizationStats.isSymbolicLink() ||
            !finalizationIdentity ||
            !isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(finalizationStats),
              finalizationIdentity
            ) ||
            finalizationStats.birthtimeMs !== finalizationIdentity.birthtimeMs
          ) {
            return false;
          }
          const rootEntry = path.join(activeRecord.tombstoneCapturePath!, 'entry');
          const nestedFinalization = path.join(
            activeRecord.tombstoneCapturePath!,
            `entry.cleanup.${activeRecord.reservationNonce}.finalizing.${activeRecord.reservationNonce}`
          );
          let captureEntry = rootEntry;
          try {
            await fs.promises.lstat(captureEntry);
          } catch (error) {
            if (!isMissing(error)) throw error;
            captureEntry = path.join(nestedFinalization, 'entry');
          }
          const destination = path.join(finalizationPath, 'entry');
          try {
            await fs.promises.lstat(destination);
            try {
              await fs.promises.lstat(captureEntry);
              return false;
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          } catch (error) {
            if (!isMissing(error)) throw error;
            if ((await moveToOwnedCapture(captureEntry, destination)) !== 'moved') return false;
          }
          if (captureEntry !== rootEntry) {
            try {
              if (!(await rmdirDurablePathIfIdentityMatchesAsync(
                nestedFinalization,
                getDurablePathIdentity(await fs.promises.lstat(nestedFinalization))
              ))) return false;
            } catch (error) {
              if (!isMissing(error)) return false;
            }
          }
          try {
            if (!(await rmdirDurablePathIfIdentityMatchesAsync(
              activeRecord.tombstoneCapturePath!,
              activeRecord.tombstoneCaptureIdentity!
            ))) return false;
          } catch (error) {
            if (!isMissing(error)) return false;
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
          let captureStats: fs.Stats;
          try {
            captureStats = await fs.promises.lstat(activeRecord.tombstoneCapturePath!);
          } catch (captureError) {
            if (!isMissing(captureError)) throw captureError;
            // Crash after finalization rmdir, before the marker/tombstone
            // suffix.  The outer tombstone receipt above is still the only
            // authority we have, so finish that exact suffix rather than
            // reporting success and orphaning the directory with its record.
            const suffixAccess = await withIdentityStableDirectoryPathAsync(
              dir,
              async (stableParentPath) => {
                const stableTombstonePath = path.join(
                  stableParentPath,
                  path.basename(record.tombstonePath!)
                );
                const stableTombstoneAccess = await withIdentityStableDirectoryPathAsync(
                  stableTombstonePath,
                  async (stableTombstoneDirectoryPath) => {
                    if (markerOwned && !(await removeOwnedMarker(
                      path.join(stableTombstoneDirectoryPath, path.basename(record.tombstoneMarkerPath!)),
                      record.reservationNonce
                    ))) return false;
                    return true;
                  },
                  { expectedIdentity: record.tombstoneIdentity, errorPath: record.tombstonePath }
                );
                if (stableTombstoneAccess.state !== 'opened' || !stableTombstoneAccess.value) return false;
                return rmdirDurablePathIfIdentityMatchesAsync(stableTombstonePath, record.tombstoneIdentity!);
              },
              { errorPath: record.tombstonePath }
            );
            return suffixAccess.state === 'opened' && suffixAccess.value;
          }
          if (
            !captureStats.isDirectory() ||
            captureStats.isSymbolicLink() ||
            !isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(captureStats),
              activeRecord.tombstoneCaptureIdentity
            ) ||
            captureStats.birthtimeMs !== activeRecord.tombstoneCaptureIdentity!.birthtimeMs
          ) {
            return false;
          }
          // Reserve the finalization directory with mkdir(2), whose EEXIST is
          // a real no-replace result.  A directory rename after an absence
          // check would overwrite a last-mile foreign destination on Node.
          try {
            await fs.promises.mkdir(finalizationPath, { mode: 0o700 });
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw mkdirError;
          }
          finalizationStats = await fs.promises.lstat(finalizationPath);
          if (!finalizationStats.isDirectory() || finalizationStats.isSymbolicLink()) return false;
          await persist({
            ...activeRecord,
            tombstoneCleanupFinalizationPath: finalizationPath,
            tombstoneCleanupFinalizationIdentity: getDurablePathIdentity(finalizationStats),
            tombstoneCleanupPath: cleanupPath,
            tombstoneCleanupDetachedPath: cleanupDetachedPath,
          });
          const finalizationEntry = path.join(finalizationPath, 'entry');
          const nestedLegacyFinalization = path.join(
            activeRecord.tombstoneCapturePath!,
            `entry.cleanup.${activeRecord.reservationNonce}.finalizing.${activeRecord.reservationNonce}`
          );
          let captureEntry = path.join(activeRecord.tombstoneCapturePath!, 'entry');
          try {
            await fs.promises.lstat(captureEntry);
          } catch (entryError) {
            if (!isMissing(entryError)) throw entryError;
            captureEntry = path.join(nestedLegacyFinalization, 'entry');
          }
          if ((await moveToOwnedCapture(captureEntry, finalizationEntry)) !== 'moved') return false;
          if (captureEntry !== path.join(activeRecord.tombstoneCapturePath!, 'entry')) {
            try {
              if (!(await rmdirDurablePathIfIdentityMatchesAsync(
                nestedLegacyFinalization,
                getDurablePathIdentity(await fs.promises.lstat(nestedLegacyFinalization))
              ))) return false;
            } catch (nestedError) {
              if (!isMissing(nestedError)) return false;
            }
          }
          try {
            if (!(await rmdirDurablePathIfIdentityMatchesAsync(
              activeRecord.tombstoneCapturePath!,
              activeRecord.tombstoneCaptureIdentity!
            ))) return false;
          } catch (captureRemoveError) {
            if (!isMissing(captureRemoveError)) return false;
          }
        }
        await persist({
          ...activeRecord,
          tombstoneCleanupFinalizationPath: finalizationPath,
          tombstoneCleanupFinalizationIdentity: getDurablePathIdentity(finalizationStats),
          // A legacy nested finalization can have journaled either child path
          // before its parent move. Both paths must advance with the parent;
          // retaining the old capture-relative spelling strands an otherwise
          // authentic nested entry outside later recovery.
          tombstoneCleanupPath: cleanupPath,
          tombstoneCleanupDetachedPath: cleanupDetachedPath,
        });
        const matchesCapturedEntry = async (candidatePath: string): Promise<boolean> => {
          try {
            const stats = await fs.promises.lstat(candidatePath);
            return (
              stats.isSymbolicLink() &&
              !!activeRecord.tombstoneCapturedEntryIdentity &&
              isSameTrustedDurableFilesystemIdentity(
                getDurablePathIdentity(stats),
                activeRecord.tombstoneCapturedEntryIdentity
              ) &&
              stats.birthtimeMs === activeRecord.tombstoneCapturedEntryIdentity.birthtimeMs &&
              path.resolve(dir, await fs.promises.readlink(candidatePath)) === activeRecord.reservationPath
            );
          } catch (error) {
            if (isMissing(error)) return false;
            throw error;
          }
        };
        const access = await withIdentityStableDirectoryPathAsync(
          finalizationPath,
          async (stableFinalizationPath) => {
            const stableEntry = path.join(stableFinalizationPath, 'entry');
            const stableCleanup = path.join(
              stableFinalizationPath,
              path.basename(cleanupPath)
            );
            const stableDetached = path.join(
              stableFinalizationPath,
              path.basename(cleanupDetachedPath)
            );
            const stableFinal = path.join(
              stableFinalizationPath,
              path.basename(cleanupFinalEntryPath)
            );
            const stableLegacyFinalization = path.join(
              stableFinalizationPath,
              `entry.cleanup.${activeRecord.reservationNonce}.finalizing.${activeRecord.reservationNonce}`
            );
            const journalCleanup = async (): Promise<void> =>
              persist({ ...activeRecord, tombstoneCleanupPath: cleanupPath });
            const journalDetached = async (): Promise<void> =>
              persist({
                ...activeRecord,
                tombstoneCleanupPath: cleanupPath,
                tombstoneCleanupDetachedPath: cleanupDetachedPath,
              });
            // Old records finalized inside `captured`. Once the complete
            // capture has moved into the outer finalization namespace, drain
            // that nested directory through the same live descriptor. Its
            // entry is moved no-replace to the current root spelling; an
            // occupied root or nonempty foreign residue fails closed.
            try {
              const legacyStats = await fs.promises.lstat(stableLegacyFinalization);
              if (!legacyStats.isDirectory() || legacyStats.isSymbolicLink()) return false;
              const legacyEntry = path.join(stableLegacyFinalization, 'entry');
              try {
                await fs.promises.lstat(stableEntry);
              } catch (error) {
                if (!isMissing(error)) throw error;
                if ((await moveToOwnedCapture(legacyEntry, stableEntry)) !== 'moved') return false;
              }
              if (!(await rmdirDurablePathIfIdentityMatchesAsync(
                stableLegacyFinalization,
                getDurablePathIdentity(legacyStats)
              ))) return false;
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
            for (const [source, destination, journal] of [
              [stableEntry, stableCleanup, journalCleanup],
              [stableCleanup, stableDetached, journalDetached],
              [stableDetached, stableFinal, journalDetached],
            ] as const) {
              try {
                const destinationStats = await fs.promises.lstat(destination);
                if (!(await matchesCapturedEntry(destination))) return false;
                if (destination === stableFinal) {
                  if (
                    !(await unlinkDurablePathIfIdentityMatchesAsync(
                      destination,
                      getDurablePathIdentity(destinationStats)
                    ))
                  ) return false;
                } else if (!destinationStats.isSymbolicLink()) {
                  return false;
                }
                continue;
              } catch (error) {
                if (!isMissing(error)) throw error;
              }
              try {
                await fs.promises.lstat(source);
              } catch (error) {
                if (isMissing(error)) continue;
                throw error;
              }
              if (!(await matchesCapturedEntry(source))) return false;
              await journal();
              if ((await moveToOwnedCapture(source, destination)) !== 'moved') return false;
              if (!(await matchesCapturedEntry(destination))) return false;
            }
            try {
              const remaining = await fs.promises.lstat(stableFinal);
              if (!(await matchesCapturedEntry(stableFinal))) return false;
              if (
                !(await unlinkDurablePathIfIdentityMatchesAsync(
                  stableFinal,
                  getDurablePathIdentity(remaining)
                ))
              ) return false;
              return remaining.isSymbolicLink();
            } catch (error) {
              if (isMissing(error)) return true;
              throw error;
            }
          },
          {
            expectedIdentity: activeRecord.tombstoneCleanupFinalizationIdentity,
            errorPath: finalizationPath,
          }
        );
        // A persisted finalization pathname can be absent because the prior
        // process completed `rmdir(finalization)` and crashed before removing
        // the marker/tombstone.  That is a cleanup suffix, not proof that the
        // whole tombstone was removed; continue below while the outer receipt
        // is still authenticated.
        if (access.state === 'opened' && !access.value) return false;
        if (access.state === 'missing') {
          try {
            await fs.promises.lstat(activeRecord.tombstoneCapturePath!);
            return false;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        try {
          // Keep the tombstone's parent descriptor open through the final
          // rmdir/unlink sequence.  Re-validating a normal pathname here used
          // to lose both the ancestor and finalization authority immediately
          // before the destructive syscall.
          const outerAccess = await withIdentityStableDirectoryPathAsync(
            dir,
            async (stableParentPath) => {
              const stableTombstonePath = path.join(stableParentPath, path.basename(record.tombstonePath!));
              const current = await fs.promises.lstat(stableTombstonePath);
              if (!current.isDirectory() || current.isSymbolicLink() ||
                !isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(current), record.tombstoneIdentity!) ||
                current.birthtimeMs !== record.tombstoneIdentity!.birthtimeMs) return false;
              // Keep both the parent and tombstone descriptors live through
              // finalization rmdir, marker unlink, and the final tombstone
              // rmdir.  No destructive child mutation falls back to a public
              // pathname after the authority descriptor has been released.
              const tombstoneAccess = await withIdentityStableDirectoryPathAsync(
                stableTombstonePath,
                async (stableTombstoneDirectoryPath) => {
                  if (access.state === 'opened') {
                    const stableFinalizationPath = path.join(stableTombstoneDirectoryPath, path.basename(finalizationPath));
                    const finalStats = await fs.promises.lstat(stableFinalizationPath);
                    if (!finalStats.isDirectory() || finalStats.isSymbolicLink() ||
                      !activeRecord.tombstoneCleanupFinalizationIdentity ||
                      !isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(finalStats), activeRecord.tombstoneCleanupFinalizationIdentity) ||
                      finalStats.birthtimeMs !== activeRecord.tombstoneCleanupFinalizationIdentity.birthtimeMs) return false;
                    if (!(await rmdirDurablePathIfIdentityMatchesAsync(
                      stableFinalizationPath,
                      getDurablePathIdentity(finalStats)
                    ))) return false;
                  }
                  if (markerOwned && !(await removeOwnedMarker(
                    path.join(stableTombstoneDirectoryPath, path.basename(record.tombstoneMarkerPath!)),
                    record.reservationNonce
                  ))) return false;
                  return true;
                },
                { expectedIdentity: record.tombstoneIdentity, errorPath: record.tombstonePath }
              );
              if (tombstoneAccess.state !== 'opened' || !tombstoneAccess.value) return false;
              return rmdirDurablePathIfIdentityMatchesAsync(stableTombstonePath, record.tombstoneIdentity!);
            },
            { expectedIdentity: undefined, errorPath: record.tombstonePath }
          );
          return outerAccess.state === 'opened' && outerAccess.value;
        } catch (error) {
          // Missing finalization is expected after the crash prefix above;
          // only a missing outer tombstone means the complete cleanup is done.
          if (isMissing(error)) {
            try {
              await fs.promises.lstat(record.tombstonePath);
              return false;
            } catch (outerError) {
              if (isMissing(outerError)) return true;
              throw outerError;
            }
          }
          if (
            (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' ||
            (error as NodeJS.ErrnoException).code === 'EEXIST'
          ) return false;
          throw error;
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
}
