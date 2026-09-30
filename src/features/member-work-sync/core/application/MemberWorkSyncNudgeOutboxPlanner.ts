import {
  buildMemberWorkSyncNudgeId,
  buildMemberWorkSyncNudgePayloadHash,
  buildMemberWorkSyncOutboxEnsureInput,
  isMemberWorkSyncEarlyContinuationEnabled,
} from '../domain';

import {
  reserveAllocatedMemberWorkSyncRecovery,
  skipMemberWorkSyncRecoveryAllocation,
} from './memberWorkSyncAllocatedRecovery';
import {
  appendMemberWorkSyncAudit,
  buildMemberWorkSyncDeliveryReadinessAuditFields,
} from './MemberWorkSyncAudit';
import {
  hasMemberWorkSyncEarlyContinuationIdentity,
  planMemberWorkSyncEarlyContinuation,
} from './MemberWorkSyncEarlyContinuationPlanner';
import {
  decideMemberWorkSyncNudgeActivation,
  type MemberWorkSyncNudgeActivationReason,
} from './MemberWorkSyncNudgeActivationPolicy';
import {
  AGENDA_SYNC_REFRESH_INTENT_PREFIX,
  DELIVERED_STILL_STUCK_RECOVERY_DELIVERY_WINDOW_MS,
  DELIVERED_STILL_STUCK_RECOVERY_INTENT_PREFIX,
  DELIVERED_STILL_STUCK_RECOVERY_MAX_DELIVERED_PER_WINDOW,
  getDeliveredStillStuckRecoveryBucket,
  getReviewRequestEventIds,
  getTaskProtocolRepairTaskIds,
  isMemberWorkSyncRecoveryAllocationEnabled,
  isOutboxItemAwaitingDelivery,
  shouldPlanAgendaSyncRefreshRecovery,
  shouldPlanStatusOnlyRecovery,
  shouldRepairDeliveredAgendaSyncNudge,
  STATUS_ONLY_RECOVERY_INTENT_PREFIX,
  TASK_PROTOCOL_REPAIR_DELIVERY_WINDOW_MS,
  TASK_PROTOCOL_REPAIR_INTENT_PREFIX,
  TASK_PROTOCOL_REPAIR_MAX_DELIVERED_PER_WINDOW,
} from './MemberWorkSyncNudgeOutboxPlanHelpers';
import {
  parseTime,
  shouldPlanDeliveredStillStuckRecovery,
} from './MemberWorkSyncNudgeRecoveryPolicy';
import { rejectQualifiedAutomaticWorkSyncIfClosed } from './memberWorkSyncQualifiedAutomaticGate';
import { retireMemberWorkSyncRecoveryIntent } from './MemberWorkSyncRecoveryDispatchOutcome';
import { prepareMemberWorkSyncReviewPickupPlan } from './memberWorkSyncReviewPickupPlan';

import type {
  MemberWorkSyncDeliveryReadinessAssessment,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncSettlementTrigger } from './MemberWorkSyncReconciler';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export interface MemberWorkSyncNudgeOutboxPlanResult {
  planned: boolean;
  code:
    | 'outbox_unavailable'
    | 'metrics_unavailable'
    | 'status_not_nudgeable'
    | 'blocking_metrics'
    | 'delivery_not_ready'
    | 'review_pickup_delivery_unavailable'
    | 'review_pickup_already_delivered_still_stuck'
    | 'review_pickup_delivery_failed_still_stuck'
    | 'task_protocol_repair_rate_limited'
    | 'member_busy'
    | 'member_stopped'
    | 'recovery_allocation_disabled'
    | 'early_continuation_disabled'
    | 'early_continuation_rejected'
    | 'slot_occupied'
    | 'created'
    | 'existing'
    | 'payload_conflict';
}

export class MemberWorkSyncNudgeOutboxPlanner {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  private canAllocateRecovery(): boolean {
    return isMemberWorkSyncRecoveryAllocationEnabled(this.deps);
  }

  async planEarlyContinuation(
    status: MemberWorkSyncStatus,
    settlement?: MemberWorkSyncSettlementTrigger
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    const result = await planMemberWorkSyncEarlyContinuation(this.deps, status, settlement);
    await this.appendPlanAudit(status, result);
    return result;
  }

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

