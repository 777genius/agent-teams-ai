import { decideMemberWorkSyncStatus } from '../domain';

import { appendMemberWorkSyncAudit, reasonToAuditEvent } from './MemberWorkSyncAudit';
import { decideMemberWorkSyncNudgeActivation } from './MemberWorkSyncNudgeActivationPolicy';
import { finalizeMemberWorkSyncAgenda } from './MemberWorkSyncReconciler';

import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncAuditEventName, MemberWorkSyncUseCaseDeps } from './ports';

const MEMBER_WORK_SYNC_MAX_NUDGES_PER_MEMBER_PER_HOUR = 2;
const MEMBER_WORK_SYNC_RETRY_BASE_MINUTES = 10;
const MEMBER_WORK_SYNC_RETRY_MAX_MINUTES = 60;

export interface MemberWorkSyncNudgeDispatchSummary {
  claimed: number;
  delivered: number;
  superseded: number;
  retryable: number;
  terminal: number;
}

export interface MemberWorkSyncNudgeDispatchOptions {
  claimedBy: string;
  teamNames: string[];
  limit?: number;
}

function emptySummary(): MemberWorkSyncNudgeDispatchSummary {
  return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function subtractMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

function stableJitterMinutes(id: string, attemptGeneration: number): number {
  const seed = `${id}:${attemptGeneration}`;
  let value = 0;
  for (const char of seed) {
    value = (value * 31 + char.charCodeAt(0)) % 997;
  }
  return value % 5;
}

function nextRetryAt(item: MemberWorkSyncOutboxItem, nowIso: string): string {
  const exponentialMinutes =
    MEMBER_WORK_SYNC_RETRY_BASE_MINUTES * 2 ** Math.max(0, item.attemptGeneration - 1);
  const cappedMinutes = Math.min(MEMBER_WORK_SYNC_RETRY_MAX_MINUTES, exponentialMinutes);
  return addMinutes(nowIso, cappedMinutes + stableJitterMinutes(item.id, item.attemptGeneration));
}

function isReviewPickupOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return item.payload.workSyncIntent === 'review_pickup';
}

function getProofMissingRecoveryOriginalMessageId(item: MemberWorkSyncOutboxItem): string | null {
  const prefix = 'proof-missing:';
  const intentKey = item.payload.workSyncIntentKey?.trim();
  if (!intentKey?.startsWith(prefix)) {
    return null;
  }

  const originalMessageId = intentKey.slice(prefix.length).trim();
  return originalMessageId.length > 0 ? originalMessageId : null;
}

function getPayloadReviewRequestEventIds(item: MemberWorkSyncOutboxItem): string[] {
  return [...new Set(item.payload.workSyncReviewRequestEventIds ?? [])]
    .filter((id) => id.length > 0)
    .sort();
}

