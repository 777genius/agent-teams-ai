import { InternalStorageImportVerificationError } from '../domain/errors';

import type { LegacyJsonStoreSource } from './ports';

export interface ImportLegacyJsonStoreDeps<TRecord> {
  storeId: string;
  source: LegacyJsonStoreSource<TRecord>;
  loadExisting(teamName: string): Promise<TRecord[]>;
  replaceAll(teamName: string, records: TRecord[]): Promise<void>;
  recordIdentity(record: TRecord): string;
  resolveConflict?(canonical: TRecord, incoming: TRecord): TRecord;
  /** Order-insensitive equivalence used to verify the import round-trip. */
  areEquivalent(imported: TRecord[], expected: TRecord[]): boolean;
  recordImport(teamName: string, entryCount: number): Promise<void>;
  hasRecordedImport(teamName: string): Promise<boolean>;
}

/**
 * One-time, idempotent migration of a legacy per-team JSON store into SQLite.
 *
 * A live legacy file always triggers an overlay import, covering first import,
 * a crash before archiving, and an app downgrade that recreated JSON. When the
 * durable SQLite import marker is missing, immutable archives also participate
 * so a recreated database can recover them. Sequence per team:
 *
 *   1. read live legacy JSON; when it is absent and no durable import marker
 *      survived, recover every archived generation
 *   2. overlay the source on existing team rows and replace in one transaction
 *   3. read back and verify the complete merged snapshot
 *   4. only then archive the JSON file (rename, never delete)
 *
 * A failure at any step leaves the JSON file untouched, so the legacy backend
 * remains a valid source of truth.
 */
const IMPORT_FAILURE_RETRY_COOLDOWN_MS = 60_000;

export class ImportLegacyJsonStoreUseCase<TRecord> {
  private readonly importedTeams = new Set<string>();
  private readonly recentFailures = new Map<string, { atMs: number; error: Error }>();

  constructor(private readonly deps: ImportLegacyJsonStoreDeps<TRecord>) {}

  /** Must be called under the same per-team mutex as subsequent store access. */
  async ensureImported(teamName: string): Promise<void> {
    if (this.importedTeams.has(teamName)) {
      return;
    }
    // A failed import stays failed for a cooldown window instead of re-running
    // the full replace transaction on every store call (callers poll every
    // few seconds); the JSON files remain the source of truth throughout.
    const failure = this.recentFailures.get(teamName);
    if (failure && Date.now() - failure.atMs < IMPORT_FAILURE_RETRY_COOLDOWN_MS) {
      throw failure.error;
    }
    try {
      await this.importTeamOnce(teamName);
      this.recentFailures.delete(teamName);
    } catch (error) {
      this.recentFailures.set(teamName, {
        atMs: Date.now(),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  private async importTeamOnce(teamName: string): Promise<void> {
    const activeRecords = await this.deps.source.read(teamName);
    const hasRecordedImport = await this.deps.hasRecordedImport(teamName);
    if (activeRecords === null && hasRecordedImport) {
      this.importedTeams.add(teamName);
      return;
    }

    // A missing marker means the canonical database may have just been
    // recreated after corruption. Overlay archives before any still-live file:
    // a crash during a multi-step archive can leave both halves on disk.
    const archivedRecords = hasRecordedImport
      ? null
      : await this.deps.source.readArchives(teamName);
    const legacyRecords = [...(archivedRecords ?? []), ...(activeRecords ?? [])];
    if (activeRecords === null && archivedRecords === null) {
      this.importedTeams.add(teamName);
      return;
    }

    const merged = overlayRecords(
      await this.deps.loadExisting(teamName),
      legacyRecords,
      this.deps.recordIdentity,
      this.deps.resolveConflict
    );
    await this.deps.replaceAll(teamName, merged);

    const roundTrip = await this.deps.loadExisting(teamName);
    if (!this.deps.areEquivalent(roundTrip, merged)) {
      throw new InternalStorageImportVerificationError(this.deps.storeId, teamName);
    }

    await this.deps.recordImport(teamName, merged.length);
    if (activeRecords !== null) {
      await this.deps.source.archive(teamName);
    }
    this.importedTeams.add(teamName);
  }
}

/**
 * Legacy journals are snapshots, but an archive generation can be incomplete
 * after a crash or downgrade. Treat each generation as an overlay: newer rows
 * replace the same identity while absent identities remain intact.
 */
function overlayRecords<TRecord>(
  existing: readonly TRecord[],
  incoming: readonly TRecord[],
  identity: (record: TRecord) => string,
  resolveConflict?: (canonical: TRecord, incoming: TRecord) => TRecord
): TRecord[] {
  const merged = new Map<string, TRecord>();
  for (const record of existing) {
    merged.set(identity(record), record);
  }
  for (const record of incoming) {
    const key = identity(record);
    const current = merged.get(key);
    merged.set(key, current && resolveConflict ? resolveConflict(current, record) : record);
  }
  return [...merged.values()];
}
