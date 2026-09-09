import { createHash, randomBytes } from 'node:crypto';

import { compileHostedPromotionPlan } from '@features/team-configuration';

import {
  parseHostedPromotionBegin,
  parseHostedPromotionLookup,
  parseHostedPromotionRecord,
} from '../../../contracts/hostedPromotionStorageContracts';
import { parseHostedTeamConfigurationStorageDraft } from '../../../contracts/hostedTeamConfigurationStorageContracts';

import { HostedTeamConfigurationStorageOps } from './hostedTeamConfigurationStorageOps';
import { TeamDraftPublicationStorageOps } from './teamDraftPublicationStorageOps';

import type {
  HostedPromotionBegin,
  HostedPromotionBeginResult,
  HostedPromotionRecord,
} from '../../../contracts/hostedPromotionStorageContracts';
import type { HostedTeamConfigurationStorageReadResult } from '../../../contracts/hostedTeamConfigurationStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;
interface Row {
  operation_id: string;
  workspace_id: string;
  team_id: string;
  actor_id: string;
  deployment_id: string;
  idempotency_key: string;
  record_json: string;
}
const RECORD_COLUMNS =
  'operation_id, workspace_id, team_id, actor_id, deployment_id, idempotency_key, record_json';

/** Host capability injected locally at the worker boundary, never in message payloads.
 * Acquire runs AFTER SQLite has obtained its IMMEDIATE lock. It must atomically
 * reject revoked capture authority and retain the exact actor/session/grant,
 * deployment and admitted mount/create binding until release (after COMMIT or
 * ROLLBACK). Retention must not expire or release itself during that interval.
 * Every relevant revoker must serialize with that retention. A boolean
 * check, deadline, cached publication or async request fence cannot implement it.
 * The real host adapter is intentionally absent; the ordinary worker fails closed.
 * This is a local commit contract, not cross-database atomicity or Owner authority.
 */
export interface HostedPromotionCommitAuthority {
  retainForCommit(input: HostedPromotionBegin): { release(): void };
}

/** The only writer of promotion snapshots. All inputs and the frozen roster are detached.
 * This transaction has no filesystem, canonical-DB, publication or Owner effect.
 */