function getAgendaReviewPickupRequestEventIds(agenda: MemberWorkSyncAgenda): string[] {
  return [
    ...new Set(
      agenda.items
        .filter(
          (item) =>
            item.kind === 'review' &&
            item.evidence.reviewObligation === 'review_pickup_required' &&
            item.evidence.canBypassPhase2 === true &&
            (item.evidence.reviewDiagnostics?.length ?? 0) === 0
        )
        .map((item) => item.evidence.reviewRequestEventId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ].sort();
}

function reviewPickupRequestIdsStillMatch(
  item: MemberWorkSyncOutboxItem,
  agenda: MemberWorkSyncAgenda
): boolean {
  const payloadIds = getPayloadReviewRequestEventIds(item);
  const agendaIds = getAgendaReviewPickupRequestEventIds(agenda);
  return payloadIds.length > 0 && payloadIds.every((id) => agendaIds.includes(id));
}

export class MemberWorkSyncNudgeDispatcher {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async dispatchDue(
    options: MemberWorkSyncNudgeDispatchOptions
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    const outbox = this.deps.outboxStore;
    const inbox = this.deps.inboxNudge;
    if (!outbox || !inbox) {
      return emptySummary();
    }

    const nowIso = this.deps.clock.now().toISOString();
    const summary = emptySummary();
    for (const teamName of [
      ...new Set(options.teamNames.map((name) => name.trim()).filter(Boolean)),
    ]) {
      const claimed = await outbox.claimDue({
        teamName,
        claimedBy: options.claimedBy,
        nowIso,
        limit: options.limit ?? 10,
      });
      summary.claimed += claimed.length;
      for (const item of claimed) {
        const result = await this.dispatchItem(item, nowIso);
        summary[result] += 1;
      }
    }
    return summary;
  }

  private async dispatchItem(
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): Promise<keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>> {
    const outbox = this.deps.outboxStore;
    const inbox = this.deps.inboxNudge;
    if (!outbox || !inbox) {
      return 'terminal';
    }

    const revalidation = await this.revalidate(item, nowIso);
    if (!revalidation.ok) {
      if (revalidation.retryable) {
        await outbox.markFailed({
          teamName: item.teamName,
          id: item.id,
          attemptGeneration: item.attemptGeneration,
          error: revalidation.reason,
          retryable: true,
          nowIso,
          nextAttemptAt: revalidation.nextAttemptAt ?? nextRetryAt(item, nowIso),
        });
        await this.appendDispatchAudit(
          item,
          reasonToAuditEvent(revalidation.reason),
          revalidation.reason
        );
        return 'retryable';
      }
      if (revalidation.reason.startsWith('review_pickup_delivery_unavailable:')) {
        await this.markReviewPickupDeliveryUnavailable(item, nowIso, revalidation.reason);
        return 'superseded';
      }
      await outbox.markSuperseded({
        teamName: item.teamName,
        id: item.id,
        reason: revalidation.reason,
        nowIso,
      });
      await this.appendDispatchAudit(item, 'nudge_superseded', revalidation.reason);
      return 'superseded';
    }

    try {
      const inserted = await inbox.insertIfAbsent({
        teamName: item.teamName,
        memberName: item.memberName,
        messageId: item.id,
        payloadHash: item.payloadHash,
        payload: item.payload,
        timestamp: nowIso,
      });
      if (inserted.conflict) {
        await outbox.markFailed({
          teamName: item.teamName,
          id: item.id,
          attemptGeneration: item.attemptGeneration,
          error: 'inbox_payload_conflict',
          retryable: false,
          nowIso,
        });
        await this.appendDispatchAudit(item, 'nudge_skipped', 'inbox_payload_conflict');
        return 'terminal';
      }
      if (isReviewPickupOutboxItem(item)) {
        return await this.deliverReviewPickupNudge(
          item,
          inserted.messageId,
          inserted.inserted,
          revalidation.providerId,
          nowIso
        );
      }
      await outbox.markDelivered({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        deliveredMessageId: inserted.messageId,
        nowIso,
      });
      await this.appendDispatchAudit(item, 'nudge_delivered', 'inbox_inserted');
      await this.scheduleDeliveryWake(
        item,
        inserted.messageId,
        inserted.inserted,
        revalidation.providerId
      );
      return 'delivered';
    } catch (error) {
      await outbox.markFailed({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        error: String(error),
        retryable: true,
        nowIso,
        nextAttemptAt: nextRetryAt(item, nowIso),
      });
      await this.appendDispatchAudit(item, 'nudge_retryable', String(error));
      return 'retryable';
    }
  }

  private async deliverReviewPickupNudge(
    item: MemberWorkSyncOutboxItem,
    messageId: string,
    inserted: boolean,
    providerId: MemberWorkSyncStatus['providerId'] | undefined,
    nowIso: string
  ): Promise<keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>> {
    const outbox = this.deps.outboxStore;
    const delivery = this.deps.reviewPickupDelivery;
    if (!outbox || !delivery) {
      await this.markReviewPickupDeliveryUnavailable(
        item,
        nowIso,
        'review_pickup_delivery_port_unavailable'
      );
      return 'superseded';
    }

    const outcome = await delivery.deliver({
      teamName: item.teamName,
      memberName: item.memberName,
      messageId,
      ...(providerId ? { providerId } : {}),
      payload: item.payload,
      inserted,
      nowIso,
    });

    if (outcome.ok) {
      await outbox.markDelivered({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        deliveredMessageId: outcome.messageId,
        deliveryState: outcome.state,
        deliveryDiagnostics: outcome.diagnostics,
        nowIso,
      });
      await this.appendDispatchAudit(item, 'review_pickup_member_nudge_delivered', outcome.state);
      await this.appendDispatchAudit(item, 'nudge_delivered', `review_pickup:${outcome.state}`);
      return 'delivered';
    }

    if (outcome.reason === 'retryable_failure') {
      await outbox.markFailed({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        error: outcome.message,
        retryable: true,
        nowIso,
        nextAttemptAt: outcome.retryAfterIso ?? nextRetryAt(item, nowIso),
      });
      await this.appendDispatchAudit(item, 'review_pickup_wake_failed_retryable', outcome.message);
      return 'retryable';
    }

    if (outcome.reason === 'capability_absent') {
      await this.markReviewPickupDeliveryUnavailable(item, nowIso, outcome.message);
      return 'superseded';
    }

    await outbox.markFailed({
      teamName: item.teamName,
      id: item.id,
      attemptGeneration: item.attemptGeneration,
      error: outcome.message,
      retryable: false,
      nowIso,
    });
    await this.appendDispatchAudit(item, 'nudge_skipped', outcome.message);
    return 'terminal';
  }

  private async markReviewPickupDeliveryUnavailable(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    reason: string
  ): Promise<void> {
    await this.deps.outboxStore?.markSuperseded({
      teamName: item.teamName,
      id: item.id,
      reason,
      nowIso,
    });
    await this.appendDispatchAudit(item, 'review_pickup_delivery_unavailable', reason);
    await this.appendDispatchAudit(item, 'review_pickup_escalated', reason);
    await this.notifyReviewPickupEscalation(item, nowIso, reason);
  }

  private async notifyReviewPickupEscalation(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    reason: string
  ): Promise<void> {
    const escalation = this.deps.reviewPickupEscalation;
    if (!escalation) {
      return;
    }

    try {
      await escalation.escalate({
        teamName: item.teamName,
        memberName: item.memberName,
        reason,
        nowIso,
        agendaFingerprint: item.agendaFingerprint,
        reviewRequestEventIds: getPayloadReviewRequestEventIds(item),
        taskRefs: item.payload.taskRefs,
      });
    } catch (error) {
      this.deps.logger?.warn('member work sync review pickup escalation failed', {
        teamName: item.teamName,
        memberName: item.memberName,
        reason,
        error: String(error),
      });
    }
  }

  private async appendDispatchAudit(
    item: MemberWorkSyncOutboxItem,
    event: MemberWorkSyncAuditEventName,
    reason: string
  ): Promise<void> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: item.teamName,
      memberName: item.memberName,
      event,
      source: 'nudge_dispatcher',
      agendaFingerprint: item.agendaFingerprint,
      reason,
      taskRefs: item.payload.taskRefs,
      messagePreview: item.payload.text,
    });
  }

  private async revalidate(
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): Promise<
    | { ok: true; providerId?: MemberWorkSyncStatus['providerId'] }
    | { ok: false; reason: string; retryable: boolean; nextAttemptAt?: string }
  > {
    const teamActive = this.deps.lifecycle
      ? await this.deps.lifecycle.isTeamActive(item.teamName)
      : true;
    if (!teamActive) {
      return { ok: false, reason: 'team_inactive', retryable: false };
    }

    const previous = await this.deps.statusStore.read({
      teamName: item.teamName,
      memberName: item.memberName,
    });
    if (!previous) {
      return { ok: false, reason: 'status_missing', retryable: false };
    }

    let source;
    try {
      source = await this.deps.agendaSource.loadAgenda({
        teamName: item.teamName,
        memberName: item.memberName,
      });
    } catch (error) {
      return { ok: false, reason: `agenda_revalidation_failed:${String(error)}`, retryable: true };
    }
    const agenda = finalizeMemberWorkSyncAgenda(this.deps, source);
    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: previous.report?.accepted ? previous.report : null,
      nowIso,
      inactive: source.inactive || !teamActive,
    });
    const providerId = source.providerId ?? previous.providerId;
    const revalidatedStatus: MemberWorkSyncStatus = {
      ...previous,
      state: decision.state,
      agenda,
      ...(decision.acceptedReport ? { report: decision.acceptedReport } : {}),
      shadow: {
        ...previous.shadow,
        reconciledBy: previous.shadow?.reconciledBy ?? 'queue',
        wouldNudge: decision.state === 'needs_sync' && agenda.items.length > 0,
        fingerprintChanged:
          Boolean(previous.agenda.fingerprint) &&
          previous.agenda.fingerprint !== agenda.fingerprint,
      },
      evaluatedAt: nowIso,
      diagnostics: [...agenda.diagnostics, ...decision.diagnostics],
      ...(providerId ? { providerId } : {}),
    };
    const agendaStillMatches =
      agenda.fingerprint === item.agendaFingerprint ||
      (isReviewPickupOutboxItem(item) && reviewPickupRequestIdsStillMatch(item, agenda));
    if (decision.state !== 'needs_sync' || agenda.items.length === 0 || !agendaStillMatches) {
      return { ok: false, reason: 'status_no_longer_matches_outbox', retryable: false };
    }

    if (!this.deps.statusStore.readTeamMetrics) {
      return { ok: false, reason: 'metrics_unavailable', retryable: true };
    }
    const metrics = await this.deps.statusStore.readTeamMetrics(item.teamName);
    const activation = decideMemberWorkSyncNudgeActivation({
      status: revalidatedStatus,
      metrics,
    });
    if (!activation.active) {
      const reason =
        activation.reason === 'blocking_metrics'
          ? 'blocking_metrics'
          : activation.reason === 'status_not_nudgeable'
            ? 'status_not_nudgeable'
            : 'phase2_not_ready';
      return { ok: false, reason, retryable: true };
    }

    if (isReviewPickupOutboxItem(item)) {
      const capability = await this.deps.reviewPickupDelivery?.canDeliver({
        teamName: item.teamName,
        memberName: item.memberName,
        providerId,
      });
      if (!capability?.ok) {
        return {
          ok: false,
          reason: `review_pickup_delivery_unavailable:${
            capability?.reason ?? 'delivery_port_unavailable'
          }`,
          retryable: false,
        };
      }
    }

    const proofMissingRecovery = await this.revalidateProofMissingRecovery(item, nowIso);
    if (!proofMissingRecovery.ok) {
      return proofMissingRecovery;
    }

    const recentDelivered = await this.deps.outboxStore?.countRecentDelivered({
      teamName: item.teamName,
      memberName: item.memberName,
      sinceIso: subtractMinutes(nowIso, 60),
    });
    if (
      recentDelivered != null &&
      recentDelivered >= MEMBER_WORK_SYNC_MAX_NUDGES_PER_MEMBER_PER_HOUR
    ) {
      return {
        ok: false,
        reason: 'member_nudge_rate_limited',
        retryable: true,
        nextAttemptAt: addMinutes(nowIso, 60),
      };
    }

    const busy = await this.deps.busySignal?.isBusy({
      teamName: item.teamName,
      memberName: item.memberName,
      nowIso,
      workSyncIntent: item.payload.workSyncIntent,
      workSyncIntentKey: item.payload.workSyncIntentKey,
      taskRefs: item.payload.taskRefs,
    });
    if (busy?.busy) {
      return {
        ok: false,
        reason: `member_busy:${busy.reason ?? 'unknown'}`,
        retryable: true,
        nextAttemptAt: busy.retryAfterIso,
      };
    }

    const taskIds = item.payload.taskRefs.map((taskRef) => taskRef.taskId);
    if (
      this.deps.watchdogCooldown &&
      (await this.deps.watchdogCooldown.hasRecentNudge({
        teamName: item.teamName,
        memberName: item.memberName,
        taskIds,
        nowIso,
      }))
    ) {
      return { ok: false, reason: 'watchdog_cooldown_active', retryable: true };
    }

    return { ok: true, ...(providerId ? { providerId } : {}) };
  }

  private async revalidateProofMissingRecovery(
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): Promise<
    { ok: true } | { ok: false; reason: string; retryable: boolean; nextAttemptAt?: string }
  > {
    const originalMessageId = getProofMissingRecoveryOriginalMessageId(item);
    if (!originalMessageId) {
      return { ok: true };
    }

    const guard = this.deps.proofMissingRecoveryGuard;
    if (!guard) {
      return { ok: true };
    }

    return guard.shouldDispatch({
      teamName: item.teamName,
      memberName: item.memberName,
      intentKey: item.payload.workSyncIntentKey ?? '',
      originalMessageId,
      taskIds: item.payload.taskRefs.map((taskRef) => taskRef.taskId),
      nowIso,
    });
  }

  private async scheduleDeliveryWake(
    item: MemberWorkSyncOutboxItem,
    messageId: string,
    inserted: boolean,
    providerId?: MemberWorkSyncStatus['providerId']
  ): Promise<void> {
    if (!this.deps.nudgeDeliveryWake) {
      return;
    }

    try {
      await this.deps.nudgeDeliveryWake.schedule({
        teamName: item.teamName,
        memberName: item.memberName,
        messageId,
        ...(providerId ? { providerId } : {}),
        reason: inserted ? 'member_work_sync_nudge_inserted' : 'member_work_sync_nudge_existing',
        delayMs: 500,
      });
    } catch (error) {
      const reason = `nudge_wake_failed:${String(error)}`;
      await this.appendDispatchAudit(item, 'nudge_wake_failed', reason);
      this.deps.logger?.warn('member work sync nudge delivery wake failed', {
        teamName: item.teamName,
        memberName: item.memberName,
        messageId,
        error: String(error),
      });
    }
  }
}
