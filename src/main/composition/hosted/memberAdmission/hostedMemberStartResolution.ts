import { createHash } from 'node:crypto';

import {
  type HostedLifecycleRunReservation,
  parseHostedPromotionRosterBinding,
} from '@features/internal-storage/contracts';
import { parseMemberId, parseRunId } from '@shared/contracts/hosted';

export const MEMBER_START_OPERATION_DOMAIN = 'agent-teams.hosted-opencode-member-start/v1\0';

const PLAN_SHA256 = /^[0-9a-f]{64}$/u;

export function memberStartOperationId(
  runId: string,
  memberId: string,
  planSha256: string
): string {
  parseRunId(runId);
  parseMemberId(memberId);
  if (!PLAN_SHA256.test(planSha256)) throw new TypeError('member-start-plan-sha-invalid');
  return `start_${createHash('sha256')
    .update(MEMBER_START_OPERATION_DOMAIN + JSON.stringify([runId, memberId, planSha256]), 'utf8')
    .digest('hex')}`;
}

/** Selects one member only from the roster cryptographically bound to the reserved run. */
export function resolveFrozenMemberStart(
  reservation: HostedLifecycleRunReservation,
  rosterValue: unknown,
  runId: string,
  memberId: string
): Readonly<{
  operationId: string;
  runId: string;
  memberId: string;
  planSha256: string;
  laneId: string;
  memberName: string;
  memberOrdinal: number;
  model: string;
  promptSha256: string;
}> {
  parseRunId(runId);
  parseMemberId(memberId);
  const roster = parseHostedPromotionRosterBinding(rosterValue);
  if (
    reservation.runId !== runId ||
    reservation.promotionOperationId !== roster.operationId ||
    reservation.planSha256 !== roster.planSha256 ||
    reservation.expectedPlanGeneration !== `plan-generation_${reservation.planSha256}` ||
    createHash('sha256').update(JSON.stringify(roster), 'utf8').digest('hex') !==
      reservation.rosterBindingSha256
  ) {
    throw new Error('member-start-frozen-binding-mismatch');
  }
  const matches = roster.lanes.flatMap((lane) =>
    lane.members
      .filter((member) => member.memberId === memberId)
      .map((member) => ({ lane, member }))
  );
  if (matches.length !== 1) throw new Error('member-start-frozen-member-unavailable');
  const { lane, member } = matches[0];
  return Object.freeze({
    operationId: memberStartOperationId(runId, memberId, reservation.planSha256),
    runId,
    memberId,
    planSha256: reservation.planSha256,
    laneId: lane.laneId,
    memberName: member.name,
    memberOrdinal: member.memberOrdinal,
    model: member.model,
    promptSha256: member.promptSha256,
  });
}
