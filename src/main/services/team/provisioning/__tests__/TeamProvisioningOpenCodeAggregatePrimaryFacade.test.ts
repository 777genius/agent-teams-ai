import { describe, expect, it, vi } from 'vitest';

import {
  type RuntimeStoreManifestEvidence,
  stableHash,
} from '../../opencode/bridge/OpenCodeBridgeCommandContract';
import { bindLifecycleManifest } from '../../opencode/bridge/OpenCodeLifecycleManifestBinding';
import { TeamRuntimeAdapterRegistry } from '../../runtime';
import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import { launchOpenCodeAggregatePrimaryLane } from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';
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
  readonly launchedRunIds: string[] = [];
  productionLaunch = false;
  initialStop?: (runId: string) => Promise<void>;
  manifest: RuntimeStoreManifestEvidence = {
    highWatermark: 0,
    activeRunId: 'restart-run',
    capabilitySnapshotId: 'cap-original',
  };
  readonly clearPrimaryLaneIfOwned = vi.fn(async () => undefined);

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
    this.launchedRunIds.push(params.run.runId);
    this.launchedMemberNames.push(params.run.effectiveMembers.map((candidate) => candidate.name));
    if (this.productionLaunch) {
      return launchOpenCodeAggregatePrimaryLane(params, {
        getTeamsBasePath: () => '/TEST/teams',
        getOpenCodeRuntimeLaunchCwd: (cwd) => cwd,
        migrateLegacyOpenCodeRuntimeState: async () => ({}),
        upsertOpenCodeRuntimeLaneIndexEntry: async () => {},
        setOpenCodeRuntimeActiveRunManifest: async ({ runId }) => {
          this.manifest = { highWatermark: 0, activeRunId: runId, capabilitySnapshotId: null };
        },
        clearOpenCodeRuntimeLaneStorage: async ({ expectedRunId }) => {
          if (this.manifest.activeRunId !== expectedRunId) return false;
          this.manifest = {
            highWatermark: 0,
            activeRunId: null,
            capabilitySnapshotId: null,
            stopSessions: [],
            sessionIdentityHash: stableHash([]),
          };
          return true;
        },
        persistOpenCodeRuntimeAdapterLaunchResult: async (result, input) => ({
          result,
          snapshot: createPersistedLaunchSnapshot({
            teamName: input.teamName,
            expectedMembers: input.expectedMembers.map((entry) => entry.name),
            launchPhase: result.launchPhase,
            members: {},
          }),
        }),
        syncOpenCodeRuntimeToolApprovals: () => {},
        setRuntimeAdapterRunByTeam: (team, owner) => this.runtimeAdapterRunByTeam.set(team, owner),
        getRuntimeAdapterRunByTeam: (team) => this.runtimeAdapterRunByTeam.get(team),
        deleteRuntimeAdapterRunByTeamIfOwned: (team, owner) => {
          if (this.runtimeAdapterRunByTeam.get(team) !== owner) return false;
          return this.runtimeAdapterRunByTeam.delete(team);
        },
      });
    }
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
    await this.initialStop?.(runId);
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

  protected override async persistLaunchStateSnapshot(): Promise<PersistedTeamLaunchSnapshot | null> {
    return null;
  }

  protected override async launchSingleMixedSecondaryLane(
    _run: ProvisioningRun,
    lane: ProvisioningRun['mixedSecondaryLanes'][number]
  ): Promise<void> {
    lane.runId = 'TEST-target-secondary';
    lane.state = 'finished';
    lane.result = materializedResult(lane.runId, [lane.member.name]);
  }

  protected override persistSentMessage(): void {}

  protected override invalidateRuntimeSnapshotCaches(): void {}

  protected override resetRuntimeToolActivity(): void {}

  protected override clearMemberSpawnToolTracking(): void {}
}

function materializedResult(
  runId: string,
  names: string[],
  failed = false
): TeamRuntimeLaunchResult {
  return {
    runId,
    teamName: 'alpha',
    launchPhase: 'finished',
    teamLaunchState: failed ? 'partial_failure' : 'clean_success',
    leadSessionId: failed ? undefined : `ses_TEST_${runId}_${names[0]}`,
    warnings: [],
    diagnostics: failed ? ['TEST bootstrap failed'] : [],
    members: Object.fromEntries(
      names.map((name) => [
        name,
        {
          memberName: name,
          providerId: 'opencode',
          model: 'zai/glm-5.3',
          sessionId: `ses_TEST_${runId}_${name}`,
          launchState: failed ? 'failed_to_start' : 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: !failed,
          bootstrapConfirmed: !failed,
          hardFailure: failed,
          diagnostics: [],
        },
      ])
    ),
  };
}

