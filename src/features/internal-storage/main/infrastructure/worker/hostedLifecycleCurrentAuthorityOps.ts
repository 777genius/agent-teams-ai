import { isDeepStrictEqual } from 'node:util';

import { parseDeploymentId, parseRunId } from '@shared/contracts/hosted';

import {
  parseHostedLifecycleCurrentAuthority,
  parseHostedLifecycleCurrentRun,
  parseHostedLifecycleCurrentTeamSelector,
  parseHostedLifecycleEpochUpdate,
  parseHostedLifecycleMemberRetirement,
  parseHostedLifecycleRunStateChange,
} from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';

import { HostedLifecycleRunReservationOps } from './hostedLifecycleRunReservationOps';
import { HostedPromotionStorageOps } from './hostedPromotionStorageOps';

import type {
  HostedLifecycleAuthorityEpoch,
  HostedLifecycleCurrentAuthority,
  HostedLifecycleCurrentMutationResult,
  HostedLifecycleCurrentRun,
  HostedLifecycleRunStateChange,
} from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedLifecycleRunReservation } from '../../../contracts/hostedLifecycleRunReservationContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;
type RunState = 'eligible' | 'cleanup_pending' | 'retired';
interface RunRow {
  runId: string;
  deploymentId: string;
  bootId: string;
  teamId: string;
  ownerAuthority: string;
  ownerGeneration: number;
  ownerSessionId: string;
  restoreGeneration: number;
  mountGeneration: number;
  state: RunState;
}
const AUTHORITY_COLUMNS = `deployment_id AS deploymentId, boot_id AS bootId,
  owner_authority AS ownerAuthority, owner_generation AS ownerGeneration,
  owner_session_id AS ownerSessionId, restore_generation AS restoreGeneration,
  mount_generation AS mountGeneration, revision, state`;
const RUN_COLUMNS = `run_id AS runId, deployment_id AS deploymentId, boot_id AS bootId,
  team_id AS teamId, owner_authority AS ownerAuthority,
  owner_generation AS ownerGeneration, owner_session_id AS ownerSessionId,
  restore_generation AS restoreGeneration, mount_generation AS mountGeneration, state`;

function sameEpoch(a: HostedLifecycleAuthorityEpoch, b: HostedLifecycleAuthorityEpoch): boolean {
  return isDeepStrictEqual(a, b);
}
function epochOf(row: HostedLifecycleCurrentAuthority): HostedLifecycleAuthorityEpoch {
  const { revision: ignoredRevision, state: ignoredState, ...epoch } = row;
  void ignoredRevision;
  void ignoredState;
  return epoch;
}
function sameRunEpoch(row: RunRow, binding: HostedLifecycleAuthorityEpoch): boolean {
  return (
    row.deploymentId === binding.deploymentId &&
    row.bootId === binding.bootId &&
    row.ownerAuthority === binding.ownerAuthority &&
    row.ownerGeneration === binding.ownerGeneration &&
    row.ownerSessionId === binding.ownerSessionId &&
    row.restoreGeneration === binding.restoreGeneration &&
    row.mountGeneration === binding.mountGeneration
  );
}
function sameReservationEpoch(
  reservation: HostedLifecycleRunReservation,
  binding: HostedLifecycleAuthorityEpoch
): boolean {
  return (
    reservation.deploymentId === binding.deploymentId &&
    reservation.bootId === binding.bootId &&
    reservation.ownerAuthority === binding.ownerAuthority &&
    reservation.ownerGeneration === binding.ownerGeneration &&
    reservation.ownerSessionId === binding.ownerSessionId &&
    reservation.restoreGeneration === binding.restoreGeneration &&
    reservation.mountGeneration === binding.mountGeneration
  );
}

