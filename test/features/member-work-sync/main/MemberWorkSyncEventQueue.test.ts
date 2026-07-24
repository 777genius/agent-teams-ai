import { MemberWorkSyncEventQueue } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MemberWorkSyncEventQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acknowledges accepted events and rejects enqueue after stop', async () => {
    const queue = new MemberWorkSyncEventQueue({
      reconcile: vi.fn(async () => undefined),
      isTeamActive: () => true,
    });

    expect(
      queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' })
    ).toBe(true);
    await queue.stop();
    expect(
      queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' })
    ).toBe(false);
  });

  it('quiesces one team, drains admitted work, and resumes same-name admission', async () => {
    let releaseReconcile!: () => void;
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReconcile = resolve;
        })
    );
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 0,
      reconcile,
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    let quiesced = false;
    const quiesce = queue.quiesceTeam('team-a').then(() => {
      quiesced = true;
    });
    expect(
      queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' })
    ).toBe(false);
    await Promise.resolve();
    expect(quiesced).toBe(false);

    releaseReconcile();
    await quiesce;
    expect(queue.getDiagnostics()).toMatchObject({ queued: 0, running: 0 });

    queue.resumeTeam('team-a');
    expect(
      queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' })
    ).toBe(true);
    await queue.stop();
  });

  it('keeps quiesce pending after timeout until the underlying reconcile settles', async () => {
    let releaseReconcile!: () => void;
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReconcile = resolve;
        })
    );
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 0,
      reconcileTimeoutMs: 20,
      reconcile,
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);

    expect(queue.getDiagnostics()).toMatchObject({
      failed: 1,
      running: 1,
      runningItems: [{ memberName: 'alice', settlingAfterTimeout: true }],
    });

    let quiesced = false;
    const quiesce = queue.quiesceTeam('team-a').then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    releaseReconcile();
    await quiesce;

    expect(quiesced).toBe(true);
    expect(queue.getDiagnostics()).toMatchObject({ running: 0 });
    await queue.stop();
  });

  it('does not retry failed in-flight work while quiesced and resumes later new work', async () => {
    let rejectFirstReconcile!: (error: Error) => void;
    const auditEvents: string[] = [];
    const reconcile = vi.fn(() => {
      if (reconcile.mock.calls.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstReconcile = reject;
        });
      }
      return Promise.resolve();
    });
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 0,
      retryDelayMs: 0,
      reconcile,
      isTeamActive: () => true,
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event.event);
        },
      },
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const quiesce = queue.quiesceTeam('team-a');
    rejectFirstReconcile(new Error('reconcile failed during deletion'));
    await quiesce;
    await vi.advanceTimersByTimeAsync(0);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(queue.getDiagnostics()).toMatchObject({
      queued: 0,
      running: 0,
      failed: 1,
      reconciled: 0,
    });
    expect(auditEvents).toEqual(['queue_enqueued']);

    queue.resumeTeam('team-a');
    expect(
      queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(queue.getDiagnostics()).toMatchObject({
      queued: 0,
      running: 0,
      failed: 1,
      reconciled: 1,
    });
    await queue.stop();
  });

  it('coalesces duplicate member events into one queue reconcile', async () => {
    const reconciles: unknown[] = [];
    const auditEvents: string[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 100,
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event.event);
        },
      },
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'inbox_changed' });

    await vi.advanceTimersByTimeAsync(100);

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({
      request: { teamName: 'team-a', memberName: 'bob' },
      context: {
        reconciledBy: 'queue',
        triggerReasons: ['inbox_changed', 'task_changed'],
      },
    });
    expect(queue.getDiagnostics()).toMatchObject({ reconciled: 1, coalesced: 1 });
    expect(auditEvents).toEqual(['queue_enqueued', 'queue_coalesced', 'queue_reconciled']);
    await queue.stop();
  });

  it('bounds coalescing so noisy event streams cannot starve reconcile forever', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 100,
      triggerTiming: {
        task_changed: { runAfterMs: 100, maxCoalesceWaitMs: 250 },
      },
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(90);
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(90);
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(69);

    expect(reconciles).toHaveLength(0);
    expect(queue.getDiagnostics()).toMatchObject({
      queued: 1,
      queuedItems: [
        {
          memberName: 'bob',
          triggerReasonCounts: { task_changed: 3 },
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    await queue.stop();
  });

  it('lets manual refresh expedite an already queued delayed reconcile', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      triggerTiming: {
        task_changed: { runAfterMs: 1_000, maxCoalesceWaitMs: 5_000 },
        manual_refresh: { runAfterMs: 0, maxCoalesceWaitMs: 0 },
      },
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(100);
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({
      context: { triggerReasons: ['manual_refresh', 'task_changed'] },
    });
    await queue.stop();
  });

  it('does not let legacy quiet window override delay manual refresh', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 10_000,
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    await queue.stop();
  });

  it('uses explicit fast timing for proof-missing recovery triggers', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'proof_missing_recovery',
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(reconciles).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({
      context: { triggerReasons: ['proof_missing_recovery'] },
    });
    await queue.stop();
  });

  it('passes proof-missing recovery context into queued reconcile', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'proof_missing_recovery',
      runAfterMs: 0,
      recovery: {
        kind: 'proof_missing',
        intentKey: 'proof-missing:message-1',
        originalMessageId: 'message-1',
        taskIds: ['task-a'],
      },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({
      request: { teamName: 'team-a', memberName: 'bob' },
      context: {
        reconciledBy: 'queue',
        triggerReasons: ['proof_missing_recovery'],
        recovery: {
          kind: 'proof_missing',
          intentKey: 'proof-missing:message-1',
          originalMessageId: 'message-1',
          taskIds: ['task-a'],
        },
      },
    });
    await queue.stop();
  });

  it('does not let a later quiet-window event delay a queued manual refresh', async () => {
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      triggerTiming: {
        task_changed: { runAfterMs: 1_000, maxCoalesceWaitMs: 5_000 },
      },
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({
      context: { triggerReasons: ['manual_refresh', 'task_changed'] },
    });
    await queue.stop();
  });

  it('drops queued work for inactive teams without reconciling', async () => {
    const reconcile = vi.fn();
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      reconcile,
      isTeamActive: () => false,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconcile).not.toHaveBeenCalled();
    expect(queue.getDiagnostics()).toMatchObject({ dropped: 1, reconciled: 0 });
    await queue.stop();
  });

  it('can reconcile inactive teams when the caller needs inactive statuses refreshed', async () => {
    const reconcile = vi.fn(async () => undefined);
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      reconcile,
      isTeamActive: () => false,
      reconcileInactiveTeams: true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconcile).toHaveBeenCalledWith(
      { teamName: 'team-a', memberName: 'bob' },
      expect.objectContaining({
        reconciledBy: 'queue',
        triggerReasons: ['manual_refresh'],
      })
    );
    await queue.stop();
    expect(queue.getDiagnostics()).toMatchObject({ dropped: 0, reconciled: 1 });
  });

  it('runs one follow-up pass when events arrive during an active reconcile', async () => {
    let release: () => void = () => {
      throw new Error('reconcile did not start');
    };
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
        if (reconciles.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(1);
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'tool_finished' });

    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(2);
    expect(reconciles[1]).toMatchObject({
      context: { reconciledBy: 'queue', triggerReasons: ['task_changed', 'tool_finished'] },
    });
    await queue.stop();
  });

  it('lets manual refresh request an immediate follow-up after an active reconcile', async () => {
    let release: () => void = () => {
      throw new Error('reconcile did not start');
    };
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
        if (reconciles.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'config_changed',
      runAfterMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });

    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(2);
    expect(reconciles[1]).toMatchObject({
      context: { triggerReasons: ['config_changed', 'manual_refresh'] },
    });
    await queue.stop();
  });

  it('does not let a later event delay a due item waiting behind concurrency', async () => {
    let release: () => void = () => {
      throw new Error('reconcile did not start');
    };
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      concurrency: 1,
      triggerTiming: {
        task_changed: { runAfterMs: 0, maxCoalesceWaitMs: 5_000 },
        inbox_changed: { runAfterMs: 1_000, maxCoalesceWaitMs: 5_000 },
      },
      reconcile: async (request, context) => {
        reconciles.push({ request, context });
        if (reconciles.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'task_changed' });
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(0);

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'inbox_changed' });
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(2);
    expect(reconciles[1]).toMatchObject({
      request: { memberName: 'bob' },
      context: { triggerReasons: ['inbox_changed', 'task_changed'] },
    });
    await queue.stop();
  });

  it('does not spin timers while concurrency is saturated', async () => {
    let release: () => void = () => {
      throw new Error('reconcile did not start');
    };
    const reconciles: unknown[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      concurrency: 1,
      reconcile: async (request) => {
        reconciles.push(request);
        if (reconciles.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'task_changed' });
    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconciles).toHaveLength(1);
    expect(queue.getDiagnostics()).toMatchObject({ queued: 1, running: 1 });

    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(2);
    await queue.stop();
  });

  it('retries a failed reconcile with bounded backoff', async () => {
    const reconciles: unknown[] = [];
    const auditEvents: string[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      retryDelayMs: 10,
      maxRetryAttempts: 2,
      reconcile: async (request) => {
        reconciles.push(request);
        if (reconciles.length === 1) {
          throw new Error('transient');
        }
      },
      isTeamActive: () => true,
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event.event);
        },
      },
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toHaveLength(1);
    expect(queue.getDiagnostics()).toMatchObject({ failed: 1, queued: 1, reconciled: 0 });
    expect(auditEvents).toEqual(['queue_enqueued', 'queue_retry_scheduled']);

    await vi.advanceTimersByTimeAsync(9);
    expect(reconciles).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(reconciles).toHaveLength(2);
    expect(queue.getDiagnostics()).toMatchObject({ failed: 1, queued: 0, reconciled: 1 });

    await queue.stop();
  });

  it('waits for a timed-out reconcile to settle before retrying that member', async () => {
    let releaseFirst!: () => void;
    let reconcileCalls = 0;
    const auditEvents: string[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      retryDelayMs: 10,
      reconcileTimeoutMs: 20,
      maxRetryAttempts: 1,
      reconcile: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
      isTeamActive: () => true,
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event.event);
        },
      },
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconcileCalls).toBe(1);
    expect(queue.getDiagnostics()).toMatchObject({ running: 1, queued: 0, failed: 0 });

    await vi.advanceTimersByTimeAsync(20);

    expect(queue.getDiagnostics()).toMatchObject({
      running: 1,
      queued: 0,
      failed: 1,
      reconciled: 0,
    });
    expect(auditEvents).toEqual(['queue_enqueued']);

    await vi.advanceTimersByTimeAsync(10);
    expect(reconcileCalls).toBe(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.getDiagnostics()).toMatchObject({
      running: 0,
      queued: 1,
      failed: 1,
      reconciled: 0,
    });
    expect(auditEvents).toEqual(['queue_enqueued', 'queue_retry_scheduled']);

    await vi.advanceTimersByTimeAsync(10);

    expect(reconcileCalls).toBe(2);
    expect(queue.getDiagnostics()).toMatchObject({
      running: 0,
      queued: 0,
      failed: 1,
      reconciled: 1,
    });
    expect(auditEvents).toEqual(['queue_enqueued', 'queue_retry_scheduled', 'queue_reconciled']);

    await queue.stop();
  });

  it('releases global concurrency after timeout while keeping the same member locked', async () => {
    let releaseFirst!: () => void;
    const reconciles: string[] = [];
    const queue = new MemberWorkSyncEventQueue({
      concurrency: 1,
      quietWindowMs: 1,
      retryDelayMs: 10,
      reconcileTimeoutMs: 20,
      maxRetryAttempts: 1,
      reconcile: async (request) => {
        reconciles.push(request.memberName);
        const firstBobReconcile =
          request.memberName === 'bob' && reconciles.filter((name) => name === 'bob').length === 1;
        if (firstBobReconcile) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    queue.enqueue({ teamName: 'team-a', memberName: 'alice', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);

    expect(reconciles).toEqual(['bob']);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(0);

    expect(reconciles).toEqual(['bob', 'alice']);
    expect(queue.getDiagnostics()).toMatchObject({
      queued: 0,
      running: 1,
      failed: 1,
      reconciled: 1,
      runningItems: [{ memberName: 'bob', settlingAfterTimeout: true }],
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'manual_refresh' });
    await vi.advanceTimersByTimeAsync(10);

    expect(reconciles).toEqual(['bob', 'alice']);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(reconciles).toEqual(['bob', 'alice', 'bob']);

    await queue.stop();
  });

  it('marks a timed-out reconcile context as cancelled for late continuations', async () => {
    let releaseFirst: () => void = () => {
      throw new Error('first reconcile did not start');
    };
    let reconcileCalls = 0;
    const lateSideEffects: string[] = [];
    const cancellationChecks: boolean[] = [];
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      retryDelayMs: 10,
      reconcileTimeoutMs: 20,
      maxRetryAttempts: 1,
      reconcile: async (_request, context) => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          const cancelled = context.isCancelled?.() === true;
          cancellationChecks.push(cancelled);
          if (!cancelled) {
            lateSideEffects.push('first');
          }
          return;
        }

        const cancelled = context.isCancelled?.() === true;
        cancellationChecks.push(cancelled);
        if (!cancelled) {
          lateSideEffects.push('retry');
        }
      },
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(10);

    expect(lateSideEffects).toEqual([]);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);

    expect(cancellationChecks).toEqual([true, false]);
    expect(lateSideEffects).toEqual(['retry']);

    await queue.stop();
  });

  it('drops a failed reconcile after the retry budget is exhausted', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('still failing');
    });
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      retryDelayMs: 10,
      maxRetryAttempts: 1,
      reconcile,
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(queue.getDiagnostics()).toMatchObject({
      dropped: 1,
      failed: 2,
      queued: 0,
      reconciled: 0,
    });

    await queue.stop();
  });

  it('resets retry budget when a fresh event joins a queued retry item', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('still failing');
    });
    const queue = new MemberWorkSyncEventQueue({
      quietWindowMs: 1,
      retryDelayMs: 10,
      maxRetryAttempts: 1,
      reconcile,
      isTeamActive: () => true,
    });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'turn_settled' });
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.getDiagnostics()).toMatchObject({ failed: 1, queued: 1, dropped: 0 });

    queue.enqueue({ teamName: 'team-a', memberName: 'bob', triggerReason: 'task_changed' });
    await vi.advanceTimersByTimeAsync(10);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(queue.getDiagnostics()).toMatchObject({
      dropped: 0,
      failed: 2,
      queued: 1,
      reconciled: 0,
    });

    await queue.stop();
  });
});