describe('TeamProvisioningOpenCodeAggregatePrimaryFacade', () => {
  it.each([0, 1, 2])(
    'uses fresh incarnations with materialized sessions; failed launches=%s',
    async (failedLaunches) => {
      const facade = new TestOpenCodeAggregatePrimaryFacade();
      facade.productionLaunch = true;
      const run = createRun();
      const originalRunId = run.runId;
      const sibling = {
        laneId: 'secondary:opencode:grok-one',
        providerId: 'opencode' as const,
        member: member('grok-one'),
        runId: 'TEST-grok-run',
        state: 'finished' as const,
        result: materializedResult('TEST-grok-run', ['grok-one']),
        warnings: [],
        diagnostics: [],
      };
      const siblings = [
        sibling,
        ...['grok-two', 'zai-one'].map((name) => ({
          ...sibling,
          laneId: `secondary:opencode:${name}`,
          member: member(name),
          runId: `TEST-${name}`,
          result: materializedResult(`TEST-${name}`, [name]),
        })),
      ];
      run.mixedSecondaryLanes = siblings;
      const stopped = new Set<string>();
      const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
        const bound = bindLifecycleManifest(
          {
            command: 'opencode.stopTeam',
            teamName: input.teamName,
            laneId: 'primary',
            runId: input.runId,
            capabilitySnapshotId: null,
            body: {
              teamId: input.teamName,
              laneId: 'primary',
              runId: input.runId,
              expectedCapabilitySnapshotId: null,
            },
          },
          facade.manifest
        );
        expect(bound.capabilitySnapshotId).toBe(
          input.runId === originalRunId ? 'cap-original' : `cap-${input.runId}`
        );
        stopped.add(input.runId);
        return {
          runId: input.runId,
          teamName: input.teamName,
          stopped: true,
          warnings: [],
          diagnostics: [],
        };
      });
      facade.initialStop = async (runId) => {
        await stop({
          runId,
          teamName: run.teamName,
          providerId: 'opencode',
          reason: 'user_requested',
          force: true,
          previousLaunchState: null,
        });
      };
      let attempt = 0;
      const launch = vi.fn(async (input: Parameters<TeamLaunchRuntimeAdapter['launch']>[0]) => {
        if (stopped.has(input.runId))
          throw new Error('OpenCode session is stopped; launch a new run');
        expect(facade.manifest.activeRunId).toBe(input.runId);
        expect(facade.manifest.capabilitySnapshotId).toBeNull();
        // The production command service publishes validated runtime authority
        // before returning either a successful or partial-failure launch result.
        facade.manifest = { ...facade.manifest, capabilitySnapshotId: `cap-${input.runId}` };
        return materializedResult(
          input.runId,
          input.expectedMembers.map((entry) => entry.name),
          ++attempt <= failedLaunches
        );
      });
      facade.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([
          { providerId: 'opencode', launch, stop } as unknown as TeamLaunchRuntimeAdapter,
        ])
      );
      facade.trackRun(run, { runId: originalRunId, providerId: 'opencode', cwd: run.request.cwd });
      const restarting = facade.restartMember(run.teamName, 'Worker', false);
      if (failedLaunches === 2) await expect(restarting).rejects.toThrow('Primary rollback failed');
      else if (failedLaunches === 1)
        await expect(restarting).rejects.toThrow('did not retain the team lead');
      else await expect(restarting).resolves.toBeUndefined();
      siblings.forEach((entry, index) => expect(run.mixedSecondaryLanes[index]).toBe(entry));
      expect(sibling.result.members['grok-one'].sessionId).toBe('ses_TEST_TEST-grok-run_grok-one');
      expect(new Set([originalRunId, ...facade.launchedRunIds]).size).toBe(failedLaunches ? 3 : 2);
      expect(stop).toHaveBeenCalledTimes(failedLaunches + 1);
      expect(stop.mock.calls.some(([input]) => input.runId === sibling.runId)).toBe(false);
      expect(facade.getPrimaryOwner(run.teamName)?.runId).toBe(
        failedLaunches === 2 ? undefined : run.runId
      );
      expect(run.progress.state).toBe(failedLaunches === 2 ? 'failed' : 'ready');
      expect(run.effectiveMembers.map((entry) => entry.name)).toEqual(
        failedLaunches ? ['Lead', 'Worker'] : ['Lead']
      );
    }
  );

  it('allocates a fresh primary incarnation after confirmed stop even when launch fails before returning evidence', async () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    // No fabricated successful launch result: the launch boundary throws before
    // returning evidence, as a stopped-session refusal does in production.
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: false,
      warnings: [],
      diagnostics: ['candidate cleanup unavailable'],
    }));
    facade.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        { providerId: 'opencode', stop } as unknown as TeamLaunchRuntimeAdapter,
      ])
    );
    const run = createRun();
    const stoppedRunId = run.runId;
    facade.trackRun(run, {
      runId: stoppedRunId,
      providerId: 'opencode',
      cwd: run.request.cwd,
    });

    await expect(facade.restartMember(run.teamName, 'Worker', false)).rejects.toThrow(
      'candidate cleanup'
    );
    expect(facade.launchedRunIds).toHaveLength(1);
    expect(facade.launchedRunIds[0]).not.toBe(stoppedRunId);
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ runId: facade.launchedRunIds[0], laneId: 'primary' })
    );
  });

  it('retains failed candidate authority when launch throws before a capability is persisted', async () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.productionLaunch = true;
    const run = createRun();
    const oldRunId = run.runId;
    const launch = vi.fn(async () => {
      throw new Error('TEST launch rejected before runtime records');
    });
    const stop = vi.fn(async (input: TeamRuntimeStopInput) => {
      bindLifecycleManifest(
        {
          command: 'opencode.stopTeam',
          teamName: input.teamName,
          laneId: 'primary',
          runId: input.runId,
          capabilitySnapshotId: null,
          body: {
            teamId: input.teamName,
            laneId: 'primary',
            runId: input.runId,
            expectedCapabilitySnapshotId: null,
          },
        },
        facade.manifest
      );
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        warnings: [],
        diagnostics: [],
      };
    });
    facade.initialStop = async (runId) => {
      await stop({
        runId,
        teamName: run.teamName,
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
        previousLaunchState: null,
      });
    };
    facade.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        { providerId: 'opencode', launch, stop } as unknown as TeamLaunchRuntimeAdapter,
      ])
    );
    facade.trackRun(run, { runId: oldRunId, providerId: 'opencode', cwd: run.request.cwd });
    await expect(facade.restartMember(run.teamName, 'Worker', false)).rejects.toThrow(
      'exact persisted lane run and capability snapshot'
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(run.runId).not.toBe(oldRunId);
    expect(facade.getPrimaryOwner(run.teamName)?.runId).toBe(run.runId);
    expect(facade.manifest).toMatchObject({ activeRunId: run.runId, capabilitySnapshotId: null });
    expect(run.progress.state).toBe('failed');
    expect(run.progress.error).toContain('TEST launch rejected before runtime records');
    expect(run.progress.error).toContain(`Primary run ${run.runId} remains owned`);
    expect(run.progress.error).toContain('Inspect this team');
    expect(run.detectedSessionId).toBeNull();
    expect(run.memberSpawnStatuses.get('Lead')?.runtimeAlive).toBe(false);
    expect(facade.clearPrimaryLaneIfOwned).not.toHaveBeenCalled();
  });

  it('does not launch a fresh incarnation when Stop cancels a pending primary restart', async () => {
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    const enteredStop = createDeferred();
    const releaseStop = createDeferred();
    facade.initialStop = async () => {
      enteredStop.resolve();
      await releaseStop.promise;
    };
    facade.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        { providerId: 'opencode', stop: vi.fn() } as unknown as TeamLaunchRuntimeAdapter,
      ])
    );
    const run = createRun();
    const originalRunId = run.runId;
    facade.trackRun(run, { runId: originalRunId, providerId: 'opencode', cwd: run.request.cwd });
    const restarting = facade.restartMember(run.teamName, 'Worker', false);
    const rejected = expect(restarting).rejects.toThrow(/cancel|no longer/i);
    await enteredStop.promise;
    facade.cancelRestart(run.teamName);
    releaseStop.resolve();
    await rejected;
    expect(run.runId).toBe(originalRunId);
    expect(facade.launchedRunIds).toEqual([]);
    expect(run.effectiveMembers.map((entry) => entry.name)).toEqual(['Lead', 'Worker']);
  });

  it('rejects stale secondary retry intent without stopping primary or healthy siblings', async () => {
    const stop = vi.fn();
    const facade = new TestOpenCodeAggregatePrimaryFacade();
    facade.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        { providerId: 'opencode', stop } as unknown as TeamLaunchRuntimeAdapter,
      ])
    );
    const run = createRun();
    facade.trackRun(run, {
      runId: run.runId,
      providerId: 'opencode',
      cwd: '/safe-test-workspace/alpha',
    });
    await expect(facade.restartMember(run.teamName, 'Worker', true)).rejects.toThrow(
      'refusing aggregate primary restart'
    );
    expect(stop).not.toHaveBeenCalled();
    expect(facade.launchedMemberNames).toEqual([]);
    expect(run.processKilled).toBe(false);
  });

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

  it('refuses stale rollback cleanup before dispatch when a newer primary owner appears', async () => {
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

    await expect(restart).rejects.toThrow('owning run is no longer active');
    expect(facade.launchedMemberNames).toEqual([['Lead'], ['Lead', 'Worker']]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(new Set([originalOwner.runId, ...facade.launchedRunIds]).size).toBe(3);
    expect(stop.mock.calls[0]?.[0].runId).toBe(facade.launchedRunIds[0]);
    expect(stop.mock.calls.some(([input]) => input.runId === newerOwner.runId)).toBe(false);
    expect(facade.getPrimaryOwner(run.teamName)).toBe(newerOwner);
    expect(facade.clearPrimaryLaneIfOwned).toHaveBeenCalledWith(run.teamName, run.runId);
  });
});
