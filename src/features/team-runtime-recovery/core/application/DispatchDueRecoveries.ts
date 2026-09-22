import { buildRuntimeRecoveryPrompt } from '../domain';

import type { TeamRuntimeRecoveryConfig } from '../../contracts';
import type {
  RuntimeRecoveryClockPort,
  RuntimeRecoveryConfigPort,
  RuntimeRecoveryDeliveryPort,
  RuntimeRecoveryHashPort,
  RuntimeRecoveryLoggerPort,
  RuntimeRecoveryNotificationPort,
  RuntimeRecoveryRepositoryPort,
  RuntimeRecoveryTargetPort,
} from './ports';
import type { RuntimeRecoveryCircuit, RuntimeRecoveryJob } from './types';

const CLAIM_STALE_MS = 5 * 60_000;
const DELIVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const OUTCOME_TIMEOUT_MS = 5 * 60_000;

export interface DispatchDueRecoveriesDeps {
  clock: RuntimeRecoveryClockPort;
  hash: RuntimeRecoveryHashPort;
  config: RuntimeRecoveryConfigPort;
  repository: RuntimeRecoveryRepositoryPort;
  target: RuntimeRecoveryTargetPort;
  delivery: RuntimeRecoveryDeliveryPort;
  notifications?: RuntimeRecoveryNotificationPort;
  logger?: RuntimeRecoveryLoggerPort;
}

export interface DispatchDueRecoveriesSummary {
  claimed: number;
  delivered: number;
  completed: number;
  deferred: number;
  terminal: number;
}

function emptySummary(): DispatchDueRecoveriesSummary {
  return { claimed: 0, delivered: 0, completed: 0, deferred: 0, terminal: 0 };
}

function isDue(job: RuntimeRecoveryJob, nowMs: number): boolean {
  return (
    ['pending', 'failed_retryable'].includes(job.status) &&
    Date.parse(job.nextAttemptAt) <= nowMs &&
    Date.parse(job.expiresAt) > nowMs
  );
}

function releaseCircuit(
  circuits: RuntimeRecoveryCircuit[],
  circuitKey: string,
  nowIso: string,
  nextProbeAt?: string
): RuntimeRecoveryCircuit[] {
  return circuits.map((circuit) =>
    circuit.key === circuitKey
      ? {
          ...circuit,
          status: nextProbeAt ? ('open' as const) : ('closed' as const),
          activeProbeJobId: undefined,
          nextProbeAt: nextProbeAt ?? nowIso,
          updatedAt: nowIso,
        }
      : circuit
  );
}

export class DispatchDueRecoveries {
  constructor(private readonly deps: DispatchDueRecoveriesDeps) {}

  async execute(input: {
    teamNames: string[];
    claimedBy: string;
    limit?: number;
  }): Promise<DispatchDueRecoveriesSummary> {
    const summary = emptySummary();
    const limit = Math.max(1, input.limit ?? 10);
    for (const teamName of [
      ...new Set(input.teamNames.map((name) => name.trim()).filter(Boolean)),
    ]) {
      if (summary.claimed >= limit) break;
      const sweep = await this.claimTeam(teamName, input.claimedBy, limit - summary.claimed);
      summary.claimed += sweep.claimed.length;
      summary.terminal += sweep.expired.length;
      for (const job of sweep.expired) {
        await this.deps.notifications?.cancelled?.(job, 'expired');
      }
      for (const job of sweep.claimed) {
        try {
          const outcome = await this.dispatchJob(job);
          summary[outcome] += 1;
        } catch (error) {
          this.deps.logger?.warn('team runtime recovery dispatch failed', {
            teamName: job.signal.teamName,
            jobId: job.id,
            error: String(error),
          });
        }
      }
    }
    return summary;
  }

