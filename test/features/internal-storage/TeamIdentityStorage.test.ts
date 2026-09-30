import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentChecksum,
  parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
  TeamIdentityStorageErrorCode,
} from '@features/internal-storage/contracts/teamIdentityStorageContracts';
import {
  TeamIdentityStorageInvariantError,
  TeamIdentityStorageOps,
} from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import {
  legacyTeamKeyReservations,
  TEAM_IDENTITY_STORAGE_COMPONENT,
  TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION,
  TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS,
  teamAdoptionIntents,
  teamIdentityRecords,
  teamIdentityStorageMetadata,
} from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted/identifiers';
import Database from 'better-sqlite3-node';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CommitTeamAdoptionInput,
  PrepareTeamAdoptionInput,
  RecordTeamIdentityFilePublishedInput,
  ReserveTeamIdentityInput,
  TeamAdoptionIntent,
} from '@features/internal-storage/contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted/identifiers';

const TEST_ROOT_PREFIX = 'agent-teams-p2-b-team-identity-';
const TEST_ROOT_MARKER = '.agent-teams-p2-b-test-root.json';

interface OwnedRuntimeRoot {
  rootPath: string;
  realPath: string;
  markerToken: string;
}

interface OpenTestStore {
  db: Database.Database;
  ops: TeamIdentityStorageOps;
  root: OwnedRuntimeRoot;
  databasePath: string;
}

const openDatabases: Database.Database[] = [];
const rootsToClean: OwnedRuntimeRoot[] = [];
const ownedRootTokens = new Map<string, string>();

async function createOwnedRuntimeRoot(): Promise<OwnedRuntimeRoot> {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const rootPath = await fs.mkdtemp(path.join(temporaryParent, TEST_ROOT_PREFIX));
  const stat = await fs.lstat(rootPath);
  const realPath = await fs.realpath(rootPath);
  if (stat.isSymbolicLink() || realPath !== rootPath) {
    throw new Error('test runtime root was not created as a direct directory');
  }

  const markerToken = randomUUID();
  await fs.writeFile(
    path.join(rootPath, TEST_ROOT_MARKER),
    JSON.stringify({ component: TEAM_IDENTITY_STORAGE_COMPONENT, markerToken }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  const root = { rootPath, realPath, markerToken };
  ownedRootTokens.set(rootPath, markerToken);
  rootsToClean.push(root);
  return root;
}

async function admitFreshDatabasePath(
  root: OwnedRuntimeRoot,
  relativeDatabasePath = path.join('storage', 'app.db')
): Promise<string> {
  if (ownedRootTokens.get(root.rootPath) !== root.markerToken) {
    throw new Error('test runtime root is not owned by this test');
  }

  const rootStat = await fs.lstat(root.rootPath);
  const currentRealRoot = await fs.realpath(root.rootPath);
  const temporaryParent = await fs.realpath(os.tmpdir());
  if (
    rootStat.isSymbolicLink() ||
    currentRealRoot !== root.realPath ||
    path.dirname(currentRealRoot) !== temporaryParent ||
    !path.basename(currentRealRoot).startsWith(TEST_ROOT_PREFIX)
  ) {
    throw new Error('test runtime root escaped its admitted temporary parent');
  }

  const marker = JSON.parse(
    await fs.readFile(path.join(currentRealRoot, TEST_ROOT_MARKER), 'utf8')
  ) as { component?: unknown; markerToken?: unknown };
  if (
    marker.component !== TEAM_IDENTITY_STORAGE_COMPONENT ||
    marker.markerToken !== root.markerToken
  ) {
    throw new Error('test runtime root marker mismatch');
  }

  const databasePath = path.resolve(currentRealRoot, relativeDatabasePath);
  if (!databasePath.startsWith(`${currentRealRoot}${path.sep}`)) {
    throw new Error('test database path escaped its marker-owned root');
  }

  const storagePath = path.dirname(databasePath);
  let storageStat;
  try {
    storageStat = await fs.lstat(storagePath);
    if (storageStat.isSymbolicLink()) {
      throw new Error('test database parent escaped through a symlink');
    }
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      throw error;
    }
    await fs.mkdir(storagePath, { recursive: false, mode: 0o700 });
    storageStat = await fs.lstat(storagePath);
  }
  const realStoragePath = await fs.realpath(storagePath);
  if (!realStoragePath.startsWith(`${currentRealRoot}${path.sep}`)) {
    throw new Error('test database parent escaped through a symlink');
  }
  try {
    await fs.lstat(databasePath);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return databasePath;
    }
    throw error;
  }
  throw new Error('test database path already exists');
}

