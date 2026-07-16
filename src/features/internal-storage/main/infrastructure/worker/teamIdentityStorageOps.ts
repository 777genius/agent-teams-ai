import { createHash } from 'node:crypto';

import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted/identifiers';

import {
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentChecksum,
  parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
  TeamIdentityStorageErrorCode,
} from '../../../contracts/teamIdentityStorageContracts';

import {
  TEAM_IDENTITY_STORAGE_COMPONENT,
  TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION,
  TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS,
} from './teamIdentityStorageSchema';

import type {
  CommitTeamAdoptionInput,
  LegacyTeamKey,
  LegacyTeamKeyReservation,
  LegacyTeamKeyTombstoneReason,
  LegacyTeamKeyTombstoneResult,
  PrepareTeamAdoptionInput,
  RecordTeamIdentityFilePublishedInput,
  ReserveTeamIdentityInput,
  TeamAdoptionCommitResult,
  TeamAdoptionIntent,
  TeamAdoptionIntentChecksum,
  TeamAdoptionPrepareResult,
  TeamIdentityFilePublishedResult,
  TeamIdentityRecord,
  TeamIdentityReservationResult,
  TeamIdentityStorageErrorCode as TeamIdentityStorageErrorCodeValue,
  TeamWorkspaceBindingEvidence,
  TombstoneLegacyTeamKeyInput,
} from '../../../contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted/identifiers';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface TeamIdentityRow {
  team_id: unknown;
  state: unknown;
  legacy_key: unknown;
  directory_fingerprint: unknown;
  workspace_id: unknown;
  workspace_binding_generation: unknown;
  adoption_intent_id: unknown;
  identity_checksum: unknown;
  created_at: unknown;
  activated_at: unknown;
  tombstoned_at: unknown;
}

interface LegacyTeamKeyReservationRow {
  legacy_key: unknown;
  team_id: unknown;
  state: unknown;
  reserved_at: unknown;
  tombstoned_at: unknown;
  tombstone_reason: unknown;
}

interface TeamAdoptionIntentRow {
  intent_id: unknown;
  team_id: unknown;
  state: unknown;
  legacy_key: unknown;
  directory_fingerprint: unknown;
  workspace_id: unknown;
  workspace_binding_generation: unknown;
  expected_identity_checksum: unknown;
  intent_checksum: unknown;
  prepared_at: unknown;
  file_published_at: unknown;
  published_identity_checksum: unknown;
  committed_at: unknown;
  committed_identity_checksum: unknown;
}

export class TeamIdentityStorageInvariantError extends Error {
  readonly name = 'TeamIdentityStorageInvariantError';

  constructor(readonly code: TeamIdentityStorageErrorCodeValue) {
    super(`team-identity-storage:${code}`);
  }
}

function fail(code: TeamIdentityStorageErrorCodeValue): never {
  throw new TeamIdentityStorageInvariantError(code);
}

/**
 * Owns the identity component's transactional invariants. It intentionally
 * accepts a database connection rather than the shared worker core so the
 * serial integration lane can register it without reversing dependencies.
 */
export class TeamIdentityStorageOps {
  constructor(private readonly getDatabase: () => SqliteDatabase) {}

  getIdentity(teamId: TeamId): TeamIdentityRecord | null {
    const parsedTeamId = this.validated(() => parseTeamId(teamId));
    return this.readIdentityByTeamId(this.database(), parsedTeamId);
  }

  getLegacyKeyReservation(legacyKey: LegacyTeamKey): LegacyTeamKeyReservation | null {
    const parsedLegacyKey = this.validated(() => parseLegacyTeamKey(legacyKey));
    return this.readReservationByKey(this.database(), parsedLegacyKey);
  }

  getAdoptionIntent(intentId: TeamAdoptionIntent['intentId']): TeamAdoptionIntent | null {
    const parsedIntentId = this.validated(() => parseTeamAdoptionIntentId(intentId));
    return this.readIntentById(this.database(), parsedIntentId);
  }

