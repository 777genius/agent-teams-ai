import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
  MAX_TEAM_IDENTITY_READ_RECORDS,
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentChecksum,
  parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { parseTeamId, parseWorkspaceId, type TeamId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3';

const MAX_IDENTITY_DATABASE_BYTES = 512 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const EXPECTED_COMPONENT = 'team-identity';
const EXPECTED_COMPONENT_SCHEMA_VERSION = 1;
const DATABASE_SIDECAR_SUFFIXES = Object.freeze(['-journal', '-shm', '-wal']);
const EXPECTED_SCHEMA_OBJECT_COUNT = 23;
// Pins the complete schema-v1 sqlite_schema projection: canonical tables (and their CHECK/FK
// constraints), explicit and automatic indexes, and transition/immutability triggers.
const EXPECTED_SCHEMA_DIGEST = '570be2f0773d8768848f2bef11c3cd70129199ac86730b055980fc46b90fdf36';
const COMPONENT_TABLE_NAMES = Object.freeze([
  'legacy_team_key_reservations',
  'team_adoption_intents',
  'team_identity_records',
  'team_identity_storage_metadata',
]);

interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface IdentityRow {
  readonly team_id: unknown;
  readonly state: unknown;
  readonly legacy_key: unknown;
  readonly directory_fingerprint: unknown;
  readonly workspace_id: unknown;
  readonly workspace_binding_generation: unknown;
  readonly adoption_intent_id: unknown;
  readonly identity_checksum: unknown;
  readonly created_at: unknown;
  readonly activated_at: unknown;
  readonly tombstoned_at: unknown;
}

interface ReservationRow {
  readonly legacy_key: unknown;
  readonly team_id: unknown;
  readonly state: unknown;
  readonly reserved_at: unknown;
  readonly tombstoned_at: unknown;
  readonly tombstone_reason: unknown;
}

interface AdoptionIntentRow {
  readonly intent_id: unknown;
  readonly team_id: unknown;
  readonly state: unknown;
  readonly legacy_key: unknown;
  readonly directory_fingerprint: unknown;
  readonly workspace_id: unknown;
  readonly workspace_binding_generation: unknown;
  readonly expected_identity_checksum: unknown;
  readonly intent_checksum: unknown;
  readonly prepared_at: unknown;
  readonly file_published_at: unknown;
  readonly published_identity_checksum: unknown;
  readonly committed_at: unknown;
  readonly committed_identity_checksum: unknown;
}

interface ParsedReservation {
  readonly legacyKey: string;
  readonly teamId: TeamId;
  readonly state: 'active' | 'tombstoned';
  readonly reservedAt: string;
  readonly tombstonedAt: string | null;
  readonly tombstoneReason: 'draft_deleted' | 'team_deleted' | 'legacy_conflict' | null;
}

interface ParsedAdoptionIntent {
  readonly intentId: string;
  readonly teamId: TeamId;
  readonly state: 'prepared' | 'file_published' | 'committed';
  readonly legacyKey: string;
  readonly directoryFingerprint: string;
  readonly workspaceBinding: { readonly workspaceId: string; readonly generation: number } | null;
  readonly expectedIdentityChecksum: string;
  readonly intentChecksum: string;
  readonly preparedAt: string;
  readonly filePublishedAt: string | null;
  readonly publishedIdentityChecksum: string | null;
  readonly committedAt: string | null;
  readonly committedIdentityChecksum: string | null;
}

export interface TeamLifecycleReadOnlyIdentitySourceInput {
  readonly appDataRoot: string;
}

function entryIdentity(stat: fs.Stats): EntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameEntry(stat: fs.Stats, expected: EntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw new Error('team-lifecycle-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function stableFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    sameEntry(after, entryIdentity(before)) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function isDirectChild(root: string, candidate: string, expectedName: string): boolean {
  return path.relative(root, candidate) === expectedName;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function lstatIfPresent(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

async function sidecarsAreAbsent(databasePath: string): Promise<boolean> {
  const values = await Promise.all(
    DATABASE_SIDECAR_SUFFIXES.map((suffix) => lstatIfPresent(`${databasePath}${suffix}`))
  );
  return values.every((value) => value === null);
}

async function readDescriptorSnapshot(
  databasePath: string,
  expectedPathStat: fs.Stats
): Promise<Buffer> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(databasePath, noFollowReadFlags());
    const opened = await handle.stat();
    if (!opened.isFile() || !stableFile(expectedPathStat, opened)) {
      throw new Error('team-lifecycle-read-identity-database-replaced');
    }

    const buffer = Buffer.allocUnsafe(expectedPathStat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== expectedPathStat.size || !stableFile(opened, after)) {
      throw new Error('team-lifecycle-read-identity-database-changed');
    }
    return buffer.subarray(0, offset);
  } finally {
    if (handle) await handle.close();
  }
}

async function readImmutableDatabaseSnapshot(appDataRoot: string): Promise<Buffer> {
  if (
    !path.isAbsolute(appDataRoot) ||
    path.resolve(appDataRoot) !== appDataRoot ||
    appDataRoot === path.parse(appDataRoot).root
  ) {
    throw new Error('team-lifecycle-read-app-data-root-invalid');
  }

  const storagePath = path.join(appDataRoot, INTERNAL_STORAGE_DIRNAME);
  const databasePath = path.join(storagePath, INTERNAL_STORAGE_DATABASE_FILENAME);
  const [rootStat, storageStat, canonicalRoot, canonicalStorage, canonicalDatabase, databaseStat] =
    await Promise.all([
      fs.promises.lstat(appDataRoot),
      fs.promises.lstat(storagePath),
      fs.promises.realpath(appDataRoot),
      fs.promises.realpath(storagePath),
      fs.promises.realpath(databasePath),
      fs.promises.lstat(databasePath),
    ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !storageStat.isDirectory() ||
    storageStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    canonicalRoot !== appDataRoot ||
    canonicalStorage !== storagePath ||
    canonicalDatabase !== databasePath ||
    !isDirectChild(canonicalRoot, canonicalStorage, INTERNAL_STORAGE_DIRNAME) ||
    !isDirectChild(canonicalStorage, canonicalDatabase, INTERNAL_STORAGE_DATABASE_FILENAME) ||
    databaseStat.size < 1 ||
    !Number.isSafeInteger(databaseStat.size) ||
    databaseStat.size > MAX_IDENTITY_DATABASE_BYTES ||
    !(await sidecarsAreAbsent(databasePath))
  ) {
    throw new Error('team-lifecycle-read-identity-database-unavailable');
  }

  const snapshot = await readDescriptorSnapshot(databasePath, databaseStat);
  const [
    rootAfter,
    storageAfter,
    databaseAfter,
    rootPathAfter,
    storagePathAfter,
    databasePathAfter,
  ] = await Promise.all([
    fs.promises.lstat(appDataRoot),
    fs.promises.lstat(storagePath),
    fs.promises.lstat(databasePath),
    fs.promises.realpath(appDataRoot),
    fs.promises.realpath(storagePath),
    fs.promises.realpath(databasePath),
  ]);
  if (
    !sameEntry(rootAfter, entryIdentity(rootStat)) ||
    !sameEntry(storageAfter, entryIdentity(storageStat)) ||
    !stableFile(databaseStat, databaseAfter) ||
    rootPathAfter !== canonicalRoot ||
    storagePathAfter !== canonicalStorage ||
    databasePathAfter !== canonicalDatabase ||
    !(await sidecarsAreAbsent(databasePath))
  ) {
    throw new Error('team-lifecycle-read-identity-database-changed');
  }
  return snapshot;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('team-lifecycle-read-identity-timestamp-invalid');
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function workspaceBinding(
  workspaceId: unknown,
  generation: unknown
): { readonly workspaceId: string; readonly generation: number } | null {
  if (workspaceId === null && generation === null) return null;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new TypeError('team-lifecycle-read-identity-workspace-binding-invalid');
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(workspaceId),
    generation: generation as number,
  });
}

function parseIdentityRow(row: IdentityRow): TeamIdentityRecord {
  return parseTeamIdentityRecord({
    teamId: row.team_id,
    state: row.state,
    legacyKey: row.legacy_key,
    directoryFingerprint: row.directory_fingerprint,
    workspaceBinding: workspaceBinding(row.workspace_id, row.workspace_binding_generation),
    adoptionIntentId: row.adoption_intent_id,
    identityChecksum: row.identity_checksum,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    tombstonedAt: row.tombstoned_at,
  });
}

function parseReservationRow(row: ReservationRow): ParsedReservation {
  const state = row.state;
  if (state !== 'active' && state !== 'tombstoned') {
    throw new TypeError('team-lifecycle-read-identity-reservation-state-invalid');
  }
  const tombstoneReason = row.tombstone_reason;
  if (
    tombstoneReason !== null &&
    tombstoneReason !== 'draft_deleted' &&
    tombstoneReason !== 'team_deleted' &&
    tombstoneReason !== 'legacy_conflict'
  ) {
    throw new TypeError('team-lifecycle-read-identity-reservation-reason-invalid');
  }
  const parsed = Object.freeze({
    legacyKey: parseLegacyTeamKey(row.legacy_key) as string,
    teamId: parseTeamId(row.team_id),
    state,
    reservedAt: timestamp(row.reserved_at),
    tombstonedAt: nullableTimestamp(row.tombstoned_at),
    tombstoneReason,
  });
  if (
    (state === 'active' && (parsed.tombstonedAt !== null || tombstoneReason !== null)) ||
    (state === 'tombstoned' && (parsed.tombstonedAt === null || tombstoneReason === null))
  ) {
    throw new TypeError('team-lifecycle-read-identity-reservation-fields-invalid');
  }
  return parsed;
}

function parseIntentRow(row: AdoptionIntentRow): ParsedAdoptionIntent {
  const state = row.state;
  if (state !== 'prepared' && state !== 'file_published' && state !== 'committed') {
    throw new TypeError('team-lifecycle-read-identity-intent-state-invalid');
  }
  const parsed = Object.freeze({
    intentId: parseTeamAdoptionIntentId(row.intent_id) as string,
    teamId: parseTeamId(row.team_id),
    state,
    legacyKey: parseLegacyTeamKey(row.legacy_key) as string,
    directoryFingerprint: parseDirectoryFingerprint(row.directory_fingerprint) as string,
    workspaceBinding: workspaceBinding(row.workspace_id, row.workspace_binding_generation),
    expectedIdentityChecksum: parseTeamIdentityChecksum(row.expected_identity_checksum) as string,
    intentChecksum: parseTeamAdoptionIntentChecksum(row.intent_checksum) as string,
    preparedAt: timestamp(row.prepared_at),
    filePublishedAt: nullableTimestamp(row.file_published_at),
    publishedIdentityChecksum:
      row.published_identity_checksum === null
        ? null
        : (parseTeamIdentityChecksum(row.published_identity_checksum) as string),
    committedAt: nullableTimestamp(row.committed_at),
    committedIdentityChecksum:
      row.committed_identity_checksum === null
        ? null
        : (parseTeamIdentityChecksum(row.committed_identity_checksum) as string),
  });
  const stateFieldsValid =
    (state === 'prepared' &&
      parsed.filePublishedAt === null &&
      parsed.publishedIdentityChecksum === null &&
      parsed.committedAt === null &&
      parsed.committedIdentityChecksum === null) ||
    (state === 'file_published' &&
      parsed.filePublishedAt !== null &&
      parsed.publishedIdentityChecksum === parsed.expectedIdentityChecksum &&
      parsed.committedAt === null &&
      parsed.committedIdentityChecksum === null) ||
    (state === 'committed' &&
      parsed.filePublishedAt !== null &&
      parsed.publishedIdentityChecksum === parsed.expectedIdentityChecksum &&
      parsed.committedAt !== null &&
      parsed.committedIdentityChecksum === parsed.expectedIdentityChecksum);
  const canonical = JSON.stringify({
    schemaVersion: 1,
    intentId: parsed.intentId,
    teamId: parsed.teamId,
    legacyKey: parsed.legacyKey,
    directoryFingerprint: parsed.directoryFingerprint,
    workspaceId: parsed.workspaceBinding?.workspaceId ?? null,
    workspaceBindingGeneration: parsed.workspaceBinding?.generation ?? null,
    expectedIdentityChecksum: parsed.expectedIdentityChecksum,
    preparedAt: parsed.preparedAt,
  });
  const expectedIntentChecksum = createHash('sha256').update(canonical).digest('hex');
  if (
    !stateFieldsValid ||
    parsed.intentChecksum !== expectedIntentChecksum ||
    (parsed.filePublishedAt !== null &&
      Date.parse(parsed.filePublishedAt) < Date.parse(parsed.preparedAt)) ||
    (parsed.committedAt !== null &&
      parsed.filePublishedAt !== null &&
      Date.parse(parsed.committedAt) < Date.parse(parsed.filePublishedAt))
  ) {
    throw new TypeError('team-lifecycle-read-identity-intent-fields-invalid');
  }
  return parsed;
}

function validateGraph(
  identities: readonly TeamIdentityRecord[],
  reservations: readonly ParsedReservation[],
  intents: readonly ParsedAdoptionIntent[]
): void {
  if (reservations.length !== identities.length || intents.length > identities.length) {
    throw new TypeError('team-lifecycle-read-identity-graph-invalid');
  }
  const identityById = new Map(identities.map((identity) => [identity.teamId, identity]));
  const identityByLegacyKey = new Map(identities.map((identity) => [identity.legacyKey, identity]));
  const identityByFingerprint = new Map(
    identities.map((identity) => [identity.directoryFingerprint, identity])
  );
  const reservationByKey = new Map(
    reservations.map((reservation) => [reservation.legacyKey, reservation])
  );
  const intentById = new Map(intents.map((intent) => [intent.intentId, intent]));
  const expectedIdentityChecksums = new Set(
    intents.map((intent) => intent.expectedIdentityChecksum)
  );
  const publishedIdentityChecksums = new Set(
    intents.flatMap((intent) =>
      intent.publishedIdentityChecksum === null ? [] : [intent.publishedIdentityChecksum]
    )
  );
  const publishedIdentityChecksumCount = intents.filter(
    (intent) => intent.publishedIdentityChecksum !== null
  ).length;
  if (
    identityById.size !== identities.length ||
    identityByLegacyKey.size !== identities.length ||
    identityByFingerprint.size !== identities.length ||
    reservationByKey.size !== reservations.length ||
    intentById.size !== intents.length ||
    expectedIdentityChecksums.size !== intents.length ||
    publishedIdentityChecksums.size !== publishedIdentityChecksumCount
  ) {
    throw new TypeError('team-lifecycle-read-identity-graph-invalid');
  }

  for (const identity of identities) {
    const reservation = reservationByKey.get(identity.legacyKey);
    if (
      !reservation ||
      reservation.teamId !== identity.teamId ||
      reservation.reservedAt !== identity.createdAt ||
      reservation.tombstonedAt !== identity.tombstonedAt ||
      (identity.state === 'tombstoned') !== (reservation.state === 'tombstoned') ||
      (identity.state !== 'tombstoned' && reservation.state !== 'active')
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }

    const intent =
      identity.adoptionIntentId === null
        ? null
        : (intentById.get(identity.adoptionIntentId as string) ?? null);
    if (
      (identity.adoptionIntentId === null) !== (intent === null) ||
      (identity.adoptionIntentId === null &&
        identity.state !== 'reserved' &&
        identity.state !== 'tombstoned')
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
    if (!intent) {
      if (identity.identityChecksum !== null || identity.activatedAt !== null) {
        throw new TypeError('team-lifecycle-read-identity-graph-invalid');
      }
      continue;
    }
    if (
      intent.teamId !== identity.teamId ||
      intent.legacyKey !== identity.legacyKey ||
      intent.directoryFingerprint !== identity.directoryFingerprint ||
      intent.workspaceBinding?.workspaceId !== identity.workspaceBinding?.workspaceId ||
      intent.workspaceBinding?.generation !== identity.workspaceBinding?.generation ||
      intent.preparedAt !== identity.createdAt
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
    if (identity.state === 'adoption_prepared' && intent.state !== 'prepared') {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
    if (
      identity.state === 'file_published' &&
      (intent.state !== 'file_published' ||
        identity.identityChecksum !== intent.expectedIdentityChecksum)
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
    if (
      identity.state === 'active' &&
      (intent.state !== 'committed' ||
        identity.identityChecksum !== intent.expectedIdentityChecksum ||
        identity.activatedAt !== intent.committedAt)
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
    if (
      identity.state === 'tombstoned' &&
      ((intent.state === 'prepared' &&
        (identity.identityChecksum !== null || identity.activatedAt !== null)) ||
        (intent.state === 'file_published' &&
          (identity.identityChecksum !== intent.expectedIdentityChecksum ||
            identity.activatedAt !== null)) ||
        (intent.state === 'committed' &&
          (identity.identityChecksum !== intent.expectedIdentityChecksum ||
            identity.activatedAt !== intent.committedAt)))
    ) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
  }

  for (const reservation of reservations) {
    if (identityById.get(reservation.teamId)?.legacyKey !== reservation.legacyKey) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
  }
  for (const intent of intents) {
    if (identityById.get(intent.teamId)?.adoptionIntentId !== intent.intentId) {
      throw new TypeError('team-lifecycle-read-identity-graph-invalid');
    }
  }
}

function validateSchema(database: Database.Database): void {
  const integrity = database.pragma('quick_check') as Array<{ readonly quick_check?: unknown }>;
  if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') {
    throw new TypeError('team-lifecycle-read-identity-database-corrupt');
  }
  const placeholders = COMPONENT_TABLE_NAMES.map(() => '?').join(', ');
  const schemaObjects = database
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE tbl_name IN (${placeholders})
        ORDER BY type, name, tbl_name`
    )
    .all(...COMPONENT_TABLE_NAMES) as Array<{
    readonly type?: unknown;
    readonly name?: unknown;
    readonly tbl_name?: unknown;
    readonly sql?: unknown;
  }>;
  const schemaDigest = createHash('sha256').update(JSON.stringify(schemaObjects)).digest('hex');
  if (
    schemaObjects.length !== EXPECTED_SCHEMA_OBJECT_COUNT ||
    schemaDigest !== EXPECTED_SCHEMA_DIGEST
  ) {
    throw new TypeError('team-lifecycle-read-identity-schema-incompatible');
  }
}

function readIdentitySnapshot(serializedDatabase: Buffer): readonly TeamIdentityRecord[] {
  const database = new Database(serializedDatabase, { readonly: true });
  try {
    if (!database.readonly || !database.memory) {
      throw new TypeError('team-lifecycle-read-identity-database-not-immutable');
    }
    validateSchema(database);
    const metadata = database
      .prepare('SELECT component, schema_version FROM team_identity_storage_metadata')
      .all() as Array<{ readonly component?: unknown; readonly schema_version?: unknown }>;
    if (
      metadata.length !== 1 ||
      metadata[0]?.component !== EXPECTED_COMPONENT ||
      metadata[0]?.schema_version !== EXPECTED_COMPONENT_SCHEMA_VERSION
    ) {
      throw new TypeError('team-lifecycle-read-identity-schema-incompatible');
    }

    const limit = MAX_TEAM_IDENTITY_READ_RECORDS + 1;
    const identityRows = database
      .prepare(
        `SELECT team_id, state, legacy_key, directory_fingerprint,
                workspace_id, workspace_binding_generation, adoption_intent_id,
                identity_checksum, created_at, activated_at, tombstoned_at
           FROM team_identity_records
          ORDER BY team_id ASC
          LIMIT ?`
      )
      .all(limit) as IdentityRow[];
    const reservationRows = database
      .prepare(
        `SELECT legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
           FROM legacy_team_key_reservations
          ORDER BY legacy_key ASC
          LIMIT ?`
      )
      .all(limit) as ReservationRow[];
    const intentRows = database
      .prepare(
        `SELECT intent_id, team_id, state, legacy_key, directory_fingerprint,
                workspace_id, workspace_binding_generation, expected_identity_checksum,
                intent_checksum, prepared_at, file_published_at,
                published_identity_checksum, committed_at, committed_identity_checksum
           FROM team_adoption_intents
          ORDER BY intent_id ASC
          LIMIT ?`
      )
      .all(limit) as AdoptionIntentRow[];
    if (
      identityRows.length > MAX_TEAM_IDENTITY_READ_RECORDS ||
      reservationRows.length > MAX_TEAM_IDENTITY_READ_RECORDS ||
      intentRows.length > MAX_TEAM_IDENTITY_READ_RECORDS
    ) {
      throw new TypeError('team-lifecycle-read-identity-record-limit-exceeded');
    }

    const identities = Object.freeze(identityRows.map(parseIdentityRow));
    validateGraph(
      identities,
      Object.freeze(reservationRows.map(parseReservationRow)),
      Object.freeze(intentRows.map(parseIntentRow))
    );
    return identities;
  } finally {
    database.close();
  }
}

class ImmutableIdentitySnapshotGateway implements TeamIdentityReadGateway {
  readonly #byTeamId: ReadonlyMap<TeamId, TeamIdentityRecord>;

  constructor(readonly identities: readonly TeamIdentityRecord[]) {
    this.#byTeamId = new Map(identities.map((identity) => [identity.teamId, identity]));
  }

  async listTeamIdentities(): Promise<readonly TeamIdentityRecord[]> {
    return this.identities;
  }

  async getTeamIdentity(teamId: TeamId): Promise<TeamIdentityRecord | null> {
    return this.#byTeamId.get(parseTeamId(teamId)) ?? null;
  }
}

/**
 * Admits one existing internal-storage database as a descriptor-read immutable memory snapshot.
 * Missing, live-sidecar, replaced, corrupt, or schema-incompatible storage is unavailable; this
 * adapter has no database path handle, worker, migration, recovery, cleanup, or mutation surface.
 */
export async function createTeamLifecycleReadOnlyIdentitySource(
  input: TeamLifecycleReadOnlyIdentitySourceInput
): Promise<TeamIdentityReadGateway | null> {
  try {
    const serializedDatabase = await readImmutableDatabaseSnapshot(input.appDataRoot);
    return new ImmutableIdentitySnapshotGateway(readIdentitySnapshot(serializedDatabase));
  } catch {
    return null;
  }
}
