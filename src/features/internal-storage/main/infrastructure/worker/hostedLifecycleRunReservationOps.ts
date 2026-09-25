import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parseRunId } from '@shared/contracts/hosted';
import {
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';

import {
  parseHostedLifecycleRunReservation,
  parseHostedLifecycleRunReservationInput,
} from '../../../contracts/hostedLifecycleRunReservationContracts';
import { parseTeamDraftPublicationScope } from '../../../contracts/teamDraftPublicationContracts';

import { HostedPromotionStorageOps } from './hostedPromotionStorageOps';

import type {
  HostedLifecycleRunReservation,
  HostedLifecycleRunReservationResult,
} from '../../../contracts/hostedLifecycleRunReservationContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;
interface Row {
  run_id: string;
  deployment_id: string;
  actor_id: string;
  boot_id: string;
  team_id: string;
  expected_revision: string;
  command_id: string;
  idempotency_key: string;
  promotion_operation_id: string;
  record_json: string;
}

const COLUMNS =
  'run_id, deployment_id, actor_id, boot_id, team_id, expected_revision, command_id, idempotency_key, promotion_operation_id, record_json';

/** Dedicated Product writer. No Owner state or provider effect is committed here. */
export class HostedLifecycleRunReservationOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  lookupByResource(value: unknown): HostedLifecycleRunReservation | null {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 4
    ) {
      throw new TypeError('hosted-run-reservation-claim-invalid');
    }
    const claim = value as Record<string, unknown>;
    const deploymentId = parseDeploymentId(claim.deploymentId);
    const bootId = parseBootId(claim.bootId);
    const teamId = parseTeamId(claim.teamId);
    const expectedRevision = parseRevision(claim.expectedRevision);
    const row = this.database()
      .prepare(
        `SELECT run_id AS runId FROM main.hosted_lifecycle_run_reservations
       WHERE deployment_id = ? AND boot_id = ? AND team_id = ? AND expected_revision = ?`
      )
      .get(deploymentId, bootId, teamId, expectedRevision) as { runId: string } | undefined;
    return row ? this.lookup(row.runId) : null;
  }

  currentPlanGeneration(value: unknown): string | null {
    const scope = parseTeamDraftPublicationScope(value);
    const db = this.database();
    const row = db
      .prepare(
        `SELECT promotion.operation_id AS operationId
      FROM main.hosted_team_configuration_promotions promotion
      JOIN main.hosted_team_configuration_publications publication
        ON publication.workspace_id = promotion.workspace_id
       AND publication.team_id = promotion.team_id
       AND publication.actor_id = promotion.actor_id
       AND publication.deployment_id = promotion.deployment_id
      WHERE promotion.workspace_id = ? AND promotion.team_id = ?
        AND promotion.actor_id = ? AND promotion.deployment_id = ?
        AND publication.state = 'published'`
      )
      .get(scope.workspaceId, scope.teamId, scope.actorId, scope.deploymentId) as
      | { operationId: string }
      | undefined;
    if (!row) return null;
    const promotion = new HostedPromotionStorageOps(this.database, this.now).lookup({
      ...scope,
      reference: { operationId: row.operationId },
    });
    return promotion?.state === 'frozen' ? promotion.planGeneration : null;
  }

  /** Reads a historical immutable binding; this is not a current authority check. */
  lookup(value: unknown): HostedLifecycleRunReservation | null {
    const runId = parseRunId(value);
    const db = this.database();
    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${COLUMNS} FROM main.hosted_lifecycle_run_reservations WHERE run_id = ?`)
        .get(runId) as Row | undefined;
      if (!row) return null;
      const record = readRow(row);
      const promotions = new HostedPromotionStorageOps(this.database, this.now);
      const reference = {
        workspaceId: record.workspaceId,
        teamId: record.teamId,
        actorId: record.actorId,
        deploymentId: record.deploymentId,
        reference: { operationId: record.promotionOperationId },
      };
      const promotion = promotions.lookup(reference);
      const roster = promotions.lookupRosterBinding(reference);
      if (
        !promotion ||
        promotion.state !== 'frozen' ||
        promotion.runtimeWorkspaceId !== record.runtimeWorkspaceId ||
        promotion.planGeneration !== record.expectedPlanGeneration ||
        promotion.planSha256 !== record.planSha256 ||
        roster?.kind !== 'found' ||
        roster.binding.planSha256 !== record.planSha256 ||
        sha256(JSON.stringify(roster.binding)) !== record.rosterBindingSha256
      ) {
        throw new Error('hosted-run-reservation-promotion-binding-corrupt');
      }
      return record;
    })();
  }

  reserve(value: unknown): HostedLifecycleRunReservationResult {
    const input = parseHostedLifecycleRunReservationInput(value);
    const db = this.database();
    if (db.inTransaction) throw new Error('hosted-run-reservation-nested-transaction-rejected');
    let retained: { release(): void } | undefined;
    try {
      return db
        .transaction((): HostedLifecycleRunReservationResult => {
          const nowMs = this.now();
          if (nowMs >= input.deadlineAtMs)
            throw new Error('hosted-run-reservation-deadline-expired');
          const publication = db
            .prepare(
              `SELECT operation_id AS operationId,
          runtime_workspace_id AS runtimeWorkspaceId, binding_generation AS bindingGeneration,
          legacy_key AS legacyKey, directory_fingerprint AS directoryFingerprint
          FROM main.hosted_team_configuration_publications
          WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ?
            AND state = 'published'`
            )
            .get(input.workspaceId, input.teamId, input.actorId, input.deploymentId) as
            | {
                operationId: string;
                runtimeWorkspaceId: string;
                bindingGeneration: number;
                legacyKey: string;
                directoryFingerprint: string;
              }
            | undefined;
          if (!publication || publication.runtimeWorkspaceId !== input.runtimeWorkspaceId) {
            return { kind: 'unavailable', reason: 'promotion_missing' };
          }
          const promotionIdRow = db
            .prepare(
              `SELECT operation_id AS operationId
          FROM main.hosted_team_configuration_promotions
          WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ?`
            )
            .get(input.workspaceId, input.teamId, input.actorId, input.deploymentId) as
            | { operationId: string }
            | undefined;
          if (!promotionIdRow) return { kind: 'unavailable', reason: 'promotion_missing' };
          const promotions = new HostedPromotionStorageOps(this.database, this.now);
          const scope = {
            workspaceId: input.workspaceId,
            teamId: input.teamId,
            actorId: input.actorId,
            deploymentId: input.deploymentId,
          };
          const reference = { ...scope, reference: { operationId: promotionIdRow.operationId } };
          const promotion = promotions.lookup(reference);
          if (
            !promotion ||
            promotion.createOperationId !== publication.operationId ||
            promotion.runtimeWorkspaceId !== input.runtimeWorkspaceId ||
            promotion.bindingGeneration !== publication.bindingGeneration ||
            promotion.planGeneration !== input.expectedPlanGeneration ||
            promotion.state !== 'frozen'
          ) {
            return { kind: 'unavailable', reason: 'promotion_missing' };
          }
          const roster = promotions.lookupRosterBinding(reference);
          if (roster?.kind === 'unavailable') {
            return { kind: 'unavailable', reason: 'legacy_frozen_without_binding' };
          }
          if (
            roster?.kind !== 'found' ||
            roster.binding.operationId !== promotion.operationId ||
            roster.binding.planSha256 !== promotion.planSha256
          ) {
            throw new Error('hosted-run-reservation-roster-binding-corrupt');
          }
          const identity = db
            .prepare(
              `SELECT state, legacy_key AS legacyKey,
          directory_fingerprint AS directoryFingerprint, workspace_id AS workspaceId,
          workspace_binding_generation AS bindingGeneration,
          adoption_intent_id AS adoptionIntentId, identity_checksum AS identityChecksum
          FROM main.team_identity_records WHERE team_id = ?`
            )
            .get(input.teamId) as
            | {
                state: string;
                legacyKey: string;
                directoryFingerprint: string;
                workspaceId: string | null;
                bindingGeneration: number | null;
                adoptionIntentId: string | null;
                identityChecksum: string | null;
              }
            | undefined;
          if (
            !identity ||
            identity.state !== 'active' ||
            identity.legacyKey !== publication.legacyKey ||
            identity.directoryFingerprint !== publication.directoryFingerprint ||
            identity.workspaceId !== input.runtimeWorkspaceId ||
            identity.bindingGeneration !== publication.bindingGeneration ||
            identity.adoptionIntentId !== publication.operationId ||
            identity.identityChecksum !== input.ownerEffectFence.identityChecksum
          ) {
            return { kind: 'unavailable', reason: 'authority_changed' };
          }
          const authority = this.commitAuthority();
          if (!authority) throw new Error('hosted-run-reservation-commit-authority-unavailable');
          try {
            retained = authority.retainForCommit({
              ...scope,
              createOperationId: promotion.createOperationId,
              runtimeWorkspaceId: promotion.runtimeWorkspaceId,
              bindingGeneration: promotion.bindingGeneration,
              expectedRevision: promotion.expectedRevision,
              idempotencyKey: promotion.idempotencyKey,
              admittedWorkspaceRoot: promotion.admittedWorkspaceRoot,
              deadlineAtMs: input.deadlineAtMs,
              authorityEvidence: {
                userId: input.authorityEvidence.userId,
                sessionId: input.authorityEvidence.sessionId,
                grantRevision: input.ownerEffectFence.grantRevision,
                grantGeneration: input.authorityEvidence.grantGeneration,
              },
            });
          } catch {
            return { kind: 'unavailable', reason: 'authority_changed' };
          }
          if (!retained || typeof retained.release !== 'function') {
            throw new Error('hosted-run-reservation-retention-invalid');
          }
          const previous = db
            .prepare(
              `SELECT ${COLUMNS} FROM main.hosted_lifecycle_run_reservations
          WHERE command_id = ? OR (deployment_id = ? AND actor_id = ? AND idempotency_key = ?)
            OR (deployment_id = ? AND boot_id = ? AND team_id = ? AND expected_revision = ?)`
            )
            .all(
              input.commandId,
              input.deploymentId,
              input.actorId,
              input.idempotencyKey,
              input.deploymentId,
              input.bootId,
              input.teamId,
              input.expectedRevision
            ) as Row[];
          if (previous.length > 0) {
            if (previous.length !== 1) return { kind: 'conflict', reason: 'binding_mismatch' };
            const saved = readRow(previous[0]);
            const { deadlineAtMs: ignored, ...binding } = input;
            void ignored;
            const {
              runId: ignoredRun,
              promotionOperationId: ignoredPromotion,
              planSha256: ignoredPlan,
              rosterBindingSha256: ignoredRoster,
              createdAtMs: ignoredCreated,
              ...savedBinding
            } = saved;
            void ignoredRun;
            void ignoredPromotion;
            void ignoredPlan;
            void ignoredRoster;
            void ignoredCreated;
            return isDeepStrictEqual(savedBinding, binding) &&
              saved.promotionOperationId === promotion.operationId &&
              saved.planSha256 === promotion.planSha256 &&
              saved.rosterBindingSha256 === sha256(JSON.stringify(roster.binding))
              ? { kind: 'idempotent_replay', reservation: saved }
              : { kind: 'conflict', reason: 'binding_mismatch' };
          }
          if (this.now() >= input.deadlineAtMs)
            throw new Error('hosted-run-reservation-deadline-expired');
          const { deadlineAtMs: ignored, ...binding } = input;
          void ignored;
          const reservation = parseHostedLifecycleRunReservation({
            ...binding,
            runId: `run_${randomBytes(16).toString('hex')}`,
            promotionOperationId: promotion.operationId,
            planSha256: promotion.planSha256,
            rosterBindingSha256: sha256(JSON.stringify(roster.binding)),
            createdAtMs: nowMs,
          });
          db.prepare(
            `INSERT INTO main.hosted_lifecycle_run_reservations
          (run_id, deployment_id, actor_id, boot_id, team_id, expected_revision, command_id,
           idempotency_key, promotion_operation_id, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            reservation.runId,
            reservation.deploymentId,
            reservation.actorId,
            reservation.bootId,
            reservation.teamId,
            reservation.expectedRevision,
            reservation.commandId,
            reservation.idempotencyKey,
            reservation.promotionOperationId,
            JSON.stringify(reservation)
          );
          const inserted = db
            .prepare(
              `SELECT ${COLUMNS} FROM main.hosted_lifecycle_run_reservations
          WHERE run_id = ?`
            )
            .get(reservation.runId) as Row | undefined;
          if (!inserted || !isDeepStrictEqual(readRow(inserted), reservation)) {
            throw new Error('hosted-run-reservation-commit-corrupt');
          }
          return { kind: 'reserved', reservation };
        })
        .immediate();
    } finally {
      retained?.release();
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readRow(row: Row): HostedLifecycleRunReservation {
  if (Buffer.byteLength(row.record_json, 'utf8') > 16 * 1024) {
    throw new Error('hosted-run-reservation-record-too-large');
  }
  const record = parseHostedLifecycleRunReservation(JSON.parse(row.record_json));
  if (
    record.runId !== row.run_id ||
    record.deploymentId !== row.deployment_id ||
    record.actorId !== row.actor_id ||
    record.bootId !== row.boot_id ||
    record.teamId !== row.team_id ||
    record.expectedRevision !== row.expected_revision ||
    record.commandId !== row.command_id ||
    record.idempotencyKey !== row.idempotency_key ||
    record.promotionOperationId !== row.promotion_operation_id
  ) {
    throw new Error('hosted-run-reservation-index-binding-corrupt');
  }
  return record;
}
