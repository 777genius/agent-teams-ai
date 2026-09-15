import { buildMemberWorkSyncOutboxEnsureInput } from '../domain';

import { filterReviewPickupStatusByRequestIds } from './MemberWorkSyncNudgeOutboxPlanHelpers';

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

interface ReviewPickupPlanContinue {
  kind: 'continue';
  input: MemberWorkSyncOutboxEnsureInput;
  planStatus: MemberWorkSyncStatus;
}

interface ReviewPickupPlanStop {
  kind: 'stop';
  result: {
    planned: false;
    code:
      | 'review_pickup_delivery_unavailable'
      | 'review_pickup_already_delivered_still_stuck'
      | 'status_not_nudgeable';
  };
}

export async function prepareMemberWorkSyncReviewPickupPlan(input: {
  deps: MemberWorkSyncUseCaseDeps;
  status: MemberWorkSyncStatus;
  ensureInput: MemberWorkSyncOutboxEnsureInput;
  onUnavailable: (diagnostics: string[]) => Promise<void>;
  onAlreadyDelivered: (code: 'review_pickup_already_delivered_still_stuck') => Promise<void>;
  onNotNudgeable: () => Promise<void>;
}): Promise<ReviewPickupPlanContinue | ReviewPickupPlanStop> {
  const capability = await input.deps.reviewPickupDelivery?.canDeliver({
    teamName: input.status.teamName,
    memberName: input.status.memberName,
    providerId: input.status.providerId,
  });
  if (!capability?.ok) {
    const diagnostics = [
      capability?.reason ?? 'review_pickup_delivery_port_unavailable',
      ...(capability?.diagnostics ?? []),
    ];
    await input.onUnavailable(diagnostics);
    return {
      kind: 'stop',
      result: { planned: false, code: 'review_pickup_delivery_unavailable' },
    };
  }

  const requestedEventIds = input.ensureInput.payload.workSyncReviewRequestEventIds ?? [];
  const deliveredEventIds =
    (await input.deps.outboxStore?.findDeliveredReviewPickupRequestEventIds?.({
      teamName: input.status.teamName,
      memberName: input.status.memberName,
      reviewRequestEventIds: requestedEventIds,
    })) ?? [];
  if (deliveredEventIds.length === 0) {
    return { kind: 'continue', input: input.ensureInput, planStatus: input.status };
  }

  const delivered = new Set(deliveredEventIds);
  const undeliveredEventIds = requestedEventIds.filter((eventId) => !delivered.has(eventId));
  if (undeliveredEventIds.length === 0) {
    const code = 'review_pickup_already_delivered_still_stuck' as const;
    await input.onAlreadyDelivered(code);
    return { kind: 'stop', result: { planned: false, code } };
  }

  const planStatus = filterReviewPickupStatusByRequestIds(input.status, undeliveredEventIds);
  const filteredInput = buildMemberWorkSyncOutboxEnsureInput({
    status: planStatus,
    hash: input.deps.hash,
    nowIso: input.status.evaluatedAt,
  });
  if (!filteredInput) {
    await input.onNotNudgeable();
    return { kind: 'stop', result: { planned: false, code: 'status_not_nudgeable' } };
  }
  return { kind: 'continue', input: filteredInput, planStatus };
}