  private async claimTeam(
    teamName: string,
    claimedBy: string,
    limit: number
  ): Promise<{ claimed: RuntimeRecoveryJob[]; expired: RuntimeRecoveryJob[] }> {
    const now = this.deps.clock.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    return this.deps.repository.update(teamName, (state) => {
      const expired: RuntimeRecoveryJob[] = [];
      const recoveredJobs = state.jobs.map((job) => {
        const staleClaim =
          job.status === 'claimed' && nowMs - Date.parse(job.claimedAt ?? '') >= CLAIM_STALE_MS;
        if (
          (['pending', 'failed_retryable'].includes(job.status) || staleClaim) &&
          Date.parse(job.expiresAt) <= nowMs
        ) {
          const expiredJob: RuntimeRecoveryJob = {
            ...job,
            status: 'superseded',
            claimedBy: undefined,
            claimedAt: undefined,
            updatedAt: nowIso,
            lastError: 'expired',
          };
          expired.push(expiredJob);
          return expiredJob;
        }
        if (staleClaim) {
          return {
            ...job,
            status: 'failed_retryable' as const,
            claimedBy: undefined,
            claimedAt: undefined,
            nextAttemptAt: nowIso,
            updatedAt: nowIso,
            lastError: 'stale_claim_recovered',
          };
        }
        return job;
      });
      const nextCircuits = expired.reduce(
        (circuits, job) => {
          const circuit = circuits.find((candidate) => candidate.key === job.circuitKey);
          if (circuit?.activeProbeJobId && circuit.activeProbeJobId !== job.id) return circuits;
          return releaseCircuit(circuits, job.circuitKey, nowIso);
        },
        [...state.circuits]
      );
      const selected: RuntimeRecoveryJob[] = [];
      const selectedCircuitKeys = new Set<string>();
      for (const job of recoveredJobs
        .filter((candidate) => isDue(candidate, nowMs))
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))) {
        if (selected.length >= limit || selectedCircuitKeys.has(job.circuitKey)) continue;
        const circuitIndex = nextCircuits.findIndex((circuit) => circuit.key === job.circuitKey);
        const circuit = circuitIndex >= 0 ? nextCircuits[circuitIndex] : undefined;
        if (
          circuit?.activeProbeJobId ||
          (circuit?.status === 'open' && Date.parse(circuit.nextProbeAt) > nowMs)
        ) {
          continue;
        }
        const claimedJob: RuntimeRecoveryJob = {
          ...job,
          status: 'claimed',
          claimedBy,
          claimedAt: nowIso,
          updatedAt: nowIso,
        };
        selected.push(claimedJob);
        selectedCircuitKeys.add(job.circuitKey);
        const claimedCircuit: RuntimeRecoveryCircuit = {
          key: job.circuitKey,
          status: 'half_open',
          consecutiveFailures: circuit?.consecutiveFailures ?? 1,
          nextProbeAt: circuit?.nextProbeAt ?? nowIso,
          activeProbeJobId: job.id,
          updatedAt: nowIso,
        };
        if (circuitIndex >= 0) nextCircuits[circuitIndex] = claimedCircuit;
        else nextCircuits.push(claimedCircuit);
      }
      const selectedById = new Map(selected.map((job) => [job.id, job]));
      return {
        state: {
          ...state,
          jobs: recoveredJobs.map((job) => selectedById.get(job.id) ?? job),
          circuits: nextCircuits,
          updatedAt: nowIso,
        },
        result: { claimed: selected, expired },
      };
    });
  }

  private async dispatchJob(
    job: RuntimeRecoveryJob
  ): Promise<'delivered' | 'completed' | 'deferred' | 'terminal'> {
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    if (Date.parse(job.expiresAt) <= now.getTime()) {
      await this.finishTerminal(job, 'expired', 'superseded');
      return 'terminal';
    }

    let preflight: Awaited<ReturnType<RuntimeRecoveryTargetPort['preflight']>>;
    try {
      preflight = await this.deps.target.preflight(job);
    } catch (error) {
      this.deps.logger?.warn('team runtime recovery preflight failed', {
        teamName: job.signal.teamName,
        jobId: job.id,
        error: String(error),
      });
      await this.defer(job, 'preflight_infrastructure_error');
      return 'deferred';
    }
    if (!preflight.ok) {
      if (preflight.retryable) {
        await this.defer(job, preflight.reason, preflight.retryAt);
        return 'deferred';
      }
      if (preflight.escalateToLead && preflight.leadName && this.deps.delivery.escalate) {
        try {
          await this.deps.delivery.escalate({
            job,
            leadName: preflight.leadName,
            reason: preflight.reason,
          });
        } catch (error) {
          this.deps.logger?.warn('team runtime recovery escalation failed', {
            teamName: job.signal.teamName,
            jobId: job.id,
            error: String(error),
          });
        }
      }
      await this.finishTerminal(job, preflight.reason, 'superseded');
      return 'terminal';
    }

    const config: TeamRuntimeRecoveryConfig = this.deps.config.getConfig();
    const text = buildRuntimeRecoveryPrompt({
      recoveryId: job.id,
      attempt: job.attempt + 1,
      maxAttempts: config.maxAttempts,
      reasonCode: job.reasonCode,
      targetKind: preflight.targetKind,
      taskRefs: job.signal.taskRefs,
    });
    const payloadHash = this.deps.hash.sha256Hex(text);
    let delivery: Awaited<ReturnType<RuntimeRecoveryDeliveryPort['deliver']>>;
    try {
      delivery = await this.deps.delivery.deliver({
        job,
        memberName: preflight.memberName,
        text,
        payloadHash,
        reasonCode: job.reasonCode,
      });
    } catch (error) {
      this.deps.logger?.warn('team runtime recovery delivery failed', {
        teamName: job.signal.teamName,
        jobId: job.id,
        error: String(error),
      });
      await this.defer(job, 'delivery_infrastructure_error');
      return 'deferred';
    }
    if (!delivery.ok) {
      if (delivery.retryable) {
        await this.defer(job, delivery.reason, delivery.retryAt);
        return 'deferred';
      }
      await this.finishTerminal(job, delivery.reason, 'failed_terminal');
      return 'terminal';
    }

    const persisted = await this.deps.repository.update(job.signal.teamName, (state) => {
      const current = state.jobs.find((candidate) => candidate.id === job.id);
      if (
        current?.status !== 'claimed' ||
        current.claimedBy !== job.claimedBy ||
        current.claimedAt !== job.claimedAt
      ) {
        return { state, result: false };
      }
      const completed = delivery.responseProven === true;
      const updatedJob: RuntimeRecoveryJob = {
        ...job,
        status: completed ? 'completed' : 'awaiting_outcome',
        attempt: job.attempt + (delivery.accepted ? 1 : 0),
        recoveryMessageId: delivery.messageId,
        claimedBy: undefined,
        claimedAt: undefined,
        outcomeDeadlineAt: completed
          ? undefined
          : new Date(this.deps.clock.now().getTime() + OUTCOME_TIMEOUT_MS).toISOString(),
        updatedAt: nowIso,
      };
      const jobs = state.jobs.map((candidate) =>
        candidate.id === job.id ? updatedJob : candidate
      );
      return {
        state: {
          ...state,
          jobs,
          circuits: completed
            ? releaseCircuit(state.circuits, job.circuitKey, nowIso)
            : state.circuits,
          updatedAt: nowIso,
        },
        result: true,
      };
    });
    if (!persisted) return 'terminal';
    if (delivery.responseProven) {
      await this.deps.notifications?.completed?.(job);
      return 'completed';
    }
    return 'delivered';
  }

  private async defer(job: RuntimeRecoveryJob, reason: string, retryAt?: string): Promise<void> {
    const now = this.deps.clock.now();
    const deliveryRetryIndex = Math.min(job.attempt, DELIVERY_RETRY_DELAYS_MS.length - 1);
    const parsedRetryAt = Date.parse(retryAt ?? '');
    const nextAttemptAt = Number.isFinite(parsedRetryAt)
      ? new Date(parsedRetryAt).toISOString()
      : new Date(now.getTime() + DELIVERY_RETRY_DELAYS_MS[deliveryRetryIndex]).toISOString();
    await this.deps.repository.update(job.signal.teamName, (state) => {
      const current = state.jobs.find((candidate) => candidate.id === job.id);
      if (
        current?.status !== 'claimed' ||
        current.claimedBy !== job.claimedBy ||
        current.claimedAt !== job.claimedAt
      ) {
        return { state, result: false };
      }
      return {
        state: {
          ...state,
          jobs: state.jobs.map((candidate) =>
            candidate.id === job.id
              ? {
                  ...job,
                  status: 'failed_retryable' as const,
                  claimedBy: undefined,
                  claimedAt: undefined,
                  nextAttemptAt,
                  updatedAt: now.toISOString(),
                  lastError: reason,
                }
              : candidate
          ),
          circuits: releaseCircuit(
            state.circuits,
            job.circuitKey,
            now.toISOString(),
            nextAttemptAt
          ),
          updatedAt: now.toISOString(),
        },
        result: true,
      };
    });
  }

  private async finishTerminal(
    job: RuntimeRecoveryJob,
    reason: string,
    status: 'superseded' | 'failed_terminal'
  ): Promise<void> {
    const nowIso = this.deps.clock.now().toISOString();
    const persisted = await this.deps.repository.update(job.signal.teamName, (state) => {
      const current = state.jobs.find((candidate) => candidate.id === job.id);
      if (
        current?.status !== 'claimed' ||
        current.claimedBy !== job.claimedBy ||
        current.claimedAt !== job.claimedAt
      ) {
        return { state, result: false };
      }
      return {
        state: {
          ...state,
          jobs: state.jobs.map((candidate) =>
            candidate.id === job.id
              ? {
                  ...job,
                  status,
                  claimedBy: undefined,
                  claimedAt: undefined,
                  updatedAt: nowIso,
                  lastError: reason,
                }
              : candidate
          ),
          circuits: releaseCircuit(state.circuits, job.circuitKey, nowIso),
          updatedAt: nowIso,
        },
        result: true,
      };
    });
    if (!persisted) return;
    if (status === 'superseded') await this.deps.notifications?.cancelled?.(job, reason);
    else await this.deps.notifications?.failed?.(job, reason);
  }
}