async function cleanupOwnedRuntimeRoot(root: OwnedRuntimeRoot): Promise<void> {
  if (ownedRootTokens.get(root.rootPath) !== root.markerToken) {
    throw new Error('refusing cleanup of an unowned test runtime root');
  }
  const stat = await fs.lstat(root.rootPath);
  const currentRealRoot = await fs.realpath(root.rootPath);
  if (stat.isSymbolicLink() || currentRealRoot !== root.realPath) {
    throw new Error('refusing cleanup after test runtime root substitution');
  }
  const marker = JSON.parse(
    await fs.readFile(path.join(currentRealRoot, TEST_ROOT_MARKER), 'utf8')
  ) as { component?: unknown; markerToken?: unknown };
  if (
    marker.component !== TEAM_IDENTITY_STORAGE_COMPONENT ||
    marker.markerToken !== root.markerToken
  ) {
    throw new Error('refusing cleanup after marker mismatch');
  }
  await fs.rm(currentRealRoot, { recursive: true });
  ownedRootTokens.delete(root.rootPath);
}

function applySchemaFragment(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  const apply = db.transaction(() => {
    for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
      db.exec(statement);
    }
  });
  apply();
}

function restoreSchemaObject(db: Database.Database, objectName: string): void {
  const statement = TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS.find((candidate) =>
    candidate.includes(objectName)
  );
  if (!statement) {
    throw new Error(`schema object statement not found: ${objectName}`);
  }
  db.exec(statement);
}

async function makeTestStore(options: { applySchema?: boolean } = {}): Promise<OpenTestStore> {
  const root = await createOwnedRuntimeRoot();
  const databasePath = await admitFreshDatabasePath(root);
  const db = new Database(databasePath);
  openDatabases.push(db);
  if (options.applySchema !== false) {
    applySchemaFragment(db);
  }
  return { db, ops: new TeamIdentityStorageOps(() => db), root, databasePath };
}

function expectStorageError(
  callback: () => unknown,
  code: (typeof TeamIdentityStorageErrorCode)[keyof typeof TeamIdentityStorageErrorCode]
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamIdentityStorageInvariantError);
    expect((error as TeamIdentityStorageInvariantError).code).toBe(code);
    return;
  }
  throw new Error(`expected team identity storage error: ${code}`);
}

const teamId = (digit: string): TeamId => parseTeamId(`team_${digit.repeat(32)}`);
const fingerprint = (digit: string) => parseDirectoryFingerprint(digit.repeat(64));
const checksum = (digit: string) => parseTeamIdentityChecksum(digit.repeat(64));
const intentId = (digit: string) => parseTeamAdoptionIntentId(`adoption_${digit.repeat(32)}`);

const CREATED_AT = '2026-07-16T12:00:00.000Z';
const FILE_PUBLISHED_AT = '2026-07-16T12:00:30.000Z';
const COMMITTED_AT = '2026-07-16T12:01:00.000Z';

