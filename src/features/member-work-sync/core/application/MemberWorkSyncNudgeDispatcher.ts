import { decideMemberWorkSyncStatus } from '../domain';

import {
  appendMemberWorkSyncAudit,
  buildMemberWorkSyncPhase2ReadinessAuditFields,
  reasonToAuditEvent,
} from './MemberWorkSyncAudit';
import { decideMemberWorkSyncNudgeActivation } from './MemberWorkSyncNudgeActivationPolicy';
import {
  applyMemberWorkSyncNudgeSuppression,
  MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC,
} from './MemberWorkSyncNudgeSuppressionPolicy';
import { finalizeMemberWorkSyncAgenda } from './MemberWorkSyncReconciler';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';

import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncPhase2ReadinessAssessment,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncAuditEventName, MemberWorkSyncUseCaseDeps } from './ports';

const MEMBER_WORK_SYNC_MAX_NUDGES_PER_MEMBER_PER_HOUR = 2;
const MEMBER_WORK_SYNC_RETRY_BASE_MINUTES = 10;
const MEMBER_WORK_SYNC_RETRY_MAX_MINUTES = 60;
const MEMBER_WORK_SYNC_NUDGE_DISPATCH_ITEM_TIMEOUT_MS = 2 * 60_000;
const MEMBER_WORK_SYNC_NUDGE_DISPATCH_TEAM_TIMEOUT_MS = 2 * 60_000;
const MEMBER_WORK_SYNC_NUDGE_CLAIM_TIMEOUT_MS = 30_000;
const AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX = 'agenda-sync-still-stuck:';

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

function emptySummary(): MemberWorkSyncNudgeDispatchSummary {
  return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
}

