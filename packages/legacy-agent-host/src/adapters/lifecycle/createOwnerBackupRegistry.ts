import { lstatSync } from 'node:fs';
import { ensureOwnerBackupDirectories } from './OwnerScopedTeamBackup.js';
import { join } from 'node:path';
import { atomicWriteAsync } from './lifecycleIo.js';
import { loadTeamBackupStartupRegistry, readTeamBackupRegistry } from './TeamBackupStartupRegistry.js';
import type { BackupRegistry, BackupRegistryEntry } from './TeamBackupStartupRegistry.js';

/** Original backup registry/index publication; owner composition supplies its existing shared lifecycle lock. */
export function createOwnerBackupRegistry(options: {
  directory: string; assertWriter(): void;
  withSharedLock<T>(scope: string, operation: () => Promise<T>): Promise<T>;
}) {
  let registry: BackupRegistry = { version: 1, teams: {} };
  const path = join(options.directory, 'registry.json');
  let namespace: { dev: number; ino: number; birthtimeMs: number } | undefined;
  function assertDirectory(): void {
    ensureOwnerBackupDirectories(options.directory, namespace === undefined);
    const current = lstatSync(options.directory);
    if (namespace && (namespace.dev !== current.dev || namespace.ino !== current.ino || namespace.birthtimeMs !== current.birthtimeMs)) throw new Error('Backup registry namespace replaced');
    namespace ??= { dev: current.dev, ino: current.ino, birthtimeMs: current.birthtimeMs };
  }
  return {
    entries: () => registry.teams,
    async initialize(): Promise<void> {
      await options.withSharedLock('backup-registry', async () => {
        options.assertWriter();
        assertDirectory();
        const captured = await loadTeamBackupStartupRegistry(options.directory);
        await atomicWriteAsync(path, JSON.stringify(captured, null, 2), { durability: 'strict', syncDirectory: true,
          beforeCommit: async () => { options.assertWriter(); assertDirectory(); } });
        registry = captured;
      });
    },
    async remove(entry: BackupRegistryEntry, assertCurrent: () => void): Promise<void> {
      await options.withSharedLock('backup-registry', async () => {
        options.assertWriter(); assertDirectory(); assertCurrent();
        const latest = await readTeamBackupRegistry(path), current = latest.teams[entry.teamName];
        if (current?.identityId !== entry.identityId || current.status !== 'deleted_by_user' || current.deletedByUserAt !== entry.deletedByUserAt) throw new Error('Backup retention ownership changed');
        delete latest.teams[entry.teamName];
        await atomicWriteAsync(path, JSON.stringify(latest, null, 2), { durability: 'strict', syncDirectory: true,
          beforeCommit: async () => { options.assertWriter(); assertDirectory(); assertCurrent(); } });
        registry = latest;
      });
    },
    async publish(entry: BackupRegistryEntry, assertCurrent: () => void = () => {}): Promise<void> {
      await options.withSharedLock('backup-registry', async () => {
        options.assertWriter(); assertDirectory(); assertCurrent();
        const latest = await readTeamBackupRegistry(path);
        latest.teams[entry.teamName] = structuredClone(entry);
        await atomicWriteAsync(path, JSON.stringify(latest, null, 2), { durability: 'strict', syncDirectory: true,
          beforeCommit: async () => { options.assertWriter(); assertDirectory(); assertCurrent(); } });
        registry = latest;
      });
    },
  };
}