function reservationInput(
  overrides: Partial<ReserveTeamIdentityInput> = {}
): ReserveTeamIdentityInput {
  return {
    teamId: teamId('a'),
    legacyKey: parseLegacyTeamKey('legacy-team-a'),
    directoryFingerprint: fingerprint('1'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      generation: 3,
    },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function adoptionInput(
  overrides: Partial<PrepareTeamAdoptionInput> = {}
): PrepareTeamAdoptionInput {
  return {
    intentId: intentId('c'),
    teamId: teamId('a'),
    legacyKey: parseLegacyTeamKey('legacy-team-a'),
    directoryFingerprint: fingerprint('1'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      generation: 3,
    },
    expectedIdentityChecksum: checksum('2'),
    preparedAt: CREATED_AT,
    ...overrides,
  };
}

function filePublishedInput(
  intent: TeamAdoptionIntent,
  overrides: Partial<RecordTeamIdentityFilePublishedInput> = {}
): RecordTeamIdentityFilePublishedInput {
  return {
    intentId: intent.intentId,
    teamId: intent.teamId,
    intentChecksum: intent.intentChecksum,
    identityChecksum: intent.expectedIdentityChecksum,
    filePublishedAt: FILE_PUBLISHED_AT,
    ...overrides,
  };
}

afterEach(async () => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // A test may close its connection before a raw reopen.
    }
  }
  for (const root of rootsToClean.splice(0).reverse()) {
    await cleanupOwnedRuntimeRoot(root);
  }
});

