import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export function assertNoActiveBackupFenceForMigration(
  db: SqliteDatabase,
  migrationVersion: number
): void {
  const activeFence = db
    .prepare("SELECT 1 FROM coordination_backup_writer_fences WHERE status = 'active' LIMIT 1")
    .get();
  if (activeFence) {
    throw new Error(`internal-storage-v${migrationVersion}-migration-backup-fenced`);
  }
}
