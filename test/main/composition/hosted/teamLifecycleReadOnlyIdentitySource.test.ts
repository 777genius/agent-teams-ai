import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import { createTeamLifecycleReadOnlyIdentitySource } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';
import { parseTeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => import('better-sqlite3-node'));

const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const INTENT_ID = `adoption_${'2'.repeat(32)}`;
const DIRECTORY_FINGERPRINT = '3'.repeat(64);
const IDENTITY_CHECKSUM = '4'.repeat(64);
const WORKSPACE_ID = `workspace_${'5'.repeat(32)}`;
const REBOUND_WORKSPACE_ID = `workspace_${'6'.repeat(32)}`;
const PREPARED_AT = '2026-07-18T08:00:00.000Z';
const PUBLISHED_AT = '2026-07-18T08:01:00.000Z';
const COMMITTED_AT = '2026-07-18T08:02:00.000Z';
const TOMBSTONED_AT = '2026-07-18T08:03:00.000Z';

const roots: string[] = [];

function intentChecksum(workspaceId = WORKSPACE_ID, workspaceBindingGeneration = 7): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        intentId: INTENT_ID,
        teamId: TEAM_ID,
        legacyKey: 'team-alpha',
        directoryFingerprint: DIRECTORY_FINGERPRINT,
        workspaceId,
        workspaceBindingGeneration,
        expectedIdentityChecksum: IDENTITY_CHECKSUM,
        preparedAt: PREPARED_AT,
      })
    )
    .digest('hex');
}

async function fixture(
  options: {
    readonly alteredConstraint?: boolean;
    readonly incompatibleVersion?: boolean;
    readonly empty?: boolean;
  } = {}
): Promise<{
  readonly appDataRoot: string;
  readonly databasePath: string;
}> {
  const appDataRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-read-identity-'))
  );
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
  if (!options.empty) seedActiveIdentity(database);
  database.close();
  return { appDataRoot, databasePath };
}

type TestDatabase = InstanceType<typeof Database>;

function seedActiveIdentity(database: TestDatabase): void {
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
}

function createIdentity(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    seedActiveIdentity(database);
  } finally {
    database.close();
  }
}

function tombstoneIdentity(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      database
        .prepare(
          `UPDATE legacy_team_key_reservations
              SET state = 'tombstoned', tombstoned_at = ?, tombstone_reason = 'team_deleted'
            WHERE legacy_key = ? AND team_id = ? AND state = 'active'`
        )
        .run(TOMBSTONED_AT, 'team-alpha', TEAM_ID);
      database
        .prepare(
          `UPDATE team_identity_records
              SET state = 'tombstoned', tombstoned_at = ?
            WHERE team_id = ? AND state = 'active'`
        )
        .run(TOMBSTONED_AT, TEAM_ID);
    })();
  } finally {
    database.close();
  }
}

function indexedHex(index: number, width: number): string {
  return index.toString(16).padStart(width, '0');
}