describe('TeamIdentityStorage schema and operations', () => {
  it('creates the isolated schema fragment with immutable transition triggers', async () => {
    const { db } = await makeTestStore();
    applySchemaFragment(db);

    expect(
      db
        .prepare('SELECT schema_version FROM team_identity_storage_metadata WHERE component = ?')
        .pluck()
        .get(TEAM_IDENTITY_STORAGE_COMPONENT)
    ).toBe(TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION);
    const objects = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type IN ('table', 'trigger', 'index') AND name LIKE 'trg_%'
          ORDER BY name`
      )
      .pluck()
      .all();
    expect(objects).toEqual([
      'trg_legacy_team_key_no_delete',
      'trg_legacy_team_key_transition',
      'trg_team_adoption_intent_no_delete',
      'trg_team_adoption_intent_transition',
      'trg_team_identity_metadata_no_delete',
      'trg_team_identity_metadata_no_update',
      'trg_team_identity_no_delete',
      'trg_team_identity_transition',
    ]);

    for (const table of [
      teamIdentityStorageMetadata,
      teamIdentityRecords,
      legacyTeamKeyReservations,
      teamAdoptionIntents,
    ]) {
      const tableName = getTableName(table);
      const actualColumns = (db.pragma(`table_info(${tableName})`) as { name: string }[])
        .map((column) => column.name)
        .sort((left, right) => left.localeCompare(right));
      const declaredColumns = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort((left, right) => left.localeCompare(right));
      expect(actualColumns, `columns of ${tableName}`).toEqual(declaredColumns);
    }
  });

  it('reserves one canonical identity idempotently without exposing database rows', async () => {
    const { ops } = await makeTestStore();
    const input = reservationInput();

    const created = ops.reserveIdentity(input);
    const retried = ops.reserveIdentity(input);

    expect(created.outcome).toBe('created');
    expect(retried.outcome).toBe('already_reserved');
    expect(retried.identity).toEqual({
      teamId: input.teamId,
      state: 'reserved',
      legacyKey: input.legacyKey,
      directoryFingerprint: input.directoryFingerprint,
      workspaceBinding: input.workspaceBinding,
      adoptionIntentId: null,
      identityChecksum: null,
      createdAt: CREATED_AT,
      activatedAt: null,
      tombstonedAt: null,
    });
    expect(retried.reservation).toMatchObject({
      legacyKey: input.legacyKey,
      teamId: input.teamId,
      state: 'active',
    });
  });

  it('lists identities deterministically and validates tombstones plus the reservation graph', async () => {
    const { db, ops } = await makeTestStore();
    const later = reservationInput({
      teamId: teamId('d'),
      legacyKey: parseLegacyTeamKey('legacy-team-d'),
      directoryFingerprint: fingerprint('4'),
    });
    const earlier = reservationInput();
    ops.reserveIdentity(later);
    ops.reserveIdentity(earlier);
    ops.tombstoneLegacyKey({
      teamId: earlier.teamId,
      legacyKey: earlier.legacyKey,
      reason: 'draft_deleted',
      tombstonedAt: COMMITTED_AT,
    });

    expect(ops.listIdentities()).toEqual([
      expect.objectContaining({ teamId: earlier.teamId, state: 'tombstoned' }),
      expect.objectContaining({ teamId: later.teamId, state: 'reserved' }),
    ]);

    db.exec('DROP TRIGGER trg_legacy_team_key_no_delete');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM legacy_team_key_reservations WHERE legacy_key = ?').run(
      later.legacyKey
    );
    restoreSchemaObject(db, 'trg_legacy_team_key_no_delete');
    expectStorageError(() => ops.listIdentities(), TeamIdentityStorageErrorCode.TamperingDetected);
  });

  it('fails closed when persisted identity chronology diverges from its reservation', async () => {
    const { db, ops } = await makeTestStore();
    const input = reservationInput();
    ops.reserveIdentity(input);
    db.exec('DROP TRIGGER trg_team_identity_transition');
    db.prepare('UPDATE team_identity_records SET created_at = ? WHERE team_id = ?').run(
      '2026-07-16T12:00:01.000Z',
      input.teamId
    );
    restoreSchemaObject(db, 'trg_team_identity_transition');

    expectStorageError(
      () => ops.getIdentity(input.teamId),
      TeamIdentityStorageErrorCode.TamperingDetected
    );
  });

  it('accepts only exact lowercase ASCII legacy keys without silent normalization', () => {
    expect(parseLegacyTeamKey('team-01')).toBe('team-01');
    expect(parseLegacyTeamKey(`a${'-'.repeat(127)}`)).toHaveLength(128);

    for (const invalid of [
      '',
      '-team',
      'Team-01',
      ' team-01',
      'team-01 ',
      'team_01',
      'team.01',
      'team/01',
      'team\\01',
      't\u00e9am',
      '\uff54\uff45\uff41\uff4d',
      `a${'-'.repeat(128)}`,
    ]) {
      expect(() => parseLegacyTeamKey(invalid), JSON.stringify(invalid)).toThrow(
        /team-identity-legacy-key-invalid/
      );
    }

    for (const reserved of [
      'aux',
      'con',
      'nul',
      'prn',
      ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
    ]) {
      expect(() => parseLegacyTeamKey(reserved), reserved).toThrow(
        /team-identity-legacy-key-invalid/
      );
    }
  });

  it('enforces the exact legacy-key policy in SQLite even when the parser is bypassed', async () => {
    const { db } = await makeTestStore();
    const insert = db.prepare(
      `INSERT INTO team_identity_records (
        team_id, state, legacy_key, directory_fingerprint, workspace_id,
        workspace_binding_generation, adoption_intent_id, identity_checksum,
        created_at, activated_at, tombstoned_at
      ) VALUES (?, 'reserved', ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)`
    );

    for (const [index, invalid] of [
      'Team-01',
      ' team-01',
      'team_01',
      't\u00e9am',
      'con',
      'lpt9',
    ].entries()) {
      expect(() =>
        insert.run(teamId(index.toString(16)), invalid, fingerprint(index.toString(16)), CREATED_AT)
      ).toThrow(/constraint/i);
    }
    expect(db.prepare('SELECT COUNT(*) FROM team_identity_records').pluck().get()).toBe(0);
  });

  it('rejects duplicate ids, fingerprints, exact keys and last-write-wins repair', async () => {
    const { ops } = await makeTestStore();
    ops.reserveIdentity(reservationInput());

    expectStorageError(
      () => ops.reserveIdentity(reservationInput({ directoryFingerprint: fingerprint('3') })),
      TeamIdentityStorageErrorCode.DuplicateIdentity
    );
    expectStorageError(
      () =>
        ops.reserveIdentity(
          reservationInput({
            teamId: teamId('d'),
            legacyKey: parseLegacyTeamKey('legacy-team-a'),
            directoryFingerprint: fingerprint('4'),
          })
        ),
      TeamIdentityStorageErrorCode.LegacyKeyConflict
    );
    expectStorageError(
      () =>
        ops.reserveIdentity(
          reservationInput({
            teamId: teamId('d'),
            legacyKey: parseLegacyTeamKey('different-key'),
          })
        ),
      TeamIdentityStorageErrorCode.DuplicateIdentity
    );
  });

  it('prepares adoption atomically and classifies exact retry versus mismatch', async () => {
    const { ops } = await makeTestStore();
    const input = adoptionInput();

    const prepared = ops.prepareAdoption(input);
    const retried = ops.prepareAdoption(input);

    expect(prepared.outcome).toBe('prepared');
    expect(retried.outcome).toBe('already_prepared');
    expect(prepared.identity.state).toBe('adoption_prepared');
    expect(prepared.intent).toMatchObject({
      intentId: input.intentId,
      teamId: input.teamId,
      state: 'prepared',
      workspaceBinding: input.workspaceBinding,
      expectedIdentityChecksum: input.expectedIdentityChecksum,
    });
    expectStorageError(
      () => ops.prepareAdoption({ ...input, directoryFingerprint: fingerprint('3') }),
      TeamIdentityStorageErrorCode.AdoptionIntentMismatch
    );
  });

  it('requires and durably recovers prepared -> file_published -> committed', async () => {
    const store = await makeTestStore();
    const prepared = store.ops.prepareAdoption(adoptionInput());
    const commit: CommitTeamAdoptionInput = {
      intentId: prepared.intent.intentId,
      teamId: prepared.intent.teamId,
      intentChecksum: prepared.intent.intentChecksum,
      identityChecksum: prepared.intent.expectedIdentityChecksum,
      committedAt: COMMITTED_AT,
    };

    expectStorageError(
      () => store.ops.commitAdoption(commit),
      TeamIdentityStorageErrorCode.IllegalTransition
    );
    expect(store.ops.getAdoptionIntent(prepared.intent.intentId)).toMatchObject({
      state: 'prepared',
      filePublishedAt: null,
      publishedIdentityChecksum: null,
    });

    const published = store.ops.recordIdentityFilePublished(filePublishedInput(prepared.intent));
    expectStorageError(
      () =>
        store.ops.commitAdoption({
          ...commit,
          committedAt: '2026-07-16T12:00:15.000Z',
        }),
      TeamIdentityStorageErrorCode.IllegalTransition
    );
    expect(store.ops.prepareAdoption(adoptionInput()).outcome).toBe('already_file_published');
    expect(
      store.ops.recordIdentityFilePublished(
        filePublishedInput(prepared.intent, {
          filePublishedAt: '2026-07-16T12:00:45.000Z',
        })
      )
    ).toMatchObject({
      outcome: 'already_file_published',
      intent: { filePublishedAt: FILE_PUBLISHED_AT },
    });

    store.db.close();
    const reopenedDb = new Database(store.databasePath);
    openDatabases.push(reopenedDb);
    const recoveredOps = new TeamIdentityStorageOps(() => reopenedDb);
    expect(recoveredOps.getAdoptionIntent(prepared.intent.intentId)).toEqual(published.intent);

    const committed = recoveredOps.commitAdoption(commit);
    expect(committed).toMatchObject({
      outcome: 'committed',
      identity: { state: 'active', identityChecksum: commit.identityChecksum },
      intent: {
        state: 'committed',
        filePublishedAt: FILE_PUBLISHED_AT,
        publishedIdentityChecksum: commit.identityChecksum,
        committedAt: COMMITTED_AT,
      },
    });
    expect(
      recoveredOps.recordIdentityFilePublished(
        filePublishedInput(prepared.intent, {
          filePublishedAt: '2026-07-16T12:02:00.000Z',
        })
      )
    ).toMatchObject({ outcome: 'already_committed', intent: { committedAt: COMMITTED_AT } });
  });

  it('commits adoption once and makes exact retries converge', async () => {
    const { ops } = await makeTestStore();
    const prepared = ops.prepareAdoption(adoptionInput());
    const published = ops.recordIdentityFilePublished(filePublishedInput(prepared.intent));
    const commit: CommitTeamAdoptionInput = {
      intentId: prepared.intent.intentId,
      teamId: prepared.intent.teamId,
      intentChecksum: prepared.intent.intentChecksum,
      identityChecksum: prepared.intent.expectedIdentityChecksum,
      committedAt: COMMITTED_AT,
    };

    const committed = ops.commitAdoption(commit);
    const retried = ops.commitAdoption({
      ...commit,
      committedAt: '2026-07-16T12:02:00.000Z',
    });

    expect(published).toMatchObject({
      outcome: 'file_published',
      identity: { state: 'file_published', identityChecksum: commit.identityChecksum },
      intent: {
        state: 'file_published',
        filePublishedAt: FILE_PUBLISHED_AT,
        publishedIdentityChecksum: commit.identityChecksum,
      },
    });
    expect(committed.outcome).toBe('committed');
    expect(retried.outcome).toBe('already_committed');
    expect(retried.identity).toMatchObject({
      state: 'active',
      identityChecksum: commit.identityChecksum,
      workspaceBinding: adoptionInput().workspaceBinding,
    });
    expect(retried.intent).toMatchObject({
      state: 'committed',
      committedIdentityChecksum: commit.identityChecksum,
      committedAt: COMMITTED_AT,
    });

    ops.tombstoneLegacyKey({
      teamId: committed.identity.teamId,
      legacyKey: committed.identity.legacyKey,
      reason: 'team_deleted',
      tombstonedAt: '2026-07-16T12:03:00.000Z',
    });
    const retryAfterTombstone = ops.commitAdoption({
      ...commit,
      committedAt: '2026-07-16T12:04:00.000Z',
    });
    expect(retryAfterTombstone).toMatchObject({
      outcome: 'already_committed',
      identity: { state: 'tombstoned', identityChecksum: commit.identityChecksum },
      reservation: { state: 'tombstoned' },
      intent: { state: 'committed', committedAt: COMMITTED_AT },
    });
  });

  it('distinguishes caller mismatch, published checksum disagreement and stored tampering', async () => {
    const { db, ops } = await makeTestStore();
    const prepared = ops.prepareAdoption(adoptionInput());

    expectStorageError(
      () =>
        ops.recordIdentityFilePublished({
          ...filePublishedInput(prepared.intent),
          intentChecksum: parseTeamAdoptionIntentChecksum('3'.repeat(64)),
        }),
      TeamIdentityStorageErrorCode.AdoptionIntentMismatch
    );
    expectStorageError(
      () =>
        ops.recordIdentityFilePublished({
          ...filePublishedInput(prepared.intent),
          identityChecksum: checksum('4'),
        }),
      TeamIdentityStorageErrorCode.ChecksumDisagreement
    );

    db.exec('DROP TRIGGER trg_team_adoption_intent_transition');
    db.prepare('UPDATE team_adoption_intents SET intent_checksum = ? WHERE intent_id = ?').run(
      '5'.repeat(64),
      prepared.intent.intentId
    );
    restoreSchemaObject(db, 'trg_team_adoption_intent_transition');
    expectStorageError(
      () => ops.getAdoptionIntent(prepared.intent.intentId),
      TeamIdentityStorageErrorCode.TamperingDetected
    );
  });

  it('makes tombstones immutable and prevents key reuse at the SQLite boundary', async () => {
    const { db, ops } = await makeTestStore();
    const input = reservationInput();
    ops.reserveIdentity(input);

    const tombstoned = ops.tombstoneLegacyKey({
      teamId: input.teamId,
      legacyKey: input.legacyKey,
      reason: 'team_deleted',
      tombstonedAt: COMMITTED_AT,
    });
    const retried = ops.tombstoneLegacyKey({
      teamId: input.teamId,
      legacyKey: input.legacyKey,
      reason: 'team_deleted',
      tombstonedAt: '2026-07-16T12:02:00.000Z',
    });

    expect(tombstoned.outcome).toBe('tombstoned');
    expect(retried.outcome).toBe('already_tombstoned');
    expect(() =>
      db
        .prepare('DELETE FROM legacy_team_key_reservations WHERE legacy_key = ?')
        .run(input.legacyKey)
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare(
          `UPDATE legacy_team_key_reservations
            SET state = 'active', tombstoned_at = NULL, tombstone_reason = NULL
            WHERE legacy_key = ?`
        )
        .run(input.legacyKey)
    ).toThrow(/illegal legacy team key transition/);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO legacy_team_key_reservations (
            legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
          ) VALUES (?, ?, 'active', ?, NULL, NULL)`
        )
        .run(input.legacyKey, input.teamId, CREATED_AT)
    ).toThrow(/immutable/);
    expectStorageError(
      () =>
        ops.reserveIdentity(
          reservationInput({
            teamId: teamId('d'),
            directoryFingerprint: fingerprint('4'),
          })
        ),
      TeamIdentityStorageErrorCode.LegacyKeyTombstoned
    );
  });

  it('rejects commit after a prepared or file-published identity is tombstoned', async () => {
    for (const publishBeforeTombstone of [false, true]) {
      const { ops } = await makeTestStore();
      const prepared = ops.prepareAdoption(adoptionInput());
      if (publishBeforeTombstone) {
        ops.recordIdentityFilePublished(filePublishedInput(prepared.intent));
      }
      ops.tombstoneLegacyKey({
        teamId: prepared.identity.teamId,
        legacyKey: prepared.identity.legacyKey,
        reason: 'legacy_conflict',
        tombstonedAt: COMMITTED_AT,
      });

      expectStorageError(
        () =>
          ops.commitAdoption({
            intentId: prepared.intent.intentId,
            teamId: prepared.intent.teamId,
            intentChecksum: prepared.intent.intentChecksum,
            identityChecksum: prepared.intent.expectedIdentityChecksum,
            committedAt: '2026-07-16T12:02:00.000Z',
          }),
        TeamIdentityStorageErrorCode.IllegalTransition
      );
    }
  });

  it('fails closed for missing component schema and unknown stored state', async () => {
    const missing = await makeTestStore({ applySchema: false });
    expectStorageError(
      () => missing.ops.getIdentity(teamId('a')),
      TeamIdentityStorageErrorCode.UnknownSchema
    );

    const current = await makeTestStore();
    const input = reservationInput();
    current.ops.reserveIdentity(input);
    current.db.exec('DROP TRIGGER trg_team_identity_transition');
    current.db.pragma('ignore_check_constraints = ON');
    current.db
      .prepare("UPDATE team_identity_records SET state = 'future' WHERE team_id = ?")
      .run(input.teamId);
    restoreSchemaObject(current.db, 'trg_team_identity_transition');
    expectStorageError(
      () => current.ops.getIdentity(input.teamId),
      TeamIdentityStorageErrorCode.UnknownState
    );
  });

  it('fails closed when an expected trigger or index keeps its name but changes definition', async () => {
    const triggerStore = await makeTestStore();
    triggerStore.db.exec('DROP TRIGGER trg_team_identity_transition');
    triggerStore.db.exec(`CREATE TRIGGER trg_team_identity_transition
      BEFORE UPDATE ON team_identity_records BEGIN SELECT 1; END`);
    expectStorageError(
      () => triggerStore.ops.getIdentity(teamId('a')),
      TeamIdentityStorageErrorCode.UnknownSchema
    );

    const indexStore = await makeTestStore();
    indexStore.db.exec('DROP INDEX idx_team_identity_checksum');
    indexStore.db.exec(`CREATE INDEX idx_team_identity_checksum
      ON team_identity_records (legacy_key)`);
    expectStorageError(
      () => indexStore.ops.getIdentity(teamId('a')),
      TeamIdentityStorageErrorCode.UnknownSchema
    );
  });

  it('fails closed for altered table SQL and unexpected component schema objects', async () => {
    const altered = await makeTestStore({ applySchema: false });
    for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) {
      altered.db.exec(
        statement.startsWith('CREATE TABLE IF NOT EXISTS team_adoption_intents')
          ? statement.replace(
              "state TEXT NOT NULL CHECK (state IN ('prepared', 'file_published', 'committed'))",
              "state TEXT NOT NULL CHECK (state IN ('prepared', 'file_published', 'committed', 'future'))"
            )
          : statement
      );
    }
    expectStorageError(
      () => altered.ops.getIdentity(teamId('a')),
      TeamIdentityStorageErrorCode.UnknownSchema
    );

    const extra = await makeTestStore();
    extra.db.exec(`CREATE TRIGGER trg_team_identity_unexpected
      AFTER INSERT ON team_identity_records BEGIN SELECT 1; END`);
    expectStorageError(
      () => extra.ops.getIdentity(teamId('a')),
      TeamIdentityStorageErrorCode.UnknownSchema
    );
  });

  it('rejects invalid canonical values and workspace generations before writes', async () => {
    const { db, ops } = await makeTestStore();

    expectStorageError(
      () =>
        ops.reserveIdentity({
          ...reservationInput(),
          teamId: 'team_display-name' as TeamId,
        }),
      TeamIdentityStorageErrorCode.InvalidInput
    );
    expectStorageError(
      () =>
        ops.reserveIdentity({
          ...reservationInput(),
          workspaceBinding: {
            workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
            generation: 0,
          },
        }),
      TeamIdentityStorageErrorCode.InvalidInput
    );
    expect(db.prepare('SELECT COUNT(*) FROM team_identity_records').pluck().get()).toBe(0);
  });
});

