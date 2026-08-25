import { describe, expect, it, vi } from 'vitest';

import { TeamRuntimeAdapterRegistry } from '../../runtime';
import {
  type PendingOpenCodePrimaryCleanup,
  TeamProvisioningLaunchStateStoreBoundary,
} from '../TeamProvisioningLaunchStateStoreBoundary';
import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from '../TeamProvisioningOpenCodeAggregatePrimaryFacade';
import { createOpenCodeAggregateProvisioningRun } from '../TeamProvisioningOpenCodeAggregateRun';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeStopInput,
} from '../../runtime';
import type { TeamLaunchStateStore } from '../../TeamLaunchStateStore';
import type { TeamProvisioningLaunchStateCompatibilityBoundary } from '../TeamProvisioningLaunchStateCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { RuntimeAdapterRunByTeamEntry } from '../TeamProvisioningServiceComposition';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest } from '@shared/types';

type OpenCodeMember = Extract<
  TeamRuntimeLanePlan,
  { mode: 'pure_opencode_member_lanes' }
>['allMembers'][number];

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function member(name: string): OpenCodeMember {
  return { name, role: 'Engineer', providerId: 'opencode' };
}

function createRun(): ProvisioningRun {
  const lead = member('Lead');
  const worker = member('Worker');
  const request = {
    teamName: 'alpha',
    cwd: '/safe-test-workspace/alpha',
    providerId: 'opencode',
    members: [lead, worker],
  } as TeamCreateRequest;
  return createOpenCodeAggregateProvisioningRun({
    runId: 'restart-run',
    startedAt: '2026-07-21T00:00:00.000Z',
    progress: {
      runId: 'restart-run',
      teamName: 'alpha',
      state: 'ready',
      message: 'Ready',
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:01.000Z',
    },
    request,
    members: [lead, worker],
    lanePlan: {
      mode: 'pure_opencode_member_lanes',
      allMembers: [lead, worker],
      primaryMembers: [lead, worker],
      sideLanes: [],
    },
    onProgress: vi.fn(),
  }) as unknown as ProvisioningRun;
}

function createStoredOldCandidate(runId: string): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'alpha',
    updatedAt: '2026-07-21T00:00:02.000Z',
    launchPhase: 'finished',
    expectedMembers: ['Lead', 'Worker'],
    members: {
      Lead: {
        name: 'Lead',
        providerId: 'opencode',
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: true,
        runtimeRunId: runId,
        lastEvaluatedAt: '2026-07-21T00:00:02.000Z',
        diagnostics: ['cancelled rollback candidate persisted before ownership changed'],
      },
    },
    summary: {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
      permissionPendingCount: 0,
    },
    teamLaunchState: 'partial_failure',
  };
}

interface TestLaunchStateBackingStore {
  launchState: PersistedTeamLaunchSnapshot | null;
  cleanupOutbox: unknown;
}

function createBackingStore(
  launchState: PersistedTeamLaunchSnapshot | null = null
): TestLaunchStateBackingStore {
  return { launchState, cleanupOutbox: null };
}

function cloneJson<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

class TestOpenCodeAggregatePrimaryFacade extends TeamProvisioningOpenCodeAggregatePrimaryFacade {
  private readonly rollbackPersistence = createDeferred();
  private readonly rollbackPersistenceRelease = createDeferred();
  private launchAttempt = 0;

  readonly rollbackPersistenceStarted = this.rollbackPersistence.promise;
  readonly launchedMemberNames: string[][] = [];
  readonly clearPrimaryLaneIfOwned = vi.fn(async () => undefined);
  readonly clearLaunchState = vi.fn(async () => {
    this.backingStore.launchState = null;
  });

  protected readonly inboxReader = {
    getMessagesFor: vi.fn(async () => []),
  } as never;
  protected readonly membersMetaStore = {
    getMembers: vi.fn(async () => []),
  } as never;
  protected readonly prepareFacade = {
    getOpenCodeRuntimeLaunchCwd: (baseCwd: string, members: TeamCreateRequest['members']): string =>
      `${baseCwd}/${members.map((candidate) => candidate.name).join('+')}`,
  } as never;
  protected readonly launchStateStore: TeamLaunchStateStore;
  protected readonly launchStateCompatibilityBoundary: TeamProvisioningLaunchStateCompatibilityBoundary;
  protected readonly cancellationBoundary = {
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: this.clearPrimaryLaneIfOwned,
  } as never;

