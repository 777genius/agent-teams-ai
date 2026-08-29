import { describe, expect, it, vi } from 'vitest';

import { TeamRuntimeAdapterRegistry } from '../../runtime';
import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from '../TeamProvisioningOpenCodeAggregatePrimaryFacade';
import { createOpenCodeAggregateProvisioningRun } from '../TeamProvisioningOpenCodeAggregateRun';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeStopInput,
} from '../../runtime';
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

class TestOpenCodeAggregatePrimaryFacade extends TeamProvisioningOpenCodeAggregatePrimaryFacade {
  private readonly rollbackPersistence = createDeferred();
  private readonly rollbackPersistenceRelease = createDeferred();
  private launchAttempt = 0;

  readonly rollbackPersistenceStarted = this.rollbackPersistence.promise;
  readonly launchedMemberNames: string[][] = [];
  readonly clearPrimaryLaneIfOwned = vi.fn(async () => undefined);
  readonly stopCleanup = vi.fn(async () => undefined);
  readonly pureRestartMessagePersistence = vi.fn();
  readonly pureRestartLaunch = vi.fn();

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
  protected readonly launchStateStore = {
    read: vi.fn(async () => null),
    clear: vi.fn(async () => undefined),
  } as never;
  protected readonly launchStateCompatibilityBoundary = {
    enqueueLaunchStateStoreOperation: async <T>(
      _teamName: string,
      operation: () => Promise<T>
    ): Promise<T> => operation(),
  } as never;
  protected readonly cancellationBoundary = {
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: this.clearPrimaryLaneIfOwned,
  } as never;

  trackRun(run: ProvisioningRun, owner: RuntimeAdapterRunByTeamEntry): void {
    this.runs.set(run.runId, run);
    this.runTracking.setAliveRunId(run.teamName, run.runId);
    this.runtimeAdapterRunByTeam.set(run.teamName, owner);
  }

  publishNewOwner(teamName: string, owner: RuntimeAdapterRunByTeamEntry): void {
    this.runTracking.setAliveRunId(teamName, owner.runId);
    this.runtimeAdapterRunByTeam.set(teamName, owner);
  }

  trackUnownedPureRuntime(teamName: string, runId = 'restart-run'): void {
    this.runtimeAdapterRunByTeam.set(teamName, {
      runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha',
    });
  }

  installDeferredPureRestartController(): {
    finalIdentityReadStarted: Promise<void>;
    releaseFinalIdentityRead: () => void;
  } {
    const finalIdentityRead = createDeferred();
    const finalIdentityReadStarted = createDeferred();
    Object.assign(this, {
      memberLifecycleController: {
        restartMember: async (
          _teamName: string,
          _memberName: string,
          authority?: { assertCurrent(): void }
        ) => {
          finalIdentityReadStarted.resolve();
          await finalIdentityRead.promise;
          authority?.assertCurrent();
          this.pureRestartMessagePersistence();
          authority?.assertCurrent();
          this.pureRestartLaunch();
        },
      },
    });
    return {
      finalIdentityReadStarted: finalIdentityReadStarted.promise,
      releaseFinalIdentityRead: finalIdentityRead.resolve,
    };
  }

  replaceRestartLease(teamName: string): void {
    this.openCodeAggregatePrimaryRestartByTeam.set(teamName.toLowerCase(), {
      teamName,
      runId: 'replacement-run',
      memberName: 'Replacement',
      completion: Promise.resolve(),
      precedingLifecycleOperations: [],
      cancelRequested: false,
    });
  }

  getPrimaryOwner(teamName: string): RuntimeAdapterRunByTeamEntry | undefined {
    return this.runtimeAdapterRunByTeam.get(teamName);
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

  isRestartCancelled(teamName: string): boolean {
    return (
      this.openCodeAggregatePrimaryRestartByTeam.get(teamName.toLowerCase())?.cancelRequested ??
      false
    );
  }

  rejectStopAuthorization(error: Error): void {
    Object.assign(this as unknown as { stopFlowBoundaryValue: unknown }, {
      stopFlowBoundaryValue: {
        preflightMetadataMutation: vi.fn(async () => {
          throw error;
        }),
        authorizeStopTeam: vi.fn(async () => {
          throw error;
        }),
        stopTeam: vi.fn(async () => undefined),
        stopAuthorizedTeam: this.stopCleanup,
        stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
        stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
      },
    });
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

  it('does not cancel an aggregate restart or run cleanup when stop metadata is unsupported', async () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    const rejected = new Error('Unsupported launch-state version: 999');
    facade.trackAggregatePrimaryRestartForShutdown('Future-Team');
    facade.rejectStopAuthorization(rejected);

    await expect(facade.stopTeam('Future-Team')).rejects.toBe(rejected);

    expect(facade.isRestartCancelled('Future-Team')).toBe(false);
    expect(facade.stopCleanup).not.toHaveBeenCalled();
    expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
  });

  it.each(['cancellation', 'lease replacement'] as const)(
    'fences pure restart persistence and launch after deferred identity read on %s',
    async (authorityLoss) => {
      const facade = new TestOpenCodeAggregatePrimaryFacade();
      facade.trackUnownedPureRuntime('alpha');
      const deferred = facade.installDeferredPureRestartController();

      const restart = facade.restartMember('alpha', 'Worker');
      await deferred.finalIdentityReadStarted;
      if (authorityLoss === 'cancellation') {
        facade.cancelRestart('alpha');
      } else {
        facade.replaceRestartLease('alpha');
      }
      deferred.releaseFinalIdentityRead();

      await expect(restart).rejects.toThrow(
        'was cancelled because team "alpha" is no longer running'
      );
      expect(facade.pureRestartMessagePersistence).not.toHaveBeenCalled();
      expect(facade.pureRestartLaunch).not.toHaveBeenCalled();
    }
  );

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
});
