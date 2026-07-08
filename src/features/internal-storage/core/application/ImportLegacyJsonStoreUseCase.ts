import { InternalStorageImportVerificationError } from '../domain/errors';

import type { LegacyJsonStoreSource } from './ports';

export interface ImportLegacyJsonStoreDeps<TRecord> {
  storeId: string;
  source: LegacyJsonStoreSource<TRecord>;
  loadExisting(teamName: string): Promise<TRecord[]>;
  replaceAll(teamName: string, records: TRecord[]): Promise<void>;
  /** Order-insensitive equivalence used to verify the import round-trip. */
  areEquivalent(imported: TRecord[], expected: TRecord[]): boolean;
  recordImport(teamName: string, entryCount: number): Promise<void>;
}

/**
 * One-time, idempotent migration of a legacy per-team JSON store into SQLite.
 *
 * The legacy file's presence is the single trigger: it covers first import,
 * a crash before archiving (re-import is safe because replaceAll clears the
 * team's rows first) and an app downgrade that recreated the JSON file (the
 * fresher JSON then wins). Sequence per team:
 *
 *   1. read legacy JSON (absent -> done)
 *   2. replace team rows in SQLite (single transaction)
 *   3. read back and verify against the source
 *   4. only then archive the JSON file (rename, never delete)
 *
 * A failure at any step leaves the JSON file untouched, so the legacy backend
 * remains a valid source of truth.
 */
export class ImportLegacyJsonStoreUseCase<TRecord> {
  private readonly importedTeams = new Set<string>();

  constructor(private readonly deps: ImportLegacyJsonStoreDeps<TRecord>) {}

  /** Must be called under the same per-team mutex as subsequent store access. */
  async ensureImported(teamName: string): Promise<void> {
    if (this.importedTeams.has(teamName)) {
      return;
    }

    const legacyRecords = await this.deps.source.read(teamName);
    if (legacyRecords === null) {
      this.importedTeams.add(teamName);
      return;
    }

    await this.deps.replaceAll(teamName, legacyRecords);

    const roundTrip = await this.deps.loadExisting(teamName);
    if (!this.deps.areEquivalent(roundTrip, legacyRecords)) {
      throw new InternalStorageImportVerificationError(this.deps.storeId, teamName);
    }

    await this.deps.recordImport(teamName, legacyRecords.length);
    await this.deps.source.archive(teamName);
    this.importedTeams.add(teamName);
  }
}