  private buildAgendaSyncRefreshRecoveryInput(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput
  ): MemberWorkSyncOutboxEnsureInput {
    const intentKey = `${AGENDA_SYNC_REFRESH_INTENT_PREFIX}:${status.agenda.fingerprint}:${baseInput.payloadHash}`;
    const payload = {
      ...baseInput.payload,
      workSyncIntentKey: intentKey,
      text: [
        'Work sync refresh: the previous work-sync nudge was delivered before the current required report instructions.',
        'Use this latest nudge as the current required sync action.',
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

  private buildDeliveredStillStuckRecoveryInput(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput,
    bucket: string
  ): MemberWorkSyncOutboxEnsureInput {
    const intentKey = `${DELIVERED_STILL_STUCK_RECOVERY_INTENT_PREFIX}:${status.agenda.fingerprint}:${baseInput.payloadHash}:${bucket}`;
    const payload = {
      ...baseInput.payload,
      workSyncIntentKey: intentKey,
      text: [
        'Work sync retry: the previous work-sync nudge for this agenda is still stuck and still no accepted member_work_sync_report exists.',
        'Use this latest nudge as the current required sync action.',
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

  private buildTaskProtocolRepairInput(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput
  ): MemberWorkSyncOutboxEnsureInput {
    const taskIds = getTaskProtocolRepairTaskIds(status);
    const intentKey = `${TASK_PROTOCOL_REPAIR_INTENT_PREFIX}:${status.agenda.fingerprint}:${taskIds.join('+')}`;
    const payload = {
      ...baseInput.payload,
      workSyncIntentKey: intentKey,
      text: [
        'Task protocol repair: your last native Codex turn left this task in_progress without durable board proof.',
        'Do not redo completed file work unless the task is actually unfinished.',
        'If the implementation is done, add a concise result comment with task_add_comment, then call task_complete, then call member_work_sync_status and member_work_sync_report with the current agendaFingerprint/reportToken.',
        'If the task is not done, add a task comment with the current status or blocker, then report still_working or blocked with member_work_sync_report.',
        'If prefixed Agent Teams MCP tool names are exposed, use mcp__agent-teams__task_add_comment, mcp__agent-teams__task_complete, mcp__agent-teams__member_work_sync_status, and mcp__agent-teams__member_work_sync_report.',
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

  private async planStatusOnlyRecovery(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput,
    activationReason?: MemberWorkSyncNudgeActivationReason
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    if (!this.canAllocateRecovery()) {
      return skipMemberWorkSyncRecoveryAllocation({
        status,
        appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
      });
    }
    const outboxStore = this.deps.outboxStore;
    if (!outboxStore) {
      return { planned: false, code: 'outbox_unavailable' };
    }
    const recoveryInput = this.buildStatusOnlyRecoveryInput(status, baseInput);
    const blocked = await reserveAllocatedMemberWorkSyncRecovery({
      deps: this.deps,
      status,
      recoveryInput,
      appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
    });
    if (blocked) {
      return blocked;
    }
    const recoveryResult = await outboxStore.ensurePending(recoveryInput);
    if (!recoveryResult.ok) {
      this.deps.logger?.warn('member work sync status-only recovery payload conflict', {
        teamName: status.teamName,
        memberName: status.memberName,
        outboxId: recoveryInput.id,
        existingPayloadHash: recoveryResult.existingPayloadHash,
        requestedPayloadHash: recoveryResult.requestedPayloadHash,
      });
      return this.rejectReservedPayloadConflict(status, recoveryInput.id);
    }
    await this.repairDeliveredAgendaSyncNudgeIfNeeded(status, recoveryInput, recoveryResult.item);

    if (activationReason) {
      const deliveredStillStuckRecovery = await this.planDeliveredStillStuckRecovery(
        status,
        baseInput,
        recoveryResult.item,
        activationReason
      );
      if (deliveredStillStuckRecovery) {
        return deliveredStillStuckRecovery;
      }
    }

    const recoveryPlanned = isOutboxItemAwaitingDelivery(recoveryResult.item);
    const recoveryPlanResult = {
      planned: recoveryPlanned,
      code: recoveryResult.outcome,
    } as const;
    await this.appendPlanAudit(status, recoveryPlanResult);
    return recoveryPlanResult;
  }

  private async planTaskProtocolRepair(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    if (!this.canAllocateRecovery()) {
      return skipMemberWorkSyncRecoveryAllocation({
        status,
        appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
      });
    }
    const outboxStore = this.deps.outboxStore;
    if (!outboxStore) {
      return { planned: false, code: 'outbox_unavailable' };
    }

    const evaluatedAtMs = parseTime(status.evaluatedAt);
    if (evaluatedAtMs != null) {
      const recentDelivered = await outboxStore.countRecentDelivered({
        teamName: status.teamName,
        memberName: status.memberName,
        sinceIso: new Date(evaluatedAtMs - TASK_PROTOCOL_REPAIR_DELIVERY_WINDOW_MS).toISOString(),
        workSyncIntentKeyPrefix: `${TASK_PROTOCOL_REPAIR_INTENT_PREFIX}:`,
      });
      if (recentDelivered.count >= TASK_PROTOCOL_REPAIR_MAX_DELIVERED_PER_WINDOW) {
        const result = { planned: false, code: 'task_protocol_repair_rate_limited' } as const;
        await this.appendPlanAudit(status, result);
        return result;
      }
    }

    const repairInput = this.buildTaskProtocolRepairInput(status, baseInput);
    const blocked = await reserveAllocatedMemberWorkSyncRecovery({
      deps: this.deps,
      status,
      recoveryInput: repairInput,
      appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
    });
    if (blocked) {
      return blocked;
    }
    const repairResult = await outboxStore.ensurePending(repairInput);
    if (!repairResult.ok) {
      this.deps.logger?.warn('member work sync task protocol repair payload conflict', {
        teamName: status.teamName,
        memberName: status.memberName,
        outboxId: repairInput.id,
        existingPayloadHash: repairResult.existingPayloadHash,
        requestedPayloadHash: repairResult.requestedPayloadHash,
      });
      return this.rejectReservedPayloadConflict(status, repairInput.id);
    }
    await this.repairDeliveredAgendaSyncNudgeIfNeeded(status, repairInput, repairResult.item);

    const result = {
      planned: isOutboxItemAwaitingDelivery(repairResult.item),
      code: repairResult.outcome,
    } as const;
    await this.appendPlanAudit(status, result);
    return result;
  }

  private async planDeliveredStillStuckRecovery(
    status: MemberWorkSyncStatus,
    baseInput: MemberWorkSyncOutboxEnsureInput,
    existingItem: MemberWorkSyncOutboxItem,
    activationReason: MemberWorkSyncNudgeActivationReason
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult | null> {
    const outboxStore = this.deps.outboxStore;
    if (!outboxStore) {
      return { planned: false, code: 'outbox_unavailable' };
    }
    if (
      !shouldPlanDeliveredStillStuckRecovery({
        status,
        baseInput,
        existingItem,
        activationReason,
      })
    ) {
      return null;
    }
    if (!this.canAllocateRecovery()) {
      return skipMemberWorkSyncRecoveryAllocation({
        status,
        appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
      });
    }

    const busy = await this.deps.busySignal?.isBusy({
      teamName: status.teamName,
      memberName: status.memberName,
      nowIso: status.evaluatedAt,
      workSyncIntent: baseInput.payload.workSyncIntent,
      workSyncIntentKey: baseInput.payload.workSyncIntentKey,
      taskRefs: baseInput.payload.taskRefs,
    });
    if (busy?.busy && busy.reason === 'pending_tool_approval') {
      const result = { planned: false, code: 'member_busy' } as const;
      await this.appendPlanAudit(status, result);
      return result;
    }

    const bucket = getDeliveredStillStuckRecoveryBucket(status);
    const evaluatedAtMs = parseTime(status.evaluatedAt);
    if (!bucket || evaluatedAtMs == null) {
      await this.appendPlanAudit(status, { planned: false, code: 'existing' });
      return { planned: false, code: 'existing' };
    }
    const recentDelivered = await outboxStore.countRecentDelivered({
      teamName: status.teamName,
      memberName: status.memberName,
      sinceIso: new Date(
        evaluatedAtMs - DELIVERED_STILL_STUCK_RECOVERY_DELIVERY_WINDOW_MS
      ).toISOString(),
      workSyncIntentKeyPrefix: `${DELIVERED_STILL_STUCK_RECOVERY_INTENT_PREFIX}:`,
    });
    if (recentDelivered.count >= DELIVERED_STILL_STUCK_RECOVERY_MAX_DELIVERED_PER_WINDOW) {
      await this.appendPlanAudit(status, { planned: false, code: 'existing' });
      return { planned: false, code: 'existing' };
    }

    const recoveryInput = this.buildDeliveredStillStuckRecoveryInput(status, baseInput, bucket);
    const blocked = await reserveAllocatedMemberWorkSyncRecovery({
      deps: this.deps,
      status,
      recoveryInput,
      appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
    });
    if (blocked) {
      return blocked;
    }
    const recoveryResult = await outboxStore.ensurePending(recoveryInput);
    if (!recoveryResult.ok) {
      this.deps.logger?.warn('member work sync delivered-still-stuck recovery payload conflict', {
        teamName: status.teamName,
        memberName: status.memberName,
        outboxId: recoveryInput.id,
        existingPayloadHash: recoveryResult.existingPayloadHash,
        requestedPayloadHash: recoveryResult.requestedPayloadHash,
      });
      return this.rejectReservedPayloadConflict(status, recoveryInput.id);
    }
    await this.repairDeliveredAgendaSyncNudgeIfNeeded(status, recoveryInput, recoveryResult.item);

    const recoveryPlanned = isOutboxItemAwaitingDelivery(recoveryResult.item);
    const recoveryPlanResult = {
      planned: recoveryPlanned,
      code: recoveryResult.outcome,
    } as const;
    await this.appendPlanAudit(status, recoveryPlanResult);
    return recoveryPlanResult;
  }

  async plan(
    status: MemberWorkSyncStatus,
    settlement?: MemberWorkSyncSettlementTrigger
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    if (!this.deps.outboxStore) {
      return { planned: false, code: 'outbox_unavailable' };
    }
    if (!this.deps.statusStore.readTeamMetrics) {
      return { planned: false, code: 'metrics_unavailable' };
    }

    if (
      hasMemberWorkSyncEarlyContinuationIdentity(settlement) &&
      isMemberWorkSyncEarlyContinuationEnabled(this.deps)
    ) {
      const early = await this.planEarlyContinuation(status, settlement);
      if (early.code !== 'early_continuation_disabled') {
        return early;
      }
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
            : 'delivery_not_ready';
      await this.appendPlanAudit(status, { planned: false, code }, metrics.deliveryReadiness);
      return { planned: false, code };
    }

    if (status.recoveryHealth?.autoResumeStopLatch) {
      const result = { planned: false, code: 'member_stopped' } as const;
      await this.appendPlanAudit(status, result);
      return result;
    }

    const closed = await rejectQualifiedAutomaticWorkSyncIfClosed(this.deps, status);
    if (closed) {
      await this.appendPlanAudit(status, closed);
      return closed;
    }

    if (input.payload.workSyncIntent === 'review_pickup') {
      const prepared = await prepareMemberWorkSyncReviewPickupPlan({
        deps: this.deps,
        status,
        ensureInput: input,
        onUnavailable: (diagnostics) =>
          this.appendReviewPickupDeliveryUnavailableAudit(status, diagnostics),
        onAlreadyDelivered: (code) =>
          this.appendReviewPickupEscalationAudit(status, code).then(() =>
            this.appendPlanAudit(status, { planned: false, code })
          ),
        onNotNudgeable: () =>
          this.appendPlanAudit(status, { planned: false, code: 'status_not_nudgeable' }),
      });
      if (prepared.kind === 'stop') {
        if (prepared.result.code === 'review_pickup_delivery_unavailable') {
          await this.appendPlanAudit(status, prepared.result);
        }
        return prepared.result;
      }
      input = prepared.input;
    }

    if (activation.reason === 'native_task_protocol_repair') {
      return this.planTaskProtocolRepair(status, input);
    }

    const result = await this.deps.outboxStore.ensurePending(input);
    if (!result.ok) {
      if (input.payload.workSyncIntent === 'review_pickup' && result.item.status === 'delivered') {
        const code = 'review_pickup_already_delivered_still_stuck' as const;
        await this.appendReviewPickupEscalationAudit(status, code);
        await this.appendPlanAudit(status, { planned: false, code });
        return { planned: false, code };
      }
      if (
        shouldPlanAgendaSyncRefreshRecovery({
          status,
          baseInput: input,
          existingItem: result.item,
        })
      ) {
        if (!this.canAllocateRecovery()) {
          return skipMemberWorkSyncRecoveryAllocation({
            status,
            appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
          });
        }
        const recoveryInput = this.buildAgendaSyncRefreshRecoveryInput(status, input);
        const blocked = await reserveAllocatedMemberWorkSyncRecovery({
          deps: this.deps,
          status,
          recoveryInput,
          appendPlanAudit: (current, result) => this.appendPlanAudit(current, result),
        });
        if (blocked) {
          return blocked;
        }
        const recoveryResult = await this.deps.outboxStore.ensurePending(recoveryInput);
        if (!recoveryResult.ok) {
          this.deps.logger?.warn('member work sync agenda-sync refresh payload conflict', {
            teamName: status.teamName,
            memberName: status.memberName,
            outboxId: recoveryInput.id,
            existingPayloadHash: recoveryResult.existingPayloadHash,
            requestedPayloadHash: recoveryResult.requestedPayloadHash,
          });
          return this.rejectReservedPayloadConflict(status, recoveryInput.id);
        }
        await this.repairDeliveredAgendaSyncNudgeIfNeeded(
          status,
          recoveryInput,
          recoveryResult.item
        );
        if (
          shouldPlanStatusOnlyRecovery({
            status,
            baseInput: input,
            existingItemStatus: recoveryResult.item.status,
          })
        ) {
          return this.planStatusOnlyRecovery(status, input, activation.reason);
        }
        const deliveredStillStuckRecovery = await this.planDeliveredStillStuckRecovery(
          status,
          input,
          recoveryResult.item,
          activation.reason
        );
        if (deliveredStillStuckRecovery) {
          return deliveredStillStuckRecovery;
        }

        const recoveryPlanned = isOutboxItemAwaitingDelivery(recoveryResult.item);
        const recoveryPlanResult = {
          planned: recoveryPlanned,
          code: recoveryResult.outcome,
        } as const;
        await this.appendPlanAudit(status, recoveryPlanResult);
        return recoveryPlanResult;
      }
      const deliveredStillStuckRecovery = await this.planDeliveredStillStuckRecovery(
        status,
        input,
        result.item,
        activation.reason
      );
      if (deliveredStillStuckRecovery) {
        return deliveredStillStuckRecovery;
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
    await this.repairDeliveredAgendaSyncNudgeIfNeeded(status, input, result.item);
    if (
      shouldPlanStatusOnlyRecovery({
        status,
        baseInput: input,
        existingItemStatus: result.item.status,
      })
    ) {
      return this.planStatusOnlyRecovery(status, input, activation.reason);
    }
    const deliveredStillStuckRecovery = await this.planDeliveredStillStuckRecovery(
      status,
      input,
      result.item,
      activation.reason
    );
    if (deliveredStillStuckRecovery) {
      return deliveredStillStuckRecovery;
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

    const planResult = {
      planned: isOutboxItemAwaitingDelivery(result.item),
      code: result.outcome,
    } as const;
    await this.appendPlanAudit(status, planResult);
    return planResult;
  }

  private async repairDeliveredAgendaSyncNudgeIfNeeded(
    status: MemberWorkSyncStatus,
    requestedInput: MemberWorkSyncOutboxEnsureInput,
    existingItem: MemberWorkSyncOutboxItem
  ): Promise<void> {
    const inboxNudge = this.deps.inboxNudge;
    if (
      !inboxNudge?.repairIfPresent ||
      !shouldRepairDeliveredAgendaSyncNudge({ status, requestedInput, existingItem })
    ) {
      return;
    }

    try {
      await inboxNudge.repairIfPresent({
        teamName: status.teamName,
        memberName: status.memberName,
        messageId: existingItem.deliveredMessageId ?? existingItem.id,
        payloadHash: existingItem.payloadHash,
        payload: existingItem.payload,
      });
    } catch (error) {
      this.deps.logger?.warn('member work sync delivered nudge repair failed', {
        teamName: status.teamName,
        memberName: status.memberName,
        outboxId: existingItem.id,
        error: String(error),
      });
    }
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

  private async rejectReservedPayloadConflict(
    status: MemberWorkSyncStatus,
    intentId: string
  ): Promise<MemberWorkSyncNudgeOutboxPlanResult> {
    await retireMemberWorkSyncRecoveryIntent({
      deps: this.deps,
      teamName: status.teamName,
      memberName: status.memberName,
      intentId,
      receiptId: `payload-conflict:${intentId}`,
    });
    await this.appendPlanAudit(status, { planned: false, code: 'payload_conflict' });
    return { planned: false, code: 'payload_conflict' };
  }

  private async appendPlanAudit(
    status: MemberWorkSyncStatus,
    result: MemberWorkSyncNudgeOutboxPlanResult,
    deliveryReadiness?: MemberWorkSyncDeliveryReadinessAssessment
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
      ...buildMemberWorkSyncDeliveryReadinessAuditFields(deliveryReadiness),
      taskRefs: status.agenda.items.map((item) => ({
        taskId: item.taskId,
        displayId: item.displayId,
        teamName: status.teamName,
      })),
    });
  }
}
