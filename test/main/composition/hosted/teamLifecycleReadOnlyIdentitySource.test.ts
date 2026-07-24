import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import { createTeamLifecycleReadOnlyIdentitySource } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';
import { parseTeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const INTENT_ID = `adoption_${'2'.repeat(32)}`;
const DIRECTORY_FINGERPRINT = '3'.repeat(64);
const IDENTITY_CHECKSUM = '4'.repeat(64);
const WORKSPACE_ID = `workspace_${'5'.repeat(32)}`;
const PREPARED_AT = '2026-07-18T08:00:00.000Z';
const PUBLISHED_AT = '2026-07-18T08:01:00.000Z';
const COMMITTED_AT = '2026-07-18T08:02:00.000Z';

const roots: string[] = [];

function intentChecksum(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        intentId: INTENT_ID,
        teamId: TEAM_ID,
        legacyKey: 'team-alpha',
        directoryFingerprint: DIRECTORY_FINGERPRINT,
        workspaceId: WORKSPACE_ID,
        workspaceBindingGeneration: 7,
        expectedIdentityChecksum: IDENTITY_CHECKSUM,
        preparedAt: PREPARED_AT,
      })
    )
    .digest('hex');
}

async function fixture(
  options: { readonly alteredConstraint?: boolean; readonly incompatibleVersion?: boolean } = {}
): Promise<{
  readonly appDataRoot: string;
  readonly databasePath: string;
}> {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-read-identity-'));
  roots.push(appDataRoot);
  const storagePath = path.join(appDataRoot, 'storage');
  await fs.mkdir(storagePath);
  const databasePath = path.join(storagePath, 'app.db');
  const database = new Database(databasePath);
  database.pragma('journal_mode = DELETE');
  for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
    database.exec(
      options.alteredConstraint
        ? statement.replace(
            'schema_version INTEGER NOT NULL CHECK (schema_version = 1)',
            'schema_version INTEGER NOT NULL CHECK (schema_version >= 1)'
          )
        : statement
    );
  }
  if (options.incompatibleVersion) {
    database.exec('DROP TRIGGER trg_team_identity_metadata_no_update');
    database.pragma('ignore_check_constraints = ON');
    database.prepare('UPDATE team_identity_storage_metadata SET schema_version = ?').run(2);
    database.pragma('ignore_check_constraints = OFF');
  }
  database
    .prepare(`INSERT INTO team_identity_records VALUES (?, 'active', ?, ?, ?, 7, ?, ?, ?, ?, NULL)`)
    .run(
      TEAM_ID,
      'team-alpha',
      DIRECTORY_FINGERPRINT,
      WORKSPACE_ID,
      INTENT_ID,
      IDENTITY_CHECKSUM,
      PREPARED_AT,
      COMMITTED_AT
    );
  database
    .prepare(
      `INSERT INTO legacy_team_key_reservations
       VALUES (?, ?, 'active', ?, NULL, NULL)`
    )
    .run('team-alpha', TEAM_ID, PREPARED_AT);
  database
    .prepare(
      `INSERT INTO team_adoption_intents
       VALUES (?, ?, 'committed', ?, ?, ?, 7, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      INTENT_ID,
      TEAM_ID,
      'team-alpha',
      DIRECTORY_FINGERPRINT,
      WORKSPACE_ID,
      IDENTITY_CHECKSUM,
      intentChecksum(),
      PREPARED_AT,
      PUBLISHED_AT,
      IDENTITY_CHECKSUM,
      COMMITTED_AT,
      IDENTITY_CHECKSUM
    );
  database.close();
  return { appDataRoot, databasePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('team lifecycle read-only identity source', () => {
  it('has no worker, database-creation, migration, recovery, cleanup, or mutation gateway', async () => {
    const source = await fs.readFile(
      'src/main/composition/hosted/teamLifecycleReadOnlyIdentitySource.ts',
      'utf8'
    );

    expect(source).toContain('fs.constants.O_RDONLY | NO_FOLLOW');
    expect(source).toContain('new Database(serializedDatabase, { readonly: true })');
    expect(source).not.toMatch(
      /\b(createInternalStorageFeature|new Worker|mkdir|writeFile|unlink|rename)\b/
    );
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/);
    expect(source).not.toContain("pragma('journal_mode");
  });

  it('loads a validated immutable snapshot without changing the database or creating sidecars', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const beforeBytes = await fs.readFile(databasePath);
    const beforeEntries = await fs.readdir(path.dirname(databasePath));
    const beforeStat = await fs.stat(databasePath);

    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(source!.listTeamIdentities()).resolves.toMatchObject([
      {
        teamId: TEAM_ID,
        legacyKey: 'team-alpha',
        directoryFingerprint: DIRECTORY_FINGERPRINT,
        workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 7 },
        state: 'active',
      },
    ]);
    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({ teamId: TEAM_ID });
    expect(await fs.readFile(databasePath)).toEqual(beforeBytes);
    expect(await fs.readdir(path.dirname(databasePath))).toEqual(beforeEntries);
    expect((await fs.stat(databasePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('accepts the complete canonical tables, indexes, constraints, and triggers', async () => {
    const { appDataRoot } = await fixture();

    await expect(
      createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })
    ).resolves.not.toBeNull();
  });

  it('returns unavailable for missing storage without creating the storage directory', async () => {
    const appDataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'team-lifecycle-read-identity-missing-')
    );
    roots.push(appDataRoot);

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
    await expect(fs.lstat(path.join(appDataRoot, 'storage'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns unavailable for incompatible metadata without migrating or rewriting it', async () => {
    const { appDataRoot, databasePath } = await fixture({ incompatibleVersion: true });
    const before = await fs.readFile(databasePath);

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
    expect(await fs.readFile(databasePath)).toEqual(before);
  });

  it('returns unavailable for an active SQLite sidecar and never removes it', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const sidecarPath = `${databasePath}-wal`;
    await fs.writeFile(sidecarPath, 'uncheckpointed');

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toBe('uncheckpointed');
  });

  it('returns unavailable when the durable identity graph is inconsistent', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const database = new Database(databasePath);
    database.exec('DROP TRIGGER trg_legacy_team_key_no_delete');
    database.prepare('DELETE FROM legacy_team_key_reservations').run();
    database.exec(TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[11]);
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it('returns unavailable when an adoption intent checksum is tampered', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const database = new Database(databasePath);
    database.exec('DROP TRIGGER trg_team_adoption_intent_transition');
    database.prepare('UPDATE team_adoption_intents SET intent_checksum = ?').run('f'.repeat(64));
    database.exec(TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[14]);
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it.each([
    ['required checksum index', 'DROP INDEX idx_team_identity_checksum'],
    ['required transition trigger', 'DROP TRIGGER trg_team_adoption_intent_transition'],
  ])('returns unavailable when the canonical schema loses a %s', async (_name, mutation) => {
    const { appDataRoot, databasePath } = await fixture();
    const database = new Database(databasePath);
    database.exec(mutation);
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it('returns unavailable when a canonical table constraint changes', async () => {
    const { appDataRoot } = await fixture({ alteredConstraint: true });

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it('returns unavailable when expected identity checksums are reused across intents', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const secondTeamId = `team_${'6'.repeat(32)}`;
    const secondIntentId = `adoption_${'7'.repeat(32)}`;
    const secondFingerprint = '8'.repeat(64);
    const secondPreparedAt = '2026-07-18T08:03:00.000Z';
    const secondIntentChecksum = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          intentId: secondIntentId,
          teamId: secondTeamId,
          legacyKey: 'team-beta',
          directoryFingerprint: secondFingerprint,
          workspaceId: WORKSPACE_ID,
          workspaceBindingGeneration: 7,
          expectedIdentityChecksum: IDENTITY_CHECKSUM,
          preparedAt: secondPreparedAt,
        })
      )
      .digest('hex');
    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO team_identity_records
         VALUES (?, 'adoption_prepared', ?, ?, ?, 7, ?, NULL, ?, NULL, NULL)`
      )
      .run(
        secondTeamId,
        'team-beta',
        secondFingerprint,
        WORKSPACE_ID,
        secondIntentId,
        secondPreparedAt
      );
    database
      .prepare(`INSERT INTO legacy_team_key_reservations VALUES (?, ?, 'active', ?, NULL, NULL)`)
      .run('team-beta', secondTeamId, secondPreparedAt);
    database
      .prepare(
        `INSERT INTO team_adoption_intents
         VALUES (?, ?, 'prepared', ?, ?, ?, 7, ?, ?, ?, NULL, NULL, NULL, NULL)`
      )
      .run(
        secondIntentId,
        secondTeamId,
        'team-beta',
        secondFingerprint,
        WORKSPACE_ID,
        IDENTITY_CHECKSUM,
        secondIntentChecksum,
        secondPreparedAt
      );
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it('returns unavailable for an unrecognized identity schema shape', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const database = new Database(databasePath);
    database.exec('ALTER TABLE team_identity_records ADD COLUMN unrecognized TEXT');
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked database path', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const targetPath = `${databasePath}.target`;
    await fs.rename(databasePath, targetPath);
    await fs.symlink(targetPath, databasePath);

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });
});
