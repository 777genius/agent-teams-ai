import { ObserveRuntimeFailure } from '@features/team-runtime-recovery';
import { describe, expect, it } from 'vitest';

import type {
  RuntimeFailureSignal,
  RuntimeRecoveryRepositoryPort,
  RuntimeRecoveryTeamState,
} from '@features/team-runtime-recovery';

class MemoryRepository implements RuntimeRecoveryRepositoryPort {
  readonly states = new Map<string, RuntimeRecoveryTeamState>();

  async read(teamName: string): Promise<RuntimeRecoveryTeamState> {
    return (
      this.states.get(teamName) ?? {
        schemaVersion: 1,
        teamName,
        jobs: [],
        circuits: [],
        processedSignalIds: [],
        updatedAt: '2026-07-16T10:00:00.000Z',
      }
    );
  }

  async update<T>(
    teamName: string,
    updater: (state: RuntimeRecoveryTeamState) => { state: RuntimeRecoveryTeamState; result: T }
  ): Promise<T> {
    const updated = updater(await this.read(teamName));
    this.states.set(teamName, updated.state);
    return updated.result;
  }

  async listTeamNames(): Promise<string[]> {
    return [...this.states.keys()];
  }
}

function makeSignal(id: string): RuntimeFailureSignal {
  return {
    id,
    source: 'agent_error_mailbox',
    phase: 'terminal',
    observedAt: '2026-07-16T10:00:00.000Z',
    contextId: 'local',
    teamName: 'test-team',
    memberName: 'bob',
    targetKind: 'member',
    detail: 'API Error: 529 overloaded_error',
    runtimeSessionId: 'session-1',
  };
}

describe('ObserveRuntimeFailure', () => {
  it('persists one scheduled job and deduplicates the same signal', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:00:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });

    expect((await useCase.execute(makeSignal('failure-1'))).outcome).toBe('scheduled');
    expect((await useCase.execute(makeSignal('failure-1'))).outcome).toBe('duplicate');
    expect((await repository.read('test-team')).jobs).toHaveLength(1);
  });

  it('coalesces equivalent active failures from the same runtime session', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:00:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });

    await useCase.execute(makeSignal('failure-1'));
    expect((await useCase.execute(makeSignal('failure-2'))).outcome).toBe('duplicate');
    expect((await repository.read('test-team')).jobs).toHaveLength(1);
  });

  it('does not persist SDK retry heartbeats or disabled recovery', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:00:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: false,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });

    expect(
      (await useCase.execute({ ...makeSignal('failure-retrying'), phase: 'sdk_retrying' })).outcome
    ).toBe('observed_retrying');
    expect((await useCase.execute(makeSignal('failure-disabled'))).outcome).toBe('manual');
    expect((await repository.read('test-team')).jobs).toHaveLength(0);
  });

  it('turns a correlated terminal recovery failure into the next bounded attempt', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:02:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });
    const initial = await useCase.execute(makeSignal('failure-1'));
    expect(initial.outcome).toBe('scheduled');
    if (initial.outcome !== 'scheduled') return;
    await repository.update('test-team', (state) => ({
      state: {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === initial.job.id
            ? {
                ...job,
                status: 'awaiting_outcome' as const,
                attempt: 1,
                recoveryMessageId: 'recovery-message-1',
              }
            : job
        ),
      },
      result: undefined,
    }));

    const chained = await useCase.execute({
      ...makeSignal('failure-2'),
      observedAt: '2026-07-16T10:02:00.000Z',
      causedByRecoveryMessageId: 'recovery-message-1',
    });

    expect(chained).toMatchObject({ outcome: 'scheduled', job: { status: 'pending', attempt: 1 } });
    expect((await repository.read('test-team')).jobs).toHaveLength(1);
  });

  it('correlates a terminal failure that arrives while the recovery delivery is still claimed', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:02:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });
    const initial = await useCase.execute(makeSignal('failure-1'));
    expect(initial.outcome).toBe('scheduled');
    if (initial.outcome !== 'scheduled') return;
    await repository.update('test-team', (state) => ({
      state: {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === initial.job.id
            ? {
                ...job,
                status: 'claimed' as const,
                claimedBy: 'dispatcher',
                claimedAt: '2026-07-16T10:01:59.000Z',
              }
            : job
        ),
      },
      result: undefined,
    }));

    const chained = await useCase.execute({
      ...makeSignal('failure-2'),
      observedAt: '2026-07-16T10:02:00.000Z',
      causedByRecoveryMessageId: `${initial.job.id}-attempt-1`,
    });

    expect(chained).toMatchObject({ outcome: 'scheduled', job: { status: 'pending', attempt: 1 } });
    expect((await repository.read('test-team')).jobs[0]).toMatchObject({
      status: 'pending',
      attempt: 1,
      recoveryMessageId: undefined,
      claimedBy: undefined,
    });
  });

  it('does not resurrect a cancelled recovery from a late correlated failure', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:02:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });
    const initial = await useCase.execute(makeSignal('failure-1'));
    expect(initial.outcome).toBe('scheduled');
    if (initial.outcome !== 'scheduled') return;
    await repository.update('test-team', (state) => ({
      state: {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === initial.job.id
            ? {
                ...job,
                status: 'cancelled' as const,
                recoveryMessageId: `${job.id}-attempt-1`,
              }
            : job
        ),
      },
      result: undefined,
    }));

    await expect(
      useCase.execute({
        ...makeSignal('failure-late'),
        causedByRecoveryMessageId: `${initial.job.id}-attempt-1`,
      })
    ).resolves.toEqual({ outcome: 'duplicate' });
    expect((await repository.read('test-team')).jobs).toHaveLength(1);
    expect((await repository.read('test-team')).jobs[0].status).toBe('cancelled');
  });

  it('immediately terminalizes a correlated permanent error and suppresses its queued circuit', async () => {
    const repository = new MemoryRepository();
    const useCase = new ObserveRuntimeFailure({
      clock: { now: () => new Date('2026-07-16T10:02:00.000Z') },
      hash: { sha256Hex: (value) => `hash-${value}` },
      config: {
        getConfig: () => ({
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        }),
      },
      repository,
    });
    const first = await useCase.execute(makeSignal('failure-1'));
    const second = await useCase.execute({
      ...makeSignal('failure-2'),
      memberName: 'alice',
      runtimeSessionId: 'session-2',
    });
    expect(first.outcome).toBe('scheduled');
    expect(second.outcome).toBe('scheduled');
    if (first.outcome !== 'scheduled') return;
    await repository.update('test-team', (state) => ({
      state: {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === first.job.id
            ? {
                ...job,
                status: 'awaiting_outcome' as const,
                attempt: 1,
                recoveryMessageId: `${job.id}-attempt-1`,
                outcomeDeadlineAt: '2026-07-16T10:05:00.000Z',
              }
            : job
        ),
      },
      result: undefined,
    }));

    await expect(
      useCase.execute({
        ...makeSignal('auth-failure'),
        detail: 'API Error: 401 invalid API key',
        statusCode: 401,
        causedByRecoveryMessageId: `${first.job.id}-attempt-1`,
      })
    ).resolves.toMatchObject({ outcome: 'manual', reason: 'not_retryable' });

    const state = await repository.read('test-team');
    expect(state.jobs.find((job) => job.id === first.job.id)?.status).toBe('failed_terminal');
    expect(state.jobs.find((job) => job.id !== first.job.id)).toMatchObject({
      status: 'superseded',
      lastError: 'circuit_probe_failed_terminal',
    });
  });
});