export class HostedPromotionStorageOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined = () => undefined
  ) {}

  begin(value: unknown): HostedPromotionBeginResult {
    const input = Object.freeze(parseHostedPromotionBegin(value));
    const db = this.database();
    // A savepoint would release the host capability before the outer COMMIT.
    if (db.inTransaction) throw new Error('promotion-nested-transaction-rejected');
    let retained: { release(): void } | undefined;
    try {
      return db.transaction((): HostedPromotionBeginResult => {
        const authority = this.commitAuthority();
        if (!authority) throw new Error('promotion-commit-authority-unavailable');
        retained = authority.retainForCommit(input);
        if (!retained || typeof retained.release !== 'function') {
          throw new Error('promotion-commit-retention-invalid');
        }
        const createdAtMs = this.now();
        if (createdAtMs >= input.deadlineAtMs) throw new Error('promotion-deadline-expired');
        const { workspaceId, teamId, actorId, deploymentId } = input;
        const publication = new TeamDraftPublicationStorageOps(this.database, this.now).read({
          workspaceId, teamId, actorId, deploymentId,
        });
        if (!publication || publication.state === 'tombstoned') {
          return { kind: 'unavailable', reason: 'publication_missing' };
        }
        if (
          publication.operationId !== input.createOperationId ||
          publication.runtimeWorkspaceId !== input.runtimeWorkspaceId ||
          publication.bindingGeneration !== input.bindingGeneration
        ) {
          return { kind: 'conflict', reason: 'binding_mismatch' };
        }
        const previous = db.prepare(`SELECT ${RECORD_COLUMNS} FROM hosted_team_configuration_promotions
          WHERE team_id = ? OR (workspace_id = ? AND actor_id = ? AND deployment_id = ? AND idempotency_key = ?)`)
          .all(teamId, workspaceId, actorId, deploymentId, input.idempotencyKey) as Row[];
        if (previous.length) {
          const operation = readRecord(db, previous[0]);
          const { deadlineAtMs: ignored, ...binding } = input;
          void ignored;
          if (
            previous.length !== 1 ||
            Object.entries(binding).some(([key, field]) =>
              operation[key as keyof HostedPromotionRecord] !== field)
          ) {
            return { kind: 'conflict', reason: 'operation_mismatch' };
          }
          return { kind: 'frozen', operation };
        }
        const current = new HostedTeamConfigurationStorageOps(this.database, this.now)
          .handle('hostedTeamConfiguration.read', { workspaceId, teamId }) as HostedTeamConfigurationStorageReadResult;
        if (current.kind !== 'found' || !current.draft.configuration) {
          return { kind: 'unavailable', reason: 'configuration_missing' };
        }
        if (current.draft.revision !== input.expectedRevision) {
          return { kind: 'conflict', reason: 'revision_mismatch' };
        }
        const saved = db.prepare(`SELECT members_json FROM hosted_team_configuration_drafts
          WHERE workspace_id = ? AND team_id = ?`).get(workspaceId, teamId) as { members_json: string };
        const laneIds = current.draft.configuration.lanes.map(() => `lane_${randomBytes(16).toString('hex')}`);
        const planJson = compileHostedPromotionPlan({
          runtimeWorkspaceId: input.runtimeWorkspaceId,
          originalTeamId: teamId,
          admittedWorkspaceRoot: input.admittedWorkspaceRoot,
          configuration: current.draft.configuration,
          laneIds,
        });
        const planSha256 = createHash('sha256').update(planJson, 'utf8').digest('hex');
        const { deadlineAtMs: ignored, ...binding } = input;
        void ignored;
        const operation: HostedPromotionRecord = {
          ...binding,
          operationId: `promotion_${randomBytes(16).toString('hex')}`,
          frozenRosterJson: saved.members_json,
          frozenDraftJson: JSON.stringify(current.draft),
          laneIds,
          planJson,
          planSha256,
          planGeneration: `plan-generation_${planSha256}`,
          createdAtMs,
          state: 'frozen',
        };
        // Validate the same retained association and snapshot used by recovery.
        readRecord(db, {
          operation_id: operation.operationId, workspace_id: workspaceId, team_id: teamId,
          actor_id: actorId, deployment_id: deploymentId, idempotency_key: input.idempotencyKey,
          record_json: JSON.stringify(operation),
        });
        if (this.now() >= input.deadlineAtMs) throw new Error('promotion-deadline-expired');
        db.prepare(`INSERT INTO hosted_team_configuration_promotions
          (operation_id, workspace_id, team_id, actor_id, deployment_id, idempotency_key, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(operation.operationId, workspaceId, teamId, actorId,
          deploymentId, input.idempotencyKey, JSON.stringify(operation));
        return { kind: 'frozen', operation };
      }).immediate();
    } finally {
      // Includes commit errors and rollback: never release before SQLite finishes.
      if (retained && typeof retained.release === 'function') retained.release();
    }
  }

  lookup(value: unknown): HostedPromotionRecord | null {
    const input = parseHostedPromotionLookup(value);
    const byOperation = 'operationId' in input.reference;
    const token = 'operationId' in input.reference
      ? input.reference.operationId
      : input.reference.idempotencyKey;
    const db = this.database();
    return db.transaction(() => {
      const row = db.prepare(`SELECT ${RECORD_COLUMNS} FROM hosted_team_configuration_promotions
        WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ?
          AND ${byOperation ? 'operation_id' : 'idempotency_key'} = ?`)
        .get(input.workspaceId, input.teamId, input.actorId, input.deploymentId, token) as Row | undefined;
      if (!row) return null;
      const record = readRecord(db, row);
      if (
        record.workspaceId !== input.workspaceId || record.teamId !== input.teamId ||
        record.actorId !== input.actorId || record.deploymentId !== input.deploymentId ||
        (byOperation ? record.operationId : record.idempotencyKey) !== token
      ) {
        throw new Error('promotion-reference-corrupt');
      }
      return record;
    })();
  }
}

function readRecord(db: Database, row: Row): HostedPromotionRecord {
  if (Buffer.byteLength(row.record_json) > 2 * 1024 * 1024) throw new Error('promotion-record-too-large');
  const record = parseHostedPromotionRecord(JSON.parse(row.record_json));
  if (
    record.operationId !== row.operation_id || record.workspaceId !== row.workspace_id ||
    record.teamId !== row.team_id || record.actorId !== row.actor_id ||
    record.deploymentId !== row.deployment_id || record.idempotencyKey !== row.idempotency_key
  ) {
    throw new Error('promotion-index-binding-corrupt');
  }
  const publication = new TeamDraftPublicationStorageOps(() => db, () => 0).read(recordScope(record));
  if (
    !publication || publication.state === 'tombstoned' ||
    publication.operationId !== record.createOperationId ||
    publication.runtimeWorkspaceId !== record.runtimeWorkspaceId ||
    publication.bindingGeneration !== record.bindingGeneration
  ) {
    throw new Error('promotion-create-association-corrupt');
  }
  const createKeys = db.prepare(`SELECT initial_revision FROM hosted_team_configuration_create_keys
    WHERE workspace_id = ? AND team_id = ?`).all(record.workspaceId, record.teamId) as
    { initial_revision: string }[];
  if (createKeys.length !== 1 || createKeys[0].initial_revision !== publication.initialRevision) {
    throw new Error('promotion-create-association-corrupt');
  }
  const draft = parseHostedTeamConfigurationStorageDraft(JSON.parse(record.frozenDraftJson));
  const roster: unknown = JSON.parse(record.frozenRosterJson);
  if (
    !roster || typeof roster !== 'object' || Array.isArray(roster) ||
    Object.keys(roster).sort().join(',') !== 'configuration,members,schemaVersion' ||
    !('schemaVersion' in roster) || roster.schemaVersion !== 1 ||
    !('members' in roster) || !('configuration' in roster)
  ) {
    throw new Error('promotion-roster-envelope-corrupt');
  }
  const rosterDraft = parseHostedTeamConfigurationStorageDraft({
    ...draft, members: roster.members, configuration: roster.configuration,
  });
  if (
    draft.workspaceId !== record.workspaceId || draft.teamId !== record.teamId ||
    draft.revision !== record.expectedRevision ||
    JSON.stringify(rosterDraft) !== JSON.stringify(draft) ||
    compileHostedPromotionPlan({
      runtimeWorkspaceId: record.runtimeWorkspaceId,
      originalTeamId: record.teamId,
      admittedWorkspaceRoot: record.admittedWorkspaceRoot,
      configuration: draft.configuration,
      laneIds: record.laneIds,
    }) !== record.planJson
  ) {
    throw new Error('promotion-snapshot-corrupt');
  }
  const digest = createHash('sha256').update(record.planJson, 'utf8').digest('hex');
  if (
    record.state !== 'frozen' || digest !== record.planSha256 ||
    record.planGeneration !== `plan-generation_${digest}`
  ) {
    throw new Error('promotion-record-corrupt');
  }
  return record;
}

function recordScope(record: HostedPromotionRecord) {
  return {
    workspaceId: record.workspaceId, teamId: record.teamId,
    actorId: record.actorId, deploymentId: record.deploymentId,
  };
}
