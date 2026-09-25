import { createHash } from 'node:crypto';

import {
  type HostedTaskAssignmentCurrentPin,
  parseHostedTaskAssignmentCurrentSelector,
} from '../../../contracts/hostedTaskAssignmentCurrentContracts';

import { HostedLifecycleCurrentAuthorityOps } from './hostedLifecycleCurrentAuthorityOps';
import { HostedLifecycleRunReservationOps } from './hostedLifecycleRunReservationOps';
import { HostedPromotionStorageOps } from './hostedPromotionStorageOps';

import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

/** One Product BEGIN IMMEDIATE decision, including current Owner, grant, identity and member. */
export class HostedTaskAssignmentCurrentOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  resolve(value: unknown): HostedTaskAssignmentCurrentPin | null {
    const input = parseHostedTaskAssignmentCurrentSelector(value);
    const db = this.database();
    if (db.inTransaction) throw new Error('hosted-task-assignment-nested-transaction-rejected');
    let retained: { release(): void } | undefined;
    try {
      return db
        .transaction((): HostedTaskAssignmentCurrentPin | null => {
          const run = db
            .prepare(
              `SELECT run_id AS runId, boot_id AS bootId, owner_authority AS ownerAuthority,
            owner_generation AS ownerGeneration, owner_session_id AS ownerSessionId,
            restore_generation AS restoreGeneration, mount_generation AS mountGeneration
           FROM main.hosted_lifecycle_current_runs
           WHERE deployment_id = ? AND team_id = ? AND state = 'eligible'`
            )
            .get(input.deploymentId, input.teamId) as
            | {
                runId: string;
                bootId: string;
                ownerAuthority: string;
                ownerGeneration: number;
                ownerSessionId: string;
                restoreGeneration: number;
                mountGeneration: number;
              }
            | undefined;
          if (!run) return null;
          const reservation = new HostedLifecycleRunReservationOps(
            this.database,
            this.now,
            this.commitAuthority
          ).lookup(run.runId);
          if (
            !reservation ||
            reservation.deploymentId !== input.deploymentId ||
            reservation.teamId !== input.teamId ||
            reservation.bootId !== run.bootId ||
            reservation.ownerAuthority !== run.ownerAuthority ||
            reservation.ownerGeneration !== run.ownerGeneration ||
            reservation.ownerSessionId !== run.ownerSessionId ||
            reservation.restoreGeneration !== run.restoreGeneration ||
            reservation.mountGeneration !== run.mountGeneration ||
            reservation.ownerEffectFence.grantRevision !== input.grantRevision ||
            reservation.ownerEffectFence.identityChecksum !== input.identityChecksum
          )
            return null;
          const binding = {
            deploymentId: reservation.deploymentId,
            bootId: reservation.bootId,
            ownerAuthority: reservation.ownerAuthority,
            ownerGeneration: reservation.ownerGeneration,
            ownerSessionId: reservation.ownerSessionId,
            restoreGeneration: reservation.restoreGeneration,
            mountGeneration: reservation.mountGeneration,
          };
          if (
            !new HostedLifecycleCurrentAuthorityOps(
              this.database,
              this.now,
              this.commitAuthority
            ).memberIsCurrent({ runId: reservation.runId, memberId: input.ownerId, binding })
          )
            return null;

          const reference = {
            workspaceId: reservation.workspaceId,
            teamId: reservation.teamId,
            actorId: reservation.actorId,
            deploymentId: reservation.deploymentId,
            reference: { operationId: reservation.promotionOperationId },
          };
          const promotions = new HostedPromotionStorageOps(this.database, this.now);
          const promotion = promotions.lookup(reference);
          const roster = promotions.lookupRosterBinding(reference);
          if (
            !promotion ||
            promotion.state !== 'frozen' ||
            promotion.planSha256 !== reservation.planSha256 ||
            promotion.planGeneration !== reservation.expectedPlanGeneration ||
            roster?.kind !== 'found' ||
            createHash('sha256').update(JSON.stringify(roster.binding)).digest('hex') !==
              reservation.rosterBindingSha256 ||
            !roster.binding.lanes.some((lane) =>
              lane.members.some((member) => member.memberId === input.ownerId)
            )
          )
            return null;
          const publication = db
            .prepare(
              `SELECT operation_id AS operationId, runtime_workspace_id AS runtimeWorkspaceId,
            binding_generation AS bindingGeneration, legacy_key AS legacyKey,
            directory_fingerprint AS directoryFingerprint
           FROM main.hosted_team_configuration_publications
           WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ?
             AND state = 'published'`
            )
            .get(
              reservation.workspaceId,
              reservation.teamId,
              reservation.actorId,
              reservation.deploymentId
            ) as
            | {
                operationId: string;
                runtimeWorkspaceId: string;
                bindingGeneration: number;
                legacyKey: string;
                directoryFingerprint: string;
              }
            | undefined;
          const identity = db
            .prepare(
              `SELECT state, legacy_key AS legacyKey, directory_fingerprint AS directoryFingerprint,
            workspace_id AS workspaceId, workspace_binding_generation AS bindingGeneration,
            adoption_intent_id AS adoptionIntentId, identity_checksum AS identityChecksum
           FROM main.team_identity_records WHERE team_id = ?`
            )
            .get(reservation.teamId) as
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
            !publication ||
            publication.operationId !== promotion.createOperationId ||
            publication.runtimeWorkspaceId !== reservation.runtimeWorkspaceId ||
            publication.bindingGeneration !== promotion.bindingGeneration ||
            !identity ||
            identity.state !== 'active' ||
            identity.legacyKey !== publication.legacyKey ||
            identity.directoryFingerprint !== publication.directoryFingerprint ||
            identity.workspaceId !== reservation.runtimeWorkspaceId ||
            identity.bindingGeneration !== publication.bindingGeneration ||
            identity.adoptionIntentId !== publication.operationId ||
            identity.identityChecksum !== input.identityChecksum
          )
            return null;
          const authority = this.commitAuthority();
          if (!authority) return null;
          try {
            retained = authority.retainForCommit({
              workspaceId: reservation.workspaceId,
              teamId: reservation.teamId,
              actorId: reservation.actorId,
              deploymentId: reservation.deploymentId,
              createOperationId: promotion.createOperationId,
              runtimeWorkspaceId: promotion.runtimeWorkspaceId,
              bindingGeneration: promotion.bindingGeneration,
              expectedRevision: promotion.expectedRevision,
              idempotencyKey: promotion.idempotencyKey,
              admittedWorkspaceRoot: promotion.admittedWorkspaceRoot,
              deadlineAtMs: Number.MAX_SAFE_INTEGER,
              authorityEvidence: {
                userId: reservation.authorityEvidence.userId,
                sessionId: reservation.authorityEvidence.sessionId,
                grantRevision: input.grantRevision,
                grantGeneration: reservation.authorityEvidence.grantGeneration,
              },
            });
          } catch {
            return null;
          }
          if (!retained || typeof retained.release !== 'function')
            throw new Error('hosted-task-assignment-retention-invalid');
          return Object.freeze({
            runId: run.runId,
            deploymentId: input.deploymentId,
            bootId: run.bootId,
            ownerAuthority: run.ownerAuthority,
            ownerGeneration: run.ownerGeneration,
            ownerSessionId: run.ownerSessionId,
            restoreGeneration: run.restoreGeneration,
            mountGeneration: run.mountGeneration,
          });
        })
        .immediate();
    } finally {
      retained?.release();
    }
  }
}
