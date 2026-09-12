import {
  appendMemberWorkSyncAudit,
  buildMemberWorkSyncPhase2ReadinessAuditFields,
  reasonToAuditEvent,
} from './MemberWorkSyncAudit';
import { insertMemberWorkSyncInboxAfterRuntimeTicket } from './MemberWorkSyncEarlyContinuationPlanner';
import {
  addNudgeDispatchSummary,
  emptyNudgeDispatchSummary,
  getPayloadReviewRequestEventIds,
  isReviewPickupOutboxItem,
  nextNudgeRetryAt,
  unrefNudgeDispatchTimer,
} from './MemberWorkSyncNudgeDispatchPolicy';
import { MemberWorkSyncNudgeRevalidator } from './MemberWorkSyncNudgeRevalidator';
import { recordMemberWorkSyncDispatchOutcome } from './MemberWorkSyncRecoveryDispatchOutcome';
import { readMemberWorkSyncStatus } from './MemberWorkSyncStatusMutation';

import type {
  MemberWorkSyncOutboxItem,
  MemberWorkSyncPhase2ReadinessAssessment,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncAuditEventName, MemberWorkSyncUseCaseDeps } from './ports';

const MEMBER_WORK_SYNC_NUDGE_DISPATCH_ITEM_TIMEOUT_MS = 2 * 60_000;
const MEMBER_WORK_SYNC_NUDGE_DISPATCH_TEAM_TIMEOUT_MS = 2 * 60_000;
const MEMBER_WORK_SYNC_NUDGE_CLAIM_TIMEOUT_MS = 30_000;

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
  itemTimeoutMs?: number;
  teamTimeoutMs?: number;
  claimTimeoutMs?: number;
  signal?: AbortSignal;
  trackSettlingWork?<T>(teamName: string, work: Promise<T>): Promise<T>;
}

interface MemberWorkSyncNudgeDispatchRun {
  cancelled: boolean;
  parent?: MemberWorkSyncNudgeDispatchRun;
  signal?: AbortSignal;
}

