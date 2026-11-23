import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INTERNAL_STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  runInternalStorageMigrations,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { expect, it, vi } from 'vitest';

it('serializes concurrent schema upgrades before reading their version and preserves template data', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-migration-race-'));
  const first = new Database(join(root, 'storage.sqlite'), { timeout: 0 });
  const second = new Database(join(root, 'storage.sqlite'), { timeout: 0 });
  try {
    runInternalStorageMigrations(first);
    first.exec('ALTER TABLE custom_team_templates DROP COLUMN revision');
    first.pragma('user_version = 6');
    first
      .prepare(
        `INSERT INTO custom_team_templates
         (id, name, name_normalized, schema_version, team_prompt, members_json, content_hash, created_at)
         VALUES ('retained', 'Retained', 'retained', 1, 'Keep this prompt', '[]', 'hash', '2026-01-01')`
      )
      .run();

    // Schedule the competing instance exactly after the first version read.
    // A deferred lock lets it commit version 7 before the first instance acts
    // on its stale version 6; the second ALTER then fails with a duplicate column.
    const pragma = first.pragma.bind(first);
    let competed = false;
    let competitorError: unknown;
    const versionRead = vi.spyOn(first, 'pragma').mockImplementation((source, options) => {
      const result = pragma(source, options);
      if (source === 'user_version' && !competed) {
        competed = true;
        try {
          runInternalStorageMigrations(second);
        } catch (error) {
          competitorError = error;
        }
      }
      return result;
    });

    expect(() => runInternalStorageMigrations(first)).not.toThrow();
    versionRead.mockRestore();
    expect(competed).toBe(true);
    expect(competitorError).toMatchObject({ code: 'SQLITE_BUSY' });

    // The waiting instance retries after the first commits, observes the new
    // version, and leaves the already migrated template untouched.
    expect(() => runInternalStorageMigrations(second)).not.toThrow();
    expect(() => runInternalStorageMigrations(first)).not.toThrow();
    expect(readSchemaVersion(first)).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(readSchemaVersion(second)).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(
      first.prepare('SELECT id, team_prompt, revision FROM custom_team_templates').all()
    ).toEqual([{ id: 'retained', team_prompt: 'Keep this prompt', revision: 1 }]);
  } finally {
    vi.restoreAllMocks();
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