/** Private Product authority state. Every state transition serializes with member resolution. */
export class HostedLifecycleCurrentAuthorityOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  lookupAuthority(value: unknown): HostedLifecycleCurrentAuthority | null {
    const deploymentId = parseDeploymentId(value);
    const row = this.database()
      .prepare(
        `SELECT ${AUTHORITY_COLUMNS} FROM main.hosted_lifecycle_deployment_authorities WHERE deployment_id = ?`
      )
      .get(deploymentId);
    return row ? parseHostedLifecycleCurrentAuthority(row) : null;
  }

  lookupRun(value: unknown): HostedLifecycleCurrentRun | null {
    const row = this.runRow(parseRunId(value));
    return row ? parseHostedLifecycleCurrentRun(row) : null;
  }

  lookupTeamRun(value: unknown): HostedLifecycleCurrentRun | null {
    const selector = parseHostedLifecycleCurrentTeamSelector(value);
    const row = this.database()
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM main.hosted_lifecycle_current_runs
      WHERE deployment_id = ? AND team_id = ? AND state != 'retired'`
      )
      .get(selector.deploymentId, selector.teamId);
    return row ? parseHostedLifecycleCurrentRun(row) : null;
  }

  setCurrentAuthority(value: unknown): HostedLifecycleCurrentMutationResult {
    const input = parseHostedLifecycleEpochUpdate(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    return db
      .transaction((): HostedLifecycleCurrentMutationResult => {
        const previous = this.lookupAuthority(input.binding.deploymentId);
        if (!previous) {
          if (input.expectedRevision !== null) return { kind: 'conflict' };
          return { kind: 'applied', revision: this.publishEpochInTransaction(null, input.binding) };
        }
        if (sameEpoch(epochOf(previous), input.binding)) {
          return previous.state === 'active'
            ? { kind: 'idempotent_replay', revision: previous.revision }
            : { kind: 'conflict' };
        }
        if (
          input.expectedRevision !== previous.revision ||
          input.binding.ownerGeneration <= previous.ownerGeneration ||
          input.binding.ownerAuthority !== previous.ownerAuthority
        )
          return { kind: 'conflict' };
        return {
          kind: 'applied',
          revision: this.publishEpochInTransaction(previous, input.binding),
        };
      })
      .immediate();
  }

  /**
   * Publishes `binding` as the active epoch inside the caller's BEGIN IMMEDIATE, fencing every
   * eligible run of the predecessor. The caller has already admitted the transition: no row, or
   * an older generation of the same Owner authority. Returns the new revision.
   */
  publishEpochInTransaction(
    previous: HostedLifecycleCurrentAuthority | null,
    binding: HostedLifecycleAuthorityEpoch
  ): number {
    const db = this.database();
    if (!db.inTransaction) throw new Error('hosted-lifecycle-current-transaction-required');
    if (!previous) {
      db.prepare(
        `INSERT INTO main.hosted_lifecycle_deployment_authorities
      (deployment_id, boot_id, owner_authority, owner_generation, owner_session_id,
       restore_generation, mount_generation, revision, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active')`
      ).run(
        binding.deploymentId,
        binding.bootId,
        binding.ownerAuthority,
        binding.ownerGeneration,
        binding.ownerSessionId,
        binding.restoreGeneration,
        binding.mountGeneration
      );
      return 1;
    }
    db.prepare(
      `UPDATE main.hosted_lifecycle_current_runs SET state = 'cleanup_pending'
    WHERE deployment_id = ? AND state = 'eligible'`
    ).run(binding.deploymentId);
    db.prepare(
      `UPDATE main.hosted_lifecycle_deployment_authorities SET
    boot_id = ?, owner_authority = ?, owner_generation = ?, owner_session_id = ?,
    restore_generation = ?, mount_generation = ?, revision = revision + 1, state = 'active'
    WHERE deployment_id = ?`
    ).run(
      binding.bootId,
      binding.ownerAuthority,
      binding.ownerGeneration,
      binding.ownerSessionId,
      binding.restoreGeneration,
      binding.mountGeneration,
      binding.deploymentId
    );
    return previous.revision + 1;
  }

  /** A null revision fences an exact lost Owner epoch even before its first launch publishes it. */
  retireAuthority(value: unknown): HostedLifecycleCurrentMutationResult {
    const input = parseHostedLifecycleEpochUpdate(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    return db
      .transaction((): HostedLifecycleCurrentMutationResult => {
        const previous = this.lookupAuthority(input.binding.deploymentId);
        if (!previous) {
          if (input.expectedRevision !== null) return { kind: 'conflict' };
          db.prepare(
            `INSERT INTO main.hosted_lifecycle_deployment_authorities
          (deployment_id, boot_id, owner_authority, owner_generation, owner_session_id,
           restore_generation, mount_generation, revision, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'retired')`
          ).run(
            input.binding.deploymentId,
            input.binding.bootId,
            input.binding.ownerAuthority,
            input.binding.ownerGeneration,
            input.binding.ownerSessionId,
            input.binding.restoreGeneration,
            input.binding.mountGeneration
          );
          return { kind: 'applied', revision: 1 };
        }
        if (!sameEpoch(epochOf(previous), input.binding)) {
          if (
            input.expectedRevision !== null ||
            input.binding.ownerAuthority !== previous.ownerAuthority ||
            input.binding.ownerGeneration <= previous.ownerGeneration
          )
            return { kind: 'conflict' };
          db.prepare(
            `UPDATE main.hosted_lifecycle_current_runs SET state = 'cleanup_pending'
          WHERE deployment_id = ? AND state = 'eligible'`
          ).run(input.binding.deploymentId);
          db.prepare(
            `UPDATE main.hosted_lifecycle_deployment_authorities SET
          boot_id = ?, owner_authority = ?, owner_generation = ?, owner_session_id = ?,
          restore_generation = ?, mount_generation = ?, revision = revision + 1, state = 'retired'
          WHERE deployment_id = ?`
          ).run(
            input.binding.bootId,
            input.binding.ownerAuthority,
            input.binding.ownerGeneration,
            input.binding.ownerSessionId,
            input.binding.restoreGeneration,
            input.binding.mountGeneration,
            input.binding.deploymentId
          );
          return { kind: 'applied', revision: previous.revision + 1 };
        }
        if (previous.state === 'retired')
          return { kind: 'idempotent_replay', revision: previous.revision };
        if (input.expectedRevision !== null && input.expectedRevision !== previous.revision)
          return { kind: 'conflict' };
        db.prepare(
          `UPDATE main.hosted_lifecycle_current_runs SET state = 'cleanup_pending'
        WHERE deployment_id = ? AND state = 'eligible'`
        ).run(input.binding.deploymentId);
        db.prepare(
          `UPDATE main.hosted_lifecycle_deployment_authorities SET state = 'retired',
        revision = revision + 1 WHERE deployment_id = ?`
        ).run(input.binding.deploymentId);
        return { kind: 'applied', revision: previous.revision + 1 };
      })
      .immediate();
  }

  activateReservedRun(value: unknown): 'activated' | 'already_current' | 'conflict' {
    const input = parseHostedLifecycleRunStateChange(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    let retained: { release(): void } | undefined;
    try {
      return db
        .transaction((): 'activated' | 'already_current' | 'conflict' => {
          if (!this.currentEpochMatches(input.binding)) return 'conflict';
          const reservation = this.reservations().lookup(input.runId);
          if (!reservation || !sameReservationEpoch(reservation, input.binding)) return 'conflict';
          const prior = this.runRow(input.runId);
          if (
            prior &&
            !(
              prior.state === 'eligible' &&
              prior.teamId === reservation.teamId &&
              sameRunEpoch(prior, input.binding)
            )
          )
            return 'conflict';
          const promotion = new HostedPromotionStorageOps(this.database, this.now).lookup({
            workspaceId: reservation.workspaceId,
            teamId: reservation.teamId,
            actorId: reservation.actorId,
            deploymentId: reservation.deploymentId,
            reference: { operationId: reservation.promotionOperationId },
          });
          const authority = this.commitAuthority();
          if (
            !promotion ||
            !authority ||
            !this.currentProductBinding(
              reservation,
              promotion.createOperationId,
              promotion.bindingGeneration
            )
          )
            return 'conflict';
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
            return 'conflict';
          }
          if (!retained || typeof retained.release !== 'function')
            throw new Error('hosted-lifecycle-current-retention-invalid');
          if (prior) return 'already_current';
          const active = db
            .prepare(
              `SELECT 1 FROM main.hosted_lifecycle_current_runs
          WHERE deployment_id = ? AND team_id = ? AND state != 'retired' LIMIT 1`
            )
            .get(reservation.deploymentId, reservation.teamId);
          if (active) return 'conflict';
          db.prepare(
            `INSERT INTO main.hosted_lifecycle_current_runs
          (run_id, deployment_id, boot_id, team_id, owner_authority, owner_generation,
           owner_session_id, restore_generation, mount_generation, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible')`
          ).run(
            input.runId,
            input.binding.deploymentId,
            input.binding.bootId,
            reservation.teamId,
            input.binding.ownerAuthority,
            input.binding.ownerGeneration,
            input.binding.ownerSessionId,
            input.binding.restoreGeneration,
            input.binding.mountGeneration
          );
          return 'activated';
        })
        .immediate();
    } finally {
      retained?.release();
    }
  }

  /** Fence new member effects before calling Owner stop/cancel. Cleanup remains pending. */
  retireRun(
    value: unknown
  ): 'cleanup_pending' | 'already_pending' | 'already_retired' | 'conflict' {
    const input = parseHostedLifecycleRunStateChange(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    return db
      .transaction((): 'cleanup_pending' | 'already_pending' | 'already_retired' | 'conflict' => {
        const row = this.runRow(input.runId);
        if (!row || !sameRunEpoch(row, input.binding)) return 'conflict';
        if (row.state === 'retired') return 'already_retired';
        if (row.state === 'cleanup_pending') return 'already_pending';
        if (!this.currentEpochMatches(input.binding)) return 'conflict';
        db.prepare(
          `UPDATE main.hosted_lifecycle_current_runs SET state = 'cleanup_pending' WHERE run_id = ?`
        ).run(input.runId);
        return 'cleanup_pending';
      })
      .immediate();
  }

  /** Called only after Product verifies exact settled Owner stop/cancel and observed idle. */
  confirmRunRetired(value: unknown): 'retired' | 'already_retired' | 'conflict' {
    const input = parseHostedLifecycleRunStateChange(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    return db
      .transaction((): 'retired' | 'already_retired' | 'conflict' => {
        const row = this.runRow(input.runId);
        if (!row || !sameRunEpoch(row, input.binding)) return 'conflict';
        if (row.state === 'retired') return 'already_retired';
        if (row.state !== 'cleanup_pending' || !this.currentEpochMatches(input.binding))
          return 'conflict';
        db.prepare(
          `UPDATE main.hosted_lifecycle_current_runs SET state = 'retired' WHERE run_id = ?`
        ).run(input.runId);
        return 'retired';
      })
      .immediate();
  }

  retireMember(value: unknown): 'retired' | 'already_retired' | 'conflict' {
    const input = parseHostedLifecycleMemberRetirement(value);
    const db = this.database();
    this.assertOutsideTransaction(db);
    return db
      .transaction((): 'retired' | 'already_retired' | 'conflict' => {
        const row = this.runRow(input.runId);
        if (!row || !sameRunEpoch(row, input.binding)) return 'conflict';
        const existing = db
          .prepare(
            `SELECT 1 FROM main.hosted_lifecycle_retired_members
        WHERE run_id = ? AND member_id = ?`
          )
          .get(input.runId, input.memberId);
        if (existing) return 'already_retired';
        if (!this.memberInFrozenRoster(input.runId, input.memberId)) return 'conflict';
        db.prepare(
          `INSERT INTO main.hosted_lifecycle_retired_members (run_id, member_id) VALUES (?, ?)`
        ).run(input.runId, input.memberId);
        return 'retired';
      })
      .immediate();
  }

  /** Current exact state check for Product's own member decision, inside its BEGIN IMMEDIATE. */
  memberIsCurrent(input: HostedLifecycleRunStateChange & { memberId: string }): boolean {
    const authority = this.lookupAuthority(input.binding.deploymentId);
    const row = this.runRow(input.runId);
    if (
      !authority ||
      authority.state !== 'active' ||
      !sameEpoch(epochOf(authority), input.binding) ||
      !row ||
      row.state !== 'eligible' ||
      !sameRunEpoch(row, input.binding)
    )
      return false;
    return !this.database()
      .prepare(
        `SELECT 1 FROM main.hosted_lifecycle_retired_members
      WHERE run_id = ? AND member_id = ?`
      )
      .get(input.runId, input.memberId);
  }

  private currentEpochMatches(binding: HostedLifecycleAuthorityEpoch): boolean {
    const authority = this.lookupAuthority(binding.deploymentId);
    return !!authority && authority.state === 'active' && sameEpoch(epochOf(authority), binding);
  }

  private runRow(runId: string): RunRow | null {
    return (
      (this.database()
        .prepare(`SELECT ${RUN_COLUMNS} FROM main.hosted_lifecycle_current_runs WHERE run_id = ?`)
        .get(runId) as RunRow | undefined) ?? null
    );
  }

  private reservations(): HostedLifecycleRunReservationOps {
    return new HostedLifecycleRunReservationOps(this.database, this.now, this.commitAuthority);
  }

  private currentProductBinding(
    reservation: HostedLifecycleRunReservation,
    createOperationId: string,
    bindingGeneration: number
  ): boolean {
    const db = this.database();
    const publication = db
      .prepare(
        `SELECT operation_id AS operationId,
      runtime_workspace_id AS runtimeWorkspaceId, binding_generation AS bindingGeneration,
      legacy_key AS legacyKey, directory_fingerprint AS directoryFingerprint
      FROM main.hosted_team_configuration_publications
      WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ? AND state = 'published'`
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
    if (
      !publication ||
      publication.runtimeWorkspaceId !== reservation.runtimeWorkspaceId ||
      publication.operationId !== createOperationId ||
      publication.bindingGeneration !== bindingGeneration
    )
      return false;
    const identity = db
      .prepare(
        `SELECT state, legacy_key AS legacyKey,
      directory_fingerprint AS directoryFingerprint, workspace_id AS workspaceId,
      workspace_binding_generation AS bindingGeneration, adoption_intent_id AS adoptionIntentId,
      identity_checksum AS identityChecksum FROM main.team_identity_records WHERE team_id = ?`
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
    return (
      !!identity &&
      identity.state === 'active' &&
      identity.legacyKey === publication.legacyKey &&
      identity.directoryFingerprint === publication.directoryFingerprint &&
      identity.workspaceId === reservation.runtimeWorkspaceId &&
      identity.bindingGeneration === publication.bindingGeneration &&
      identity.adoptionIntentId === publication.operationId &&
      identity.identityChecksum === reservation.ownerEffectFence.identityChecksum
    );
  }

  private memberInFrozenRoster(runId: string, memberId: string): boolean {
    const reservation = this.reservations().lookup(runId);
    if (!reservation) return false;
    const roster = new HostedPromotionStorageOps(this.database, this.now).lookupRosterBinding({
      workspaceId: reservation.workspaceId,
      teamId: reservation.teamId,
      actorId: reservation.actorId,
      deploymentId: reservation.deploymentId,
      reference: { operationId: reservation.promotionOperationId },
    });
    return (
      roster?.kind === 'found' &&
      roster.binding.lanes.some((lane) =>
        lane.members.some((member) => member.memberId === memberId)
      )
    );
  }

  private assertOutsideTransaction(db: Database): void {
    if (db.inTransaction) throw new Error('hosted-lifecycle-current-nested-transaction-rejected');
  }
}
