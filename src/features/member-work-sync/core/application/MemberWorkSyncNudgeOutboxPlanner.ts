import {
  buildMemberWorkSyncNudgeId,
  buildMemberWorkSyncNudgePayloadHash,
  buildMemberWorkSyncOutboxEnsureInput,
} from '../domain';

import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';
import { decideMemberWorkSyncNudgeActivation } from './MemberWorkSyncNudgeActivationPolicy';

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

const STATUS_ONLY_RECOVERY_INTENT_PREFIX = 'status-only';

function getReviewRequestEventIds(status: MemberWorkSyncStatus): string[] {
  return [
    ...new Set(
      status.agenda.items
        .map((item) => item.evidence.reviewRequestEventId?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ].sort();
}

function filterReviewPickupStatusByRequestIds(
  status: MemberWorkSyncStatus,
  reviewRequestEventIds: string[]
): MemberWorkSyncStatus {
  const allowed = new Set(reviewRequestEventIds);
  return {
    ...status,
    agenda: {
      ...status.agenda,
      items: status.agenda.items.filter((item) => {
        const eventId = item.evidence.reviewRequestEventId?.trim();
        return eventId ? allowed.has(eventId) : false;
      }),
    },
  };
}

function isTurnSettledReconcile(status: MemberWorkSyncStatus): boolean {
  return status.shadow?.triggerReasons?.includes('turn_settled') === true;
}

function shouldPlanStatusOnlyRecovery(input: {
  status: MemberWorkSyncStatus;
  baseInput: MemberWorkSyncOutboxEnsureInput;
  existingItemStatus: string;
}): boolean {
  return (
    input.status.state === 'needs_sync' &&
    input.status.shadow?.wouldNudge === true &&
    isTurnSettledReconcile(input.status) &&
    input.baseInput.payload.workSyncIntent === 'agenda_sync' &&
    input.baseInput.payload.workSyncIntentKey === undefined &&
    input.existingItemStatus === 'delivered' &&
    input.status.report?.accepted !== true
  );
}

export interface MemberWorkSyncNudgeOutboxPlanResult {
  planned: boolean;
  code:
    | 'outbox_unavailable'
    | 'metrics_unavailable'
    | 'status_not_nudgeable'
    | 'blocking_metrics'
    | 'phase2_not_ready'
    | 'review_pickup_delivery_unavailable'
    | 'review_pickup_already_delivered_still_stuck'
    | 'review_pickup_delivery_failed_still_stuck'
    | 'created'
    | 'existing'
    | 'payload_conflict';
}

export class MemberWorkSyncNudgeOutboxPlanner {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  private buildStatusOnlyRecoveryInput(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput
  ): MemberWorkSyncOutboxEnsureInput {
    const intentKey = `${STATUS_ONLY_RECOVERY_INTENT_PREFIX}:${status.agenda.fingerprint}`;
    const payload = {
      ...baseInput.payload,
      workSyncIntentKey: intentKey,
      text: [
        'Status-only recovery: the previous work-sync turn appears to have stopped after member_work_sync_status without member_work_sync_report.',
        'You must now call member_work_sync_status again, then member_work_sync_report with the returned agendaFingerprint/reportToken.',
        baseInput.payload.text,
      ].join('\n'),
    };

    return {
      ...baseInput,
      id: buildMemberWorkSyncNudgeId({
        teamName: status.teamName,
        memberName: status.memberName,
        agendaFingerprint: status.agenda.fingerprint,
        intentKey,
      }),
      payload,
      payloadHash: buildMemberWorkSyncNudgePayloadHash(this.deps.hash, payload),
    };
  }

  async plan(status: MemberWorkSyncStatus): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    if (!this.deps.outboxStore) {
      return { planned: false, code: 'outbox_unavailable' };
    }
    if (!this.deps.statusStore.readTeamMetrics) {
      return { planned: false, code: 'metrics_unavailable' };
    }

    let input = buildMemberWorkSyncOutboxEnsureInput({
      status,
      hash: this.deps.hash,
      nowIso: status.evaluatedAt,
    });
    if (!input) {
      return { planned: false, code: 'status_not_nudgeable' };
    }

    const metrics = await this.deps.statusStore.readTeamMetrics(status.teamName);
    const activation = decideMemberWorkSyncNudgeActivation({ status, metrics });
    if (!activation.active) {
      const code =
        activation.reason === 'blocking_metrics'
          ? 'blocking_metrics'
          : activation.reason === 'status_not_nudgeable'
            ? 'status_not_nudgeable'
            : 'phase2_not_ready';
      await this.appendPlanAudit(status, { planned: false, code });
      return { planned: false, code };
    }

    if (input.payload.workSyncIntent === 'review_pickup') {
      const capability = await this.deps.reviewPickupDelivery?.canDeliver({
        teamName: status.teamName,
        memberName: status.memberName,
        providerId: status.providerId,
      });
      if (!capability?.ok) {
        const diagnostics = [
          capability?.reason ?? 'review_pickup_delivery_port_unavailable',
          ...(capability?.diagnostics ?? []),
        ];
        await this.appendReviewPickupDeliveryUnavailableAudit(status, diagnostics);
        const result = {
          planned: false,
          code: 'review_pickup_delivery_unavailable',
        } as const;
        await this.appendPlanAudit(status, result);
        return result;
      }

      const requestedEventIds = input.payload.workSyncReviewRequestEventIds ?? [];
      const deliveredEventIds =
        (await this.deps.outboxStore.findDeliveredReviewPickupRequestEventIds?.({
          teamName: status.teamName,
          memberName: status.memberName,
          reviewRequestEventIds: requestedEventIds,
        })) ?? [];
      if (deliveredEventIds.length > 0) {
        const delivered = new Set(deliveredEventIds);
        const undeliveredEventIds = requestedEventIds.filter((eventId) => !delivered.has(eventId));
        if (undeliveredEventIds.length === 0) {
          const code = 'review_pickup_already_delivered_still_stuck' as const;
          await this.appendReviewPickupEscalationAudit(status, code);
          await this.appendPlanAudit(status, { planned: false, code });
          return { planned: false, code };
        }

        const filteredStatus = filterReviewPickupStatusByRequestIds(status, undeliveredEventIds);
        const filteredInput = buildMemberWorkSyncOutboxEnsureInput({
          status: filteredStatus,
          hash: this.deps.hash,
          nowIso: status.evaluatedAt,
        });
        if (!filteredInput) {
          const code = 'status_not_nudgeable' as const;
          await this.appendPlanAudit(status, { planned: false, code });
          return { planned: false, code };
        }
        input = filteredInput;
      }
    }

    const result = await this.deps.outboxStore.ensurePending(input);
    if (!result.ok) {
      if (input.payload.workSyncIntent === 'review_pickup' && result.item.status === 'delivered') {
        const code = 'review_pickup_already_delivered_still_stuck' as const;
        await this.appendReviewPickupEscalationAudit(status, code);
        await this.appendPlanAudit(status, { planned: false, code });
        return { planned: false, code };
      }
      this.deps.logger?.warn('member work sync nudge outbox payload conflict', {
        teamName: status.teamName,
        memberName: status.memberName,
        outboxId: input.id,
        existingPayloadHash: result.existingPayloadHash,
        requestedPayloadHash: result.requestedPayloadHash,
      });
      await this.appendPlanAudit(status, { planned: false, code: 'payload_conflict' });
      return { planned: false, code: 'payload_conflict' };
    }

    if (input.payload.workSyncIntent === 'review_pickup' && result.item.status === 'delivered') {
      const code = 'review_pickup_already_delivered_still_stuck' as const;
      await this.appendReviewPickupEscalationAudit(status, code);
      await this.appendPlanAudit(status, { planned: false, code });
      return { planned: false, code };
    }
    if (
      shouldPlanStatusOnlyRecovery({
        status,
        baseInput: input,
        existingItemStatus: result.item.status,
      })
    ) {
      const recoveryInput = this.buildStatusOnlyRecoveryInput(status, input);
      const recoveryResult = await this.deps.outboxStore.ensurePending(recoveryInput);
      if (!recoveryResult.ok) {
        this.deps.logger?.warn('member work sync status-only recovery payload conflict', {
          teamName: status.teamName,
          memberName: status.memberName,
          outboxId: recoveryInput.id,
          existingPayloadHash: recoveryResult.existingPayloadHash,
          requestedPayloadHash: recoveryResult.requestedPayloadHash,
        });
        await this.appendPlanAudit(status, { planned: false, code: 'payload_conflict' });
        return { planned: false, code: 'payload_conflict' };
      }

      const recoveryPlanned = recoveryResult.item.status !== 'delivered';
      const recoveryPlanResult = {
        planned: recoveryPlanned,
        code: recoveryResult.outcome,
      } as const;
      await this.appendPlanAudit(status, recoveryPlanResult);
      return recoveryPlanResult;
    }
    if (
      input.payload.workSyncIntent === 'review_pickup' &&
      result.item.status === 'failed_terminal'
    ) {
      const code = 'review_pickup_delivery_failed_still_stuck' as const;
      await this.appendReviewPickupEscalationAudit(status, code);
      await this.appendPlanAudit(status, { planned: false, code });
      return { planned: false, code };
    }

    const planResult = { planned: true, code: result.outcome } as const;
    await this.appendPlanAudit(status, planResult);
    return planResult;
  }

  private async appendReviewPickupEscalationAudit(
    status: MemberWorkSyncStatus,
    reason: string
  ): Promise<void> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: status.teamName,
      memberName: status.memberName,
      event: 'review_pickup_escalated',
      source: 'nudge_planner',
      agendaFingerprint: status.agenda.fingerprint,
      state: status.state,
      actionableCount: status.agenda.items.length,
      reason,
      ...(status.providerId ? { providerId: status.providerId } : {}),
      taskRefs: status.agenda.items.map((item) => ({
        taskId: item.taskId,
        displayId: item.displayId,
        teamName: status.teamName,
      })),
    });
    await this.notifyReviewPickupEscalation(status, reason);
  }

  private async appendReviewPickupDeliveryUnavailableAudit(
    status: MemberWorkSyncStatus,
    diagnostics: string[]
  ): Promise<void> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: status.teamName,
      memberName: status.memberName,
      event: 'review_pickup_delivery_unavailable',
      source: 'nudge_planner',
      agendaFingerprint: status.agenda.fingerprint,
      state: status.state,
      actionableCount: status.agenda.items.length,
      reason: diagnostics[0],
      diagnostics,
      ...(status.providerId ? { providerId: status.providerId } : {}),
      taskRefs: status.agenda.items.map((item) => ({
        taskId: item.taskId,
        displayId: item.displayId,
        teamName: status.teamName,
      })),
    });
    await this.appendReviewPickupEscalationAudit(status, diagnostics[0]);
  }

  private async notifyReviewPickupEscalation(
    status: MemberWorkSyncStatus,
    reason: string
  ): Promise<void> {
    const escalation = this.deps.reviewPickupEscalation;
    if (!escalation) {
      return;
    }

    try {
      await escalation.escalate({
        teamName: status.teamName,
        memberName: status.memberName,
        reason,
        nowIso: status.evaluatedAt,
        agendaFingerprint: status.agenda.fingerprint,
        reviewRequestEventIds: getReviewRequestEventIds(status),
        diagnostics: status.diagnostics,
        taskRefs: status.agenda.items.map((item) => ({
          taskId: item.taskId,
          displayId: item.displayId,
          teamName: status.teamName,
        })),
      });
    } catch (error) {
      this.deps.logger?.warn('member work sync review pickup escalation failed', {
        teamName: status.teamName,
        memberName: status.memberName,
        reason,
        error: String(error),
      });
    }
  }

  private async appendPlanAudit(
    status: MemberWorkSyncStatus,
    result: MemberWorkSyncNudgeOutboxPlanResult
  ): Promise<void> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: status.teamName,
      memberName: status.memberName,
      event: result.planned ? 'nudge_planned' : 'nudge_skipped',
      source: 'nudge_planner',
      agendaFingerprint: status.agenda.fingerprint,
      state: status.state,
      actionableCount: status.agenda.items.length,
      reason: result.code,
      ...(status.providerId ? { providerId: status.providerId } : {}),
      taskRefs: status.agenda.items.map((item) => ({
        taskId: item.taskId,
        displayId: item.displayId,
        teamName: status.teamName,
      })),
    });
  }
}
