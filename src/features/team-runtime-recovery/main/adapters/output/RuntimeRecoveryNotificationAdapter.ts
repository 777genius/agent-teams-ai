import type { RuntimeFailureSignal } from '../../../contracts';
import type {
  RuntimeRecoveryJob,
  RuntimeRecoveryNotificationPort,
} from '../../../core/application';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

export class RuntimeRecoveryNotificationAdapter implements RuntimeRecoveryNotificationPort {
  constructor(
    private readonly deps: {
      add(payload: TeamNotificationPayload): Promise<unknown>;
      getTeamDisplayName(teamName: string): Promise<string>;
      logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
    }
  ) {}

  scheduled(job: RuntimeRecoveryJob): Promise<void> {
    return this.notifyJob(
      job,
      'scheduled',
      `Recovery ${job.attempt + 1} scheduled for ${job.nextAttemptAt}`
    );
  }

  completed(job: RuntimeRecoveryJob): Promise<void> {
    return this.notifyJob(job, 'completed', 'The agent produced recovery outcome proof');
  }

  manual(signal: RuntimeFailureSignal, reason: string): Promise<void> {
    return this.notifySignal(
      signal,
      `manual:${reason}`,
      'Manual action needed',
      `Automatic recovery was not scheduled: ${reason}`
    );
  }

  failed(job: RuntimeRecoveryJob, reason: string): Promise<void> {
    return this.notifyJob(job, `failed:${reason}`, `Manual action needed: ${reason}`);
  }

  cancelled(job: RuntimeRecoveryJob, reason: string): Promise<void> {
    return this.notifyJob(job, `cancelled:${reason}`, `Recovery cancelled: ${reason}`);
  }

  private async notifyJob(job: RuntimeRecoveryJob, state: string, body: string): Promise<void> {
    await this.notifySignal(
      job.signal,
      `${job.id}:${state}`,
      `Agent recovery: ${job.signal.memberName}`,
      body
    );
  }

  private async notifySignal(
    signal: RuntimeFailureSignal,
    dedupeSuffix: string,
    summary: string,
    body: string
  ): Promise<void> {
    try {
      await this.deps.add({
        teamEventType: 'runtime_recovery',
        teamName: signal.teamName,
        teamDisplayName: await this.deps.getTeamDisplayName(signal.teamName),
        from: signal.memberName,
        to: 'user',
        summary,
        body,
        dedupeKey: `runtime-recovery:${signal.teamName}:${dedupeSuffix}`,
        target: { kind: 'team', teamName: signal.teamName, section: 'messages' },
      });
    } catch (error) {
      this.deps.logger?.warn('team runtime recovery notification failed', {
        teamName: signal.teamName,
        error: String(error),
      });
    }
  }
}
