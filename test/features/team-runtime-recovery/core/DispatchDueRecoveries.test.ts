import {
  CancelRuntimeRecoveries,
  CancelStaleRecoveries,
  DispatchDueRecoveries,
  ObserveRecoveryOutcome,
  type RuntimeRecoveryDeliveryPort,
  type RuntimeRecoveryJob,
  type RuntimeRecoveryTargetPort,
  type RuntimeRecoveryTeamState,
} from '@features/team-runtime-recovery/core/application';
import { describe, expect, it, type Mock, vi } from 'vitest';

const NOW = new Date('2026-07-16T10:00:00.000Z');

function makeJob(index: number, circuitKey = 'same-circuit'): RuntimeRecoveryJob {
  return {
    id: `job-${index}`,
    signal: {
      id: `signal-${index}`,
      source: 'agent_error_mailbox',
      phase: 'terminal',
      observedAt: '2026-07-16T09:59:00.000Z',
      contextId: 'local',
      teamName: 'sandbox-team',
      memberName: `member-${index}`,
      targetKind: 'member',
      detail: 'API Error: 529 overloaded_error',
      providerId: 'anthropic',
    },
    reasonCode: 'provider_overloaded',
    normalizedDetailHash: `hash-${index}`,
    circuitKey,
    status: 'pending',
    attempt: 0,
    nextAttemptAt: NOW.toISOString(),
    expiresAt: '2026-07-16T12:00:00.000Z',
    createdAt: '2026-07-16T09:59:00.000Z',
    updatedAt: '2026-07-16T09:59:00.000Z',
  };
}