  reserveIdentity(input: ReserveTeamIdentityInput): TeamIdentityReservationResult {
    const normalized = this.normalizeReservationInput(input);
    const db = this.database();

    return this.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamIdentityReservationResult => {
          const existingIdentity = this.readIdentityByTeamId(db, normalized.teamId);
          if (existingIdentity) {
            if (existingIdentity.state === 'tombstoned') {
              fail(TeamIdentityStorageErrorCode.LegacyKeyTombstoned);
            }
            if (!this.isSameReservedIdentity(existingIdentity, normalized)) {
              fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
            }
            const reservation = this.requireConsistentReservation(db, existingIdentity);
            if (reservation.state === 'tombstoned') {
              fail(TeamIdentityStorageErrorCode.LegacyKeyTombstoned);
            }
            return { outcome: 'already_reserved', identity: existingIdentity, reservation };
          }

          this.assertIdentitySlotsAvailable(
            db,
            normalized.teamId,
            normalized.legacyKey,
            normalized.directoryFingerprint
          );
          this.insertIdentity(db, {
            ...normalized,
            state: 'reserved',
            adoptionIntentId: null,
          });
          this.insertReservation(db, normalized.legacyKey, normalized.teamId, normalized.createdAt);

          const identity = this.requireIdentity(db, normalized.teamId);
          const reservation = this.requireConsistentReservation(db, identity);
          return { outcome: 'created', identity, reservation };
        })()
    );
  }

  prepareAdoption(input: PrepareTeamAdoptionInput): TeamAdoptionPrepareResult {
    const normalized = this.normalizePrepareInput(input);
    const intentChecksum = this.computeIntentChecksum(normalized);
    const db = this.database();

    return this.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamAdoptionPrepareResult => {
          const existingIntent = this.readIntentById(db, normalized.intentId);
          if (existingIntent) {
            if (!this.isSameIntentRequest(existingIntent, normalized, intentChecksum)) {
              fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
            }
            const identity = this.requireIdentity(db, normalized.teamId);
            const reservation = this.requireConsistentReservation(db, identity);
            this.assertIntentGraphConsistent(existingIntent, identity, reservation);
            return {
              outcome:
                existingIntent.state === 'committed'
                  ? 'already_committed'
                  : existingIntent.state === 'file_published'
                    ? 'already_file_published'
                    : 'already_prepared',
              identity,
              reservation,
              intent: existingIntent,
            };
          }

          const intentForTeam = this.readIntentByTeamId(db, normalized.teamId);
          if (intentForTeam) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
          }
          this.assertIdentitySlotsAvailable(
            db,
            normalized.teamId,
            normalized.legacyKey,
            normalized.directoryFingerprint
          );

          this.insertIdentity(db, {
            teamId: normalized.teamId,
            legacyKey: normalized.legacyKey,
            directoryFingerprint: normalized.directoryFingerprint,
            workspaceBinding: normalized.workspaceBinding,
            createdAt: normalized.preparedAt,
            state: 'adoption_prepared',
            adoptionIntentId: normalized.intentId,
          });
          this.insertReservation(
            db,
            normalized.legacyKey,
            normalized.teamId,
            normalized.preparedAt
          );
          db.prepare(
            `INSERT INTO team_adoption_intents (
            intent_id, team_id, state, legacy_key, directory_fingerprint,
            workspace_id, workspace_binding_generation, expected_identity_checksum,
            intent_checksum, prepared_at, file_published_at, published_identity_checksum,
            committed_at, committed_identity_checksum
          ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
          ).run(
            normalized.intentId,
            normalized.teamId,
            normalized.legacyKey,
            normalized.directoryFingerprint,
            normalized.workspaceBinding?.workspaceId ?? null,
            normalized.workspaceBinding?.generation ?? null,
            normalized.expectedIdentityChecksum,
            intentChecksum,
            normalized.preparedAt
          );

          const identity = this.requireIdentity(db, normalized.teamId);
          const reservation = this.requireConsistentReservation(db, identity);
          const intent = this.requireIntent(db, normalized.intentId);
          this.assertIntentGraphConsistent(intent, identity, reservation);
          return { outcome: 'prepared', identity, reservation, intent };
        })()
    );
  }

  recordIdentityFilePublished(
    input: RecordTeamIdentityFilePublishedInput
  ): TeamIdentityFilePublishedResult {
    const normalized = this.normalizeFilePublishedInput(input);
    const db = this.database();

    return this.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamIdentityFilePublishedResult => {
          const intent = this.readIntentById(db, normalized.intentId);
          if (!intent) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentNotFound);
          }
          if (
            intent.teamId !== normalized.teamId ||
            intent.intentChecksum !== normalized.intentChecksum
          ) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
          }
          if (intent.expectedIdentityChecksum !== normalized.identityChecksum) {
            fail(TeamIdentityStorageErrorCode.ChecksumDisagreement);
          }
          if (Date.parse(normalized.filePublishedAt) < Date.parse(intent.preparedAt)) {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const currentIdentity = this.requireIdentity(db, normalized.teamId);
          const currentReservation = this.requireConsistentReservation(db, currentIdentity);
          this.assertIntentGraphConsistent(intent, currentIdentity, currentReservation);

          if (intent.state === 'committed') {
            if (
              intent.publishedIdentityChecksum !== normalized.identityChecksum ||
              intent.committedIdentityChecksum !== normalized.identityChecksum ||
              currentIdentity.identityChecksum !== normalized.identityChecksum
            ) {
              fail(TeamIdentityStorageErrorCode.TamperingDetected);
            }
            return {
              outcome: 'already_committed',
              identity: currentIdentity,
              reservation: currentReservation,
              intent,
            };
          }
          if (intent.state === 'file_published') {
            if (
              intent.publishedIdentityChecksum !== normalized.identityChecksum ||
              currentIdentity.identityChecksum !== normalized.identityChecksum
            ) {
              fail(TeamIdentityStorageErrorCode.TamperingDetected);
            }
            return {
              outcome: 'already_file_published',
              identity: currentIdentity,
              reservation: currentReservation,
              intent,
            };
          }
          if (currentIdentity.state !== 'adoption_prepared') {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }
          if (currentReservation.state !== 'active') {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const checksumOwner = this.readIdentityByChecksum(db, normalized.identityChecksum);
          if (checksumOwner && checksumOwner.teamId !== normalized.teamId) {
            fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
          }

          const intentUpdate = db
            .prepare(
              `UPDATE team_adoption_intents
              SET state = 'file_published', file_published_at = ?,
                published_identity_checksum = ?
              WHERE intent_id = ? AND state = 'prepared'`
            )
            .run(normalized.filePublishedAt, normalized.identityChecksum, normalized.intentId);
          const identityUpdate = db
            .prepare(
              `UPDATE team_identity_records
              SET state = 'file_published', identity_checksum = ?
              WHERE team_id = ? AND state = 'adoption_prepared'`
            )
            .run(normalized.identityChecksum, normalized.teamId);
          if (intentUpdate.changes !== 1 || identityUpdate.changes !== 1) {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const publishedIdentity = this.requireIdentity(db, normalized.teamId);
          const publishedReservation = this.requireConsistentReservation(db, publishedIdentity);
          const publishedIntent = this.requireIntent(db, normalized.intentId);
          this.assertIntentGraphConsistent(
            publishedIntent,
            publishedIdentity,
            publishedReservation
          );
          return {
            outcome: 'file_published',
            identity: publishedIdentity,
            reservation: publishedReservation,
            intent: publishedIntent,
          };
        })()
    );
  }

  commitAdoption(input: CommitTeamAdoptionInput): TeamAdoptionCommitResult {
    const normalized = this.normalizeCommitInput(input);
    const db = this.database();

    return this.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamAdoptionCommitResult => {
          const intent = this.readIntentById(db, normalized.intentId);
          if (!intent) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentNotFound);
          }
          if (
            intent.teamId !== normalized.teamId ||
            intent.intentChecksum !== normalized.intentChecksum
          ) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
          }
          if (intent.expectedIdentityChecksum !== normalized.identityChecksum) {
            fail(TeamIdentityStorageErrorCode.ChecksumDisagreement);
          }
          if (
            intent.filePublishedAt !== null &&
            Date.parse(normalized.committedAt) < Date.parse(intent.filePublishedAt)
          ) {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const currentIdentity = this.requireIdentity(db, normalized.teamId);
          const currentReservation = this.requireConsistentReservation(db, currentIdentity);
          this.assertIntentGraphConsistent(intent, currentIdentity, currentReservation);

          if (intent.state === 'committed') {
            if (
              intent.publishedIdentityChecksum !== normalized.identityChecksum ||
              intent.committedIdentityChecksum !== normalized.identityChecksum ||
              currentIdentity.identityChecksum !== normalized.identityChecksum
            ) {
              fail(TeamIdentityStorageErrorCode.TamperingDetected);
            }
            return {
              outcome: 'already_committed',
              identity: currentIdentity,
              reservation: currentReservation,
              intent,
            };
          }
          if (intent.state !== 'file_published' || intent.filePublishedAt === null) {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }
          if (currentIdentity.state !== 'file_published') {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }
          if (currentReservation.state !== 'active') {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const checksumOwner = this.readIdentityByChecksum(db, normalized.identityChecksum);
          if (checksumOwner && checksumOwner.teamId !== normalized.teamId) {
            fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
          }

          const intentUpdate = db
            .prepare(
              `UPDATE team_adoption_intents
              SET state = 'committed', committed_at = ?, committed_identity_checksum = ?
              WHERE intent_id = ? AND state = 'file_published'`
            )
            .run(normalized.committedAt, normalized.identityChecksum, normalized.intentId);
          const identityUpdate = db
            .prepare(
              `UPDATE team_identity_records
              SET state = 'active', activated_at = ?
              WHERE team_id = ? AND state = 'file_published' AND identity_checksum = ?`
            )
            .run(normalized.committedAt, normalized.teamId, normalized.identityChecksum);
          if (intentUpdate.changes !== 1 || identityUpdate.changes !== 1) {
            fail(TeamIdentityStorageErrorCode.IllegalTransition);
          }

          const committedIdentity = this.requireIdentity(db, normalized.teamId);
          const committedReservation = this.requireConsistentReservation(db, committedIdentity);
          const committedIntent = this.requireIntent(db, normalized.intentId);
          this.assertIntentGraphConsistent(
            committedIntent,
            committedIdentity,
            committedReservation
          );
          return {
            outcome: 'committed',
            identity: committedIdentity,
            reservation: committedReservation,
            intent: committedIntent,
          };
        })()
    );
  }

  tombstoneLegacyKey(input: TombstoneLegacyTeamKeyInput): LegacyTeamKeyTombstoneResult {
    const normalized = this.normalizeTombstoneInput(input);
    const db = this.database();

    return db.transaction((): LegacyTeamKeyTombstoneResult => {
      const reservation = this.readReservationByKey(db, normalized.legacyKey);
      if (!reservation || reservation.teamId !== normalized.teamId) {
        fail(TeamIdentityStorageErrorCode.LegacyKeyConflict);
      }
      const identity = this.requireIdentity(db, normalized.teamId);
      if (identity.legacyKey !== normalized.legacyKey) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }

      if (reservation.state === 'tombstoned') {
        if (reservation.tombstoneReason !== normalized.reason || identity.state !== 'tombstoned') {
          fail(TeamIdentityStorageErrorCode.TamperingDetected);
        }
        return { outcome: 'already_tombstoned', identity, reservation };
      }
      if (identity.state === 'tombstoned') {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }

      const reservationUpdate = db
        .prepare(
          `UPDATE legacy_team_key_reservations
            SET state = 'tombstoned', tombstoned_at = ?, tombstone_reason = ?
            WHERE legacy_key = ? AND team_id = ? AND state = 'active'`
        )
        .run(normalized.tombstonedAt, normalized.reason, normalized.legacyKey, normalized.teamId);
      const identityUpdate = db
        .prepare(
          `UPDATE team_identity_records
            SET state = 'tombstoned', tombstoned_at = ?
            WHERE team_id = ?
              AND state IN ('reserved', 'adoption_prepared', 'file_published', 'active')`
        )
        .run(normalized.tombstonedAt, normalized.teamId);
      if (reservationUpdate.changes !== 1 || identityUpdate.changes !== 1) {
        fail(TeamIdentityStorageErrorCode.IllegalTransition);
      }

      return {
        outcome: 'tombstoned',
        identity: this.requireIdentity(db, normalized.teamId),
        reservation: this.requireReservation(db, normalized.legacyKey),
      };
    })();
  }

  private database(): SqliteDatabase {
    const db = this.getDatabase();
    let rows: Array<{ component?: unknown; schema_version?: unknown }>;
    try {
      rows = db
        .prepare(
          `SELECT component, schema_version
            FROM team_identity_storage_metadata`
        )
        .all() as Array<{
        component?: unknown;
        schema_version?: unknown;
      }>;
    } catch {
      fail(TeamIdentityStorageErrorCode.UnknownSchema);
    }
    if (
      rows.length !== 1 ||
      rows[0]?.component !== TEAM_IDENTITY_STORAGE_COMPONENT ||
      rows[0]?.schema_version !== TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION
    ) {
      fail(TeamIdentityStorageErrorCode.UnknownSchema);
    }
    const componentTableNames = [
      ...new Set(TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.map(({ tableName }) => tableName)),
    ];
    const placeholders = componentTableNames.map(() => '?').join(', ');
    let schemaObjects: Array<{
      type?: unknown;
      name?: unknown;
      tbl_name?: unknown;
      sql?: unknown;
    }>;
    try {
      schemaObjects = db
        .prepare(
          `SELECT type, name, tbl_name, sql
            FROM sqlite_schema
            WHERE tbl_name IN (${placeholders})`
        )
        .all(...componentTableNames) as Array<{
        type?: unknown;
        name?: unknown;
        tbl_name?: unknown;
        sql?: unknown;
      }>;
    } catch {
      fail(TeamIdentityStorageErrorCode.UnknownSchema);
    }
    const observedObjects = new Map(
      schemaObjects.map((definition) => [
        `${String(definition.type)}:${String(definition.name)}:${String(definition.tbl_name)}`,
        definition,
      ])
    );
    if (
      schemaObjects.length !== TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.length ||
      !TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.every((expected) => {
        const observed = observedObjects.get(
          `${expected.type}:${expected.name}:${expected.tableName}`
        );
        return observed?.sql === expected.sql;
      })
    ) {
      fail(TeamIdentityStorageErrorCode.UnknownSchema);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('recursive_triggers = ON');
    return db;
  }

  private normalizeReservationInput(input: ReserveTeamIdentityInput): ReserveTeamIdentityInput {
    return this.validated(() => ({
      teamId: parseTeamId(input.teamId),
      legacyKey: parseLegacyTeamKey(input.legacyKey),
      directoryFingerprint: parseDirectoryFingerprint(input.directoryFingerprint),
      workspaceBinding: this.parseWorkspaceBinding(input.workspaceBinding),
      createdAt: this.parseTimestamp(input.createdAt),
    }));
  }

  private normalizePrepareInput(input: PrepareTeamAdoptionInput): PrepareTeamAdoptionInput {
    return this.validated(() => ({
      intentId: parseTeamAdoptionIntentId(input.intentId),
      teamId: parseTeamId(input.teamId),
      legacyKey: parseLegacyTeamKey(input.legacyKey),
      directoryFingerprint: parseDirectoryFingerprint(input.directoryFingerprint),
      workspaceBinding: this.parseWorkspaceBinding(input.workspaceBinding),
      expectedIdentityChecksum: parseTeamIdentityChecksum(input.expectedIdentityChecksum),
      preparedAt: this.parseTimestamp(input.preparedAt),
    }));
  }

  private normalizeCommitInput(input: CommitTeamAdoptionInput): CommitTeamAdoptionInput {
    return this.validated(() => ({
      intentId: parseTeamAdoptionIntentId(input.intentId),
      teamId: parseTeamId(input.teamId),
      intentChecksum: parseTeamAdoptionIntentChecksum(input.intentChecksum),
      identityChecksum: parseTeamIdentityChecksum(input.identityChecksum),
      committedAt: this.parseTimestamp(input.committedAt),
    }));
  }

  private normalizeFilePublishedInput(
    input: RecordTeamIdentityFilePublishedInput
  ): RecordTeamIdentityFilePublishedInput {
    return this.validated(() => ({
      intentId: parseTeamAdoptionIntentId(input.intentId),
      teamId: parseTeamId(input.teamId),
      intentChecksum: parseTeamAdoptionIntentChecksum(input.intentChecksum),
      identityChecksum: parseTeamIdentityChecksum(input.identityChecksum),
      filePublishedAt: this.parseTimestamp(input.filePublishedAt),
    }));
  }

  private normalizeTombstoneInput(input: TombstoneLegacyTeamKeyInput): TombstoneLegacyTeamKeyInput {
    return this.validated(() => ({
      teamId: parseTeamId(input.teamId),
      legacyKey: parseLegacyTeamKey(input.legacyKey),
      reason: this.parseTombstoneReason(input.reason),
      tombstonedAt: this.parseTimestamp(input.tombstonedAt),
    }));
  }

  private parseWorkspaceBinding(
    value: TeamWorkspaceBindingEvidence | null
  ): TeamWorkspaceBindingEvidence | null {
    if (value === null) {
      return null;
    }
    if (
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1
    ) {
      throw new TypeError('team-identity-workspace-binding-invalid');
    }
    return { workspaceId: parseWorkspaceId(value.workspaceId), generation: value.generation };
  }

  private parseTimestamp(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      throw new TypeError('team-identity-timestamp-invalid');
    }
    return value;
  }

  private parseTombstoneReason(value: unknown): LegacyTeamKeyTombstoneReason {
    if (value !== 'draft_deleted' && value !== 'team_deleted' && value !== 'legacy_conflict') {
      throw new TypeError('team-identity-tombstone-reason-invalid');
    }
    return value;
  }

  private validated<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      fail(TeamIdentityStorageErrorCode.InvalidInput);
    }
  }

  private withConstraintClassification<T>(
    _db: SqliteDatabase,
    code: TeamIdentityStorageErrorCodeValue,
    callback: () => T
  ): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      const sqliteCode = (error as { code?: unknown }).code;
      if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
        fail(code);
      }
      throw error;
    }
  }

  private assertIdentitySlotsAvailable(
    db: SqliteDatabase,
    teamId: TeamId,
    legacyKey: LegacyTeamKey,
    directoryFingerprint: ReserveTeamIdentityInput['directoryFingerprint']
  ): void {
    if (this.readIdentityByTeamId(db, teamId)) {
      fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
    }
    const identityByKey = this.readIdentityByLegacyKey(db, legacyKey);
    if (identityByKey) {
      fail(
        identityByKey.state === 'tombstoned'
          ? TeamIdentityStorageErrorCode.LegacyKeyTombstoned
          : TeamIdentityStorageErrorCode.LegacyKeyConflict
      );
    }
    const reservation = this.readReservationByKey(db, legacyKey);
    if (reservation) {
      fail(
        reservation.state === 'tombstoned'
          ? TeamIdentityStorageErrorCode.LegacyKeyTombstoned
          : TeamIdentityStorageErrorCode.LegacyKeyConflict
      );
    }
    if (this.readIdentityByDirectoryFingerprint(db, directoryFingerprint)) {
      fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
    }
  }

  private insertIdentity(
    db: SqliteDatabase,
    input: ReserveTeamIdentityInput & {
      state: 'reserved' | 'adoption_prepared';
      adoptionIntentId: TeamAdoptionIntent['intentId'] | null;
    }
  ): void {
    db.prepare(
      `INSERT INTO team_identity_records (
        team_id, state, legacy_key, directory_fingerprint, workspace_id,
        workspace_binding_generation, adoption_intent_id, identity_checksum,
        created_at, activated_at, tombstoned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`
    ).run(
      input.teamId,
      input.state,
      input.legacyKey,
      input.directoryFingerprint,
      input.workspaceBinding?.workspaceId ?? null,
      input.workspaceBinding?.generation ?? null,
      input.adoptionIntentId,
      input.createdAt
    );
  }

  private insertReservation(
    db: SqliteDatabase,
    legacyKey: LegacyTeamKey,
    teamId: TeamId,
    reservedAt: string
  ): void {
    db.prepare(
      `INSERT INTO legacy_team_key_reservations (
        legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
      ) VALUES (?, ?, 'active', ?, NULL, NULL)`
    ).run(legacyKey, teamId, reservedAt);
  }

  private readIdentityByTeamId(db: SqliteDatabase, teamId: TeamId): TeamIdentityRecord | null {
    const row = db.prepare('SELECT * FROM team_identity_records WHERE team_id = ?').get(teamId) as
      | TeamIdentityRow
      | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  private readIdentityByLegacyKey(
    db: SqliteDatabase,
    legacyKey: LegacyTeamKey
  ): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE legacy_key = ?')
      .get(legacyKey) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  private readIdentityByDirectoryFingerprint(
    db: SqliteDatabase,
    directoryFingerprint: ReserveTeamIdentityInput['directoryFingerprint']
  ): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE directory_fingerprint = ?')
      .get(directoryFingerprint) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  private readIdentityByChecksum(
    db: SqliteDatabase,
    checksum: CommitTeamAdoptionInput['identityChecksum']
  ): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE identity_checksum = ?')
      .get(checksum) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  private readReservationByKey(
    db: SqliteDatabase,
    legacyKey: LegacyTeamKey
  ): LegacyTeamKeyReservation | null {
    const row = db
      .prepare('SELECT * FROM legacy_team_key_reservations WHERE legacy_key = ?')
      .get(legacyKey) as LegacyTeamKeyReservationRow | undefined;
    return row ? this.mapReservation(row) : null;
  }

  private readIntentById(
    db: SqliteDatabase,
    intentId: TeamAdoptionIntent['intentId']
  ): TeamAdoptionIntent | null {
    const row = db
      .prepare('SELECT * FROM team_adoption_intents WHERE intent_id = ?')
      .get(intentId) as TeamAdoptionIntentRow | undefined;
    return row ? this.mapIntent(row) : null;
  }

  private readIntentByTeamId(db: SqliteDatabase, teamId: TeamId): TeamAdoptionIntent | null {
    const row = db.prepare('SELECT * FROM team_adoption_intents WHERE team_id = ?').get(teamId) as
      | TeamAdoptionIntentRow
      | undefined;
    return row ? this.mapIntent(row) : null;
  }

  private requireIdentity(db: SqliteDatabase, teamId: TeamId): TeamIdentityRecord {
    const identity = this.readIdentityByTeamId(db, teamId);
    if (!identity) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return identity;
  }

  private requireReservation(
    db: SqliteDatabase,
    legacyKey: LegacyTeamKey
  ): LegacyTeamKeyReservation {
    const reservation = this.readReservationByKey(db, legacyKey);
    if (!reservation) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return reservation;
  }

  private requireIntent(
    db: SqliteDatabase,
    intentId: TeamAdoptionIntent['intentId']
  ): TeamAdoptionIntent {
    const intent = this.readIntentById(db, intentId);
    if (!intent) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return intent;
  }

  private requireConsistentReservation(
    db: SqliteDatabase,
    identity: TeamIdentityRecord
  ): LegacyTeamKeyReservation {
    const reservation = this.requireReservation(db, identity.legacyKey);
    if (
      reservation.teamId !== identity.teamId ||
      (identity.state === 'tombstoned') !== (reservation.state === 'tombstoned')
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return reservation;
  }

  private assertIntentGraphConsistent(
    intent: TeamAdoptionIntent,
    identity: TeamIdentityRecord,
    reservation: LegacyTeamKeyReservation
  ): void {
    if (
      intent.teamId !== identity.teamId ||
      intent.legacyKey !== identity.legacyKey ||
      intent.directoryFingerprint !== identity.directoryFingerprint ||
      !this.sameWorkspaceBinding(intent.workspaceBinding, identity.workspaceBinding) ||
      identity.adoptionIntentId !== intent.intentId ||
      reservation.teamId !== identity.teamId ||
      reservation.legacyKey !== identity.legacyKey
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    if (intent.state === 'prepared') {
      if (identity.state !== 'adoption_prepared' || reservation.state !== 'active') {
        fail(TeamIdentityStorageErrorCode.IllegalTransition);
      }
      return;
    }
    if (intent.state === 'file_published') {
      if (identity.state === 'tombstoned' || reservation.state === 'tombstoned') {
        fail(TeamIdentityStorageErrorCode.IllegalTransition);
      }
      if (
        identity.state !== 'file_published' ||
        identity.identityChecksum !== intent.publishedIdentityChecksum ||
        intent.publishedIdentityChecksum !== intent.expectedIdentityChecksum
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      return;
    }
    if (identity.state !== 'active' && identity.state !== 'tombstoned') {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    if (
      identity.identityChecksum !== intent.publishedIdentityChecksum ||
      identity.identityChecksum !== intent.committedIdentityChecksum ||
      intent.publishedIdentityChecksum !== intent.expectedIdentityChecksum ||
      (identity.state === 'active' && reservation.state !== 'active')
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  private mapIdentity(row: TeamIdentityRow): TeamIdentityRecord {
    if (
      row.state !== 'reserved' &&
      row.state !== 'adoption_prepared' &&
      row.state !== 'file_published' &&
      row.state !== 'active' &&
      row.state !== 'tombstoned'
    ) {
      fail(TeamIdentityStorageErrorCode.UnknownState);
    }
    try {
      const identity: TeamIdentityRecord = {
        teamId: parseTeamId(row.team_id),
        state: row.state,
        legacyKey: this.parseStoredLegacyKey(row.legacy_key),
        directoryFingerprint: parseDirectoryFingerprint(row.directory_fingerprint),
        workspaceBinding: this.parseStoredWorkspaceBinding(
          row.workspace_id,
          row.workspace_binding_generation
        ),
        adoptionIntentId:
          row.adoption_intent_id === null
            ? null
            : parseTeamAdoptionIntentId(row.adoption_intent_id),
        identityChecksum:
          row.identity_checksum === null ? null : parseTeamIdentityChecksum(row.identity_checksum),
        createdAt: this.parseTimestamp(row.created_at),
        activatedAt: row.activated_at === null ? null : this.parseTimestamp(row.activated_at),
        tombstonedAt: row.tombstoned_at === null ? null : this.parseTimestamp(row.tombstoned_at),
      };
      const validStateFields =
        (identity.state === 'reserved' &&
          identity.adoptionIntentId === null &&
          identity.identityChecksum === null &&
          identity.activatedAt === null &&
          identity.tombstonedAt === null) ||
        (identity.state === 'adoption_prepared' &&
          identity.adoptionIntentId !== null &&
          identity.identityChecksum === null &&
          identity.activatedAt === null &&
          identity.tombstonedAt === null) ||
        (identity.state === 'file_published' &&
          identity.adoptionIntentId !== null &&
          identity.identityChecksum !== null &&
          identity.activatedAt === null &&
          identity.tombstonedAt === null) ||
        (identity.state === 'active' &&
          identity.identityChecksum !== null &&
          identity.activatedAt !== null &&
          identity.tombstonedAt === null) ||
        (identity.state === 'tombstoned' && identity.tombstonedAt !== null);
      if (!validStateFields) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      return identity;
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  private mapReservation(row: LegacyTeamKeyReservationRow): LegacyTeamKeyReservation {
    if (row.state !== 'active' && row.state !== 'tombstoned') {
      fail(TeamIdentityStorageErrorCode.UnknownState);
    }
    try {
      const reason =
        row.tombstone_reason === null ? null : this.parseTombstoneReason(row.tombstone_reason);
      const reservation: LegacyTeamKeyReservation = {
        legacyKey: this.parseStoredLegacyKey(row.legacy_key),
        teamId: parseTeamId(row.team_id),
        state: row.state,
        reservedAt: this.parseTimestamp(row.reserved_at),
        tombstonedAt: row.tombstoned_at === null ? null : this.parseTimestamp(row.tombstoned_at),
        tombstoneReason: reason,
      };
      if (
        (reservation.state === 'active' &&
          (reservation.tombstonedAt !== null || reservation.tombstoneReason !== null)) ||
        (reservation.state === 'tombstoned' &&
          (reservation.tombstonedAt === null || reservation.tombstoneReason === null))
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      return reservation;
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  private mapIntent(row: TeamAdoptionIntentRow): TeamAdoptionIntent {
    if (row.state !== 'prepared' && row.state !== 'file_published' && row.state !== 'committed') {
      fail(TeamIdentityStorageErrorCode.UnknownState);
    }
    try {
      const intent: TeamAdoptionIntent = {
        intentId: parseTeamAdoptionIntentId(row.intent_id),
        teamId: parseTeamId(row.team_id),
        state: row.state,
        legacyKey: this.parseStoredLegacyKey(row.legacy_key),
        directoryFingerprint: parseDirectoryFingerprint(row.directory_fingerprint),
        workspaceBinding: this.parseStoredWorkspaceBinding(
          row.workspace_id,
          row.workspace_binding_generation
        ),
        expectedIdentityChecksum: parseTeamIdentityChecksum(row.expected_identity_checksum),
        intentChecksum: parseTeamAdoptionIntentChecksum(row.intent_checksum),
        preparedAt: this.parseTimestamp(row.prepared_at),
        filePublishedAt:
          row.file_published_at === null ? null : this.parseTimestamp(row.file_published_at),
        publishedIdentityChecksum:
          row.published_identity_checksum === null
            ? null
            : parseTeamIdentityChecksum(row.published_identity_checksum),
        committedAt: row.committed_at === null ? null : this.parseTimestamp(row.committed_at),
        committedIdentityChecksum:
          row.committed_identity_checksum === null
            ? null
            : parseTeamIdentityChecksum(row.committed_identity_checksum),
      };
      const expectedIntentChecksum = this.computeIntentChecksum({
        intentId: intent.intentId,
        teamId: intent.teamId,
        legacyKey: intent.legacyKey,
        directoryFingerprint: intent.directoryFingerprint,
        workspaceBinding: intent.workspaceBinding,
        expectedIdentityChecksum: intent.expectedIdentityChecksum,
        preparedAt: intent.preparedAt,
      });
      if (intent.intentChecksum !== expectedIntentChecksum) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      if (
        (intent.state === 'prepared' &&
          (intent.filePublishedAt !== null ||
            intent.publishedIdentityChecksum !== null ||
            intent.committedAt !== null ||
            intent.committedIdentityChecksum !== null)) ||
        (intent.state === 'file_published' &&
          (intent.filePublishedAt === null ||
            intent.publishedIdentityChecksum !== intent.expectedIdentityChecksum ||
            intent.committedAt !== null ||
            intent.committedIdentityChecksum !== null)) ||
        (intent.state === 'committed' &&
          (intent.filePublishedAt === null ||
            intent.publishedIdentityChecksum !== intent.expectedIdentityChecksum ||
            intent.committedAt === null ||
            intent.committedIdentityChecksum !== intent.expectedIdentityChecksum))
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      if (
        intent.filePublishedAt !== null &&
        Date.parse(intent.filePublishedAt) < Date.parse(intent.preparedAt)
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      if (
        intent.committedAt !== null &&
        intent.filePublishedAt !== null &&
        Date.parse(intent.committedAt) < Date.parse(intent.filePublishedAt)
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      return intent;
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  private parseStoredLegacyKey(value: unknown): LegacyTeamKey {
    const parsed = parseLegacyTeamKey(value);
    if (parsed !== value) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return parsed;
  }

  private parseStoredWorkspaceBinding(
    workspaceId: unknown,
    generation: unknown
  ): TeamWorkspaceBindingEvidence | null {
    if (workspaceId === null && generation === null) {
      return null;
    }
    if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return {
      workspaceId: parseWorkspaceId(workspaceId),
      generation: generation as number,
    };
  }

  private computeIntentChecksum(input: PrepareTeamAdoptionInput): TeamAdoptionIntentChecksum {
    const canonical = JSON.stringify({
      schemaVersion: 1,
      intentId: input.intentId,
      teamId: input.teamId,
      legacyKey: input.legacyKey,
      directoryFingerprint: input.directoryFingerprint,
      workspaceId: input.workspaceBinding?.workspaceId ?? null,
      workspaceBindingGeneration: input.workspaceBinding?.generation ?? null,
      expectedIdentityChecksum: input.expectedIdentityChecksum,
      preparedAt: input.preparedAt,
    });
    return parseTeamAdoptionIntentChecksum(createHash('sha256').update(canonical).digest('hex'));
  }

  private isSameReservedIdentity(
    identity: TeamIdentityRecord,
    input: ReserveTeamIdentityInput
  ): boolean {
    return (
      identity.state === 'reserved' &&
      identity.legacyKey === input.legacyKey &&
      identity.directoryFingerprint === input.directoryFingerprint &&
      this.sameWorkspaceBinding(identity.workspaceBinding, input.workspaceBinding) &&
      identity.createdAt === input.createdAt
    );
  }

  private isSameIntentRequest(
    intent: TeamAdoptionIntent,
    input: PrepareTeamAdoptionInput,
    checksum: TeamAdoptionIntentChecksum
  ): boolean {
    return (
      intent.teamId === input.teamId &&
      intent.legacyKey === input.legacyKey &&
      intent.directoryFingerprint === input.directoryFingerprint &&
      this.sameWorkspaceBinding(intent.workspaceBinding, input.workspaceBinding) &&
      intent.expectedIdentityChecksum === input.expectedIdentityChecksum &&
      intent.preparedAt === input.preparedAt &&
      intent.intentChecksum === checksum
    );
  }

  private sameWorkspaceBinding(
    left: TeamWorkspaceBindingEvidence | null,
    right: TeamWorkspaceBindingEvidence | null
  ): boolean {
    return (
      (left === null && right === null) ||
      (left !== null &&
        right !== null &&
        left.workspaceId === right.workspaceId &&
        left.generation === right.generation)
    );
  }
}
