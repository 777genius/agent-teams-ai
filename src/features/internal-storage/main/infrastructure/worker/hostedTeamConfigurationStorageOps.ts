import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import {
  type HostedTeamConfigurationStorageCreateResult,
  type HostedTeamConfigurationStorageDeleteResult,
  type HostedTeamConfigurationStorageReadResult,
  type HostedTeamConfigurationStorageUpdateResult,
  parseHostedTeamConfigurationStorageCreateRequest,
  parseHostedTeamConfigurationStorageDeleteRequest,
  parseHostedTeamConfigurationStorageDraft,
  parseHostedTeamConfigurationStorageIdentity,
  parseHostedTeamConfigurationStorageUpdateRequest,
} from '../../../contracts/hostedTeamConfigurationStorageContracts';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export const hostedTeamConfigurationDrafts = sqliteTable(
  'hosted_team_configuration_drafts',
  {
    workspaceId: text('workspace_id').notNull(),
    teamId: text('team_id').notNull(),
    state: text('state').notNull(),
    revisionOrdinal: integer('revision_ordinal').notNull(),
    revisionToken: text('revision_token').notNull(),
    metadataJson: text('metadata_json').notNull(),
    membersJson: text('members_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.teamId] }),
    uniqueIndex('idx_hosted_team_configuration_team_id').on(table.teamId),
    uniqueIndex('idx_hosted_team_configuration_revision_token').on(table.revisionToken),
    check('ck_hosted_team_configuration_state', sql`${table.state} IN ('active', 'deleted')`),
    check('ck_hosted_team_configuration_revision', sql`${table.revisionOrdinal} > 0`),
    check('ck_hosted_team_configuration_metadata', sql`json_valid(${table.metadataJson})`),
    check('ck_hosted_team_configuration_members', sql`json_valid(${table.membersJson})`),
  ]
);

export const hostedTeamConfigurationCreateKeys = sqliteTable(
  'hosted_team_configuration_create_keys',
  {
    workspaceId: text('workspace_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    teamId: text('team_id').notNull(),
    initialRevision: text('initial_revision').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [
        hostedTeamConfigurationDrafts.workspaceId,
        hostedTeamConfigurationDrafts.teamId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ]
);

interface DraftRow {
  workspace_id: string;
  team_id: string;
  revision_token: string;
  metadata_json: string;
  members_json: string;
  state: 'active' | 'deleted';
  revision_ordinal: number;
}

function teamId(): string {
  return `team_${randomBytes(16).toString('hex')}`;
}

function revision(): string {
  return `revision_${randomBytes(24).toString('hex')}`;
}

function draft(row: DraftRow) {
  return parseHostedTeamConfigurationStorageDraft({
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    revision: row.revision_token,
    metadata: JSON.parse(row.metadata_json),
    members: JSON.parse(row.members_json),
  });
}

/** All mutations execute under one SQLite IMMEDIATE transaction. */
export class HostedTeamConfigurationStorageOps {
  constructor(
    private readonly getDatabase: () => SqliteDatabase,
    private readonly now: () => number
  ) {}

  handle(op: string, payload: unknown): unknown {
    switch (op) {
      case 'hostedTeamConfiguration.create':
        return this.create(payload);
      case 'hostedTeamConfiguration.read':
        return this.read(payload);
      case 'hostedTeamConfiguration.update':
        return this.update(payload);
      case 'hostedTeamConfiguration.delete':
        return this.delete(payload);
      default:
        throw new Error(`Unknown hosted team configuration storage op: ${op}`);
    }
  }

  private create(payload: unknown): HostedTeamConfigurationStorageCreateResult {
    const input = parseHostedTeamConfigurationStorageCreateRequest(payload);
    const db = this.getDatabase();
    return db
      .transaction((): HostedTeamConfigurationStorageCreateResult => {
        const admittedAtMs = this.requireMutationAdmission(input.deadlineAtMs);
        const replay = db
          .prepare(
            `SELECT payload_hash, team_id, initial_revision
             FROM hosted_team_configuration_create_keys
            WHERE workspace_id = ? AND idempotency_key = ?`
          )
          .get(input.workspaceId, input.idempotencyKey) as
          | { payload_hash: string; team_id: string; initial_revision: string }
          | undefined;
        if (replay) {
          return replay.payload_hash === input.payloadHash
            ? {
                kind: 'created',
                teamId: replay.team_id as never,
                revision: replay.initial_revision as never,
                outcome: 'idempotent_replay',
              }
            : { kind: 'conflict', reason: 'idempotency_mismatch' };
        }

        let reservedTeamId = teamId();
        while (
          db
            .prepare('SELECT 1 FROM hosted_team_configuration_drafts WHERE team_id = ?')
            .get(reservedTeamId)
        ) {
          reservedTeamId = teamId();
        }
        const initialRevision = revision();
        db.prepare(
          `INSERT INTO hosted_team_configuration_drafts
          (workspace_id, team_id, state, revision_ordinal, revision_token,
           metadata_json, members_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?)`
        ).run(
          input.workspaceId,
          reservedTeamId,
          initialRevision,
          JSON.stringify(input.metadata),
          JSON.stringify(input.members),
          admittedAtMs,
          admittedAtMs
        );
        db.prepare(
          `INSERT INTO hosted_team_configuration_create_keys
          (workspace_id, idempotency_key, payload_hash, team_id, initial_revision, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          input.workspaceId,
          input.idempotencyKey,
          input.payloadHash,
          reservedTeamId,
          initialRevision,
          admittedAtMs
        );
        return {
          kind: 'created',
          teamId: reservedTeamId as never,
          revision: initialRevision as never,
          outcome: 'created',
        };
      })
      .immediate();
  }

  private read(payload: unknown): HostedTeamConfigurationStorageReadResult {
    const input = parseHostedTeamConfigurationStorageIdentity(payload);
    const row = this.getDatabase()
      .prepare(
        `SELECT workspace_id, team_id, revision_token, revision_ordinal,
                metadata_json, members_json, state
           FROM hosted_team_configuration_drafts
          WHERE workspace_id = ? AND team_id = ? AND state = 'active'`
      )
      .get(input.workspaceId, input.teamId) as DraftRow | undefined;
    return row ? { kind: 'found', draft: draft(row) } : { kind: 'not_found' };
  }

  private update(payload: unknown): HostedTeamConfigurationStorageUpdateResult {
    const input = parseHostedTeamConfigurationStorageUpdateRequest(payload);
    const db = this.getDatabase();
    return db
      .transaction((): HostedTeamConfigurationStorageUpdateResult => {
        const admittedAtMs = this.requireMutationAdmission(input.deadlineAtMs);
        const row = db
          .prepare(
            `SELECT workspace_id, team_id, revision_token, revision_ordinal,
                  metadata_json, members_json, state
             FROM hosted_team_configuration_drafts
            WHERE workspace_id = ? AND team_id = ?`
          )
          .get(input.workspaceId, input.teamId) as DraftRow | undefined;
        if (!row || row.state !== 'active') return { kind: 'not_found' };
        if (row.revision_token !== input.expectedRevision) {
          return { kind: 'conflict', reason: 'revision_mismatch' };
        }
        const nextRevision = revision();
        const nextMetadata = { ...(JSON.parse(row.metadata_json) as object), ...input.updates };
        const changed = db
          .prepare(
            `UPDATE hosted_team_configuration_drafts
              SET revision_ordinal = revision_ordinal + 1,
                  revision_token = ?, metadata_json = ?, updated_at_ms = ?
            WHERE workspace_id = ? AND team_id = ? AND state = 'active' AND revision_token = ?`
          )
          .run(
            nextRevision,
            JSON.stringify(nextMetadata),
            admittedAtMs,
            input.workspaceId,
            input.teamId,
            input.expectedRevision
          );
        if (changed.changes !== 1) return { kind: 'conflict', reason: 'revision_mismatch' };
        return {
          kind: 'updated',
          draft: draft({
            ...row,
            revision_ordinal: row.revision_ordinal + 1,
            revision_token: nextRevision,
            metadata_json: JSON.stringify(nextMetadata),
          }),
        };
      })
      .immediate();
  }

  private delete(payload: unknown): HostedTeamConfigurationStorageDeleteResult {
    const input = parseHostedTeamConfigurationStorageDeleteRequest(payload);
    const db = this.getDatabase();
    return db
      .transaction((): HostedTeamConfigurationStorageDeleteResult => {
        const admittedAtMs = this.requireMutationAdmission(input.deadlineAtMs);
        const row = db
          .prepare(
            `SELECT state, revision_token, revision_ordinal
             FROM hosted_team_configuration_drafts
            WHERE workspace_id = ? AND team_id = ?`
          )
          .get(input.workspaceId, input.teamId) as
          | { state: 'active' | 'deleted'; revision_token: string; revision_ordinal: number }
          | undefined;
        // Absence and tombstones deliberately have the same response, including wrong-workspace IDs.
        if (!row || row.state === 'deleted') return { kind: 'deleted', outcome: 'already_absent' };
        if (row.revision_token !== input.expectedRevision) {
          return { kind: 'conflict', reason: 'revision_mismatch' };
        }
        const changed = db
          .prepare(
            `UPDATE hosted_team_configuration_drafts
              SET state = 'deleted', revision_ordinal = revision_ordinal + 1,
                  revision_token = ?, updated_at_ms = ?
            WHERE workspace_id = ? AND team_id = ? AND state = 'active' AND revision_token = ?`
          )
          .run(revision(), admittedAtMs, input.workspaceId, input.teamId, input.expectedRevision);
        return changed.changes === 1
          ? { kind: 'deleted', outcome: 'deleted' }
          : { kind: 'conflict', reason: 'revision_mismatch' };
      })
      .immediate();
  }

  private requireMutationAdmission(deadlineAtMs: number): number {
    const now = this.now();
    if (now >= deadlineAtMs) {
      throw new Error('hosted-team-configuration-mutation-deadline-expired');
    }
    return now;
  }
}
