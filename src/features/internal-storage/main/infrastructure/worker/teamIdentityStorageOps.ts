import { parseTeamId } from '@shared/contracts/hosted/identifiers';

import {
  MAX_TEAM_IDENTITY_READ_RECORDS,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentId,
  TeamIdentityStorageErrorCode,
} from '../../../contracts/teamIdentityStorageContracts';

import { fail } from './teamIdentityStorageErrors';
import { type TeamIdentityRow, TeamIdentityStorageSupport } from './teamIdentityStorageSupport';

export { TeamIdentityStorageInvariantError } from './teamIdentityStorageErrors';

import {
  TEAM_IDENTITY_STORAGE_COMPONENT,
  TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION,
  TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS,
} from './teamIdentityStorageSchema';

import type {
  CommitTeamAdoptionInput,
  LegacyTeamKey,
  LegacyTeamKeyReservation,
  LegacyTeamKeyTombstoneResult,
  PrepareTeamAdoptionInput,
  RecordTeamIdentityFilePublishedInput,
  ReserveTeamIdentityInput,
  TeamAdoptionCommitResult,
  TeamAdoptionIntent,
  TeamAdoptionPrepareResult,
  TeamIdentityFilePublishedResult,
  TeamIdentityRecord,
  TeamIdentityReservationResult,
  TombstoneLegacyTeamKeyInput,
} from '../../../contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted/identifiers';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export class TeamIdentityStorageOps {
  private readonly support = new TeamIdentityStorageSupport();

  constructor(private readonly getDatabase: () => SqliteDatabase) {}

  getIdentity(teamId: TeamId): TeamIdentityRecord | null {
    const parsedTeamId = this.support.validated(() => parseTeamId(teamId));
    const db = this.database();
    const identity = this.support.readIdentityByTeamId(db, parsedTeamId);
    if (identity) this.support.assertReadableIdentityGraph(db, identity);
    return identity;
  }

  listIdentities(): readonly TeamIdentityRecord[] {
    return this.listIdentitiesWhere('');
  }

  listActiveIdentities(): readonly TeamIdentityRecord[] {
    return this.listIdentitiesWhere("WHERE state = 'active'");
  }

  captureExternalWriterInventory(retirementCandidates: readonly TeamId[]): {
    readonly active: readonly TeamIdentityRecord[];
    readonly retiredCandidates: readonly {
      teamId: TeamId;
      identityChecksum: NonNullable<TeamIdentityRecord['identityChecksum']>;
      tombstonedAt: string;
    }[];
  } {
    if (retirementCandidates.length > 1_024 || new Set(retirementCandidates).size !== retirementCandidates.length) {
      throw new TypeError('external-writer-inventory-candidates-invalid');
    }
    const parsed = retirementCandidates.map((teamId) =>
      this.support.validated(() => parseTeamId(teamId))
    );
    return this.database().transaction(() => {
      const active = this.listActiveIdentities();
      const retiredCandidates = parsed.flatMap((teamId) => {
        const identity = this.support.readIdentityByTeamId(this.database(), teamId);
        if (!identity || identity.state !== 'tombstoned') return [];
        this.support.assertReadableIdentityGraph(this.database(), identity);
        if (identity.identityChecksum === null || identity.tombstonedAt === null) {
          fail(TeamIdentityStorageErrorCode.TamperingDetected);
        }
        return [{
          teamId: identity.teamId,
          identityChecksum: identity.identityChecksum,
          tombstonedAt: identity.tombstonedAt,
        }];
      });
      return Object.freeze({
        active,
        retiredCandidates: Object.freeze(retiredCandidates),
      });
    })();
  }

  private listIdentitiesWhere(where: string): readonly TeamIdentityRecord[] {
    const db = this.database();
    let rows: TeamIdentityRow[];
    try {
      rows = db
        .prepare(
          `SELECT team_id, state, legacy_key, directory_fingerprint,
                  workspace_id, workspace_binding_generation, adoption_intent_id,
                  identity_checksum, created_at, activated_at, tombstoned_at
             FROM team_identity_records
            ${where}
            ORDER BY team_id ASC
            LIMIT ?`
        )
        .all(MAX_TEAM_IDENTITY_READ_RECORDS + 1) as TeamIdentityRow[];
    } catch {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    if (rows.length > MAX_TEAM_IDENTITY_READ_RECORDS) {
      fail(TeamIdentityStorageErrorCode.ReadLimitExceeded);
    }
    const identities = rows.map((row) => this.support.mapIdentity(row));
    for (const identity of identities) this.support.assertReadableIdentityGraph(db, identity);
    return Object.freeze(identities);
  }

  getLegacyKeyReservation(legacyKey: LegacyTeamKey): LegacyTeamKeyReservation | null {
    const parsedLegacyKey = this.support.validated(() => parseLegacyTeamKey(legacyKey));
    return this.support.readReservationByKey(this.database(), parsedLegacyKey);
  }

  getAdoptionIntent(intentId: TeamAdoptionIntent['intentId']): TeamAdoptionIntent | null {
    const parsedIntentId = this.support.validated(() => parseTeamAdoptionIntentId(intentId));
    return this.support.readIntentById(this.database(), parsedIntentId);
  }

  reserveIdentity(input: ReserveTeamIdentityInput): TeamIdentityReservationResult {
    const normalized = this.support.normalizeReservationInput(input);
    const db = this.database();

    return this.support.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamIdentityReservationResult => {
          const existingIdentity = this.support.readIdentityByTeamId(db, normalized.teamId);
          if (existingIdentity) {
            if (existingIdentity.state === 'tombstoned') {
              fail(TeamIdentityStorageErrorCode.LegacyKeyTombstoned);
            }
            if (!this.support.isSameReservedIdentity(existingIdentity, normalized)) {
              fail(TeamIdentityStorageErrorCode.DuplicateIdentity);
            }
            const reservation = this.support.requireConsistentReservation(db, existingIdentity);
            if (reservation.state === 'tombstoned') {
              fail(TeamIdentityStorageErrorCode.LegacyKeyTombstoned);
            }
            return { outcome: 'already_reserved', identity: existingIdentity, reservation };
          }

          this.support.assertIdentitySlotsAvailable(
            db,
            normalized.teamId,
            normalized.legacyKey,
            normalized.directoryFingerprint
          );
          this.support.insertIdentity(db, {
            ...normalized,
            state: 'reserved',
            adoptionIntentId: null,
          });
          this.support.insertReservation(
            db,
            normalized.legacyKey,
            normalized.teamId,
            normalized.createdAt
          );

          const identity = this.support.requireIdentity(db, normalized.teamId);
          const reservation = this.support.requireConsistentReservation(db, identity);
          return { outcome: 'created', identity, reservation };
        })()
    );
  }

  prepareAdoption(input: PrepareTeamAdoptionInput): TeamAdoptionPrepareResult {
    const normalized = this.support.normalizePrepareInput(input);
    const intentChecksum = this.support.computeIntentChecksum(normalized);
    const db = this.database();

    return this.support.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamAdoptionPrepareResult => {
          const existingIntent = this.support.readIntentById(db, normalized.intentId);
          if (existingIntent) {
            if (!this.support.isSameIntentRequest(existingIntent, normalized, intentChecksum)) {
              fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
            }
            const identity = this.support.requireIdentity(db, normalized.teamId);
            const reservation = this.support.requireConsistentReservation(db, identity);
            this.support.assertIntentGraphConsistent(existingIntent, identity, reservation);
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

          const intentForTeam = this.support.readIntentByTeamId(db, normalized.teamId);
          if (intentForTeam) {
            fail(TeamIdentityStorageErrorCode.AdoptionIntentMismatch);
          }
          this.support.assertIdentitySlotsAvailable(
            db,
            normalized.teamId,
            normalized.legacyKey,
            normalized.directoryFingerprint
          );

          this.support.insertIdentity(db, {
            teamId: normalized.teamId,
            legacyKey: normalized.legacyKey,
            directoryFingerprint: normalized.directoryFingerprint,
            workspaceBinding: normalized.workspaceBinding,
            createdAt: normalized.preparedAt,
            state: 'adoption_prepared',
            adoptionIntentId: normalized.intentId,
          });
          this.support.insertReservation(
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

          const identity = this.support.requireIdentity(db, normalized.teamId);
          const reservation = this.support.requireConsistentReservation(db, identity);
          const intent = this.support.requireIntent(db, normalized.intentId);
          this.support.assertIntentGraphConsistent(intent, identity, reservation);
          return { outcome: 'prepared', identity, reservation, intent };
        })()
    );
  }

  recordIdentityFilePublished(
    input: RecordTeamIdentityFilePublishedInput
  ): TeamIdentityFilePublishedResult {
    const normalized = this.support.normalizeFilePublishedInput(input);
    const db = this.database();

    return this.support.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamIdentityFilePublishedResult => {
          const intent = this.support.readIntentById(db, normalized.intentId);
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

          const currentIdentity = this.support.requireIdentity(db, normalized.teamId);
          const currentReservation = this.support.requireConsistentReservation(db, currentIdentity);
          this.support.assertIntentGraphConsistent(intent, currentIdentity, currentReservation);

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

          const checksumOwner = this.support.readIdentityByChecksum(
            db,
            normalized.identityChecksum
          );
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

          const publishedIdentity = this.support.requireIdentity(db, normalized.teamId);
          const publishedReservation = this.support.requireConsistentReservation(
            db,
            publishedIdentity
          );
          const publishedIntent = this.support.requireIntent(db, normalized.intentId);
          this.support.assertIntentGraphConsistent(
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
    const normalized = this.support.normalizeCommitInput(input);
    const db = this.database();

    return this.support.withConstraintClassification(
      db,
      TeamIdentityStorageErrorCode.DuplicateIdentity,
      () =>
        db.transaction((): TeamAdoptionCommitResult => {
          const intent = this.support.readIntentById(db, normalized.intentId);
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

          const currentIdentity = this.support.requireIdentity(db, normalized.teamId);
          const currentReservation = this.support.requireConsistentReservation(db, currentIdentity);
          this.support.assertIntentGraphConsistent(intent, currentIdentity, currentReservation);

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

          const checksumOwner = this.support.readIdentityByChecksum(
            db,
            normalized.identityChecksum
          );
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

          const committedIdentity = this.support.requireIdentity(db, normalized.teamId);
          const committedReservation = this.support.requireConsistentReservation(
            db,
            committedIdentity
          );
          const committedIntent = this.support.requireIntent(db, normalized.intentId);
          this.support.assertIntentGraphConsistent(
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
    const normalized = this.support.normalizeTombstoneInput(input);
    const db = this.database();

    return db.transaction((): LegacyTeamKeyTombstoneResult => {
      const reservation = this.support.readReservationByKey(db, normalized.legacyKey);
      if (reservation?.teamId !== normalized.teamId) {
        fail(TeamIdentityStorageErrorCode.LegacyKeyConflict);
      }
      const identity = this.support.requireIdentity(db, normalized.teamId);
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
        identity: this.support.requireIdentity(db, normalized.teamId),
        reservation: this.support.requireReservation(db, normalized.legacyKey),
      };
    })();
  }

  private database(): SqliteDatabase {
    const db = this.getDatabase();
    let rows: { component?: unknown; schema_version?: unknown }[];
    try {
      rows = db
        .prepare(
          `SELECT component, schema_version
            FROM team_identity_storage_metadata`
        )
        .all() as {
        component?: unknown;
        schema_version?: unknown;
      }[];
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
    let schemaObjects: {
      type?: unknown;
      name?: unknown;
      tbl_name?: unknown;
      sql?: unknown;
    }[];
    try {
      schemaObjects = db
        .prepare(
          `SELECT type, name, tbl_name, sql
            FROM sqlite_schema
            WHERE tbl_name IN (${placeholders})`
        )
        .all(...componentTableNames) as {
        type?: unknown;
        name?: unknown;
        tbl_name?: unknown;
        sql?: unknown;
      }[];
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
}