function seedIndexedCommittedIdentity(
  database: TestDatabase,
  index: number,
  state: 'active' | 'tombstoned'
): ReturnType<typeof parseTeamId> {
  const teamId = parseTeamId(`team_${indexedHex(index, 32)}`);
  const intentId = `adoption_${indexedHex(index + 20_000, 32)}`;
  const legacyKey = `history-${index}`;
  const fingerprint = createHash('sha256').update(`directory-${index}`).digest('hex');
  const identityChecksum = createHash('sha256').update(`identity-${index}`).digest('hex');
  const preparedAt = `2026-01-01T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
  const publishedAt = `2026-01-02T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
  const committedAt = `2026-01-03T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
  const tombstonedAt = state === 'tombstoned' ? '2026-01-04T00:00:00.000Z' : null;
  const checksum = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        intentId,
        teamId,
        legacyKey,
        directoryFingerprint: fingerprint,
        workspaceId: WORKSPACE_ID,
        workspaceBindingGeneration: 7,
        expectedIdentityChecksum: identityChecksum,
        preparedAt,
      })
    )
    .digest('hex');
  database
    .prepare(`INSERT INTO team_identity_records VALUES (?, ?, ?, ?, ?, 7, ?, ?, ?, ?, ?)`)
    .run(
      teamId,
      state,
      legacyKey,
      fingerprint,
      WORKSPACE_ID,
      intentId,
      identityChecksum,
      preparedAt,
      committedAt,
      tombstonedAt
    );
  database
    .prepare(`INSERT INTO legacy_team_key_reservations VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      legacyKey,
      teamId,
      state,
      preparedAt,
      tombstonedAt,
      state === 'tombstoned' ? 'team_deleted' : null
    );
  database
    .prepare(
      `INSERT INTO team_adoption_intents
       VALUES (?, ?, 'committed', ?, ?, ?, 7, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      intentId,
      teamId,
      legacyKey,
      fingerprint,
      WORKSPACE_ID,
      identityChecksum,
      checksum,
      preparedAt,
      publishedAt,
      identityChecksum,
      committedAt,
      identityChecksum
    );
  return teamId;
}

function rebindIdentity(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      database.exec('DROP TRIGGER trg_team_identity_transition');
      database.exec('DROP TRIGGER trg_team_adoption_intent_transition');
      database
        .prepare(
          `UPDATE team_identity_records
              SET workspace_id = ?, workspace_binding_generation = 8
            WHERE team_id = ?`
        )
        .run(REBOUND_WORKSPACE_ID, TEAM_ID);
      database
        .prepare(
          `UPDATE team_adoption_intents
              SET workspace_id = ?, workspace_binding_generation = 8, intent_checksum = ?
            WHERE intent_id = ?`
        )
        .run(REBOUND_WORKSPACE_ID, intentChecksum(REBOUND_WORKSPACE_ID, 8), INTENT_ID);
      database.exec(TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[10]);
      database.exec(TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[14]);
    })();
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('team lifecycle read-only identity source', () => {
  it('captures bounded active identities without enumerating historical tombstones', async () => {
    const { appDataRoot, databasePath } = await fixture({ empty: true });
    const database = new Database(databasePath);
    database.transaction(() => {
      for (let index = 1; index <= 1_005; index += 1) {
        seedIndexedCommittedIdentity(database, index, 'tombstoned');
      }
      seedIndexedCommittedIdentity(database, 10_001, 'active');
    })();
    database.close();

    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [] })
    ).resolves.toMatchObject({
      active: [{ teamId: parseTeamId(`team_${indexedHex(10_001, 32)}`), state: 'active' }],
      retiredCandidates: [],
    });
    await expect(source!.listTeamIdentities()).rejects.toThrow(
      'team-lifecycle-read-identity-record-limit-exceeded'
    );
  });

  it('fails closed when more than 1000 active identities exist', async () => {
    const { appDataRoot, databasePath } = await fixture({ empty: true });
    const database = new Database(databasePath);
    database.transaction(() => {
      for (let index = 1; index <= 1_001; index += 1) {
        seedIndexedCommittedIdentity(database, index, 'active');
      }
    })();
    database.close();

    await expect(createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })).resolves.toBeNull();
  });

  it('rejects duplicate and oversized retirement candidate sets', async () => {
    const { appDataRoot } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [TEAM_ID, TEAM_ID] })
    ).rejects.toThrow('team-lifecycle-read-external-writer-candidate-duplicate');
    await expect(
      source!.captureExternalWriterTeamIdentities({
        retirementCandidates: Array.from({ length: 1_025 }, (_, index) =>
          parseTeamId(`team_${indexedHex(index + 1, 32)}`)
        ),
      })
    ).rejects.toThrow('team-lifecycle-read-external-writer-candidate-limit-exceeded');
  });

  it('returns an exact full-graph tombstone proof and rejects selected graph tampering', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
    expect(source).not.toBeNull();
    tombstoneIdentity(databasePath);

    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [TEAM_ID] })
    ).resolves.toEqual({
      active: [],
      retiredCandidates: [
        { teamId: TEAM_ID, identityChecksum: IDENTITY_CHECKSUM, tombstonedAt: TOMBSTONED_AT },
      ],
    });

    const database = new Database(databasePath);
    database.exec('DROP TRIGGER trg_legacy_team_key_no_delete');
    database.prepare('DELETE FROM legacy_team_key_reservations WHERE team_id = ?').run(TEAM_ID);
    database.exec(TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[11]);
    database.close();
    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [TEAM_ID] })
    ).rejects.toThrow('team-lifecycle-read-identity-graph-invalid');
  });

  it('classifies active candidates from the same snapshot and proves retirement on the next', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
    expect(source).not.toBeNull();

    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [TEAM_ID] })
    ).resolves.toMatchObject({ active: [{ teamId: TEAM_ID }], retiredCandidates: [] });
    tombstoneIdentity(databasePath);
    await expect(
      source!.captureExternalWriterTeamIdentities({ retirementCandidates: [TEAM_ID] })
    ).resolves.toMatchObject({
      active: [],
      retiredCandidates: [{ teamId: TEAM_ID, tombstonedAt: TOMBSTONED_AT }],
    });
  });

  it('has no worker, database-creation, migration, recovery, cleanup, or mutation gateway', async () => {
    const source = await Promise.all(
      [
        'src/main/composition/hosted/teamLifecycleReadOnlyIdentitySource.ts',
        'src/main/composition/hosted/teamLifecycleReadOnlyIdentitySnapshot.ts',
      ].map((file) => fs.readFile(file, 'utf8'))
    ).then((parts) => parts.join('\n'));

    expect(source).toContain('fs.constants.O_RDONLY | NO_FOLLOW');
    expect(source).toContain('new Database(serializedDatabase, { readonly: true })');
    expect(source).not.toMatch(
      /\b(createInternalStorageFeature|new Worker|mkdir|writeFile|unlink|rename)\b/
    );
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/);
    expect(source).not.toContain("pragma('journal_mode");
  });

  it('reads a validated descriptor snapshot without changing the database or creating sidecars', async () => {
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

  it('re-reads the canonical database for list calls after startup admission', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    tombstoneIdentity(databasePath);

    await expect(source!.listTeamIdentities()).resolves.toMatchObject([
      {
        teamId: TEAM_ID,
        state: 'tombstoned',
        tombstonedAt: TOMBSTONED_AT,
      },
    ]);
  });

  it('observes a canonical identity created after startup admission', async () => {
    const { appDataRoot, databasePath } = await fixture({ empty: true });
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(source!.listTeamIdentities()).resolves.toEqual([]);
    createIdentity(databasePath);

    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({
      teamId: TEAM_ID,
      state: 'active',
      workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 7 },
    });
  });

  it('re-reads the canonical database for individual identity calls', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({ state: 'active' });
    tombstoneIdentity(databasePath);

    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({
      state: 'tombstoned',
      tombstonedAt: TOMBSTONED_AT,
    });
  });

  it('observes a canonical workspace rebind after startup admission', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });

    expect(source).not.toBeNull();
    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({
      workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 7 },
    });
    rebindIdentity(databasePath);

    await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toMatchObject({
      workspaceBinding: { workspaceId: REBOUND_WORKSPACE_ID, generation: 8 },
    });
  });

  it('fails closed when the database path is replaced after admission', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
    const admittedDatabasePath = `${databasePath}.admitted`;

    expect(source).not.toBeNull();
    await fs.rename(databasePath, admittedDatabasePath);
    await fs.copyFile(admittedDatabasePath, databasePath);

    await expect(source!.listTeamIdentities()).rejects.toThrow(
      'team-lifecycle-read-identity-database-replaced'
    );
  });

  it('fails closed when a SQLite sidecar appears after admission', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
    const sidecarPath = `${databasePath}-wal`;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(source).not.toBeNull();
    await fs.writeFile(sidecarPath, 'uncheckpointed');

    try {
      await expect(source!.getTeamIdentity(TEAM_ID)).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        '[HostedIdentity] Failed to read the current team identity snapshot',
        expect.objectContaining({ message: 'team-lifecycle-read-identity-database-replaced' })
      );
      await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toBe('uncheckpointed');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retries a brief live SQLite sidecar without accepting stale identity state', async () => {
    const { appDataRoot, databasePath } = await fixture();
    const source = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
    const sidecarPath = `${databasePath}-wal`;

    expect(source).not.toBeNull();
    await fs.writeFile(sidecarPath, 'live-transaction');
    const read = source!.getTeamIdentity(TEAM_ID);
    await new Promise<void>((resolve) => setTimeout(resolve, 12));
    await fs.rm(sidecarPath);

    await expect(read).resolves.toMatchObject({ teamId: TEAM_ID, state: 'active' });
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
