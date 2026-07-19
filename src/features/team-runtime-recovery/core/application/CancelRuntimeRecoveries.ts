import type {
  RuntimeRecoveryClockPort,
  RuntimeRecoveryNotificationPort,
  RuntimeRecoveryRepositoryPort,
} from './ports';
import type { RuntimeRecoveryJob, RuntimeRecoveryTeamState } from './types';

const CANCELLABLE_STATUSES = new Set([
  'pending',
  'claimed',
  'failed_retryable',
  'awaiting_outcome',
]);

export class CancelRuntimeRecoveries {
  constructor(
    private readonly deps: {
      clock: RuntimeRecoveryClockPort;
      repository: RuntimeRecoveryRepositoryPort;
      notifications?: RuntimeRecoveryNotificationPort;
    }
  ) {}

  async execute(input: {
    teamName: string;
    reason: string;
    matches?: (job: RuntimeRecoveryJob) => boolean;
  }): Promise<number> {
    const nowIso = this.deps.clock.now().toISOString();
    const cancelled = await this.deps.repository.update<RuntimeRecoveryJob[]>(
      input.teamName,
      (state) => {
        const jobs: RuntimeRecoveryJob[] = [];
        const nextJobs = state.jobs.map((job) => {
          if (!CANCELLABLE_STATUSES.has(job.status) || input.matches?.(job) === false) {
            return job;
          }
          const next: RuntimeRecoveryJob = {
            ...job,
            status: 'cancelled',
            claimedAt: undefined,
            claimedBy: undefined,
            updatedAt: nowIso,
            lastError: input.reason,
          };
          jobs.push(next);
          return next;
        });
        const circuitKeys = new Set(jobs.map((job) => job.circuitKey));
        return {
          state: {
            ...state,
            jobs: nextJobs,
            circuits: state.circuits.map((circuit) =>
              circuitKeys.has(circuit.key)
                ? this.reconcileCircuitAfterCancellation(circuit, nextJobs, nowIso)
                : circuit
            ),
            updatedAt: jobs.length > 0 ? nowIso : state.updatedAt,
          },
          result: jobs,
        };
      }
    );
    for (const job of cancelled) {
      await this.deps.notifications?.cancelled?.(job, input.reason);
    }
    return cancelled.length;
  }

  private reconcileCircuitAfterCancellation(
    circuit: RuntimeRecoveryTeamState['circuits'][number],
    jobs: RuntimeRecoveryJob[],
    nowIso: string
  ): RuntimeRecoveryTeamState['circuits'][number] {
    const activeProbe = jobs.find(
      (job) =>
        job.id === circuit.activeProbeJobId && ['claimed', 'awaiting_outcome'].includes(job.status)
    );
    if (activeProbe) return circuit;
    const nextPending = jobs
      .filter(
        (job) =>
          job.circuitKey === circuit.key && ['pending', 'failed_retryable'].includes(job.status)
      )
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0];
    return {
      ...circuit,
      status: nextPending ? 'open' : 'closed',
      activeProbeJobId: undefined,
      nextProbeAt: nextPending?.nextAttemptAt ?? nowIso,
      updatedAt: nowIso,
    };
  }
}
