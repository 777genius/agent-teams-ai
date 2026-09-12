import { decideMemberWorkSyncStatus } from '../domain';
import { getMemberWorkSyncAcceptedReport } from '../domain/MemberWorkSyncAcceptedReport';

import { decideMemberWorkSyncNudgeActivation } from './MemberWorkSyncNudgeActivationPolicy';
import {
  addNudgeDispatchMinutes,
  AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX,
  getProofMissingRecoveryOriginalMessageId,
  isAgendaSyncStillStuckRecoveryOutboxItem,
  isManualContinueOutboxItem,
  isReviewPickupOutboxItem,
  isStatusOnlyRecoveryOutboxItem,
  preserveCurrentRuntimeStallDiagnostics,
  reviewPickupRequestIdsStillMatch,
  subtractNudgeDispatchMinutes,
} from './MemberWorkSyncNudgeDispatchPolicy';
import {
  applyMemberWorkSyncNudgeSuppression,
  MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC,
} from './MemberWorkSyncNudgeSuppressionPolicy';
import { finalizeMemberWorkSyncAgenda } from './MemberWorkSyncReconciler';
import { resolveMemberWorkSyncRuntimeActivity } from './MemberWorkSyncRuntimeActivity';
import {
  commitMemberWorkSyncStatus,
  readMemberWorkSyncStatus,
  runMemberWorkSyncStatusMutation,
} from './MemberWorkSyncStatusMutation';

import type {
  MemberWorkSyncOutboxItem,
  MemberWorkSyncPhase2ReadinessAssessment,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

const MEMBER_WORK_SYNC_MAX_NUDGES_PER_MEMBER_PER_HOUR = 2;

/** Revalidates one claimed intent; never sends a message or creates a second transport attempt. */
export class MemberWorkSyncNudgeRevalidator {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async revalidate(
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
    let attempt = 0;
    return runMemberWorkSyncStatusMutation(this.deps, (mutationId) =>
      this.revalidateAttempt(
        item,
        attempt++ === 0 ? nowIso : this.deps.clock.now().toISOString(),
        mutationId
      )
    );
  }

  private async revalidateAttempt(
    item: MemberWorkSyncOutboxItem,
    nowIso: string,
    mutationId: string | undefined
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

    const read = await readMemberWorkSyncStatus(this.deps, {
      teamName: item.teamName,
      memberName: item.memberName,
    });
    const previous = read.status;
    if (!previous) {
      return { ok: false, reason: 'status_missing', retryable: false };
    }
    if (previous.recoveryHealth?.autoResumeStopLatch) {
      return { ok: false, reason: 'member_stopped', retryable: false };
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
      latestAcceptedReport: getMemberWorkSyncAcceptedReport(previous),
      nowIso,
      inactive: source.inactive || runtimeActivity.inactive,
    });
    const providerId = source.providerId ?? previous.providerId;
    const { report: _previousReport, ...previousWithoutReport } = previous;
    const revalidatedStatus: MemberWorkSyncStatus = {
      ...previousWithoutReport,
      state: decision.state,
      agenda,
      ...(previous.report ? { report: previous.report } : {}),
      ...(getMemberWorkSyncAcceptedReport(previous)
        ? { lastAcceptedReport: getMemberWorkSyncAcceptedReport(previous)! }
        : {}),
      shadow: {
        ...previous.shadow,
        reconciledBy: 'queue',
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
      await commitMemberWorkSyncStatus(this.deps, read, suppressionStatus, mutationId);
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
    const manualContinue = isManualContinueOutboxItem(item);
    if (!activation.active && !manualContinue) {
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
      sinceIso: subtractNudgeDispatchMinutes(nowIso, 60),
      ...(isAgendaSyncStillStuckRecoveryOutboxItem(item)
        ? { workSyncIntentKeyPrefix: AGENDA_SYNC_STILL_STUCK_RECOVERY_INTENT_PREFIX }
        : {}),
    });
    if (
      !manualContinue &&
      recentDelivered != null &&
      recentDelivered >= MEMBER_WORK_SYNC_MAX_NUDGES_PER_MEMBER_PER_HOUR
    ) {
      return {
        ok: false,
        reason: 'member_nudge_rate_limited',
        retryable: true,
        nextAttemptAt: addNudgeDispatchMinutes(nowIso, 60),
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
      !(
        (isStatusOnlyRecoveryOutboxItem(item) || isManualContinueOutboxItem(item)) &&
        busy.reason === 'recent_tool_activity'
      )
    ) {
      return {
        ok: false,
        reason: `member_busy:${busy.reason ?? 'unknown'}`,
        retryable: true,
        nextAttemptAt: busy.retryAfterIso,
      };
    }

    const taskIds = item.payload.taskRefs.map((taskRef) => taskRef.taskId);
    const watchdogCooldown = manualContinue
      ? { active: false as const }
      : await this.resolveWatchdogCooldown(item, taskIds, nowIso);
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
}
