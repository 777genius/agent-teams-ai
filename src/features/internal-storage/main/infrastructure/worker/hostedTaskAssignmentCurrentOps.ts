import { isDeepStrictEqual } from 'node:util';

import { parseWorkspaceId } from '@shared/contracts/hosted';

import {
  type HostedTaskAssignmentCurrentPin,
  parseHostedTaskAssignmentCurrentSelector,
} from '../../../contracts/hostedTaskAssignmentCurrentContracts';

import { HostedLifecycleCurrentAuthorityOps } from './hostedLifecycleCurrentAuthorityOps';
import { HostedProductTaskWriterCurrency } from './hostedProductTaskWriterCurrency';
import { HostedTaskAssignmentMemberCurrency } from './hostedTaskAssignmentMemberCurrency';

import type {
  HostedLifecycleAuthorityEpoch,
  HostedLifecycleCurrentRun,
} from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

function sameWriterEpoch(
  run: HostedLifecycleCurrentRun,
  epoch: HostedLifecycleAuthorityEpoch
): boolean {
  const { runId: ignoredRunId, teamId: ignoredTeamId, state: ignoredState, ...runEpoch } = run;
  void ignoredRunId;
  void ignoredTeamId;
  void ignoredState;
  return isDeepStrictEqual(runEpoch, epoch);
}

/** One Product BEGIN IMMEDIATE decision, layering Writer (W), Team (T), Requester (R) and,
 * for member-target commands only, Member (M) currency. See docs/team-management for the
 * split-brain rationale: a stale or hung deployment must never silently commit a task write.
 */
export class HostedTaskAssignmentCurrentOps {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  /** Callers must already hold Product's global task-write authority lock (the same lock v35
   * authority mutations take): an admitted decision may claim the writer epoch, so it must be
   * ordered with every other authority transition and with the task-file write it guards.
   */
  resolve(value: unknown): HostedTaskAssignmentCurrentPin | null {
    const input = parseHostedTaskAssignmentCurrentSelector(value);
    const db = this.database();
    if (db.inTransaction) throw new Error('hosted-task-assignment-nested-transaction-rejected');
    let retained: { release(): void } | undefined;
    try {
      return db
        .transaction((): HostedTaskAssignmentCurrentPin | null => {
          const writer = new HostedProductTaskWriterCurrency(
            this.database,
            this.now,
            this.commitAuthority
          );
          const writerDecision = writer.classify(input.writerEpoch);
          if (writerDecision === 'superseded') return null;
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
              input.requester.workspaceId,
              input.teamId,
              input.requester.actorId,
              input.deploymentId
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
            !publication ||
            !identity ||
            identity.state !== 'active' ||
            identity.legacyKey !== publication.legacyKey ||
            identity.directoryFingerprint !== publication.directoryFingerprint ||
            identity.workspaceId !== publication.runtimeWorkspaceId ||
            identity.bindingGeneration !== publication.bindingGeneration ||
            identity.adoptionIntentId !== publication.operationId ||
            identity.identityChecksum !== input.identityChecksum
          )
            return null;
          const authority = this.commitAuthority();
          const retainForTaskWrite = authority?.retainForTaskWrite;
          if (!retainForTaskWrite) return null;
          try {
            retained = retainForTaskWrite({
              deploymentId: input.deploymentId,
              workspaceId: input.requester.workspaceId,
              runtimeWorkspaceId: parseWorkspaceId(publication.runtimeWorkspaceId),
              actorId: input.requester.actorId,
              userId: input.requester.userId,
              sessionId: input.requester.sessionId,
              grantRevision: input.requester.grantRevision,
              grantGeneration: input.requester.grantGeneration,
            });
          } catch {
            return null;
          }
          if (!retained || typeof retained.release !== 'function')
            throw new Error('hosted-task-assignment-retention-invalid');
          const teamRun = new HostedLifecycleCurrentAuthorityOps(
            this.database,
            this.now,
            this.commitAuthority
          ).lookupTeamRun({ deploymentId: input.deploymentId, teamId: input.teamId });
          const eligibleInOurEpoch =
            !!teamRun &&
            teamRun.state === 'eligible' &&
            sameWriterEpoch(teamRun, input.writerEpoch);
          if (input.target.kind === 'member') {
            if (teamRun && !eligibleInOurEpoch) return null;
            if (eligibleInOurEpoch) {
              const admitted = new HostedTaskAssignmentMemberCurrency(
                this.database,
                this.now,
                this.commitAuthority
              ).resolveEligibleMember({
                runId: teamRun!.runId,
                teamId: input.teamId,
                memberId: input.target.memberId,
                binding: input.writerEpoch,
              });
              if (!admitted) return null;
            }
            // No eligible run at all: the command was stopped. Product falls back to the
            // frozen file roster (resolveActiveMember) outside this SQL decision.
          }
          // Claim last, so a denied T/R/M decision leaves the authority row untouched. A claimable
          // epoch has no runs of its own yet, so the decisions above do not depend on the claim.
          if (writerDecision === 'claimable' && !writer.claim(input.writerEpoch)) return null;
          return Object.freeze({
            runId: eligibleInOurEpoch ? teamRun!.runId : null,
            ...input.writerEpoch,
          });
        })
        .immediate();
    } finally {
      retained?.release();
    }
  }
}