function createRepository(jobs: RuntimeRecoveryJob[]) {
  let state: RuntimeRecoveryTeamState = {
    schemaVersion: 1,
    teamName: 'sandbox-team',
    jobs,
    circuits: [...new Set(jobs.map((job) => job.circuitKey))].map((key) => ({
      key,
      status: 'open' as const,
      consecutiveFailures: 1,
      nextProbeAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
    processedSignalIds: [],
    updatedAt: NOW.toISOString(),
  };
  return {
    read: async () => structuredClone(state),
    listTeamNames: async () => ['sandbox-team'],
    update: async <T>(
      _teamName: string,
      updater: (current: RuntimeRecoveryTeamState) => {
        state: RuntimeRecoveryTeamState;
        result: T;
      }
    ) => {
      const updated = updater(structuredClone(state));
      state = updated.state;
      return updated.result;
    },
    getState: () => state,
  };
}

function createDispatcher(
  jobs: RuntimeRecoveryJob[],
  delivery: Mock<RuntimeRecoveryDeliveryPort['deliver']> = vi.fn(async () => ({
    ok: true as const,
    messageId: 'recovery-message',
    accepted: false,
  })),
  target: RuntimeRecoveryTargetPort = {
    preflight: async (job) => ({
      ok: true as const,
      memberName: job.signal.memberName,
      targetKind: job.signal.targetKind,
    }),
  }
) {
  const repository = createRepository(jobs);
  const dispatcher = new DispatchDueRecoveries({
    clock: { now: () => NOW },
    hash: { sha256Hex: (value) => `hash:${value.length}` },
    config: {
      getConfig: () => ({
        transientErrorsEnabled: true,
        rateLimitsEnabled: true,
        initialDelaySeconds: 60,
        maxAttempts: 2,
      }),
    },
    repository,
    target,
    delivery: { deliver: delivery },
  });
  return { dispatcher, repository, delivery };
}

describe('DispatchDueRecoveries', () => {
  it('releases one half-open probe when ten teammates share a provider circuit', async () => {
    const { dispatcher, delivery, repository } = createDispatcher(
      Array.from({ length: 10 }, (_, index) => makeJob(index))
    );

    const summary = await dispatcher.execute({
      teamNames: ['sandbox-team'],
      claimedBy: 'test',
      limit: 10,
    });

    expect(summary.claimed).toBe(1);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(
      repository.getState().jobs.filter((job) => job.status === 'awaiting_outcome')
    ).toHaveLength(1);
  });

  it('does not block independent provider/model circuits', async () => {
    const { dispatcher, delivery } = createDispatcher([
      makeJob(1, 'anthropic:model-a'),
      makeJob(2, 'opencode:model-b'),
    ]);

    const summary = await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(summary.claimed).toBe(2);
    expect(delivery).toHaveBeenCalledTimes(2);
  });

  it('recovers a stale claim after process restart', async () => {
    const job = {
      ...makeJob(1),
      status: 'claimed' as const,
      claimedBy: 'dead-process',
      claimedAt: '2026-07-16T09:50:00.000Z',
    };
    const { dispatcher, delivery } = createDispatcher([job]);

    await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'new-process' });

    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('does not consume a model attempt when inbox delivery is retryable', async () => {
    const delivery = vi.fn(async () => ({
      ok: false as const,
      retryable: true,
      reason: 'temporary_file_lock',
    }));
    const { dispatcher, repository } = createDispatcher([makeJob(1)], delivery);

    await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(repository.getState().jobs[0]).toMatchObject({
      status: 'failed_retryable',
      attempt: 0,
      lastError: 'temporary_file_lock',
    });
  });

  it('does not resurrect a job cancelled while delivery is in flight', async () => {
    let resolveDelivery:
      | ((value: { ok: true; messageId: string; accepted: boolean }) => void)
      | undefined;
    const delivery: Mock<RuntimeRecoveryDeliveryPort['deliver']> = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDelivery = resolve;
        })
    );
    const { dispatcher, repository } = createDispatcher([makeJob(1)], delivery);

    const dispatch = dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await repository.update('sandbox-team', (state) => ({
      state: {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === 'job-1' ? { ...job, status: 'cancelled' as const } : job
        ),
      },
      result: undefined,
    }));
    resolveDelivery?.({ ok: true, messageId: 'late-delivery', accepted: true });
    await dispatch;

    expect(repository.getState().jobs[0].status).toBe('cancelled');
  });

  it('terminally expires overdue pending jobs instead of waking forever', async () => {
    const job = {
      ...makeJob(1),
      expiresAt: '2026-07-16T09:59:59.000Z',
    };
    const { dispatcher, delivery, repository } = createDispatcher([job]);

    const summary = await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(summary).toMatchObject({ claimed: 0, terminal: 1 });
    expect(delivery).not.toHaveBeenCalled();
    expect(repository.getState().jobs[0]).toMatchObject({
      status: 'superseded',
      lastError: 'expired',
    });
  });

  it('does not release another in-flight probe when an adjacent pending job expires', async () => {
    const claimed = {
      ...makeJob(1),
      status: 'claimed' as const,
      claimedBy: 'other-dispatcher',
      claimedAt: '2026-07-16T09:59:59.000Z',
    };
    const expired = {
      ...makeJob(2),
      expiresAt: '2026-07-16T09:59:59.000Z',
    };
    const { dispatcher, repository } = createDispatcher([claimed, expired]);
    await repository.update('sandbox-team', (state) => ({
      state: {
        ...state,
        circuits: state.circuits.map((circuit) => ({
          ...circuit,
          status: 'half_open' as const,
          activeProbeJobId: claimed.id,
        })),
      },
      result: undefined,
    }));

    await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(repository.getState().circuits[0]).toMatchObject({
      status: 'half_open',
      activeProbeJobId: claimed.id,
    });
  });

  it('defers without consuming an attempt when preflight infrastructure throws', async () => {
    const target: RuntimeRecoveryTargetPort = {
      preflight: vi.fn(async () => {
        throw new Error('temporary snapshot read failure');
      }),
    };
    const { dispatcher, delivery, repository } = createDispatcher([makeJob(1)], undefined, target);

    await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(delivery).not.toHaveBeenCalled();
    expect(repository.getState().jobs[0]).toMatchObject({
      status: 'failed_retryable',
      attempt: 0,
      lastError: 'preflight_infrastructure_error',
    });
  });

  it('defers without consuming an attempt when a delivery port throws', async () => {
    const delivery = vi.fn(async () => {
      throw new Error('temporary inbox write failure');
    });
    const { dispatcher, repository } = createDispatcher([makeJob(1)], delivery);

    await dispatcher.execute({ teamNames: ['sandbox-team'], claimedBy: 'test' });

    expect(repository.getState().jobs[0]).toMatchObject({
      status: 'failed_retryable',
      attempt: 0,
      lastError: 'delivery_infrastructure_error',
    });
  });
});

