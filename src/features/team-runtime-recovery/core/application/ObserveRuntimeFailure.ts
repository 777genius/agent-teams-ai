import {
  buildRuntimeRecoveryCircuitKey,
  buildRuntimeRecoveryMessageId,
  classifyRuntimeFailure,
  planRuntimeRecovery,
} from '../domain';

import type { RuntimeFailureSignal } from '../../contracts';
import type {
  RuntimeRecoveryClockPort,
  RuntimeRecoveryConfigPort,
  RuntimeRecoveryHashPort,
  RuntimeRecoveryNotificationPort,
  RuntimeRecoveryRepositoryPort,
} from './ports';
import type { RuntimeRecoveryJob, RuntimeRecoveryTeamState } from './types';

const PROCESSED_SIGNAL_IDS_LIMIT = 1_000;
const JOB_HISTORY_LIMIT = 500;

export interface ObserveRuntimeFailureDeps {
  clock: RuntimeRecoveryClockPort;
  hash: RuntimeRecoveryHashPort;
  config: RuntimeRecoveryConfigPort;
  repository: RuntimeRecoveryRepositoryPort;
  notifications?: RuntimeRecoveryNotificationPort;
}

export type ObserveRuntimeFailureResult =
  | { outcome: 'scheduled'; job: RuntimeRecoveryJob }
  | { outcome: 'duplicate' | 'observed_retrying' }
  | { outcome: 'manual'; reason: string };

function appendProcessedSignal(state: RuntimeRecoveryTeamState, signalId: string): string[] {
  return [...state.processedSignalIds.filter((id) => id !== signalId), signalId].slice(
    -PROCESSED_SIGNAL_IDS_LIMIT
  );
}

function findActiveCausedJob(
  state: RuntimeRecoveryTeamState,
  recoveryMessageId: string | undefined
): RuntimeRecoveryJob | undefined {
  if (!recoveryMessageId) return undefined;
  return state.jobs.find(
    (candidate) =>
      ['claimed', 'awaiting_outcome'].includes(candidate.status) &&
      (candidate.recoveryMessageId === recoveryMessageId ||
        buildRuntimeRecoveryMessageId(candidate) === recoveryMessageId)
  );
}

function terminateCorrelatedCircuit(input: {
  state: RuntimeRecoveryTeamState;
  causedJob: RuntimeRecoveryJob;
  failedJob: RuntimeRecoveryJob;
  nowIso: string;
  suppressedReason: string;
}): Pick<RuntimeRecoveryTeamState, 'jobs' | 'circuits'> {
  return {
    jobs: input.state.jobs.map((candidate) => {
      if (candidate.id === input.causedJob.id) return input.failedJob;
      if (
        candidate.circuitKey === input.causedJob.circuitKey &&
        ['pending', 'failed_retryable'].includes(candidate.status)
      ) {
        return {
          ...candidate,
          status: 'superseded' as const,
          updatedAt: input.nowIso,
          lastError: input.suppressedReason,
        };
      }
      return candidate;
    }),
    circuits: input.state.circuits.map((circuit) =>
      circuit.key === input.causedJob.circuitKey
        ? {
            ...circuit,
            status: 'closed' as const,
            activeProbeJobId: undefined,
            nextProbeAt: input.nowIso,
            updatedAt: input.nowIso,
          }
        : circuit
    ),
  };
}

export class ObserveRuntimeFailure {
  constructor(private readonly deps: ObserveRuntimeFailureDeps) {}

