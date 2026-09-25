import { createHash } from 'node:crypto';

import { HostedLifecycleCurrentAuthorityOps } from './hostedLifecycleCurrentAuthorityOps';
import { HostedLifecycleRunReservationOps } from './hostedLifecycleRunReservationOps';
import { HostedPromotionStorageOps } from './hostedPromotionStorageOps';

import type { HostedLifecycleAuthorityEpoch } from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type { RunId } from '@shared/contracts/hosted';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

export interface HostedTaskAssignmentMemberCurrencyInput {
  readonly runId: RunId;
  readonly teamId: string;
  readonly memberId: string;
  /** The eligible run's own binding, already confirmed current by the caller. */
  readonly binding: HostedLifecycleAuthorityEpoch;
}

/** Member (M) currency: only asked when an eligible run exists in the caller's own epoch.
 * A stopped command (no eligible run) is not this class's concern; Product falls back to the
 * frozen file roster (resolveActiveMember) the same way the desktop mutation authority does.
 */
export class HostedTaskAssignmentMemberCurrency {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  resolveEligibleMember(input: HostedTaskAssignmentMemberCurrencyInput): boolean {
    const reservation = new HostedLifecycleRunReservationOps(
      this.database,
      this.now,
      this.commitAuthority
    ).lookup(input.runId);
    if (!reservation || reservation.teamId !== input.teamId) return false;
    if (
      !new HostedLifecycleCurrentAuthorityOps(
        this.database,
        this.now,
        this.commitAuthority
      ).memberIsCurrent({ runId: input.runId, memberId: input.memberId, binding: input.binding })
    )
      return false;
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
    return !!(
      promotion &&
      promotion.state === 'frozen' &&
      promotion.planSha256 === reservation.planSha256 &&
      promotion.planGeneration === reservation.expectedPlanGeneration &&
      roster?.kind === 'found' &&
      createHash('sha256').update(JSON.stringify(roster.binding)).digest('hex') ===
        reservation.rosterBindingSha256 &&
      roster.binding.lanes.some((lane) =>
        lane.members.some((member) => member.memberId === input.memberId)
      )
    );
  }
}
