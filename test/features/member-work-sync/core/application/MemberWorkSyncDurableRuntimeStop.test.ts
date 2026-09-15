import { MemberWorkSyncRecoveryCommands } from '@features/member-work-sync/core/application';
import { MemberWorkSyncExactRuntimeStop } from '@features/member-work-sync/core/application/MemberWorkSyncExactRuntimeStop';
import {
  applyMemberWorkSyncStopLatch,
  clearMemberWorkSyncStopLatch,
  findMemberWorkSyncDurableStopReceipt,
  isMemberWorkSyncStopRetired,
  MemberWorkSyncRecoveryHealthError,
} from '@features/member-work-sync/core/domain';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncUseCaseDeps } from '@features/member-work-sync/core/application';

function initialStatus(): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    diagnostics: [],
    providerId: 'codex',
    statusRevision: {
      incarnation: 'inc-1',
      lineageId: 'lineage-1',
      sequence: 1,
      nonce: 'nonce-1',
    },
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-09-15T00:00:00.000Z',
      fingerprint: 'agenda-1',
      diagnostics: [],
      items: [],
    },
    recoveryHealth: { schemaVersion: 1, episodes: [], controlRevision: 3 },
  };
}

function harness() {
  let stored = initialStatus();
  let token = 1;
  let mutation = 0;
  let failCommit: number | undefined;
  let commits = 0;
  let live: {
    runtimeInstanceId: string;
    controlRevision: number;
    stopped: boolean;
    handshakeCompleted: true;
    requestId?: string;
  } | null = {
    runtimeInstanceId: 'runtime-1',
    controlRevision: 3,
    stopped: false,
    handshakeCompleted: true,
  };
  let syncHook:
    | ((
        input: Parameters<
          NonNullable<MemberWorkSyncUseCaseDeps['runtimeTicketAdmission']>['syncControl']
        >[0]
      ) => Promise<void>)
    | undefined;
  let syncAppliedHook:
    | ((
        input: Parameters<
          NonNullable<MemberWorkSyncUseCaseDeps['runtimeTicketAdmission']>['syncControl']
        >[0]
      ) => Promise<void>)
    | undefined;
  const syncControl = vi.fn(async (input) => {
    await syncHook?.(input);
    const runtimeInstanceId = input.runtimeInstanceId || live?.runtimeInstanceId;
    if (!live || live.runtimeInstanceId !== runtimeInstanceId) {
      return { ok: false as const, code: 'instance_mismatch' as const };
    }
    if (input.controlRevision < live.controlRevision) {
      return { ok: false as const, code: 'superseded' as const };
    }
    if (
      input.controlRevision === live.controlRevision &&
      (input.stopped !== live.stopped ||
        (input.requestId !== undefined && live.requestId !== input.requestId))
    ) {
      return { ok: false as const, code: 'conflict' as const };
    }
    live = {
      runtimeInstanceId,
      controlRevision: input.controlRevision,
      stopped: input.stopped,
      handshakeCompleted: true,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
    await syncAppliedHook?.(input);
    return {
      ok: true as const,
      code: input.stopped ? ('closed' as const) : ('open' as const),
      controlRevision: input.controlRevision,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
  });
  const readStatus = vi.fn(async () => stored);
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date('2026-09-15T00:01:00.000Z'), delay: async () => undefined },
    hash: { sha256Hex: (value) => `hash${value.length}` },
    agendaSource: { loadAgenda: async () => ({ agenda: stored.agenda }) },
    statusStore: {
      read: readStatus,
      write: async (next) => {
        stored = next;
      },
      readTeamMetrics: async () => ({ total: 1, caughtUp: 0, needsSync: 1 }),
    },
    statusMutations: {
      createMutationId: () => `mutation-${++mutation}`,
      readSnapshot: async () => ({
        ok: true as const,
        snapshot: { status: stored, token: `token-${token}`, incarnation: 'inc-1' },
      }),
      compareAndWrite: async (request) => {
        commits += 1;
        if (request.expectedToken !== `token-${token}`) {
          return {
            committed: false as const,
            reason: 'conflict' as const,
            current: { status: stored, token: `token-${token}`, incarnation: 'inc-1' },
          };
        }
        if (commits === failCommit) {
          return {
            committed: 'unknown' as const,
            reason: 'commit_unknown' as const,
            mutationId: request.mutationId,
          };
        }
        stored = request.nextStatus;
        token += 1;
        return {
          committed: true as const,
          snapshot: { status: stored, token: `token-${token}`, incarnation: 'inc-1' },
          projectionDegraded: [],
        };
      },
    },
    runtimeTicketAdmission: {
      admit: async () => ({ admitted: false, code: 'not_early' }),
      cancel: async () => undefined,
      syncControl,
      readLiveControl: async () => (live ? { ...live } : null),
    },
  };
  return {
    commands: () => new MemberWorkSyncRecoveryCommands(deps),
    exactStop: () => new MemberWorkSyncExactRuntimeStop(deps),
    readStatus,
    get status() {
      return stored;
    },
    set status(next: MemberWorkSyncStatus) {
      stored = next;
    },
    get live() {
      return live;
    },
    set live(next: typeof live) {
      live = next;
    },
    syncControl,
    failNextFinalization() {
      failCommit = commits + 2;
    },
    clearFailure() {
      failCommit = undefined;
    },
    setSyncHook(next: typeof syncHook) {
      syncHook = next;
    },
    setSyncAppliedHook(next: typeof syncAppliedHook) {
      syncAppliedHook = next;
    },
  };
}

