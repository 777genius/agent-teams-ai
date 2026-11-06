import { readFile } from 'node:fs/promises';
import { getBackupManifestPath, readBackupManifestStrict } from './teamBackupManifest.js';
import { removePathWithIdentityFenceAsync } from './lifecycleIo.js';
import type { BackupRegistryEntry } from './TeamBackupStartupRegistry.js';
import type { BackupManifest } from './teamBackupManifest.js';
export const DELETED_BACKUP_RETENTION_DAYS = 30;
/** Original deleted-backup retention algorithm; an owner may additionally retain referenced private evidence/debt. */
export async function pruneDeletedTeamBackups(options: {
  entries(): Record<string, BackupRegistryEntry>; directory(teamName: string): string;
  withIdentityFence(teamName: string, operation: () => Promise<boolean>): Promise<boolean>;
  assertPrunable(teamName: string, identityId: string): void;
  onPruned(teamName: string, entry: BackupRegistryEntry): Promise<void>;
  log(message: string): void;
}): Promise<number> {
  const cutoff = Date.now() - DELETED_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [teamName, entry] of Object.entries(options.entries())) {
    if (entry.status !== 'deleted_by_user' || !entry.deletedByUserAt) continue;
    const deletedAt = new Date(entry.deletedByUserAt).getTime();
    if (!Number.isFinite(deletedAt) || deletedAt > cutoff) continue;
    const removed = await options.withIdentityFence(teamName, async () => {
      const current = options.entries()[teamName];
      if (current?.status !== 'deleted_by_user' || current.identityId !== entry.identityId || current.deletedByUserAt !== entry.deletedByUserAt) return false;
      const manifest = await readBackupManifestStrict(getBackupManifestPath(options.directory(teamName)), teamName);
      if (manifest?.workSyncRestorePending || (manifest && manifest.identityId !== entry.identityId)) return false;
      try { options.assertPrunable(teamName, entry.identityId); } catch { return false; }
      const removal = await removePathWithIdentityFenceAsync(options.directory(teamName), { recursive: true, force: true, durability: 'strict',
        validateDetached: async detached => {
          try {
            const captured = JSON.parse(await readFile(getBackupManifestPath(detached), 'utf8')) as BackupManifest;
            options.assertPrunable(teamName, entry.identityId);
            return captured.teamName === teamName && captured.identityId === entry.identityId && captured.status === 'deleted_by_user' && !Object.hasOwn(captured, 'workSyncRestorePending');
          } catch { return false; }
        },
      });
      if (removal === 'changed') return false;
      await options.onPruned(teamName, entry);
      options.log(`[Backup] Pruned stale backup for ${teamName}`); return true;
    });
    if (removed) pruned++;
  }
  return pruned;
}
