import { createHash } from 'node:crypto';

import { parseRunId } from '@shared/contracts/hosted';

import { HostedLifecycleRunReservationOps } from './hostedLifecycleRunReservationOps';
import { HostedPromotionStorageOps } from './hostedPromotionStorageOps';

import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

/** A current, point-in-time Product decision. It is not a durable launch permit. */
export interface HostedCurrentMemberAdmission {
  readonly kind: 'admitted';
  readonly runId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly runtimeWorkspaceId: string;
  readonly teamId: string;
  readonly actorId: string;
  readonly memberId: string;
  readonly laneId: string;
  readonly laneOrdinal: number;
  readonly memberOrdinal: number;
  readonly memberName: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly planSha256: string;
  readonly rosterBindingSha256: string;
  readonly promotionOperationId: string;
  readonly grantRevision: string;
  readonly grantGeneration: number;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
}

/** All current authority reads run after BEGIN IMMEDIATE on the Product writer. */
export class HostedCurrentMemberAdmissionOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  resolve(runIdValue: unknown, memberIdValue: unknown): HostedCurrentMemberAdmission | null {
    const runId = parseRunId(runIdValue);
    if (typeof memberIdValue !== 'string' || !/^member_[a-f0-9]{32}$/.test(memberIdValue)) {
      throw new TypeError('hosted-member-id-invalid');
    }
    const memberId = memberIdValue;
    const db = this.database();
    if (db.inTransaction) throw new Error('hosted-member-admission-nested-transaction-rejected');
    let retained: { release(): void } | undefined;
    try {
      return db
        .transaction((): HostedCurrentMemberAdmission | null => {
          const reservation = new HostedLifecycleRunReservationOps(
            this.database,
            this.now,
            this.commitAuthority
          ).lookup(runId);
          if (!reservation) return null;
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
              reservation.rosterBindingSha256
          ) {
            throw new Error('hosted-member-admission-binding-corrupt');
          }
          const found = roster.binding.lanes.flatMap((lane) =>
            lane.members
              .filter((member) => member.memberId === memberId)
              .map((member) => ({ lane, member }))
          );
          if (found.length !== 1) return null;
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
            identity.identityChecksum !== reservation.ownerEffectFence.identityChecksum
          ) {
            return null;
          }
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
                grantRevision: reservation.ownerEffectFence.grantRevision,
                grantGeneration: reservation.authorityEvidence.grantGeneration,
              },
            });
          } catch {
            return null;
          }
          if (!retained || typeof retained.release !== 'function') {
            throw new Error('hosted-member-admission-retention-invalid');
          }
          const { lane, member } = found[0];
          return {
            kind: 'admitted',
            runId: reservation.runId,
            deploymentId: reservation.deploymentId,
            bootId: reservation.bootId,
            workspaceId: reservation.workspaceId,
            runtimeWorkspaceId: reservation.runtimeWorkspaceId,
            teamId: reservation.teamId,
            actorId: reservation.actorId,
            memberId: member.memberId,
            laneId: lane.laneId,
            laneOrdinal: lane.laneOrdinal,
            memberOrdinal: member.memberOrdinal,
            memberName: member.name,
            model: member.model,
            promptSha256: member.promptSha256,
            planSha256: reservation.planSha256,
            rosterBindingSha256: reservation.rosterBindingSha256,
            promotionOperationId: promotion.operationId,
            grantRevision: reservation.ownerEffectFence.grantRevision,
            grantGeneration: reservation.authorityEvidence.grantGeneration,
            restoreGeneration: reservation.restoreGeneration,
            mountGeneration: reservation.mountGeneration,
          };
        })
        .immediate();
    } finally {
      retained?.release();
    }
  }
}