  constructor(private readonly backingStore: TestLaunchStateBackingStore = createBackingStore()) {
    super();
    this.launchStateStore = {
      read: vi.fn(async () => cloneJson(this.backingStore.launchState)),
      clear: this.clearLaunchState,
    } as unknown as TeamLaunchStateStore;
    const storeBoundary = new TeamProvisioningLaunchStateStoreBoundary({
      launchStateStore: {
        read: async () => cloneJson(this.backingStore.launchState),
        write: async (_teamName, snapshot) => {
          this.backingStore.launchState = cloneJson(snapshot);
        },
        clear: this.clearLaunchState,
      },
      membersMetaStore: {
        getMembers: async () => [],
      },
      getTrackedRunId: () => null,
      applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => snapshot,
      applyBootstrapStallOverlay: () => null,
      areSnapshotsSemanticallyEqual: () => false,
      clearBootstrapState: async () => undefined,
      invalidateRuntimeSnapshotCaches: () => undefined,
      logDebug: () => undefined,
      nowMs: () => Date.parse('2026-07-21T00:00:00.000Z'),
      openCodePrimaryCleanupOutbox: {
        read: async () => cloneJson(this.backingStore.cleanupOutbox),
        write: async (_teamId, document) => {
          this.backingStore.cleanupOutbox = cloneJson(document);
        },
      },
    });
    this.launchStateCompatibilityBoundary = {
      readPendingOpenCodePrimaryCleanups: (teamId: string) =>
        storeBoundary.readPendingOpenCodePrimaryCleanups(teamId),
      appendPendingOpenCodePrimaryCleanup: (cleanup: PendingOpenCodePrimaryCleanup) =>
        storeBoundary.appendPendingOpenCodePrimaryCleanup(cleanup),
      consumePendingOpenCodePrimaryCleanup: (cleanup: PendingOpenCodePrimaryCleanup) =>
        storeBoundary.consumePendingOpenCodePrimaryCleanup(cleanup),
      enqueueLaunchStateStoreOperation: <T>(teamName: string, operation: () => Promise<T>) =>
        storeBoundary.enqueue(teamName, operation),
      reconcilePersistedLaunchState: async () => ({
        snapshot: cloneJson(this.backingStore.launchState),
        statuses: {},
      }),
    } as unknown as TeamProvisioningLaunchStateCompatibilityBoundary;
  }

  trackRun(run: ProvisioningRun, owner: RuntimeAdapterRunByTeamEntry): void {
    this.runs.set(run.runId, run);
    this.runTracking.setAliveRunId(run.teamName, run.runId);
    this.runtimeAdapterRunByTeam.set(run.teamName, owner);
  }

  publishNewOwner(teamName: string, owner: RuntimeAdapterRunByTeamEntry): void {
    this.runTracking.setAliveRunId(teamName, owner.runId);
    this.runtimeAdapterRunByTeam.set(teamName, owner);
  }

  getPrimaryOwner(teamName: string): RuntimeAdapterRunByTeamEntry | undefined {
    return this.runtimeAdapterRunByTeam.get(teamName);
  }

  getPendingPrimaryCleanups(teamName: string): Promise<PendingOpenCodePrimaryCleanup[]> {
    return this.readPendingOpenCodePrimaryCleanups(teamName);
  }

  async retryPendingPrimaryCleanup(teamName: string): Promise<void> {
    await this.retryPendingOpenCodePrimaryCleanup(teamName);
  }

  async recoverPendingPrimaryCleanup(teamName: string): Promise<void> {
    await this.reconcilePersistedLaunchState(teamName);
  }

  trackAggregatePrimaryRestartForShutdown(teamName: string): void {
    this.openCodeAggregatePrimaryRestartByTeam.set(teamName.toLowerCase(), {
      teamName,
      runId: 'restart-run',
      memberName: 'Worker',
      completion: Promise.resolve(),
      precedingLifecycleOperations: [],
      cancelRequested: false,
    });
  }

  trackRuntimeAdapterStopForShutdown(teamName: string): void {
    this.openCodeRuntimeAdapterStopInFlightByTeam.set(teamName.toLowerCase(), {
      teamName,
      runId: 'stop-run',
      promise: Promise.resolve(),
    });
  }

  getShutdownTrackedTeamNames(): string[] {
    return this.shutdownCoordination.getShutdownTrackedTeamNames();
  }

  cancelRestart(teamName: string): void {
    const restart = this.openCodeAggregatePrimaryRestartByTeam.get(teamName.toLowerCase());
    if (!restart) {
      throw new Error(`No aggregate restart is active for ${teamName}`);
    }
    restart.cancelRequested = true;
  }

  releaseRollbackPersistence(): void {
    this.rollbackPersistenceRelease.resolve();
  }

