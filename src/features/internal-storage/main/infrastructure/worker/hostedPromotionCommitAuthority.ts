import { createHash } from 'node:crypto';

import type { HostedTaskWriteCommitEvidence } from '../../../contracts/hostedTaskAssignmentCurrentContracts';
import type { HostedPromotionBegin } from '../../../contracts/hostedPromotionStorageContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

/** Immutable launcher-admitted mount and current restore generation for this dedicated worker.
 * Hosted Core v1 treats mount replacement/revocation as a process restart: the worker and its
 * binding are torn down with that process. In-process mount revocation would need a retained
 * cross-thread capability serialized with this transaction before promotion can remain enabled.
 */
export interface HostedPromotionCommitBinding {
  readonly deploymentId: string;
  readonly runtimeWorkspaceId: string;
  readonly admittedWorkspaceRoot: string;
  readonly restoreGeneration: number;
}

interface RequesterEvidence {
  readonly userId: string;
  readonly sessionId: string;
  readonly grantRevision: string;
  readonly grantGeneration: number;
}

interface RequesterScope {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly runtimeWorkspaceId: string;
}

/** Called only after BEGIN IMMEDIATE. All auth revokers write this same SQLite database. */
export function createHostedPromotionCommitAuthority(
  db: () => Database,
  binding: HostedPromotionCommitBinding,
  now: () => number
): HostedPromotionCommitAuthority {
  // Shared body for every Product writer: match the authenticated query-context actor
  // projection from the durable user id, then re-check the live grant and session/role under
  // the same IMMEDIATE lock that every relevant revoker must serialize with.
  function assertRequesterEvidenceCurrent(
    database: Database,
    evidence: RequesterEvidence,
    scope: RequesterScope
  ): void {
    const domain = Buffer.from('agent-teams/hosted-query-context/actor/v1');
    const user = Buffer.from(evidence.userId);
    const frame = Buffer.allocUnsafe(8 + domain.length + user.length);
    frame.writeUInt32BE(domain.length, 0);
    domain.copy(frame, 4);
    frame.writeUInt32BE(user.length, 4 + domain.length);
    user.copy(frame, 8 + domain.length);
    if (scope.actorId !== `actor_${createHash('sha256').update(frame).digest('hex')}`) {
      throw new Error('promotion-commit-actor-mismatch');
    }
    const grant = database
      .prepare(
        `SELECT grants.grant_revision AS revision
        FROM hosted_workspace_grants grants
        JOIN hosted_workspaces workspaces ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
        JOIN users ON users.user_id = grants.user_id
        WHERE grants.user_id = ? AND grants.runtime_workspace_id = ? AND
          grants.grant_generation = ? AND workspaces.public_workspace_id = ? AND
          workspaces.status = 'active' AND users.status = 'active'`
      )
      .get(
        evidence.userId,
        scope.runtimeWorkspaceId,
        evidence.grantGeneration,
        scope.workspaceId
      ) as { revision: string } | undefined;
    if (grant?.revision !== evidence.grantRevision)
      throw new Error('promotion-commit-grant-revoked');
    const mode = database
      .prepare(
        `SELECT auth_mode AS mode FROM hosted_auth_configuration
        WHERE singleton = 1`
      )
      .get() as { mode: string } | undefined;
    const currentMs = now();
    if (mode?.mode === 'oidc') {
      const session = database
        .prepare(
          `SELECT sessions.status, sessions.idle_expires_at AS idleExpiresAt,
          sessions.absolute_expires_at AS absoluteExpiresAt, roles.role
          FROM operator_sessions sessions JOIN role_snapshots roles ON roles.session_id = sessions.session_id
          WHERE sessions.session_id = ? AND sessions.user_id = ?`
        )
        .get(evidence.sessionId, evidence.userId) as
        | { status: string; idleExpiresAt: number; absoluteExpiresAt: number; role: string }
        | undefined;
      if (
        session?.status !== 'active' ||
        session.idleExpiresAt <= currentMs ||
        session.absoluteExpiresAt <= currentMs ||
        session.role === 'viewer'
      ) {
        throw new Error('promotion-commit-session-revoked');
      }
    } else if (mode?.mode === 'personal') {
      const owner = database
        .prepare(
          `SELECT owners.operator_id AS operatorId FROM personal_owners owners
          JOIN users ON users.user_id = owners.user_id WHERE owners.user_id = ? AND users.status = 'active'
          AND owners.singleton = 1`
        )
        .get(evidence.userId) as { operatorId: string } | undefined;
      const row = database
        .prepare(
          `SELECT state_json AS stateJson FROM hosted_access_authority
          WHERE singleton = 1`
        )
        .get() as { stateJson: string } | undefined;
      if (!owner || !row) throw new Error('promotion-commit-session-revoked');
      const state = JSON.parse(row.stateJson) as {
        operatorId?: unknown;
        binding?: {
          deploymentId?: unknown;
          restoreGeneration?: unknown;
        };
        sessions?: unknown;
        deviceFamilies?: unknown;
        resetIntent?: unknown;
      };
      const session = Array.isArray(state.sessions)
        ? (state.sessions.find(
            (candidate: unknown) =>
              !!candidate &&
              typeof candidate === 'object' &&
              'sessionId' in candidate &&
              candidate.sessionId === evidence.sessionId
          ) as Record<string, unknown> | undefined)
        : undefined;
      const deadlines = session?.deadlines as Record<string, unknown> | undefined;
      const family = Array.isArray(state.deviceFamilies)
        ? (state.deviceFamilies.find(
            (candidate: unknown) =>
              !!candidate &&
              typeof candidate === 'object' &&
              'familyId' in candidate &&
              candidate.familyId === session?.familyId
          ) as Record<string, unknown> | undefined)
        : undefined;
      if (
        state.operatorId !== owner.operatorId ||
        state.binding?.deploymentId !== binding.deploymentId ||
        state.binding.restoreGeneration !== binding.restoreGeneration ||
        state.resetIntent !== null ||
        session?.operatorId !== owner.operatorId ||
        session.status !== 'active' ||
        typeof deadlines?.idleExpiresAt !== 'number' ||
        !Number.isSafeInteger(deadlines.idleExpiresAt) ||
        deadlines.idleExpiresAt <= currentMs ||
        typeof deadlines.absoluteExpiresAt !== 'number' ||
        !Number.isSafeInteger(deadlines.absoluteExpiresAt) ||
        deadlines.absoluteExpiresAt <= currentMs ||
        typeof deadlines.renewalExpiresAt !== 'number' ||
        !Number.isSafeInteger(deadlines.renewalExpiresAt) ||
        deadlines.renewalExpiresAt <= currentMs ||
        family?.operatorId !== owner.operatorId ||
        family.status !== 'active' ||
        typeof family.idleExpiresAt !== 'number' ||
        !Number.isSafeInteger(family.idleExpiresAt) ||
        family.idleExpiresAt <= currentMs ||
        typeof family.absoluteExpiresAt !== 'number' ||
        family.absoluteExpiresAt <= currentMs
      ) {
        throw new Error('promotion-commit-session-revoked');
      }
    } else {
      throw new Error('promotion-commit-auth-mode-unavailable');
    }
  }

  return {
    retainForCommit(input: HostedPromotionBegin) {
      const evidence = input.authorityEvidence;
      if (
        !evidence ||
        input.deploymentId !== binding.deploymentId ||
        input.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
        input.admittedWorkspaceRoot !== binding.admittedWorkspaceRoot ||
        evidence.grantGeneration !== binding.restoreGeneration
      ) {
        throw new Error('promotion-commit-binding-invalid');
      }
      const database = db();
      if (!database.inTransaction) throw new Error('promotion-commit-transaction-required');
      assertRequesterEvidenceCurrent(database, evidence, {
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        runtimeWorkspaceId: input.runtimeWorkspaceId,
      });
      // SQLite's IMMEDIATE write lock serializes every relevant session/grant revoker
      // until the outer transaction commits or rolls back. No async timer releases it.
      return { release() {} };
    },
    retainForTaskWrite(input: HostedTaskWriteCommitEvidence) {
      if (
        input.deploymentId !== binding.deploymentId ||
        input.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
        input.grantGeneration !== binding.restoreGeneration
      ) {
        throw new Error('hosted-task-write-binding-invalid');
      }
      const database = db();
      if (!database.inTransaction) throw new Error('hosted-task-write-transaction-required');
      assertRequesterEvidenceCurrent(database, input, {
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        runtimeWorkspaceId: input.runtimeWorkspaceId,
      });
      return { release() {} };
    },
  };
}
