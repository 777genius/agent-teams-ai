import { MemberWorkSyncTeamDeletionCoordinator } from '@features/member-work-sync/main/composition/MemberWorkSyncTeamDeletionCoordinator';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncTeamDeletionCoordinatorPorts } from '@features/member-work-sync/main/composition/MemberWorkSyncTeamDeletionCoordinator';

/** Mirrors ABANDONED_PURGE_RELEASE_GRACE_MS in the coordinator. */
const PURGE_RELEASE_GRACE_MS = 30_000;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type CoordinatorPortMocks = MemberWorkSyncTeamDeletionCoordinatorPorts & {
  resumeOperationGate: ReturnType<typeof vi.fn>;
  resumeAudit: ReturnType<typeof vi.fn>;
  resumeRouter: ReturnType<typeof vi.fn>;
  purgeTeam: ReturnType<typeof vi.fn>;
};

function createPorts(
  overrides: Partial<MemberWorkSyncTeamDeletionCoordinatorPorts> = {}
): CoordinatorPortMocks {
  return {
    teamsBasePath: '/teams',
    configFileAccess: vi.fn(() => Promise.resolve()),
    beginOperationGateQuiesce: vi.fn(),
    awaitOperationGateIdle: vi.fn(() => Promise.resolve()),
    resumeOperationGate: vi.fn(),
    cancelScheduledDispatch: vi.fn(),
    beginAuditQuiesce: vi.fn(),
    awaitAuditIdle: vi.fn(() => Promise.resolve()),
    resumeAudit: vi.fn(),
    quiesceRouter: vi.fn(() => Promise.resolve()),
    resumeRouter: vi.fn(),
    enqueueStartupScan: vi.fn(() => Promise.resolve()),
    purgeTeam: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as CoordinatorPortMocks;
}

/** Runs every queued microtask without advancing any timer. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

function expectQuiescenceHeld(ports: CoordinatorPortMocks): void {
  expect(ports.resumeOperationGate).not.toHaveBeenCalled();
  expect(ports.resumeAudit).not.toHaveBeenCalled();
  expect(ports.resumeRouter).not.toHaveBeenCalled();
}

function expectQuiescenceReleased(ports: CoordinatorPortMocks): void {
  expect(ports.resumeOperationGate).toHaveBeenCalledWith('team-a');
  expect(ports.resumeAudit).toHaveBeenCalledWith('team-a');
  expect(ports.resumeRouter).toHaveBeenCalledWith('team-a');
}

describe('MemberWorkSyncTeamDeletionCoordinator abandoned preparations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the quiescence at once when the purge has not started yet', async () => {
    // The wait with no deadline is the one a caller gives up on, and nothing
    // destructive has run at that point, so the team goes back immediately.
    const ports = createPorts({
      awaitOperationGateIdle: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const coordinator = new MemberWorkSyncTeamDeletionCoordinator(ports);
    const abandon = new AbortController();

    const preparation = coordinator.prepare('team-a', 'identity-1', { signal: abandon.signal });
    await flushMicrotasks();
    abandon.abort();

    await expect(preparation).rejects.toThrow('was abandoned before it completed');
    expectQuiescenceReleased(ports);
    expect(ports.purgeTeam).not.toHaveBeenCalled();
  });

  it('keeps the team quiesced until an abandoned purge has finished', async () => {
    const purge = createDeferred();
    const ports = createPorts({ purgeTeam: vi.fn(() => purge.promise) });
    const coordinator = new MemberWorkSyncTeamDeletionCoordinator(ports);
    const abandon = new AbortController();

    const preparation = coordinator.prepare('team-a', 'identity-1', { signal: abandon.signal });
    await flushMicrotasks();
    expect(ports.purgeTeam).toHaveBeenCalledWith('team-a', 'identity-1');

    abandon.abort();
    // The caller still gets its answer straight away.
    await expect(preparation).rejects.toThrow('was abandoned before it completed');
    // The purge is deleting this team's work-sync state and cannot be told to
    // stop, so resuming the gate, the audit journal and the router here would
    // let new work land in a tree that is still being deleted.
    expectQuiescenceHeld(ports);

    purge.resolve();
    await flushMicrotasks();
    expectQuiescenceReleased(ports);
  });

  it('hands the team back when an abandoned purge outlasts the grace', async () => {
    vi.useFakeTimers();
    const ports = createPorts({ purgeTeam: vi.fn(() => new Promise<void>(() => undefined)) });
    const coordinator = new MemberWorkSyncTeamDeletionCoordinator(ports);
    const abandon = new AbortController();

    const preparation = coordinator.prepare('team-a', 'identity-1', { signal: abandon.signal });
    await flushMicrotasks();
    expect(ports.purgeTeam).toHaveBeenCalledOnce();

    abandon.abort();
    await expect(preparation).rejects.toThrow('was abandoned before it completed');
    await vi.advanceTimersByTimeAsync(PURGE_RELEASE_GRACE_MS - 1);
    expectQuiescenceHeld(ports);

    // Waiting for a purge that never settles is the defect this path exists
    // for, so the wait is bounded: the team is handed back and the purge is
    // left to finish on its own.
    await vi.advanceTimersByTimeAsync(1);
    expectQuiescenceReleased(ports);
  });

  it('makes a retry queue behind the abandoned purge instead of running a second one', async () => {
    const purge = createDeferred();
    const purgeTeam = vi.fn((_teamName: string, deletionIdentityId?: string) =>
      deletionIdentityId === 'identity-1' ? purge.promise : Promise.resolve()
    );
    const ports = createPorts({ purgeTeam });
    const coordinator = new MemberWorkSyncTeamDeletionCoordinator(ports);
    const abandon = new AbortController();

    const preparation = coordinator.prepare('team-a', 'identity-1', { signal: abandon.signal });
    await flushMicrotasks();
    abandon.abort();
    await expect(preparation).rejects.toThrow('was abandoned before it completed');

    const retry = coordinator.prepare('team-a', 'identity-2');
    await flushMicrotasks();
    // The abandoned purge still owns the tree, so the retry waits rather than
    // deleting the same state twice at once.
    expect(purgeTeam).toHaveBeenCalledOnce();

    purge.resolve();
    await expect(retry).resolves.toBeUndefined();
    expect(purgeTeam).toHaveBeenCalledTimes(2);
    expect(purgeTeam).toHaveBeenLastCalledWith('team-a', 'identity-2');
    // The release the abandoned generation deferred must not fire into the
    // retry: between prepare and complete the team is quiesced on purpose.
    expectQuiescenceHeld(ports);
  });

  it('does not resume across an inherited purge when the retry is abandoned too', async () => {
    vi.useFakeTimers();
    const purge = createDeferred();
    const purgeTeam = vi.fn((_teamName: string, deletionIdentityId?: string) =>
      deletionIdentityId === 'identity-1' ? purge.promise : Promise.resolve()
    );
    const ports = createPorts({ purgeTeam });
    const coordinator = new MemberWorkSyncTeamDeletionCoordinator(ports);
    const abandonFirst = new AbortController();
    const abandonRetry = new AbortController();

    const preparation = coordinator.prepare('team-a', 'identity-1', {
      signal: abandonFirst.signal,
    });
    await flushMicrotasks();
    abandonFirst.abort();
    await expect(preparation).rejects.toThrow('was abandoned before it completed');

    const retry = coordinator.prepare('team-a', 'identity-2', { signal: abandonRetry.signal });
    await flushMicrotasks();
    abandonRetry.abort();
    await expect(retry).rejects.toThrow('was abandoned before it completed');

    // The retry never started a purge of its own, but the one it was waiting
    // for is still running, so it inherits that wait rather than resuming on
    // top of it.
    expect(purgeTeam).toHaveBeenCalledOnce();
    expectQuiescenceHeld(ports);

    purge.resolve();
    await flushMicrotasks();
    expectQuiescenceReleased(ports);
  });
});