  protected override async launchOpenCodeAggregatePrimaryLane(params: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    assertStillCurrentAfterPersistence?: () => void;
  }): Promise<TeamRuntimeLaunchResult | null> {
    this.launchAttempt += 1;
    this.launchedMemberNames.push(params.run.effectiveMembers.map((candidate) => candidate.name));
    if (this.launchAttempt === 1) {
      throw new Error('primary relaunch failed');
    }

    this.rollbackPersistence.resolve();
    await this.rollbackPersistenceRelease.promise;
    params.assertStillCurrentAfterPersistence?.();
    throw new Error('rollback should not publish after cancellation');
  }

  protected override async stopOpenCodeRuntimeAdapterTeam(
    teamName: string,
    runId: string
  ): Promise<void> {
    if (this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      this.runtimeAdapterRunByTeam.delete(teamName);
    }
    if (this.runTracking.getAliveRunId(teamName) === runId) {
      this.runTracking.deleteAliveRunId(teamName);
    }
  }

  protected override getRunLeadName(): string {
    return 'Lead';
  }

  protected override persistSentMessage(): void {}

  protected override invalidateRuntimeSnapshotCaches(): void {}

  protected override resetRuntimeToolActivity(): void {}

  protected override clearMemberSpawnToolTracking(): void {}
}

