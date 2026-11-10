import type {
  RuntimeRecoveryClockPort,
  RuntimeRecoveryNotificationPort,
  RuntimeRecoveryRepositoryPort,
} from './ports';
import type { RuntimeRecoveryCircuit, RuntimeRecoveryJob } from './types';

const CIRCUIT_RELEASE_STAGGER_MS = 5_000;

export class ObserveRecoveryOutcome {
  constructor(
    private readonly deps: {
      clock: RuntimeRecoveryClockPort;
      repository: RuntimeRecoveryRepositoryPort;
      notifications?: RuntimeRecoveryNotificationPort;
    }
  ) {}

  async markCompleted(input: { teamName: string; recoveryMessageId: string }): Promise<boolean> {
    const nowIso = this.deps.clock.now().toISOString();
    const completed = await this.deps.repository.update(input.teamName, (state) => {
      const job = state.jobs.find(
        (candidate) =>
          candidate.recoveryMessageId === input.recoveryMessageId &&
          candidate.status === 'awaiting_outcome'
      );
      if (!job) return { state, result: null as RuntimeRecoveryJob | null };
      const nextJobs = state.jobs.map((candidate) =>
        candidate.id === job.id
          ? { ...candidate, status: 'completed' as const, updatedAt: nowIso }
          : candidate
      );
      let staggerIndex = 0;
      const staggeredJobs = nextJobs.map((candidate) => {
        if (
          candidate.circuitKey !== job.circuitKey ||
          !['pending', 'failed_retryable'].includes(candidate.status)
        ) {
          return candidate;
        }
        staggerIndex += 1;
        return {
          ...candidate,
          nextAttemptAt: new Date(
            Math.max(
              Date.parse(candidate.nextAttemptAt),
              this.deps.clock.now().getTime() + staggerIndex * CIRCUIT_RELEASE_STAGGER_MS
            )
          ).toISOString(),
          updatedAt: nowIso,
        };
      });
      const circuits: RuntimeRecoveryCircuit[] = state.circuits.map((circuit) =>
        circuit.key === job.circuitKey
          ? {
              ...circuit,
              status: 'closed',
              activeProbeJobId: undefined,
              consecutiveFailures: 0,
              updatedAt: nowIso,
            }
          : circuit
      );
      return {
        state: { ...state, jobs: staggeredJobs, circuits, updatedAt: nowIso },
        result: job,
      };
    });
    if (completed) await this.deps.notifications?.completed?.(completed);
    return completed != null;
  }

  async expireUnknownOutcomes(teamNames: string[]): Promise<number> {
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    let expired = 0;
    for (const teamName of teamNames) {
      const result = await this.deps.repository.update(teamName, (state) => {
        const unknown: RuntimeRecoveryJob[] = [];
        const jobsWithUnknown = state.jobs.map((job) => {
          if (
            job.status !== 'awaiting_outcome' ||
            Date.parse(job.outcomeDeadlineAt ?? '') > now.getTime()
          ) {
            return job;
          }
          const next = {
            ...job,
            status: 'outcome_unknown' as const,
            updatedAt: nowIso,
            lastError: 'outcome_unknown',
          };
          unknown.push(next);
          return next;
        });
        const unknownCircuitKeys = new Set(unknown.map((job) => job.circuitKey));
        const suppressed: RuntimeRecoveryJob[] = [];
        const nextJobs = jobsWithUnknown.map((job) => {
          if (
            !unknownCircuitKeys.has(job.circuitKey) ||
            !['pending', 'failed_retryable'].includes(job.status)
          ) {
            return job;
          }
          const next: RuntimeRecoveryJob = {
            ...job,
            status: 'superseded',
            updatedAt: nowIso,
            lastError: 'circuit_probe_outcome_unknown',
          };
          suppressed.push(next);
          return next;
        });
        return {
          state: {
            ...state,
            jobs: nextJobs,
            circuits: state.circuits.map((circuit) =>
              unknownCircuitKeys.has(circuit.key)
                ? {
                    ...circuit,
                    status: 'closed' as const,
                    activeProbeJobId: undefined,
                    nextProbeAt: nowIso,
                    updatedAt: nowIso,
                  }
                : circuit
            ),
            updatedAt: unknown.length > 0 ? nowIso : state.updatedAt,
          },
          result: { unknown, suppressed },
        };
      });
      expired += result.unknown.length;
      for (const job of result.unknown) {
        await this.deps.notifications?.failed?.(job, 'outcome_unknown');
      }
      for (const job of result.suppressed) {
        await this.deps.notifications?.cancelled?.(job, 'circuit_probe_outcome_unknown');
      }
    }
    return expired;
  }
}