function addSummary(
  left: MemberWorkSyncNudgeDispatchSummary,
  right: MemberWorkSyncNudgeDispatchSummary
): MemberWorkSyncNudgeDispatchSummary {
  return {
    claimed: left.claimed + right.claimed,
    delivered: left.delivered + right.delivered,
    superseded: left.superseded + right.superseded,
    retryable: left.retryable + right.retryable,
    terminal: left.terminal + right.terminal,
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function subtractMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

function preserveCurrentRuntimeStallDiagnostics(input: {
  previous: MemberWorkSyncStatus;
  agenda: MemberWorkSyncAgenda;
  state: MemberWorkSyncStatus['state'];
  diagnostics: string[];
}): string[] {
  const diagnostics = new Set(input.diagnostics);
  if (
    input.state !== 'needs_sync' ||
    input.previous.agenda.fingerprint !== input.agenda.fingerprint
  ) {
    return [...diagnostics];
  }
  for (const diagnostic of input.previous.diagnostics) {
    if (diagnostic.startsWith('runtime_stall:')) {
      diagnostics.add(diagnostic);
    }
  }
  return [...diagnostics];
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

function isStatusOnlyRecoveryOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return item.payload.workSyncIntentKey?.startsWith('status-only:') === true;
}

function isAgendaSyncStillStuckRecoveryOutboxItem(item: MemberWorkSyncOutboxItem): boolean {
  return (
    item.payload.workSyncIntentKey?.startsWith(AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX) ===
    true
  );
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
    let summary = emptySummary();
    for (const teamName of teamNames) {
      if (options.signal?.aborted) {
        break;
      }
      try {
        summary = addSummary(
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
          unrefTimer(timeout);
        }),
      ]);
      if (result !== 'timeout') {
        return result;
      }
      this.deps.logger?.warn('member work sync team nudge dispatch timed out', {
        teamName,
        timeoutMs: timeouts.teamTimeoutMs,
      });
      return emptySummary();
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
    const summary = emptySummary();
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
          unrefTimer(timeout);
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
          unrefTimer(timeout);
        }),
      ]);
      if (result !== 'timeout') {
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
      return 'retryable';
    } catch (error) {
      await this.tryMarkDispatchItemRetryable(item, nowIso, String(error), timeoutMs, run, options);
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
          unrefTimer(timeout);
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
      nextAttemptAt: nextRetryAt(item, nowIso),
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
    const revalidation = await this.revalidate(item, nowIso);
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
          nextAttemptAt: revalidation.nextAttemptAt ?? nextRetryAt(item, nowIso),
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
      const inserted = await inbox.insertIfAbsent({
        teamName: item.teamName,
        memberName: item.memberName,
        messageId: item.id,
        payloadHash: item.payloadHash,
        payload: item.payload,
        timestamp: nowIso,
      });
      if (isDispatchRunCancelled(run)) {
        return 'retryable';
      }
      if (inserted.conflict) {
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
          inserted.messageId,
          inserted.inserted,
          revalidation.providerId,
          nowIso,
          run
        );
      }
      await outbox.markDelivered({
        teamName: item.teamName,
        id: item.id,
        attemptGeneration: item.attemptGeneration,
        deliveredMessageId: inserted.messageId,
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
        inserted.messageId,
        inserted.inserted,
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
        nextAttemptAt: nextRetryAt(item, nowIso),
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
        nextAttemptAt: outcome.retryAfterIso ?? nextRetryAt(item, nowIso),
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

  private async revalidate(
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): Promise<
    | { ok: true; providerId?: MemberWorkSyncStatus['providerId'] }
    | {
        ok: false;
        reason: string;
        retryable: boolean;
        nextAttemptAt?: string;
        phase2Readiness?: MemberWorkSyncPhase2ReadinessAssessment;
      }
  > {
    const runtimeActivity = await resolveMemberWorkSyncRuntimeActivity(this.deps, {
      teamName: item.teamName,
      memberName: item.memberName,
    });
    if (!runtimeActivity.teamActive) {
      return { ok: false, reason: 'team_inactive', retryable: false };
    }
    if (!runtimeActivity.memberActive) {
      return { ok: false, reason: 'member_runtime_inactive', retryable: false };
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
      inactive: source.inactive || runtimeActivity.inactive,
    });
    const providerId = source.providerId ?? previous.providerId;
    const { report: _previousReport, ...previousWithoutReport } = previous;
    const revalidatedStatus: MemberWorkSyncStatus = {
      ...previousWithoutReport,
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
      diagnostics: preserveCurrentRuntimeStallDiagnostics({
        previous,
        agenda,
        state: decision.state,
        diagnostics: [...agenda.diagnostics, ...decision.diagnostics],
      }),
      ...(providerId ? { providerId } : {}),
    };
    const agendaStillMatches =
      agenda.fingerprint === item.agendaFingerprint ||
      (isReviewPickupOutboxItem(item) && reviewPickupRequestIdsStillMatch(item, agenda));
    if (decision.state !== 'needs_sync' || agenda.items.length === 0 || !agendaStillMatches) {
      return { ok: false, reason: 'status_no_longer_matches_outbox', retryable: false };
    }
    const suppressionStatus = await applyMemberWorkSyncNudgeSuppression(this.deps, {
      status: revalidatedStatus,
      previousStatus: previous,
      source: 'nudge_dispatcher',
    });
    if (
      suppressionStatus.shadow?.wouldNudge !== true &&
      suppressionStatus.diagnostics.includes(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC)
    ) {
      await this.deps.statusStore.write(suppressionStatus);
      return {
        ok: false,
        reason: MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC,
        retryable: false,
      };
    }

    if (!this.deps.statusStore.readTeamMetrics) {
      return { ok: false, reason: 'metrics_unavailable', retryable: true };
    }
    const metrics = await this.deps.statusStore.readTeamMetrics(item.teamName);
    const activation = decideMemberWorkSyncNudgeActivation({
      status: suppressionStatus,
      metrics,
    });
    if (!activation.active) {
      const reason =
        activation.reason === 'blocking_metrics'
          ? 'blocking_metrics'
          : activation.reason === 'status_not_nudgeable'
            ? 'status_not_nudgeable'
            : 'phase2_not_ready';
      return {
        ok: false,
        reason,
        retryable: true,
        phase2Readiness: metrics.phase2Readiness,
      };
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
      ...(isAgendaSyncStillStuckRecoveryOutboxItem(item)
        ? { workSyncIntentKeyPrefix: AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX }
        : {}),
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
    if (
      busy?.busy &&
      !(isStatusOnlyRecoveryOutboxItem(item) && busy.reason === 'recent_tool_activity')
    ) {
      return {
        ok: false,
        reason: `member_busy:${busy.reason ?? 'unknown'}`,
        retryable: true,
        nextAttemptAt: busy.retryAfterIso,
      };
    }

    const taskIds = item.payload.taskRefs.map((taskRef) => taskRef.taskId);
    const watchdogCooldown = await this.resolveWatchdogCooldown(item, taskIds, nowIso);
    if (watchdogCooldown.active) {
      return {
        ok: false,
        reason: 'watchdog_cooldown_active',
        retryable: true,
        ...(watchdogCooldown.retryAfterIso
          ? { nextAttemptAt: watchdogCooldown.retryAfterIso }
          : {}),
      };
    }

    return { ok: true, ...(providerId ? { providerId } : {}) };
  }

  private async resolveWatchdogCooldown(
    item: MemberWorkSyncOutboxItem,
    taskIds: string[],
    nowIso: string
  ): Promise<{ active: boolean; retryAfterIso?: string }> {
    const watchdogCooldown = this.deps.watchdogCooldown;
    if (!watchdogCooldown) {
      return { active: false };
    }
    const input = {
      teamName: item.teamName,
      memberName: item.memberName,
      taskIds,
      nowIso,
    };
    if (watchdogCooldown.getRecentNudgeCooldown) {
      const result = await watchdogCooldown.getRecentNudgeCooldown(input);
      return {
        active: result.active,
        ...(result.retryAfterIso ? { retryAfterIso: result.retryAfterIso } : {}),
      };
    }
    return { active: await watchdogCooldown.hasRecentNudge(input) };
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