  async execute(signal: RuntimeFailureSignal): Promise<ObserveRuntimeFailureResult> {
    const classification = classifyRuntimeFailure(signal);
    if (classification.disposition === 'observe_only') {
      return { outcome: 'observed_retrying' };
    }

    const config = this.deps.config.getConfig();
    const normalizedDetailHash = this.deps.hash.sha256Hex(classification.normalizedDetail);
    const plan = planRuntimeRecovery({
      signal,
      classification,
      config,
      attempt: 0,
      now: this.deps.clock.now(),
    });
    if (plan.kind === 'manual') {
      const result = await this.deps.repository.update<ObserveRuntimeFailureResult>(
        signal.teamName,
        (state) => {
          if (state.processedSignalIds.includes(signal.id)) {
            return { state, result: { outcome: 'duplicate' } };
          }
          const causedJob = findActiveCausedJob(state, signal.causedByRecoveryMessageId);
          if (causedJob) {
            const failedJob: RuntimeRecoveryJob = {
              ...causedJob,
              signal: { ...signal, detail: classification.normalizedDetail },
              reasonCode: classification.reasonCode,
              normalizedDetailHash,
              status: 'failed_terminal',
              claimedBy: undefined,
              claimedAt: undefined,
              recoveryMessageId: undefined,
              outcomeDeadlineAt: undefined,
              updatedAt: this.deps.clock.now().toISOString(),
              lastError: plan.reason,
            };
            const terminal = terminateCorrelatedCircuit({
              state,
              causedJob,
              failedJob,
              nowIso: failedJob.updatedAt,
              suppressedReason: 'circuit_probe_failed_terminal',
            });
            return {
              state: {
                ...state,
                ...terminal,
                processedSignalIds: appendProcessedSignal(state, signal.id),
                updatedAt: failedJob.updatedAt,
              },
              result: { outcome: 'manual', reason: plan.reason },
            };
          }
          return {
            state: {
              ...state,
              processedSignalIds: appendProcessedSignal(state, signal.id),
              updatedAt: this.deps.clock.now().toISOString(),
            },
            result: { outcome: 'manual', reason: plan.reason },
          };
        }
      );
      if (result.outcome === 'manual' && plan.reason !== 'disabled') {
        await this.deps.notifications?.manual?.(signal, plan.reason);
      }
      return result;
    }

    const nowIso = this.deps.clock.now().toISOString();
    const jobId = `runtime-recovery-${this.deps.hash
      .sha256Hex(`${signal.contextId}\n${signal.teamName}\n${signal.memberName}\n${signal.id}`)
      .slice(0, 24)}`;
    const job: RuntimeRecoveryJob = {
      id: jobId,
      signal: {
        ...signal,
        detail: classification.normalizedDetail,
        ...(classification.statusCode ? { statusCode: classification.statusCode } : {}),
      },
      reasonCode: classification.reasonCode,
      normalizedDetailHash,
      circuitKey: buildRuntimeRecoveryCircuitKey(signal),
      status: 'pending',
      attempt: 0,
      nextAttemptAt: plan.nextAttemptAt,
      expiresAt: plan.expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const result = await this.deps.repository.update<ObserveRuntimeFailureResult>(
      signal.teamName,
      (state) => {
        if (state.processedSignalIds.includes(signal.id)) {
          return { state, result: { outcome: 'duplicate' } as const };
        }
        const causedJob = findActiveCausedJob(state, signal.causedByRecoveryMessageId);
        if (causedJob) {
          const chainedPlan = planRuntimeRecovery({
            signal,
            classification,
            config,
            attempt: Math.max(causedJob.attempt, 1),
            now: this.deps.clock.now(),
          });
          if (chainedPlan.kind === 'manual') {
            const failedJob: RuntimeRecoveryJob = {
              ...causedJob,
              signal: { ...signal, detail: classification.normalizedDetail },
              reasonCode: classification.reasonCode,
              normalizedDetailHash,
              status: 'failed_terminal',
              claimedBy: undefined,
              claimedAt: undefined,
              recoveryMessageId: undefined,
              outcomeDeadlineAt: undefined,
              updatedAt: nowIso,
              lastError: chainedPlan.reason,
            };
            const terminal = terminateCorrelatedCircuit({
              state,
              causedJob,
              failedJob,
              nowIso,
              suppressedReason: 'circuit_probe_attempts_exhausted',
            });
            return {
              state: {
                ...state,
                ...terminal,
                processedSignalIds: appendProcessedSignal(state, signal.id),
                updatedAt: nowIso,
              },
              result: { outcome: 'manual', reason: chainedPlan.reason } as const,
            };
          }
          const retriedJob: RuntimeRecoveryJob = {
            ...causedJob,
            signal: { ...signal, detail: classification.normalizedDetail },
            reasonCode: classification.reasonCode,
            normalizedDetailHash,
            status: 'pending',
            attempt: Math.max(causedJob.attempt, 1),
            nextAttemptAt: chainedPlan.nextAttemptAt,
            expiresAt: chainedPlan.expiresAt,
            updatedAt: nowIso,
            claimedBy: undefined,
            claimedAt: undefined,
            recoveryMessageId: undefined,
            outcomeDeadlineAt: undefined,
            lastError: classification.normalizedDetail,
          };
          return {
            state: {
              ...state,
              jobs: state.jobs.map((candidate) =>
                candidate.id === causedJob.id ? retriedJob : candidate
              ),
              circuits: state.circuits.map((circuit) =>
                circuit.key === causedJob.circuitKey
                  ? {
                      ...circuit,
                      status: 'open' as const,
                      activeProbeJobId: undefined,
                      consecutiveFailures: circuit.consecutiveFailures + 1,
                      nextProbeAt: chainedPlan.nextAttemptAt,
                      updatedAt: nowIso,
                    }
                  : circuit
              ),
              processedSignalIds: appendProcessedSignal(state, signal.id),
              updatedAt: nowIso,
            },
            result: { outcome: 'scheduled', job: retriedJob } as const,
          };
        }
        if (signal.causedByRecoveryMessageId) {
          return {
            state: {
              ...state,
              processedSignalIds: appendProcessedSignal(state, signal.id),
              updatedAt: nowIso,
            },
            result: { outcome: 'duplicate' } as const,
          };
        }
        const coalesced = state.jobs.find(
          (candidate) =>
            candidate.signal.memberName.toLowerCase() === signal.memberName.toLowerCase() &&
            candidate.signal.runtimeSessionId === signal.runtimeSessionId &&
            candidate.normalizedDetailHash === normalizedDetailHash &&
            ['pending', 'claimed', 'awaiting_outcome', 'failed_retryable'].includes(
              candidate.status
            )
        );
        if (coalesced) {
          return {
            state: {
              ...state,
              processedSignalIds: appendProcessedSignal(state, signal.id),
              updatedAt: nowIso,
            },
            result: { outcome: 'duplicate' } as const,
          };
        }
        return {
          state: {
            ...state,
            jobs: [...state.jobs, job].slice(-JOB_HISTORY_LIMIT),
            circuits: state.circuits.some((circuit) => circuit.key === job.circuitKey)
              ? state.circuits.map((circuit) =>
                  circuit.key === job.circuitKey &&
                  Date.parse(job.nextAttemptAt) < Date.parse(circuit.nextProbeAt)
                    ? { ...circuit, nextProbeAt: job.nextAttemptAt, updatedAt: nowIso }
                    : circuit
                )
              : [
                  ...state.circuits,
                  {
                    key: job.circuitKey,
                    status: 'open' as const,
                    consecutiveFailures: 1,
                    nextProbeAt: job.nextAttemptAt,
                    updatedAt: nowIso,
                  },
                ].slice(-500),
            processedSignalIds: appendProcessedSignal(state, signal.id),
            updatedAt: nowIso,
          },
          result: { outcome: 'scheduled', job } as const,
        };
      }
    );

    if (result.outcome === 'scheduled') {
      await this.deps.notifications?.scheduled?.(result.job);
    } else if (result.outcome === 'manual') {
      await this.deps.notifications?.manual?.(signal, result.reason);
    }
    return result;
  }
}
