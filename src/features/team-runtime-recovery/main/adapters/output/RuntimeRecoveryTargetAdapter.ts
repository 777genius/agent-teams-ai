import type {
  RuntimeRecoveryConfigPort,
  RuntimeRecoveryJob,
  RuntimeRecoveryPreflightResult,
  RuntimeRecoveryTargetPort,
} from '../../../core/application';
import type {
  InboxMessage,
  MemberRuntimeAdvisory,
  TeamAgentRuntimeSnapshot,
  TeamTaskWithKanban,
} from '@shared/types';

const BUSY_RETRY_MS = 30_000;

function normalize(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? '';
}

function isRecoveryEnabled(
  job: RuntimeRecoveryJob,
  config: ReturnType<RuntimeRecoveryConfigPort['getConfig']>
): boolean {
  return job.reasonCode === 'rate_limited' || job.reasonCode === 'quota_exhausted'
    ? config.rateLimitsEnabled
    : config.transientErrorsEnabled;
}

function hasNewManualActivity(messages: InboxMessage[], job: RuntimeRecoveryJob): boolean {
  const failedAt = Date.parse(job.signal.observedAt);
  if (!Number.isFinite(failedAt)) return true;
  return messages.some((message) => {
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= failedAt) return false;
    if (
      message.messageId === job.signal.sourceMessageId ||
      message.messageId === job.signal.failedMessageId
    ) {
      return false;
    }
    if (message.messageKind === 'runtime_recovery_nudge') return false;
    return message.source === 'user_sent' || normalize(message.from) === 'user';
  });
}

function tasksAreComplete(tasks: Array<TeamTaskWithKanban | null>): boolean {
  return (
    tasks.length > 0 &&
    tasks.every((task) => {
      if (!task) return false;
      return (
        task.status === 'completed' || task.status === 'deleted' || task.reviewState === 'approved'
      );
    })
  );
}

export class RuntimeRecoveryTargetAdapter implements RuntimeRecoveryTargetPort {
  constructor(
    private readonly deps: {
      config: RuntimeRecoveryConfigPort;
      now(): Date;
      getCurrentContextId(): string;
      getRuntimeState(teamName: string): Promise<{ isAlive: boolean; runId: string | null }>;
      getRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
      getLeadName(teamName: string): Promise<string | null>;
      getInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
      getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null>;
      getMemberAdvisory(
        teamName: string,
        memberName: string,
        options?: { observedAfterMs?: number | null }
      ): Promise<MemberRuntimeAdvisory | null>;
      getOpenCodeBusyStatus(input: {
        teamName: string;
        memberName: string;
        nowIso: string;
        taskRefs?: RuntimeRecoveryJob['signal']['taskRefs'];
      }): Promise<{ busy: boolean; reason?: string; retryAfterIso?: string }>;
    }
  ) {}

  async preflight(job: RuntimeRecoveryJob): Promise<RuntimeRecoveryPreflightResult> {
    if (!isRecoveryEnabled(job, this.deps.config.getConfig())) {
      return { ok: false, retryable: false, reason: 'setting_disabled' };
    }
    if (normalize(job.signal.contextId) !== normalize(this.deps.getCurrentContextId())) {
      return { ok: false, retryable: false, reason: 'context_changed' };
    }

    const [runtimeState, runtimeSnapshot, leadName] = await Promise.all([
      this.deps.getRuntimeState(job.signal.teamName),
      this.deps.getRuntimeSnapshot(job.signal.teamName),
      this.deps.getLeadName(job.signal.teamName),
    ]);
    if (!runtimeState.isAlive) {
      return { ok: false, retryable: false, reason: 'team_offline' };
    }
    if (job.signal.runId && runtimeState.runId !== job.signal.runId) {
      return { ok: false, retryable: false, reason: 'run_changed' };
    }

    const entry = Object.values(runtimeSnapshot.members).find(
      (member) => normalize(member.memberName) === normalize(job.signal.memberName)
    );
    if (!entry || !entry.alive) {
      return {
        ok: false,
        retryable: false,
        reason: entry ? 'member_offline' : 'member_removed',
        escalateToLead: job.signal.targetKind === 'member',
        ...(leadName ? { leadName } : {}),
      };
    }
    if (
      job.signal.runtimeSessionId &&
      entry.runtimeSessionId &&
      normalize(job.signal.runtimeSessionId) !== normalize(entry.runtimeSessionId)
    ) {
      return { ok: false, retryable: false, reason: 'runtime_session_changed' };
    }
    if (job.signal.providerId && normalize(job.signal.providerId) !== normalize(entry.providerId)) {
      return { ok: false, retryable: false, reason: 'provider_changed' };
    }
    if (
      job.signal.providerBackendId &&
      normalize(job.signal.providerBackendId) !== normalize(entry.providerBackendId)
    ) {
      return { ok: false, retryable: false, reason: 'provider_backend_changed' };
    }
    if (
      job.signal.model &&
      entry.runtimeModel &&
      normalize(job.signal.model) !== normalize(entry.runtimeModel)
    ) {
      return { ok: false, retryable: false, reason: 'model_changed' };
    }

    const messages = await this.deps.getInboxMessages(job.signal.teamName, entry.memberName);
    if (hasNewManualActivity(messages, job)) {
      return { ok: false, retryable: false, reason: 'new_manual_activity' };
    }
    if (job.signal.taskRefs?.length) {
      const tasks = await Promise.all(
        job.signal.taskRefs.map((taskRef) => this.deps.getTask(job.signal.teamName, taskRef.taskId))
      );
      if (tasksAreComplete(tasks)) {
        return { ok: false, retryable: false, reason: 'tasks_completed' };
      }
    }

    const observedAfterMs = Date.parse(job.signal.observedAt);
    const advisory = await this.deps.getMemberAdvisory(job.signal.teamName, entry.memberName, {
      observedAfterMs: Number.isFinite(observedAfterMs) ? observedAfterMs : null,
    });
    if (advisory?.kind === 'sdk_retrying') {
      return {
        ok: false,
        retryable: true,
        reason: 'runtime_retry_in_progress',
        retryAt:
          advisory.retryUntil ??
          new Date(
            this.deps.now().getTime() + (advisory.retryDelayMs ?? BUSY_RETRY_MS)
          ).toISOString(),
      };
    }
    if (entry.providerId === 'opencode') {
      const busy = await this.deps.getOpenCodeBusyStatus({
        teamName: job.signal.teamName,
        memberName: entry.memberName,
        nowIso: this.deps.now().toISOString(),
        taskRefs: job.signal.taskRefs?.map((taskRef) => ({
          taskId: taskRef.taskId,
          displayId: taskRef.displayId ?? taskRef.taskId.slice(0, 8),
          teamName: taskRef.teamName ?? job.signal.teamName,
        })),
      });
      if (busy.busy) {
        return {
          ok: false,
          retryable: true,
          reason: busy.reason ?? 'opencode_retry_in_progress',
          retryAt:
            busy.retryAfterIso ?? new Date(this.deps.now().getTime() + BUSY_RETRY_MS).toISOString(),
        };
      }
    }

    return {
      ok: true,
      currentRunId: runtimeState.runId ?? undefined,
      currentRuntimeSessionId: entry.runtimeSessionId,
      memberName: entry.memberName,
      targetKind: job.signal.targetKind,
      providerId: entry.providerId,
      providerBackendId: entry.providerBackendId,
      model: entry.runtimeModel,
    };
  }
}