describe('TeamProvisioningOpenCodeAggregatePrimaryFacade', () => {
  it('keeps aggregate primary restart ownership visible to shutdown coordination', () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.trackAggregatePrimaryRestartForShutdown('Restart-Team');

    expect(facade.getShutdownTrackedTeamNames()).toEqual(['Restart-Team']);
  });

  it('keeps runtime adapter stop ownership visible to shutdown coordination', () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.trackRuntimeAdapterStopForShutdown('Stopping-Team');

    expect(facade.getShutdownTrackedTeamNames()).toEqual(['Stopping-Team']);
  });

  it('stops a cancelled rollback candidate that has not published ownership', async () => {
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const adapter = {
      providerId: 'opencode',
      stop,
    } as unknown as TeamLaunchRuntimeAdapter;
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const run = createRun();
    const originalOwner: RuntimeAdapterRunByTeamEntry = {
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
    };
    facade.trackRun(run, originalOwner);

    const restart = facade.restartMember(run.teamName, 'Worker');
    await facade.rollbackPersistenceStarted;

    const newerOwner: RuntimeAdapterRunByTeamEntry = {
      runId: 'newer-run',
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/newer',
    };
    facade.cancelRestart(run.teamName);
    facade.publishNewOwner(run.teamName, newerOwner);
    facade.releaseRollbackPersistence();

    await expect(restart).rejects.toThrow(
      'was cancelled because team "alpha" is no longer running'
    );
    expect(facade.launchedMemberNames).toEqual([['Lead'], ['Lead', 'Worker']]);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls[1]?.[0]).toMatchObject({
      runId: run.runId,
      laneId: 'primary',
      teamName: run.teamName,
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: null,
      force: true,
    });
    expect(facade.getPrimaryOwner(run.teamName)).toBe(newerOwner);
    expect(facade.clearPrimaryLaneIfOwned).toHaveBeenCalledWith(run.teamName, run.runId);
  });

  it('retains exact retry ownership when cancelled rollback cleanup is not confirmed', async () => {
    let stopAttempt = 0;
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
      stopAttempt += 1;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: stopAttempt === 1,
        members: {},
        warnings: [],
        diagnostics: stopAttempt === 1 ? [] : ['cancelled rollback runtime is still live'],
      };
    });
    const adapter = {
      providerId: 'opencode',
      stop,
    } as unknown as TeamLaunchRuntimeAdapter;
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const run = createRun();
    facade.trackRun(run, {
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
    });

    const restart = facade.restartMember(run.teamName, 'Worker');
    await facade.rollbackPersistenceStarted;

    facade.cancelRestart(run.teamName);
    facade.releaseRollbackPersistence();

    const error = await restart.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: 'OpenCode aggregate launch failed and runtime cleanup was not confirmed',
      errors: [expect.objectContaining({ message: 'cancelled rollback runtime is still live' })],
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls[1]?.[0]).toMatchObject({
      runId: run.runId,
      laneId: 'primary',
      teamName: run.teamName,
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: null,
      force: true,
    });
    expect(facade.getPrimaryOwner(run.teamName)).toEqual({
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
    });
    expect(facade.clearLaunchState).not.toHaveBeenCalled();
    expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
      '[Service:TeamProvisioning] [alpha] Failed to stop unretainable OpenCode primary lane: cancelled rollback runtime is still live',
    ]);
    vi.mocked(console.warn).mockClear();
  });

  it.each(['returns false', 'throws'] as const)(
    'preserves a successor and retries its separate old cleanup record when stop %s',
    async (failureMode) => {
      const cleanupFailure = new Error('cancelled rollback cleanup transport failed');
      let stopAttempt = 0;
      const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
        stopAttempt += 1;
        if (stopAttempt === 2) {
          if (failureMode === 'throws') {
            throw cleanupFailure;
          }
          return {
            runId: input.runId,
            teamName: input.teamName,
            stopped: false,
            members: {},
            warnings: [],
            diagnostics: ['cancelled rollback runtime is still live'],
          };
        }
        if (stopAttempt === 3) {
          return {
            runId: input.runId,
            teamName: input.teamName,
            stopped: false,
            members: {},
            warnings: [],
            diagnostics: ['pending old cleanup retry is still live'],
          };
        }
        return {
          runId: input.runId,
          teamName: input.teamName,
          stopped: true,
          members: {},
          warnings: [],
          diagnostics: [],
        };
      });
      const adapter = {
        providerId: 'opencode',
        stop,
      } as unknown as TeamLaunchRuntimeAdapter;
      const run = createRun();
      const oldCandidate = createStoredOldCandidate(run.runId);
      const facade = new TestOpenCodeAggregatePrimaryFacade(createBackingStore(oldCandidate));
      facade.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      facade.trackRun(run, {
        runId: run.runId,
        providerId: 'opencode',
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
      });

      const restart = facade.restartMember(run.teamName, 'Worker');
      await facade.rollbackPersistenceStarted;

      const successorOwner: RuntimeAdapterRunByTeamEntry = {
        runId: 'successor-run',
        providerId: 'opencode',
        cwd: '/safe-test-workspace/alpha/successor',
      };
      facade.cancelRestart(run.teamName);
      facade.publishNewOwner(run.teamName, successorOwner);
      facade.releaseRollbackPersistence();

      const error = await restart.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: 'OpenCode aggregate launch failed and runtime cleanup was not confirmed',
        errors: [
          failureMode === 'throws'
            ? cleanupFailure
            : expect.objectContaining({ message: 'cancelled rollback runtime is still live' }),
        ],
      });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(stop.mock.calls[1]?.[0]).toMatchObject({
        runId: run.runId,
        laneId: 'primary',
        teamName: run.teamName,
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: oldCandidate,
        force: true,
      });
      expect(facade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
      await expect(facade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([
        {
          teamId: run.teamName,
          runId: run.runId,
          providerId: 'opencode',
          cwd: '/safe-test-workspace/alpha/Lead+Worker',
          previousLaunchState: oldCandidate,
        },
      ]);
      expect(facade.clearLaunchState).not.toHaveBeenCalled();
      expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
      expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
        `[Service:TeamProvisioning] [alpha] Failed to stop unretainable OpenCode primary lane: ${
          failureMode === 'throws'
            ? 'cancelled rollback cleanup transport failed'
            : 'cancelled rollback runtime is still live'
        }`,
      ]);

      await expect(facade.retryPendingPrimaryCleanup(run.teamName)).rejects.toMatchObject({
        message: 'OpenCode aggregate launch failed and runtime cleanup was not confirmed',
        errors: [expect.objectContaining({ message: 'pending old cleanup retry is still live' })],
      });

      expect(stop).toHaveBeenCalledTimes(3);
      expect(stop.mock.calls[2]?.[0]).toMatchObject({
        runId: run.runId,
        laneId: 'primary',
        teamName: run.teamName,
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: oldCandidate,
        force: true,
      });
      await expect(facade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([
        {
          teamId: run.teamName,
          runId: run.runId,
          providerId: 'opencode',
          cwd: '/safe-test-workspace/alpha/Lead+Worker',
          previousLaunchState: oldCandidate,
        },
      ]);
      expect(facade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
      expect(facade.clearLaunchState).not.toHaveBeenCalled();
      expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();

      await facade.retryPendingPrimaryCleanup(run.teamName);

      expect(stop).toHaveBeenCalledTimes(4);
      expect(stop.mock.calls[3]?.[0]).toMatchObject({
        runId: run.runId,
        laneId: 'primary',
        teamName: run.teamName,
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: oldCandidate,
        force: true,
      });
      await expect(facade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([]);
      expect(facade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
      expect(facade.clearLaunchState).not.toHaveBeenCalled();
      expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
      vi.mocked(console.warn).mockClear();
    }
  );

  it('rehydrates displaced cleanup across facade restarts and consumes only its exact old identity', async () => {
    let stopAttempt = 0;
    const retryTransportError = new Error('restarted cleanup transport failed');
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
      stopAttempt += 1;
      if (stopAttempt === 4) {
        throw retryTransportError;
      }
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: stopAttempt === 1 || stopAttempt === 5,
        members: {},
        warnings: [],
        diagnostics:
          stopAttempt === 1 || stopAttempt === 5
            ? []
            : [`cleanup attempt ${stopAttempt} remains live`],
      };
    });
    const adapter = {
      providerId: 'opencode',
      stop,
    } as unknown as TeamLaunchRuntimeAdapter;
    const registry = new TeamRuntimeAdapterRegistry([adapter]);
    const run = createRun();
    const oldLaunchState = createStoredOldCandidate(run.runId);
    const successorLaunchState = createStoredOldCandidate('successor-run');
    const backingStore = createBackingStore(oldLaunchState);
    const successorOwner: RuntimeAdapterRunByTeamEntry = {
      runId: 'successor-run',
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/successor',
    };
    const expectedOldCleanup: PendingOpenCodePrimaryCleanup = {
      teamId: run.teamName,
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
      previousLaunchState: oldLaunchState,
    };

    const originalFacade = new TestOpenCodeAggregatePrimaryFacade(backingStore);
    originalFacade.setRuntimeAdapterRegistry(registry);
    originalFacade.trackRun(run, {
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha/Lead+Worker',
    });
    const restart = originalFacade.restartMember(run.teamName, 'Worker');
    await originalFacade.rollbackPersistenceStarted;
    originalFacade.cancelRestart(run.teamName);
    originalFacade.publishNewOwner(run.teamName, successorOwner);
    originalFacade.releaseRollbackPersistence();

    await expect(restart).rejects.toBeInstanceOf(AggregateError);
    await expect(originalFacade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([
      expectedOldCleanup,
    ]);
    expect(originalFacade.getPrimaryOwner(run.teamName)).toBe(successorOwner);

    // Simulate the successor's launch-state publication before the process is
    // replaced. The cleanup outbox has its own durable identity and must not
    // be overwritten by the successor's current launch projection.
    backingStore.launchState = cloneJson(successorLaunchState);

    const recoveryFacade = new TestOpenCodeAggregatePrimaryFacade(backingStore);
    recoveryFacade.setRuntimeAdapterRegistry(registry);
    recoveryFacade.publishNewOwner(run.teamName, successorOwner);
    await expect(recoveryFacade.recoverPendingPrimaryCleanup(run.teamName)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'cleanup attempt 3 remains live' })],
    });
    await expect(recoveryFacade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([
      expectedOldCleanup,
    ]);
    expect(recoveryFacade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
    expect(backingStore.launchState).toEqual(successorLaunchState);

    const restartedFacade = new TestOpenCodeAggregatePrimaryFacade(backingStore);
    restartedFacade.setRuntimeAdapterRegistry(registry);
    restartedFacade.publishNewOwner(run.teamName, successorOwner);
    await expect(restartedFacade.restartMember(run.teamName, 'Worker')).rejects.toMatchObject({
      errors: [retryTransportError],
    });
    await expect(restartedFacade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual([
      expectedOldCleanup,
    ]);
    expect(restartedFacade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
    expect(backingStore.launchState).toEqual(successorLaunchState);

    const successfulRecoveryFacade = new TestOpenCodeAggregatePrimaryFacade(backingStore);
    successfulRecoveryFacade.setRuntimeAdapterRegistry(registry);
    successfulRecoveryFacade.publishNewOwner(run.teamName, successorOwner);
    await successfulRecoveryFacade.recoverPendingPrimaryCleanup(run.teamName);

    await expect(successfulRecoveryFacade.getPendingPrimaryCleanups(run.teamName)).resolves.toEqual(
      []
    );
    expect(successfulRecoveryFacade.getPrimaryOwner(run.teamName)).toBe(successorOwner);
    expect(backingStore.launchState).toEqual(successorLaunchState);
    expect(successfulRecoveryFacade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(5);
    for (const call of stop.mock.calls.slice(1)) {
      expect(call[0]).toEqual({
        runId: run.runId,
        laneId: 'primary',
        teamName: run.teamName,
        cwd: '/safe-test-workspace/alpha/Lead+Worker',
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: oldLaunchState,
        force: true,
      });
    }
    vi.mocked(console.warn).mockClear();
  });
});