function isDispatchRunCancelled(run?: MemberWorkSyncNudgeDispatchRun): boolean {
  let current: MemberWorkSyncNudgeDispatchRun | undefined = run;
  while (current) {
    if (current.cancelled || current.signal?.aborted) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export class MemberWorkSyncNudgeDispatcher {
  private readonly revalidator: MemberWorkSyncNudgeRevalidator;
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {
    this.revalidator = new MemberWorkSyncNudgeRevalidator(deps);
  }

  async dispatchDue(
    options: MemberWorkSyncNudgeDispatchOptions
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    const outbox = this.deps.outboxStore;
    const inbox = this.deps.inboxNudge;
    if (!outbox || !inbox) {
      return emptyNudgeDispatchSummary();
    }

    const nowIso = this.deps.clock.now().toISOString();
    const itemTimeoutMs = Math.max(
      1,
      options.itemTimeoutMs ?? MEMBER_WORK_SYNC_NUDGE_DISPATCH_ITEM_TIMEOUT_MS
    );
    const teamTimeoutMs = Math.max(
      1,
      options.teamTimeoutMs ?? MEMBER_WORK_SYNC_NUDGE_DISPATCH_TEAM_TIMEOUT_MS
    );
    const claimTimeoutMs = Math.max(
      1,
      options.claimTimeoutMs ?? MEMBER_WORK_SYNC_NUDGE_CLAIM_TIMEOUT_MS
    );
    const teamNames = [...new Set(options.teamNames.map((name) => name.trim()).filter(Boolean))];
    let summary = emptyNudgeDispatchSummary();
    for (const teamName of teamNames) {
      if (options.signal?.aborted) {
        break;
      }
      try {
        summary = addNudgeDispatchSummary(
          summary,
          await this.dispatchTeamWithTimeout(teamName, options, nowIso, {
            itemTimeoutMs,
            teamTimeoutMs,
            claimTimeoutMs,
          })
        );
      } catch (error) {
        this.deps.logger?.warn('member work sync team nudge dispatch failed', {
          teamName,
          error: String(error),
        });
      }
    }
    return summary;
  }

  private async dispatchTeamWithTimeout(
    teamName: string,
    options: MemberWorkSyncNudgeDispatchOptions,
    nowIso: string,
    timeouts: { itemTimeoutMs: number; teamTimeoutMs: number; claimTimeoutMs: number }
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const run: MemberWorkSyncNudgeDispatchRun = {
      cancelled: false,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const work = this.trackSettlingWork(
      teamName,
      options,
      this.dispatchTeam(teamName, options, nowIso, timeouts, run)
    );
    void work.catch(() => undefined);

    try {
      const result = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => {
            run.cancelled = true;
            resolve('timeout');
          }, timeouts.teamTimeoutMs);
          unrefNudgeDispatchTimer(timeout);
        }),
      ]);
      if (result !== 'timeout') {
        return result;
      }
      this.deps.logger?.warn('member work sync team nudge dispatch timed out', {
        teamName,
        timeoutMs: timeouts.teamTimeoutMs,
      });
      return emptyNudgeDispatchSummary();
    } finally {
      run.cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async dispatchTeam(
    teamName: string,
    options: MemberWorkSyncNudgeDispatchOptions,
    nowIso: string,
    timeouts: { itemTimeoutMs: number; claimTimeoutMs: number },
    run: MemberWorkSyncNudgeDispatchRun
  ): Promise<MemberWorkSyncNudgeDispatchSummary> {
    const summary = emptyNudgeDispatchSummary();
    const claimed = await this.claimDueWithTimeout(teamName, options, nowIso, timeouts, run);
    if (!claimed || isDispatchRunCancelled(run)) {
      return summary;
    }

    summary.claimed += claimed.length;
    for (const item of claimed) {
      if (isDispatchRunCancelled(run)) {
        break;
      }
      const result = await this.dispatchItemWithTimeout(
        item,
        nowIso,
        timeouts.itemTimeoutMs,
        run,
        options
      );
      summary[result] += 1;
    }
    return summary;
  }

  private async claimDueWithTimeout(
    teamName: string,
    options: MemberWorkSyncNudgeDispatchOptions,
    nowIso: string,
    timeouts: { claimTimeoutMs: number },
    run: MemberWorkSyncNudgeDispatchRun
  ): Promise<MemberWorkSyncOutboxItem[] | null> {
    const outbox = this.deps.outboxStore;
    if (!outbox) {
      return null;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const work = this.trackSettlingWork(
      teamName,
      options,
      outbox.claimDue({
        teamName,
        claimedBy: options.claimedBy,
        nowIso,
        limit: options.limit ?? 10,
      })
    );
    void work.catch(() => undefined);

    try {
      const result = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), timeouts.claimTimeoutMs);
          unrefNudgeDispatchTimer(timeout);
        }),
      ]);
      if (result !== 'timeout') {
        return isDispatchRunCancelled(run) ? null : result;
      }
      this.deps.logger?.warn('member work sync nudge claim timed out', {
        teamName,
        timeoutMs: timeouts.claimTimeoutMs,
      });
      return null;
    } catch (error) {
      this.deps.logger?.warn('member work sync nudge claim failed', {
        teamName,
        error: String(error),
      });
      return null;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async dispatchItemWithTimeout(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    timeoutMs: number,
    run: MemberWorkSyncNudgeDispatchRun,
    options: MemberWorkSyncNudgeDispatchOptions
  ): Promise<keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const itemRun: MemberWorkSyncNudgeDispatchRun = { cancelled: false, parent: run };
    const work = this.trackSettlingWork(
      item.teamName,
      options,
      this.dispatchItem(item, nowIso, itemRun)
    );
    void work.catch(() => undefined);

    try {
      const result = await Promise.race<
        keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'> | 'timeout'
      >([
        work,
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => {
            itemRun.cancelled = true;
            resolve('timeout');
          }, timeoutMs);
          unrefNudgeDispatchTimer(timeout);
        }),
      ]);
      if (result !== 'timeout') {
        await this.recordRecoveryDispatchOutcome(item, result);
        return result;
      }
      await this.tryMarkDispatchItemRetryable(
        item,
        nowIso,
        `nudge dispatch item timed out after ${timeoutMs}ms`,
        timeoutMs,
        run,
        options
      );
      await this.recordRecoveryDispatchOutcome(item, 'retryable');
      return 'retryable';
    } catch (error) {
      await this.tryMarkDispatchItemRetryable(item, nowIso, String(error), timeoutMs, run, options);
      await this.recordRecoveryDispatchOutcome(item, 'retryable');
      return 'retryable';
    } finally {
      itemRun.cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async tryMarkDispatchItemRetryable(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    error: string,
    timeoutMs: number,
    run: MemberWorkSyncNudgeDispatchRun | undefined,
    options: MemberWorkSyncNudgeDispatchOptions
  ): Promise<void> {
    if (isDispatchRunCancelled(run)) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const markTimeoutMs = Math.min(Math.max(1, timeoutMs), 5_000);
    const work = this.trackSettlingWork(
      item.teamName,
      options,
      this.markDispatchItemRetryable(item, nowIso, error, run)
    );
    void work.catch(() => undefined);

    try {
      const result = await Promise.race([
        work.then(() => 'marked' as const),
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), markTimeoutMs);
          unrefNudgeDispatchTimer(timeout);
        }),
      ]);
      if (result === 'timeout') {
        this.deps.logger?.warn('member work sync nudge retry mark timed out', {
          teamName: item.teamName,
          memberName: item.memberName,
          outboxId: item.id,
          timeoutMs: markTimeoutMs,
          error,
        });
      }
    } catch (markError) {
      this.deps.logger?.warn('member work sync nudge retry mark failed', {
        teamName: item.teamName,
        memberName: item.memberName,
        outboxId: item.id,
        error: String(markError),
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async markDispatchItemRetryable(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    error: string,
    run?: MemberWorkSyncNudgeDispatchRun
  ): Promise<void> {
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.deps.outboxStore?.markFailed({
      teamName: item.teamName,
      id: item.id,
      attemptGeneration: item.attemptGeneration,
      error,
      retryable: true,
      nowIso,
      nextAttemptAt: nextNudgeRetryAt(item, nowIso),
    });
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.appendDispatchAudit(item, 'nudge_retryable', error);
  }

  private trackSettlingWork<T>(
    teamName: string,
    options: MemberWorkSyncNudgeDispatchOptions,
    work: Promise<T>
  ): Promise<T> {
    return options.trackSettlingWork?.(teamName, work) ?? work;
  }

  private async recordRecoveryDispatchOutcome(
    item: MemberWorkSyncOutboxItem,
    outcome: keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>
  ): Promise<void> {
    await recordMemberWorkSyncDispatchOutcome({
      deps: this.deps,
      item,
      outcome,
    });
  }

  private async dispatchItem(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    run: MemberWorkSyncNudgeDispatchRun
  ): Promise<keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>> {
    const outbox = this.deps.outboxStore;
    const inbox = this.deps.inboxNudge;
    if (!outbox || !inbox) {
      return 'terminal';
    }

    if (isDispatchRunCancelled(run)) {
      return 'retryable';
    }
    const revalidation = await this.revalidator.revalidate(item, nowIso);
    if (isDispatchRunCancelled(run)) {
      return 'retryable';
    }
    if (!revalidation.ok) {
      if (revalidation.retryable) {
        await outbox.markFailed({
          teamName: item.teamName,
          id: item.id,
          attemptGeneration: item.attemptGeneration,
          error: revalidation.reason,
          retryable: true,
          nowIso,
          nextAttemptAt: revalidation.nextAttemptAt ?? nextNudgeRetryAt(item, nowIso),
        });
        if (isDispatchRunCancelled(run)) {
          return 'retryable';
        }
        await this.appendDispatchAudit(
          item,
          reasonToAuditEvent(revalidation.reason),
          revalidation.reason,
          revalidation.phase2Readiness
        );
        return 'retryable';
      }
      if (revalidation.reason.startsWith('review_pickup_delivery_unavailable:')) {
        await this.markReviewPickupDeliveryUnavailable(item, nowIso, revalidation.reason, run);
        return isDispatchRunCancelled(run) ? 'retryable' : 'superseded';
      }
      await outbox.markSuperseded({
        teamName: item.teamName,
        id: item.id,
        reason: revalidation.reason,
        nowIso,
      });
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.appendDispatchAudit(item, 'nudge_superseded', revalidation.reason);
      return 'superseded';
    }

    try {
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      const preDelivery = await readMemberWorkSyncStatus(this.deps, {
        teamName: item.teamName,
        memberName: item.memberName,
      });
      if (preDelivery.status?.recoveryHealth?.autoResumeStopLatch) {
        await outbox.markSuperseded({
          teamName: item.teamName,
          id: item.id,
          reason: 'member_stopped',
          nowIso,
        });
        return 'superseded';
      }
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      const delivery = await insertMemberWorkSyncInboxAfterRuntimeTicket({
        admission: this.deps.runtimeTicketAdmission,
        inbox,
        item,
        nowIso,
        shouldAbort: async () => {
          if (isDispatchRunCancelled(run)) {
            return true;
          }
          const current = await readMemberWorkSyncStatus(this.deps, {
            teamName: item.teamName,
            memberName: item.memberName,
          });
          return Boolean(current.status?.recoveryHealth?.autoResumeStopLatch);
        },
      });
      if (delivery.status === 'busy') {
        await outbox.markFailed({
          teamName: item.teamName,
          id: item.id,
          attemptGeneration: item.attemptGeneration,
          error: 'runtime_ticket_busy',
          retryable: true,
          nowIso,
          nextAttemptAt: nextNudgeRetryAt(item, nowIso),
        });
        return 'retryable';
      }
      if (
        delivery.status === 'stale' ||
        delivery.status === 'stopped' ||
        delivery.status === 'aborted'
      ) {
        await outbox.markSuperseded({
          teamName: item.teamName,
          id: item.id,
          reason: `runtime_ticket_${delivery.status}`,
          nowIso,
        });
        return 'superseded';
      }
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      if (delivery.status === 'conflict') {
        await outbox.markFailed({
          teamName: item.teamName,
          id: item.id,
          attemptGeneration: item.attemptGeneration,
          error: 'inbox_payload_conflict',
          retryable: false,
          nowIso,
        });
        if (isDispatchRunCancelled(run)) {
          return 'retryable';
        }
        await this.appendDispatchAudit(item, 'nudge_skipped', 'inbox_payload_conflict');
        return 'terminal';
      }
      if (isReviewPickupOutboxItem(item)) {
        return await this.deliverReviewPickupNudge(
          item,
          delivery.messageId,
          delivery.inserted,
          revalidation.providerId,
          nowIso,
          run
        );
      }
      await outbox.markDelivered({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        deliveredMessageId: delivery.messageId,
        nowIso,
      });
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.appendDispatchAudit(item, 'nudge_delivered', 'inbox_inserted');
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.scheduleDeliveryWake(
        item,
        delivery.messageId,
        delivery.inserted,
        revalidation.providerId,
        run
      );
      return isDispatchRunCancelled(run) ? 'retryable' : 'delivered';
    } catch (error) {
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await outbox.markFailed({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        error: String(error),
        retryable: true,
        nowIso,
        nextAttemptAt: nextNudgeRetryAt(item, nowIso),
      });
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.appendDispatchAudit(item, 'nudge_retryable', String(error));
      return 'retryable';
    }
  }

  private async deliverReviewPickupNudge(
    item: MemberWorkSyncOutboxItem,
    messageId: string,
    inserted: boolean,
    providerId: MemberWorkSyncStatus['providerId'] | undefined,
    nowIso: string,
    run: MemberWorkSyncNudgeDispatchRun
  ): Promise<keyof Omit<MemberWorkSyncNudgeDispatchSummary, 'claimed'>> {
    const outbox = this.deps.outboxStore;
    const delivery = this.deps.reviewPickupDelivery;
    if (!outbox || !delivery) {
      await this.markReviewPickupDeliveryUnavailable(
        item,
        nowIso,
        'review_pickup_delivery_port_unavailable',
        run
      );
      return isDispatchRunCancelled(run) ? 'retryable' : 'superseded';
    }

    if (isDispatchRunCancelled(run)) {
      return 'retryable';
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
    if (isDispatchRunCancelled(run)) {
      return 'retryable';
    }

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
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.appendDispatchAudit(item, 'review_pickup_member_nudge_delivered', outcome.state);
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
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
        nextAttemptAt: outcome.retryAfterIso ?? nextNudgeRetryAt(item, nowIso),
      });
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      await this.appendDispatchAudit(item, 'review_pickup_wake_failed_retryable', outcome.message);
      return 'retryable';
    }

    if (outcome.reason === 'capability_absent') {
      await this.markReviewPickupDeliveryUnavailable(item, nowIso, outcome.message, run);
      return isDispatchRunCancelled(run) ? 'retryable' : 'superseded';
    }

    await outbox.markFailed({
      teamName: item.teamName,
      id: item.id,
      attemptGeneration: item.attemptGeneration,
      error: outcome.message,
      retryable: false,
      nowIso,
    });
    if (isDispatchRunCancelled(run)) {
      return 'retryable';
    }
    await this.appendDispatchAudit(item, 'nudge_skipped', outcome.message);
    return 'terminal';
  }

  private async markReviewPickupDeliveryUnavailable(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    reason: string,
    run?: MemberWorkSyncNudgeDispatchRun
  ): Promise<void> {
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.deps.outboxStore?.markSuperseded({
      teamName: item.teamName,
      id: item.id,
      reason,
      nowIso,
    });
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.appendDispatchAudit(item, 'review_pickup_delivery_unavailable', reason);
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.appendDispatchAudit(item, 'review_pickup_escalated', reason);
    if (isDispatchRunCancelled(run)) {
      return;
    }
    await this.notifyReviewPickupEscalation(item, nowIso, reason, run);
  }

  private async notifyReviewPickupEscalation(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    reason: string,
    run?: MemberWorkSyncNudgeDispatchRun
  ): Promise<void> {
    const escalation = this.deps.reviewPickupEscalation;
    if (!escalation || isDispatchRunCancelled(run)) {
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
    reason: string,
    phase2Readiness?: MemberWorkSyncPhase2ReadinessAssessment
  ): Promise<void> {
    await appendMemberWorkSyncAudit(this.deps, {
      teamName: item.teamName,
      memberName: item.memberName,
      event,
      source: 'nudge_dispatcher',
      agendaFingerprint: item.agendaFingerprint,
      reason,
      ...buildMemberWorkSyncPhase2ReadinessAuditFields(phase2Readiness),
      taskRefs: item.payload.taskRefs,
      messagePreview: item.payload.text,
    });
  }

  private async scheduleDeliveryWake(
    item: MemberWorkSyncOutboxItem,
    messageId: string,
    inserted: boolean,
    providerId?: MemberWorkSyncStatus['providerId'],
    run?: MemberWorkSyncNudgeDispatchRun
  ): Promise<void> {
    if (!this.deps.nudgeDeliveryWake || isDispatchRunCancelled(run)) {
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
