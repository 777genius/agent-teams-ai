import { readdir, rm, rmdir, stat } from 'node:fs/promises';

import * as path from 'path';

import { withFileLock } from '../../fileLock';

import { readRuntimeStoreManifestEvidenceData } from './OpenCodeRuntimeManifestEvidenceData';
import { readOpenCodeStopSessionIdentity } from './OpenCodeStopSessionIdentity';

interface ClearOpenCodeRuntimeLaneStorageInput {
  teamName: string;
  expectedRunId?: string;
  expectedSessionIdentityHash?: string;
  laneDirectory: string;
  manifestPath: string;
  durableArtifacts: ReadonlySet<string>;
  removeIndexEntry: () => Promise<void>;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    }
  );
}

/** The caller holds the lane lifecycle lock for the entire clear. */
export async function clearOpenCodeRuntimeLaneStorageUnlocked({
  teamName,
  expectedRunId,
  expectedSessionIdentityHash,
  laneDirectory,
  manifestPath,
  durableArtifacts,
  removeIndexEntry,
}: ClearOpenCodeRuntimeLaneStorageInput): Promise<boolean> {
  const manifestExists = await pathExists(manifestPath);
  if (expectedRunId && manifestExists) {
    const manifest = await readRuntimeStoreManifestEvidenceData(
      manifestPath,
      teamName,
      () => new Date()
    );
    if (manifest?.activeRunId !== expectedRunId) return false;
  }
  if (
    expectedSessionIdentityHash !== undefined &&
    (await readOpenCodeStopSessionIdentity(manifestPath)) !== expectedSessionIdentityHash
  ) {
    return false;
  }

  const laneDirectoryExists = await pathExists(laneDirectory);
  if (laneDirectoryExists) {
    const deliveryJournalPath = path.join(laneDirectory, 'opencode-delivery-journal.json');
    const runTombstonesPath = path.join(laneDirectory, 'opencode-run-tombstones.json');
    const safeToClear = await withFileLock(deliveryJournalPath, () =>
      withFileLock(runTombstonesPath, async () => {
        const transientEntries = (await readdir(laneDirectory)).filter(
          (entry) => !durableArtifacts.has(entry)
        );
        // If the manifest is gone, only an empty transient lane is provably
        // safe to finish. Another run's evidence must never be deleted.
        if (expectedRunId && !manifestExists && transientEntries.length > 0) return false;
        for (const entry of transientEntries) {
          if (entry === path.basename(manifestPath)) continue;
          await rm(path.join(laneDirectory, entry), { recursive: true, force: true });
        }
        return true;
      })
    );
    if (!safeToClear) return false;
  }

  await removeIndexEntry();
  // Retain the run fence until the index write succeeds, so a partial clear
  // can retry against the same run rather than becoming permanently blocked.
  if (manifestExists) await rm(manifestPath, { force: true });
  if (laneDirectoryExists) {
    await rmdir(laneDirectory).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    });
  }
  return true;
}
