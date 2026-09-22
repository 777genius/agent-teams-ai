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

import { fail, TeamIdentityStorageInvariantError } from './teamIdentityStorageErrors';

import type {
  CommitTeamAdoptionInput,
  LegacyTeamKey,
  LegacyTeamKeyReservation,
  LegacyTeamKeyTombstoneReason,
  PrepareTeamAdoptionInput,
  RecordTeamIdentityFilePublishedInput,
  ReserveTeamIdentityInput,
  TeamAdoptionIntent,
  TeamAdoptionIntentChecksum,
  TeamIdentityRecord,
  TeamIdentityStorageErrorCode as TeamIdentityStorageErrorCodeValue,
  TeamWorkspaceBindingEvidence,
  TombstoneLegacyTeamKeyInput,
} from '../../../contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted/identifiers';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface TeamIdentityRow {
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

export interface LegacyTeamKeyReservationRow {
  legacy_key: unknown;
  team_id: unknown;
  state: unknown;
  reserved_at: unknown;
  tombstoned_at: unknown;
  tombstone_reason: unknown;
}

export interface TeamAdoptionIntentRow {
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

export class TeamIdentityStorageSupport {
  normalizeReservationInput(input: ReserveTeamIdentityInput): ReserveTeamIdentityInput {
    return this.validated(() => ({
      teamId: parseTeamId(input.teamId),
      legacyKey: parseLegacyTeamKey(input.legacyKey),
      directoryFingerprint: parseDirectoryFingerprint(input.directoryFingerprint),
      workspaceBinding: this.parseWorkspaceBinding(input.workspaceBinding),
      createdAt: this.parseTimestamp(input.createdAt),
    }));
  }

  normalizePrepareInput(input: PrepareTeamAdoptionInput): PrepareTeamAdoptionInput {
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

  normalizeCommitInput(input: CommitTeamAdoptionInput): CommitTeamAdoptionInput {
    return this.validated(() => ({
      intentId: parseTeamAdoptionIntentId(input.intentId),
      teamId: parseTeamId(input.teamId),
      intentChecksum: parseTeamAdoptionIntentChecksum(input.intentChecksum),
      identityChecksum: parseTeamIdentityChecksum(input.identityChecksum),
      committedAt: this.parseTimestamp(input.committedAt),
    }));
  }

  normalizeFilePublishedInput(
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

  normalizeTombstoneInput(input: TombstoneLegacyTeamKeyInput): TombstoneLegacyTeamKeyInput {
    return this.validated(() => ({
      teamId: parseTeamId(input.teamId),
      legacyKey: parseLegacyTeamKey(input.legacyKey),
      reason: this.parseTombstoneReason(input.reason),
      tombstonedAt: this.parseTimestamp(input.tombstonedAt),
    }));
  }

  parseWorkspaceBinding(
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

  parseTimestamp(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      throw new TypeError('team-identity-timestamp-invalid');
    }
    return value;
  }

  parseTombstoneReason(value: unknown): LegacyTeamKeyTombstoneReason {
    if (value !== 'draft_deleted' && value !== 'team_deleted' && value !== 'legacy_conflict') {
      throw new TypeError('team-identity-tombstone-reason-invalid');
    }
    return value;
  }

  validated<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof TeamIdentityStorageInvariantError) {
        throw error;
      }
      fail(TeamIdentityStorageErrorCode.InvalidInput);
    }
  }

  withConstraintClassification<T>(
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

  assertIdentitySlotsAvailable(
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

  insertIdentity(
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

  insertReservation(
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

  readIdentityByTeamId(db: SqliteDatabase, teamId: TeamId): TeamIdentityRecord | null {
    const row = db.prepare('SELECT * FROM team_identity_records WHERE team_id = ?').get(teamId) as
      | TeamIdentityRow
      | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  readIdentityByLegacyKey(db: SqliteDatabase, legacyKey: LegacyTeamKey): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE legacy_key = ?')
      .get(legacyKey) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  readIdentityByDirectoryFingerprint(
    db: SqliteDatabase,
    directoryFingerprint: ReserveTeamIdentityInput['directoryFingerprint']
  ): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE directory_fingerprint = ?')
      .get(directoryFingerprint) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  readIdentityByChecksum(
    db: SqliteDatabase,
    checksum: CommitTeamAdoptionInput['identityChecksum']
  ): TeamIdentityRecord | null {
    const row = db
      .prepare('SELECT * FROM team_identity_records WHERE identity_checksum = ?')
      .get(checksum) as TeamIdentityRow | undefined;
    return row ? this.mapIdentity(row) : null;
  }

  readReservationByKey(
    db: SqliteDatabase,
    legacyKey: LegacyTeamKey
  ): LegacyTeamKeyReservation | null {
    const row = db
      .prepare('SELECT * FROM legacy_team_key_reservations WHERE legacy_key = ?')
      .get(legacyKey) as LegacyTeamKeyReservationRow | undefined;
    return row ? this.mapReservation(row) : null;
  }

  readIntentById(
    db: SqliteDatabase,
    intentId: TeamAdoptionIntent['intentId']
  ): TeamAdoptionIntent | null {
    const row = db
      .prepare('SELECT * FROM team_adoption_intents WHERE intent_id = ?')
      .get(intentId) as TeamAdoptionIntentRow | undefined;
    return row ? this.mapIntent(row) : null;
  }

  readIntentByTeamId(db: SqliteDatabase, teamId: TeamId): TeamAdoptionIntent | null {
    const row = db.prepare('SELECT * FROM team_adoption_intents WHERE team_id = ?').get(teamId) as
      | TeamAdoptionIntentRow
      | undefined;
    return row ? this.mapIntent(row) : null;
  }

  requireIdentity(db: SqliteDatabase, teamId: TeamId): TeamIdentityRecord {
    const identity = this.readIdentityByTeamId(db, teamId);
    if (!identity) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return identity;
  }

  requireReservation(db: SqliteDatabase, legacyKey: LegacyTeamKey): LegacyTeamKeyReservation {
    const reservation = this.readReservationByKey(db, legacyKey);
    if (!reservation) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return reservation;
  }

  requireIntent(db: SqliteDatabase, intentId: TeamAdoptionIntent['intentId']): TeamAdoptionIntent {
    const intent = this.readIntentById(db, intentId);
    if (!intent) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return intent;
  }

  requireConsistentReservation(
    db: SqliteDatabase,
    identity: TeamIdentityRecord
  ): LegacyTeamKeyReservation {
    const reservation = this.requireReservation(db, identity.legacyKey);
    if (
      reservation.teamId !== identity.teamId ||
      reservation.reservedAt !== identity.createdAt ||
      reservation.tombstonedAt !== identity.tombstonedAt ||
      (identity.state === 'tombstoned') !== (reservation.state === 'tombstoned')
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return reservation;
  }

  assertReadableIdentityGraph(db: SqliteDatabase, identity: TeamIdentityRecord): void {
    const reservation = this.requireConsistentReservation(db, identity);
    if (identity.adoptionIntentId === null) {
      if (
        (identity.state !== 'reserved' && identity.state !== 'tombstoned') ||
        identity.identityChecksum !== null ||
        identity.activatedAt !== null
      ) {
        fail(TeamIdentityStorageErrorCode.TamperingDetected);
      }
      return;
    }

    const intent = this.requireIntent(db, identity.adoptionIntentId);
    if (identity.state !== 'tombstoned') {
      this.assertIntentGraphConsistent(intent, identity, reservation);
      return;
    }
    if (
      intent.teamId !== identity.teamId ||
      intent.legacyKey !== identity.legacyKey ||
      intent.directoryFingerprint !== identity.directoryFingerprint ||
      !this.sameWorkspaceBinding(intent.workspaceBinding, identity.workspaceBinding) ||
      intent.preparedAt !== identity.createdAt ||
      reservation.state !== 'tombstoned' ||
      (intent.state === 'prepared' &&
        (identity.identityChecksum !== null || identity.activatedAt !== null)) ||
      (intent.state === 'file_published' &&
        (identity.identityChecksum !== intent.expectedIdentityChecksum ||
          identity.activatedAt !== null)) ||
      (intent.state === 'committed' &&
        (identity.identityChecksum !== intent.expectedIdentityChecksum ||
          identity.activatedAt !== intent.committedAt))
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  assertIntentGraphConsistent(
    intent: TeamAdoptionIntent,
    identity: TeamIdentityRecord,
    reservation: LegacyTeamKeyReservation
  ): void {
    if (
      intent.teamId !== identity.teamId ||
      intent.legacyKey !== identity.legacyKey ||
      intent.directoryFingerprint !== identity.directoryFingerprint ||
      !this.sameWorkspaceBinding(intent.workspaceBinding, identity.workspaceBinding) ||
      intent.preparedAt !== identity.createdAt ||
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
      identity.activatedAt !== intent.committedAt ||
      (identity.state === 'active' && reservation.state !== 'active')
    ) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
  }

  mapIdentity(row: TeamIdentityRow): TeamIdentityRecord {
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

  mapReservation(row: LegacyTeamKeyReservationRow): LegacyTeamKeyReservation {
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

  mapIntent(row: TeamAdoptionIntentRow): TeamAdoptionIntent {
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

  parseStoredLegacyKey(value: unknown): LegacyTeamKey {
    const parsed = parseLegacyTeamKey(value);
    if (parsed !== value) {
      fail(TeamIdentityStorageErrorCode.TamperingDetected);
    }
    return parsed;
  }

  parseStoredWorkspaceBinding(
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

  computeIntentChecksum(input: PrepareTeamAdoptionInput): TeamAdoptionIntentChecksum {
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

  isSameReservedIdentity(identity: TeamIdentityRecord, input: ReserveTeamIdentityInput): boolean {
    return (
      identity.state === 'reserved' &&
      identity.legacyKey === input.legacyKey &&
      identity.directoryFingerprint === input.directoryFingerprint &&
      this.sameWorkspaceBinding(identity.workspaceBinding, input.workspaceBinding) &&
      identity.createdAt === input.createdAt
    );
  }

  isSameIntentRequest(
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

  sameWorkspaceBinding(
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
