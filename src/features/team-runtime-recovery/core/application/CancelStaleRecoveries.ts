import type { CancelRuntimeRecoveries } from './CancelRuntimeRecoveries';
import type {
  RuntimeRecoveryDeliveryPort,
  RuntimeRecoveryLoggerPort,
  RuntimeRecoveryRepositoryPort,
  RuntimeRecoveryTargetPort,
} from './ports';
import type { RuntimeRecoveryJob } from './types';

const ACTIVE_STATUSES = new Set(['pending', 'claimed', 'failed_retryable', 'awaiting_outcome']);

export class CancelStaleRecoveries {
  constructor(
    private readonly deps: {
      repository: RuntimeRecoveryRepositoryPort;
      target: RuntimeRecoveryTargetPort;
      cancel: Pick<CancelRuntimeRecoveries, 'execute'>;
      delivery?: Pick<RuntimeRecoveryDeliveryPort, 'escalate'>;
      logger?: RuntimeRecoveryLoggerPort;
    }
  ) {}

  async execute(teamName: string): Promise<number> {
    const state = await this.deps.repository.read(teamName);
    let cancelled = 0;
    for (const job of state.jobs.filter((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
      let preflight: Awaited<ReturnType<RuntimeRecoveryTargetPort['preflight']>>;
      try {
        preflight = await this.deps.target.preflight(job);
      } catch (error) {
        this.deps.logger?.warn('team runtime recovery lifecycle preflight failed', {
          teamName: job.signal.teamName,
          jobId: job.id,
          error: String(error),
        });
        continue;
      }
      if (preflight.ok || preflight.retryable) continue;
      const cancelledJob = await this.deps.cancel.execute({
        teamName,
        reason: preflight.reason,
        matches: (candidate) => candidate.id === job.id,
      });
      cancelled += cancelledJob;
      if (cancelledJob > 0) await this.escalateIfNeeded(job, preflight);
    }
    return cancelled;
  }

  private async escalateIfNeeded(
    job: RuntimeRecoveryJob,
    preflight: Extract<Awaited<ReturnType<RuntimeRecoveryTargetPort['preflight']>>, { ok: false }>
  ): Promise<void> {
    if (!preflight.escalateToLead || !preflight.leadName || !this.deps.delivery?.escalate) return;
    try {
      await this.deps.delivery.escalate({
        job,
        leadName: preflight.leadName,
        reason: preflight.reason,
      });
    } catch (error) {
      this.deps.logger?.warn('team runtime recovery lifecycle escalation failed', {
        teamName: job.signal.teamName,
        jobId: job.id,
        error: String(error),
      });
    }
  }
}
