import { parseActorId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  exactPublicationRecord,
  parseTeamDraftPublication,
  parseTeamDraftPublicationScope,
  type TeamDraftPublication,
  type TeamDraftPublicationScope,
} from '../../../contracts/teamDraftPublicationContracts';
import { parseDirectoryFingerprint, parseTeamAdoptionIntentId } from '../../../contracts/teamIdentityStorageContracts';

import type DatabaseConstructor from 'better-sqlite3';
type Database = InstanceType<typeof DatabaseConstructor>;

export class TeamDraftPublicationStorageOps {
  constructor(private readonly getDatabase: () => Database, private readonly now: () => number) {}

  lookupOperation(value: unknown): TeamDraftPublication | null {
    const input = exactPublicationRecord(value, ['workspaceId', 'actorId', 'deploymentId', 'reference']);
    const workspaceId = parseWorkspaceId(input.workspaceId);
    const actorId = parseActorId(input.actorId);
    const deploymentId = parseDeploymentId(input.deploymentId);
    const reference = input.reference;
    const byOperation = !!reference && typeof reference === 'object' && Object.hasOwn(reference, 'operationId');
    const key = byOperation ? 'operationId' : 'idempotencyKey';
    const parsed = exactPublicationRecord(reference, [key]);
    const token = byOperation ? parseTeamAdoptionIntentId(parsed[key]) : parsed[key];
    if (typeof token !== 'string' || (!byOperation && !/^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(token))) {
      throw new TypeError('draft-publication-reference-invalid');
    }
    const row = this.getDatabase().prepare(byOperation
      ? `SELECT team_id FROM hosted_team_configuration_publications
         WHERE workspace_id = ? AND operation_id = ? AND actor_id = ? AND deployment_id = ?`
      : `SELECT p.team_id FROM hosted_team_configuration_publications p
         JOIN hosted_team_configuration_create_keys k ON k.team_id = p.team_id AND k.workspace_id = p.workspace_id
         WHERE p.workspace_id = ? AND k.idempotency_key = ? AND p.actor_id = ? AND p.deployment_id = ?`)
      .get(workspaceId, token, actorId, deploymentId) as { team_id: string } | undefined;
    return row ? this.read({ workspaceId, teamId: row.team_id, actorId, deploymentId }) : null;
  }

  read(value: unknown): TeamDraftPublication | null {
    const scope = parseTeamDraftPublicationScope(value);
    return this.lookup(scope);
  }

  settle(value: unknown): TeamDraftPublication {
    const input = exactPublicationRecord(value, ['workspaceId', 'teamId', 'actorId', 'deploymentId',
      'operationId', 'directoryFingerprint', 'state', 'deadlineAtMs']);
    const { workspaceId, teamId, actorId, deploymentId } = input;
    const scope = parseTeamDraftPublicationScope({ workspaceId, teamId, actorId, deploymentId });
    const operationId = parseTeamAdoptionIntentId(input.operationId);
    const fingerprint = input.directoryFingerprint === null ? null : parseDirectoryFingerprint(input.directoryFingerprint);
    if (typeof input.state !== 'string' || !['pending', 'published', 'recovery_required', 'tombstoned'].includes(input.state) ||
        !Number.isSafeInteger(input.deadlineAtMs) || (input.state === 'published' && fingerprint === null)) throw new TypeError('draft-publication-settle-invalid');
    return this.getDatabase().transaction(() => {
      if (this.now() >= (input.deadlineAtMs as number)) throw new Error('draft-publication-deadline');
      const current = this.lookup(scope);
      if (!current || current.operationId !== operationId || current.state === 'tombstoned' ||
          (current.directoryFingerprint !== null && current.directoryFingerprint !== fingerprint)) {
        throw new Error('draft-publication-conflict');
      }
      this.getDatabase().prepare(`UPDATE hosted_team_configuration_publications
        SET directory_fingerprint = ?, state = ? WHERE operation_id = ?`)
        .run(fingerprint, input.state, operationId);
      return this.lookup(scope)!;
    }).immediate();
  }

  private lookup(scope: TeamDraftPublicationScope): TeamDraftPublication | null {
    const row = this.getDatabase().prepare(`SELECT
      operation_id AS operationId, workspace_id AS workspaceId, team_id AS teamId,
      actor_id AS actorId, deployment_id AS deploymentId, runtime_workspace_id AS runtimeWorkspaceId,
      binding_generation AS bindingGeneration, legacy_key AS legacyKey, created_at AS createdAt,
      initial_revision AS initialRevision, directory_fingerprint AS directoryFingerprint, state
      FROM hosted_team_configuration_publications
      WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ?`)
      .get(scope.workspaceId, scope.teamId, scope.actorId, scope.deploymentId);
    return row ? parseTeamDraftPublication(row) : null;
  }
}