describe('TeamIdentityStorage test-root admission', () => {
  it('rejects unowned, ambient and pre-existing database paths before SQLite access', async () => {
    const owned = await createOwnedRuntimeRoot();
    const unmarkedChild = path.join(owned.rootPath, 'unmarked-child');
    await fs.mkdir(unmarkedChild);
    const forged: OwnedRuntimeRoot = {
      rootPath: unmarkedChild,
      realPath: unmarkedChild,
      markerToken: randomUUID(),
    };
    await expect(admitFreshDatabasePath(forged)).rejects.toThrow(/not owned/);
    await expect(
      admitFreshDatabasePath({
        rootPath: os.tmpdir(),
        realPath: os.tmpdir(),
        markerToken: randomUUID(),
      })
    ).rejects.toThrow(/not owned/);
    await expect(
      admitFreshDatabasePath({
        rootPath: os.homedir(),
        realPath: os.homedir(),
        markerToken: randomUUID(),
      })
    ).rejects.toThrow(/not owned/);
    await expect(admitFreshDatabasePath(owned, path.join('..', 'escaped.db'))).rejects.toThrow(
      /escaped/
    );

    const databasePath = await admitFreshDatabasePath(owned);
    await fs.writeFile(databasePath, 'pre-existing', { flag: 'wx' });
    await expect(admitFreshDatabasePath(owned)).rejects.toThrow(/already exists/);
  });

  it('rejects a symlink-escaped database parent and cleans only marker-owned roots', async () => {
    const root = await createOwnedRuntimeRoot();
    const escapeTarget = await createOwnedRuntimeRoot();
    await fs.symlink(escapeTarget.rootPath, path.join(root.rootPath, 'storage'), 'dir');

    await expect(admitFreshDatabasePath(root)).rejects.toThrow(/symlink/);
    await expect(
      fs.readFile(path.join(escapeTarget.rootPath, TEST_ROOT_MARKER), 'utf8')
    ).resolves.toContain(escapeTarget.markerToken);
  });
});