const stop = {
  teamName: 'team-a',
  memberName: 'bob',
  expectedIncarnation: 'inc-1',
  expectedRuntimeInstanceId: 'runtime-1',
  localStopId: 'local-stop-1',
};

describe('durable exact runtime Stop ordering', () => {
  it.each([
    { length: 256, accepted: true },
    { length: 257, accepted: false },
  ])(
    'enforces the $length-character reason boundary before mutation',
    async ({ length, accepted }) => {
      const state = harness();
      const reason = 'r'.repeat(length);
      const stopping = state.commands().stop({ ...stop, reason });

      if (accepted) {
        await expect(stopping).resolves.toMatchObject({ code: 'stopped' });
        expect(state.status.recoveryHealth?.autoResumeStopLatch?.reason).toBe(reason);
        expect(state.syncControl).toHaveBeenCalledTimes(1);
      } else {
        await expect(stopping).rejects.toBeInstanceOf(MemberWorkSyncRecoveryHealthError);
        expect(state.status).toEqual(initialStatus());
        expect(state.syncControl).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['a trailing character beyond the boundary', `${'r'.repeat(256)} `],
    ['an oversized whitespace-only value', ' '.repeat(257)],
  ])('rejects %s before direct exact-runtime state access', async (_label, reason) => {
    const state = harness();

    await expect(state.exactStop().execute({ ...stop, reason })).rejects.toBeInstanceOf(
      MemberWorkSyncRecoveryHealthError
    );
    expect(state.readStatus).not.toHaveBeenCalled();
    expect(state.status).toEqual(initialStatus());
    expect(state.syncControl).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'keeps the exact-runtime Stop default for absent or empty reason %#',
    async (reason) => {
      const state = harness();

      await state.exactStop().execute({ ...stop, reason });

      expect(state.status.recoveryHealth?.autoResumeStopLatch?.reason).toBe('runtime_local_stop');
    }
  );

  it('preserves a traversal-shaped local Stop as the immutable runtime request identity', async () => {
    const state = harness();
    const localStopId = '../../outside/stop-id';
    await state.commands().stop({ ...stop, localStopId });
    const runtimeRequest = state.syncControl.mock.calls[0]?.[0];
    expect(runtimeRequest?.requestId).toBe(localStopId);
    expect(state.status.recoveryHealth?.durableStopReceipts?.[0]?.localStopId).toBe(localStopId);
  });

  it('recovers ACK then crash before status CAS without issuing a new Stop', async () => {
    const state = harness();
    state.failNextFinalization();
    await expect(state.commands().stop(stop)).rejects.toMatchObject({
      name: 'MemberWorkSyncStatusMutationError',
    });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toMatchObject({
      localStopId: 'local-stop-1',
      controlRevision: 4,
      stopped: true,
    });
    expect(state.syncControl).toHaveBeenCalledTimes(1);

    state.clearFailure();
    await state.commands().stop(stop);
    expect(state.syncControl).toHaveBeenCalledTimes(1);
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toBeUndefined();
    expect(state.status.recoveryHealth?.durableStopReceipts?.[0]).toMatchObject({
      localStopId: 'local-stop-1',
      controlRevision: 4,
    });
  });

  it('keeps replay fenced after Resume and command-service restart', async () => {
    const state = harness();
    await state.commands().stop(stop);
    await state.commands().resume({ teamName: 'team-a', memberName: 'bob' });
    const calls = state.syncControl.mock.calls.length;
    await state.commands().stop(stop);
    expect(state.syncControl).toHaveBeenCalledTimes(calls);
    expect(state.live).toMatchObject({ stopped: false, controlRevision: 5 });
    expect(state.status.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
  });

  it('fails closed when a fresh localStopId collides with the retired replay filter', async () => {
    const state = harness();
    const baseScope = {
      teamName: stop.teamName,
      memberName: stop.memberName,
      incarnation: stop.expectedIncarnation,
      runtimeInstanceId: stop.expectedRuntimeInstanceId,
    };
    let health = state.status.recoveryHealth;
    for (let index = 0; index < 800; index += 1) {
      health = applyMemberWorkSyncStopLatch({
        previous: clearMemberWorkSyncStopLatch({ previous: health }),
        nowIso: '2026-09-15T00:00:00.000Z',
        reason: 'runtime_local_stop',
        durableReceipt: {
          ...baseScope,
          localStopId: `retired-stop-${index}`,
          appliedAt: '2026-09-15T00:00:00.000Z',
        },
      });
    }
    health = clearMemberWorkSyncStopLatch({ previous: health });
    const freshLocalStopId = Array.from(
      { length: 10_000 },
      (_, index) => `fresh-stop-${index}`
    ).find(
      (localStopId) =>
        !findMemberWorkSyncDurableStopReceipt(health, { ...baseScope, localStopId }) &&
        isMemberWorkSyncStopRetired(health, { ...baseScope, localStopId })
    );
    expect(freshLocalStopId).toBeDefined();
    state.status = { ...state.status, recoveryHealth: health };
    state.live = {
      runtimeInstanceId: stop.expectedRuntimeInstanceId,
      controlRevision: health?.controlRevision ?? 0,
      stopped: false,
      handshakeCompleted: true,
    };

    await expect(
      state.commands().stop({ ...stop, localStopId: freshLocalStopId! })
    ).rejects.toMatchObject({ name: 'MemberWorkSyncRuntimeControlUnavailableError' });
    const fencedCheckpoint = state.status.recoveryHealth?.pendingRuntimeControl;
    await expect(
      state.commands().stop({ ...stop, localStopId: freshLocalStopId! })
    ).rejects.toMatchObject({ name: 'MemberWorkSyncRuntimeControlUnavailableError' });

    expect(state.syncControl).not.toHaveBeenCalled();
    expect(state.live).toMatchObject({ stopped: false });
    expect(state.status.runtimeAdmission).toEqual({ state: 'unknown' });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toMatchObject({
      localStopId: freshLocalStopId,
      stopped: true,
    });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toEqual(fencedCheckpoint);
    expect(state.status.recoveryHealth?.autoResumeStopLatch).toMatchObject({
      reason: 'runtime_local_stop',
    });
  });

  it('lets a racing Resume durably supersede a delayed Stop', async () => {
    const state = harness();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    state.setSyncHook(async (input) => {
      if (input.stopped) {
        stopEntered();
        await delayed;
      }
    });
    const stopping = state.commands().stop(stop);
    await entered;
    await state.commands().resume({ teamName: 'team-a', memberName: 'bob' });
    release();
    const result = await stopping;
    expect(result).toMatchObject({ runtimeAdmission: { state: 'superseded' } });
    expect(state.live).toMatchObject({ stopped: false, controlRevision: 5 });
    expect(state.status.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(state.status.recoveryHealth?.retiredStopFilter).toBeDefined();
  });

  it('abandons the pending checkpoint if the runtime is replaced after sync', async () => {
    const state = harness();
    state.setSyncHook(async () => {
      // Replacement is observed by the post-ACK exact-instance read.
      queueMicrotask(() => {
        state.live = {
          runtimeInstanceId: 'runtime-2',
          controlRevision: 1,
          stopped: false,
          handshakeCompleted: true,
        };
      });
    });
    await expect(state.commands().stop(stop)).rejects.toMatchObject({
      name: 'MemberWorkSyncStaleRuntimeInstanceError',
    });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toBeUndefined();
    expect(state.status.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
  });

  it('does not let delayed Resume finalization erase a newer ordinary Stop latch', async () => {
    const state = harness();
    state.failNextFinalization();
    await expect(state.commands().stop(stop)).rejects.toMatchObject({
      name: 'MemberWorkSyncStatusMutationError',
    });
    state.clearFailure();

    let resumeApplied!: () => void;
    const applied = new Promise<void>((resolve) => {
      resumeApplied = resolve;
    });
    let releaseResume!: () => void;
    const delayedFinalization = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    state.setSyncAppliedHook(async (input) => {
      if (!input.stopped) {
        resumeApplied();
        await delayedFinalization;
      }
    });

    const resuming = state.commands().resume({ teamName: 'team-a', memberName: 'bob' });
    await applied;
    const newerStop = await state.commands().stop({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'newer_user_stop',
    });
    expect(newerStop.status.recoveryHealth).toMatchObject({
      controlRevision: 6,
      autoResumeStopLatch: { controlRevision: 6, reason: 'newer_user_stop' },
    });
    expect(newerStop.status.recoveryHealth?.pendingRuntimeControl).toBeUndefined();
    expect(state.syncControl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeInstanceId: '',
        controlRevision: 6,
        stopped: true,
      })
    );

    releaseResume();
    await resuming;
    expect(state.status.recoveryHealth).toMatchObject({
      controlRevision: 6,
      autoResumeStopLatch: { controlRevision: 6, reason: 'newer_user_stop' },
    });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toBeUndefined();
    expect(state.status.recoveryHealth?.retiredStopFilter).toBeDefined();
    expect(state.live).toMatchObject({ stopped: true, controlRevision: 6 });
    const calls = state.syncControl.mock.calls.length;
    await expect(state.commands().stop(stop)).rejects.toMatchObject({
      name: 'MemberWorkSyncRuntimeControlUnavailableError',
    });
    expect(state.syncControl).toHaveBeenCalledTimes(calls);
    expect(state.status.recoveryHealth).toMatchObject({
      controlRevision: 6,
      autoResumeStopLatch: { controlRevision: 6, reason: 'newer_user_stop' },
    });
  });

  it('retries Resume with the same durable revision, request identity, and command fields', async () => {
    const state = harness();
    state.failNextFinalization();
    await expect(state.commands().stop(stop)).rejects.toMatchObject({
      name: 'MemberWorkSyncStatusMutationError',
    });
    state.clearFailure();

    let failOnce = true;
    state.setSyncAppliedHook(async (input) => {
      if (!input.stopped && failOnce) {
        failOnce = false;
        throw new Error('transport_lost_after_apply');
      }
    });
    await expect(
      state.commands().resume({ teamName: 'team-a', memberName: 'bob' })
    ).rejects.toThrow('transport_lost_after_apply');
    const checkpoint = state.status.recoveryHealth?.pendingRuntimeControl;
    expect(checkpoint).toMatchObject({
      stopped: false,
      controlRevision: 5,
      requestId: 'resume-5-hash38',
    });

    await state.commands().resume({ teamName: 'team-a', memberName: 'bob' });
    const resumeCalls = state.syncControl.mock.calls
      .map(([input]) => input)
      .filter((input) => !input.stopped);
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls[1]).toEqual(resumeCalls[0]);
    expect(resumeCalls[0]).toMatchObject({
      controlRevision: checkpoint?.controlRevision,
      requestId: checkpoint?.requestId,
      issuedAt: checkpoint?.issuedAt,
    });
    expect(state.status.recoveryHealth?.pendingRuntimeControl).toBeUndefined();
    expect(state.status.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
  });
});