describe('CancelStaleRecoveries', () => {
  it('cancels a stale member job and emits one lead escalation', async () => {
    const repository = createRepository([makeJob(1)]);
    const cancel = new CancelRuntimeRecoveries({
      clock: { now: () => NOW },
      repository,
    });
    const escalate = vi.fn();
    const reconcile = new CancelStaleRecoveries({
      repository,
      cancel,
      target: {
        preflight: async () => ({
          ok: false as const,
          retryable: false,
          reason: 'member_removed',
          escalateToLead: true,
          leadName: 'team-lead',
        }),
      },
      delivery: { escalate },
    });

    await expect(reconcile.execute('sandbox-team')).resolves.toBe(1);
    expect(repository.getState().jobs[0]).toMatchObject({
      status: 'cancelled',
      lastError: 'member_removed',
    });
    expect(escalate).toHaveBeenCalledOnce();
  });
});

describe('CancelRuntimeRecoveries', () => {
  it('preserves an in-flight circuit probe when only another pending job is cancelled', async () => {
    const claimed = {
      ...makeJob(1),
      status: 'claimed' as const,
      claimedBy: 'dispatcher',
      claimedAt: NOW.toISOString(),
    };
    const pending = makeJob(2);
    const repository = createRepository([claimed, pending]);
    await repository.update('sandbox-team', (state) => ({
      state: {
        ...state,
        circuits: state.circuits.map((circuit) => ({
          ...circuit,
          status: 'half_open' as const,
          activeProbeJobId: claimed.id,
        })),
      },
      result: undefined,
    }));
    const cancel = new CancelRuntimeRecoveries({
      clock: { now: () => NOW },
      repository,
    });

    await cancel.execute({
      teamName: 'sandbox-team',
      reason: 'member_removed',
      matches: (job) => job.id === pending.id,
    });

    expect(repository.getState().circuits[0]).toMatchObject({
      status: 'half_open',
      activeProbeJobId: claimed.id,
    });
    expect(repository.getState().jobs.find((job) => job.id === claimed.id)?.status).toBe('claimed');
  });
});

describe('ObserveRecoveryOutcome', () => {
  it('moves an unproven delivery to outcome_unknown without a blind retry', async () => {
    const job = {
      ...makeJob(1),
      status: 'awaiting_outcome' as const,
      recoveryMessageId: 'recovery-1',
      outcomeDeadlineAt: '2026-07-16T09:59:59.000Z',
    };
    const queuedSameCircuit = makeJob(2);
    const queuedIndependent = makeJob(3, 'independent-circuit');
    const repository = createRepository([job, queuedSameCircuit, queuedIndependent]);
    const failed = vi.fn();
    const cancelled = vi.fn();
    const observer = new ObserveRecoveryOutcome({
      clock: { now: () => NOW },
      repository,
      notifications: { failed, cancelled },
    });

    expect(await observer.expireUnknownOutcomes(['sandbox-team'])).toBe(1);
    expect(repository.getState().jobs[0].status).toBe('outcome_unknown');
    expect(repository.getState().jobs[1]).toMatchObject({
      status: 'superseded',
      lastError: 'circuit_probe_outcome_unknown',
    });
    expect(repository.getState().jobs[2].status).toBe('pending');
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'outcome_unknown'
    );
    expect(cancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-2' }),
      'circuit_probe_outcome_unknown'
    );
  });

  it('never moves a later server-hinted attempt earlier when releasing a circuit', async () => {
    const completedProbe = {
      ...makeJob(1),
      status: 'awaiting_outcome' as const,
      recoveryMessageId: 'recovery-1',
      outcomeDeadlineAt: '2026-07-16T10:05:00.000Z',
    };
    const delayed = {
      ...makeJob(2),
      nextAttemptAt: '2026-07-16T11:00:00.000Z',
    };
    const repository = createRepository([completedProbe, delayed]);
    const observer = new ObserveRecoveryOutcome({
      clock: { now: () => NOW },
      repository,
    });

    await observer.markCompleted({
      teamName: 'sandbox-team',
      recoveryMessageId: 'recovery-1',
    });

    expect(repository.getState().jobs.find((job) => job.id === 'job-2')?.nextAttemptAt).toBe(
      '2026-07-16T11:00:00.000Z'
    );
  });
});
