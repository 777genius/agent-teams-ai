import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningLaunchStateStoreBoundary } from '../TeamProvisioningLaunchStateStoreBoundary';
import {
  launchOpenCodeAggregatePrimaryLane,
  type LaunchOpenCodeAggregatePrimaryLanePorts,
  persistOpenCodeRuntimeAdapterLaunchResult,
  type PersistOpenCodeRuntimeAdapterLaunchResultPorts,
  summarizeOpenCodeAggregateLaunchState,
} from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeStopInput,
} from '../../runtime';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}

function bootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
  return {
    teamsBasePath: '/workspace/teams',
    readFileUtf8: vi.fn(),
    mkdirRecursive: vi.fn(),
    readCommittedBootstrapSessionEvidence: vi.fn(),
    getCurrentAgentTeamsMcpHttpTransportEvidence: vi.fn(() => null),
    isFileLockTimeoutError: vi.fn(() => false),
    warn: vi.fn(),
  };
}

function launchInput(overrides: Partial<TeamRuntimeLaunchInput> = {}): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    laneId: 'primary',
    teamName: 'team-a',
    cwd: '/repo',
    prompt: 'launch',
    providerId: 'opencode' as const,
    skipPermissions: true,
    previousLaunchState: null,
    expectedMembers: [
      {
        name: 'alice',
        role: 'Engineer',
        providerId: 'opencode' as const,
        cwd: '/repo',
      },
    ],
    ...overrides,
  } as TeamRuntimeLaunchInput;
}

function confirmedMemberEvidence(
  memberName: string,
  model: string
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName,
    providerId: 'opencode',
    model,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    diagnostics: [],
  };
}

async function launchAggregateRuntimeEvidenceFixture(): Promise<{
  lane: MixedSecondaryRuntimeLaneState;
  primaryResult: TeamRuntimeLaunchResult;
  runtimeRun: Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1];
}> {
  const alice = { name: 'alice', role: 'Engineer', providerId: 'opencode' as const };
  const bob = { name: 'bob', role: 'Reviewer', providerId: 'opencode' as const };
  const request = {
    teamName: 'team-a',
    cwd: '/repo',
    providerId: 'opencode',
    members: [alice, bob],
  } as TeamCreateRequest;
  const primaryResult: TeamRuntimeLaunchResult = {
    runId: 'aggregate-run',
    teamName: 'team-a',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      alice: confirmedMemberEvidence('alice', 'primary-alice-model'),
      bob: confirmedMemberEvidence('bob', 'stale-primary-bob-model'),
    },
    warnings: [],
    diagnostics: [],
  };
  const lane: MixedSecondaryRuntimeLaneState = {
    laneId: 'secondary:opencode:bob',
    providerId: 'opencode',
    member: bob,
    runId: 'secondary-run',
    state: 'finished',
    result: {
      runId: 'secondary-run',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {
        bob: confirmedMemberEvidence('bob', 'secondary-bob-model'),
      },
      warnings: [],
      diagnostics: [],
    },
    warnings: [],
    diagnostics: [],
  };
  let runtimeRun:
    | Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
    | undefined;

  await launchOpenCodeAggregatePrimaryLane(
    {
      run: {
        runId: 'aggregate-run',
        teamName: 'team-a',
        request,
        effectiveMembers: [alice],
        memberSpawnStatuses: new Map(),
        mixedSecondaryLanes: [lane],
      },
      adapter: {
        launch: vi.fn(async () => primaryResult),
      } as unknown as TeamLaunchRuntimeAdapter,
      prompt: 'launch',
      previousLaunchState: null,
    },
    {
      getTeamsBasePath: () => '/workspace/teams',
      getOpenCodeRuntimeLaunchCwd: () => '/repo',
      migrateLegacyOpenCodeRuntimeState: async () => ({}),
      upsertOpenCodeRuntimeLaneIndexEntry: async () => {},
      setOpenCodeRuntimeActiveRunManifest: async () => {},
      clearOpenCodeRuntimeLaneStorage: async () => true,
      persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
        persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
          createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
          nowIso: () => '2026-01-01T00:00:00.000Z',
          writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
        }),
      syncOpenCodeRuntimeToolApprovals: () => {},
      setRuntimeAdapterRunByTeam: (_teamName, nextRuntimeRun) => {
        runtimeRun = nextRuntimeRun;
      },
    }
  );

  if (!runtimeRun) {
    throw new Error('Expected aggregate primary launch to publish its runtime run');
  }
  return { lane, primaryResult, runtimeRun };
}

describe('TeamProvisioningOpenCodeAggregateLaunchPersistence', () => {
  it('summarizes aggregate launch state across primary and secondary lanes', () => {
    expect(
      summarizeOpenCodeAggregateLaunchState({
        primaryResult: null,
        lanes: [],
      })
    ).toBe('partial_failure');

    expect(
      summarizeOpenCodeAggregateLaunchState({
        primaryResult: {
          runId: 'run-1',
          teamName: 'team-a',
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          members: {},
          warnings: [],
          diagnostics: [],
        },
        lanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: { name: 'bob', role: 'Engineer', providerId: 'opencode' },
            runId: null,
            state: 'queued',
            result: null,
            warnings: [],
            diagnostics: [],
          } satisfies MixedSecondaryRuntimeLaneState,
        ],
      })
    ).toBe('partial_pending');

    expect(
      summarizeOpenCodeAggregateLaunchState({
        primaryResult: {
          runId: 'run-1',
          teamName: 'team-a',
          launchPhase: 'finished',
          teamLaunchState: 'clean_success',
          members: {},
          warnings: [],
          diagnostics: [],
        },
        lanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: { name: 'bob', role: 'Engineer', providerId: 'opencode' },
            runId: 'run-2',
            state: 'finished',
            result: {
              runId: 'run-2',
              teamName: 'team-a',
              launchPhase: 'finished',
              teamLaunchState: 'partial_failure',
              members: {},
              warnings: [],
              diagnostics: [],
            },
            warnings: [],
            diagnostics: [],
          } satisfies MixedSecondaryRuntimeLaneState,
        ],
      })
    ).toBe('partial_failure');
  });

  it('persists runtime adapter launch results through the provided snapshot port', async () => {
    const writeLaunchStateSnapshot = vi.fn<
      PersistOpenCodeRuntimeAdapterLaunchResultPorts['writeLaunchStateSnapshot']
    >(async (_teamName, snapshot) => snapshot);
    const result: TeamRuntimeLaunchResult = {
      runId: 'run-1',
      teamName: 'team-a',
      leadSessionId: 'lead-session',
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          diagnostics: [],
        },
      },
      warnings: [],
      diagnostics: [],
    };

    const persistencePorts: PersistOpenCodeRuntimeAdapterLaunchResultPorts & {
      expectedNow: string;
    } = {
      expectedNow: '2026-01-01T00:00:00.000Z',
      createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
      nowIso() {
        return this.expectedNow;
      },
      writeLaunchStateSnapshot,
    };
    const persisted = await persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      launchInput(),
      persistencePorts
    );

    expect(writeLaunchStateSnapshot).toHaveBeenCalledTimes(1);
    expect(writeLaunchStateSnapshot.mock.calls[0][0]).toBe('team-a');
    expect(writeLaunchStateSnapshot.mock.calls[0][2]).toEqual({
      requireTrackedRun: true,
      runId: 'run-1',
    });
    expect(persisted.result).toBe(result);
    expect(persisted.snapshot).toMatchObject({
      teamName: 'team-a',
      expectedMembers: ['alice'],
      leadSessionId: 'lead-session',
      launchPhase: 'finished',
      members: {
        alice: {
          name: 'alice',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
          lastRuntimeAliveAt: '2026-01-01T00:00:00.000Z',
          lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
  });

  it('fences a superseded primary write and preserves a queued successor snapshot', async () => {
    const staleWriteStarted = deferred();
    const staleWriteGate = deferred();
    const storeEvents: string[] = [];
    let trackedRunId = 'run-1';
    let persistedSnapshot: PersistedTeamLaunchSnapshot | null = null;
    let writeCount = 0;
    const boundary = new TeamProvisioningLaunchStateStoreBoundary({
      launchStateStore: {
        read: async () => persistedSnapshot,
        write: async (_teamName, snapshot) => {
          writeCount += 1;
          storeEvents.push(`write:${snapshot.members.alice?.model}`);
          if (writeCount === 1) {
            staleWriteStarted.resolve();
            await staleWriteGate.promise;
          }
          persistedSnapshot = snapshot;
        },
        clear: async () => {
          storeEvents.push('clear');
          persistedSnapshot = null;
        },
      },
      membersMetaStore: {
        getMembers: async () => [],
      },
      getTrackedRunId: () => trackedRunId,
      applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => snapshot,
      applyBootstrapStallOverlay: () => null,
      areSnapshotsSemanticallyEqual: () => false,
      clearBootstrapState: async () => undefined,
      invalidateRuntimeSnapshotCaches: () => undefined,
      logDebug: () => undefined,
      nowMs: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    const persistencePorts: PersistOpenCodeRuntimeAdapterLaunchResultPorts = {
      createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      writeLaunchStateSnapshot: (teamName, snapshot, options) =>
        boundary.writeLaunchStateSnapshot(teamName, snapshot, options),
    };
    const launchResult = (runId: string, model: string): TeamRuntimeLaunchResult => ({
      runId,
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {
        alice: confirmedMemberEvidence('alice', model),
      },
      warnings: [],
      diagnostics: [],
    });

    const stalePersistence = persistOpenCodeRuntimeAdapterLaunchResult(
      launchResult('run-1', 'stale-model'),
      launchInput({ runId: 'run-1' }),
      persistencePorts
    );
    await staleWriteStarted.promise;

    trackedRunId = 'run-2';
    const successorPersistence = persistOpenCodeRuntimeAdapterLaunchResult(
      launchResult('run-2', 'successor-model'),
      launchInput({ runId: 'run-2' }),
      persistencePorts
    );
    staleWriteGate.resolve();

    const [, successor] = await Promise.all([stalePersistence, successorPersistence]);
    expect(storeEvents).toEqual(['write:stale-model', 'clear', 'write:successor-model']);
    expect(persistedSnapshot).toEqual(successor.snapshot);
    expect((persistedSnapshot as PersistedTeamLaunchSnapshot | null)?.members.alice?.model).toBe(
      'successor-model'
    );
    expect(boundary.getWrittenRunIdByTeam().get('team-a')).toBe('run-2');
  });

  it('launches the aggregate primary lane through ordered ports and records live runtime state', async () => {
    const calls: string[] = [];
    const adapterLaunch = vi.fn(async () => {
      calls.push('adapter.launch');
      return {
        runId: 'run-1',
        teamName: 'team-a',
        launchPhase: 'finished',
        teamLaunchState: 'clean_success',
        members: {
          alice: {
            memberName: 'alice',
            providerId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            diagnostics: [],
          },
        },
        warnings: [],
        diagnostics: [],
      };
    });
    const adapter = { launch: adapterLaunch } as unknown as TeamLaunchRuntimeAdapter;
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      color: 'blue',
      displayName: 'Team A',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const memberSpawnStatuses = new Map<string, MemberSpawnStatusEntry>();
    const runtimeRuns = new Map();
    const syncedApprovals = vi.fn<
      LaunchOpenCodeAggregatePrimaryLanePorts['syncOpenCodeRuntimeToolApprovals']
    >((input) => {
      calls.push('syncApprovals');
      expect(input.teamColor).toBe('blue');
      expect(input.teamDisplayName).toBe('Team A');
    });

    const result = await launchOpenCodeAggregatePrimaryLane(
      {
        run: {
          runId: 'run-1',
          teamName: 'team-a',
          request,
          effectiveMembers: request.members,
          memberSpawnStatuses,
        },
        adapter,
        prompt: 'launch',
        previousLaunchState: null,
      },
      {
        getTeamsBasePath: () => {
          calls.push('getTeamsBasePath');
          return '/workspace/teams';
        },
        getOpenCodeRuntimeLaunchCwd: () => {
          calls.push('getLaunchCwd');
          return '/repo';
        },
        migrateLegacyOpenCodeRuntimeState: async () => {
          calls.push('migrate');
          return { degraded: false, diagnostics: ['migrated'] };
        },
        upsertOpenCodeRuntimeLaneIndexEntry: async (input) => {
          calls.push('upsert');
          expect(input.diagnostics).toEqual(['migrated']);
        },
        setOpenCodeRuntimeActiveRunManifest: async () => {
          calls.push('setActive');
        },
        clearOpenCodeRuntimeLaneStorage: async () => true,
        persistOpenCodeRuntimeAdapterLaunchResult: async (launchResult, input) => {
          calls.push('persist');
          expect(input.expectedMembers).toMatchObject([
            { name: 'alice', role: 'Engineer', providerId: 'opencode', cwd: '/repo' },
          ]);
          return persistOpenCodeRuntimeAdapterLaunchResult(launchResult, input, {
            createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
            nowIso: () => '2026-01-01T00:00:00.000Z',
            writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
          });
        },
        syncOpenCodeRuntimeToolApprovals: syncedApprovals,
        setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
          calls.push('setRuntimeRun');
          runtimeRuns.set(teamName, runtimeRun);
        },
      }
    );

    expect(result?.teamLaunchState).toBe('clean_success');
    expect(calls).toEqual([
      'getLaunchCwd',
      'getTeamsBasePath',
      'migrate',
      'getTeamsBasePath',
      'upsert',
      'getTeamsBasePath',
      'setActive',
      'adapter.launch',
      'persist',
      'setRuntimeRun',
      'syncApprovals',
    ]);
    expect(memberSpawnStatuses.get('alice')).toMatchObject({ status: 'online' });
    expect(runtimeRuns.get('team-a')).toMatchObject({
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/repo',
    });
  });

  it('does not publish primary runtime ownership after persistence loses authority', async () => {
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const setRuntimeAdapterRunByTeam =
      vi.fn<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>();
    const syncOpenCodeRuntimeToolApprovals =
      vi.fn<LaunchOpenCodeAggregatePrimaryLanePorts['syncOpenCodeRuntimeToolApprovals']>();

    await expect(
      launchOpenCodeAggregatePrimaryLane(
        {
          run: {
            runId: 'run-1',
            teamName: 'team-a',
            request,
            effectiveMembers: request.members,
            memberSpawnStatuses: new Map(),
          },
          adapter: {
            launch: vi.fn(async () => ({
              runId: 'run-1',
              teamName: 'team-a',
              launchPhase: 'finished',
              teamLaunchState: 'clean_success',
              members: {
                alice: confirmedMemberEvidence('alice', 'opencode/model'),
              },
              warnings: [],
              diagnostics: [],
            })),
          } as unknown as TeamLaunchRuntimeAdapter,
          prompt: 'launch',
          previousLaunchState: null,
          assertStillCurrentAfterPersistence: () => {
            throw new Error('run ownership was cleared during persistence');
          },
        },
        {
          getTeamsBasePath: () => '/workspace/teams',
          getOpenCodeRuntimeLaunchCwd: () => '/repo',
          migrateLegacyOpenCodeRuntimeState: async () => ({}),
          upsertOpenCodeRuntimeLaneIndexEntry: async () => {},
          setOpenCodeRuntimeActiveRunManifest: async () => {},
          clearOpenCodeRuntimeLaneStorage: async () => true,
          persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
            persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
              createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
              nowIso: () => '2026-01-01T00:00:00.000Z',
              writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
            }),
          syncOpenCodeRuntimeToolApprovals,
          setRuntimeAdapterRunByTeam,
        }
      )
    ).rejects.toThrow('run ownership was cleared during persistence');

    expect(setRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
  });

  it('retains exact ownership when an unretainable primary runtime stop fails', async () => {
    const failedResult: TeamRuntimeLaunchResult = {
      runId: 'run-failed',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Shared OpenCode runtime timed out',
          diagnostics: ['Shared OpenCode runtime timed out'],
        },
      },
      warnings: [],
      diagnostics: ['Shared OpenCode runtime timed out'],
    };
    const adapterStop = vi.fn(async () => {
      throw new Error('cleanup transport failed');
    });
    const logWarning = vi.fn();
    const laneIndexWrites: Array<{ state: string; diagnostics?: string[] }> = [];
    let runtimeOwner:
      | Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
      | undefined;
    const setRuntimeAdapterRunByTeam = vi.fn<
      LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']
    >((_teamName, owner) => {
      runtimeOwner = owner;
    });
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;

    const result = await launchOpenCodeAggregatePrimaryLane(
      {
        run: {
          runId: 'run-failed',
          teamName: 'team-a',
          request,
          effectiveMembers: request.members,
          memberSpawnStatuses: new Map(),
        },
        adapter: {
          launch: vi.fn(async () => failedResult),
          stop: adapterStop,
        } as unknown as TeamLaunchRuntimeAdapter,
        prompt: 'launch',
        previousLaunchState: null,
      },
      {
        getTeamsBasePath: () => '/workspace/teams',
        getOpenCodeRuntimeLaunchCwd: () => '/repo',
        migrateLegacyOpenCodeRuntimeState: async () => ({ diagnostics: ['migration-note'] }),
        upsertOpenCodeRuntimeLaneIndexEntry: async (input) => {
          laneIndexWrites.push({ state: input.state, diagnostics: input.diagnostics });
        },
        setOpenCodeRuntimeActiveRunManifest: async () => undefined,
        clearOpenCodeRuntimeLaneStorage: async () => true,
        persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
          persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
            createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
            nowIso: () => '2026-01-01T00:00:00.000Z',
            writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
          }),
        syncOpenCodeRuntimeToolApprovals: vi.fn(),
        setRuntimeAdapterRunByTeam,
        getRuntimeAdapterRunByTeam: () => runtimeOwner,
        logWarning,
      }
    );

    expect(result).toBe(failedResult);
    expect(laneIndexWrites).toEqual([
      { state: 'active', diagnostics: ['migration-note'] },
      {
        state: 'degraded',
        diagnostics: ['migration-note', 'Shared OpenCode runtime timed out'],
      },
    ]);
    expect(adapterStop).toHaveBeenCalledTimes(1);
    expect(adapterStop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-failed',
        teamName: 'team-a',
        laneId: 'primary',
        cwd: '/repo',
        reason: 'cleanup',
        force: true,
      })
    );
    expect(setRuntimeAdapterRunByTeam).toHaveBeenCalledWith('team-a', {
      runId: 'run-failed',
      providerId: 'opencode',
      cwd: '/repo',
      members: failedResult.members,
    });
    expect(logWarning).toHaveBeenCalledWith(
      '[team-a] Failed to stop unretainable OpenCode primary lane: cleanup transport failed'
    );
    expect(runtimeOwner).toMatchObject({ runId: 'run-failed', providerId: 'opencode' });
  });

  it('publishes a non-deliverable state and exact owner before awaiting slow unretainable cleanup', async () => {
    const failedResult: TeamRuntimeLaunchResult = {
      runId: 'run-slow-cleanup',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {},
      warnings: [],
      diagnostics: ['runtime did not become retainable'],
    };
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const stopStarted = deferred();
    const stopRelease = deferred();
    const runtimeOwners = new Map<
      string,
      Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
    >();
    const runtimeProgress = new Map<string, TeamProvisioningProgress>([
      [
        failedResult.runId,
        {
          runId: failedResult.runId,
          teamName: failedResult.teamName,
          state: 'spawning',
          message: 'Launching primary lane',
          startedAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:01.000Z',
        },
      ],
    ]);
    const provisioningRuns = new Map([['team-a', failedResult.runId]]);
    const trackedRuns = new Map([
      [
        failedResult.runId,
        {
          processKilled: false,
          cancelRequested: false,
          progress: { state: 'spawning' as const },
        },
      ],
    ]);
    const delivery = new TeamProvisioningRunTrackingDeliveryHelper({
      state: {
        provisioningRunByTeam: provisioningRuns,
        aliveRunByTeam: new Map(),
        runs: trackedRuns,
        runtimeAdapterProgressByRunId: runtimeProgress,
        runtimeAdapterRunByTeam: runtimeOwners,
        getRetainedProvisioningProgressMap: () => new Map(),
      },
      ports: {
        notifyTeamWatchScopeChanged: vi.fn(),
        isTeamAlive: vi.fn(() => true),
        hasAlivePersistedTeamProcess: vi.fn(() => true),
        hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
        logDebug: vi.fn(),
      },
      liveRuntimeSnapshotCacheTtlMs: 2_000,
      persistedRuntimeSnapshotCacheTtlMs: 10_000,
    });

    const launching = launchOpenCodeAggregatePrimaryLane(
      {
        run: {
          runId: failedResult.runId,
          teamName: failedResult.teamName,
          request,
          effectiveMembers: request.members,
          memberSpawnStatuses: new Map(),
        },
        adapter: {
          launch: vi.fn(async () => failedResult),
          stop: vi.fn(async () => {
            stopStarted.resolve();
            await stopRelease.promise;
            throw new Error('slow cleanup failed');
          }),
        } as unknown as TeamLaunchRuntimeAdapter,
        prompt: 'launch',
        previousLaunchState: null,
      },
      {
        getTeamsBasePath: () => '/workspace/teams',
        getOpenCodeRuntimeLaunchCwd: () => '/repo',
        migrateLegacyOpenCodeRuntimeState: async () => ({}),
        upsertOpenCodeRuntimeLaneIndexEntry: async () => {},
        setOpenCodeRuntimeActiveRunManifest: async () => {},
        clearOpenCodeRuntimeLaneStorage: async () => true,
        persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
          persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
            createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
            nowIso: () => '2026-07-23T00:00:01.000Z',
            writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
          }),
        syncOpenCodeRuntimeToolApprovals: vi.fn(),
        setRuntimeAdapterRunByTeam: (teamName, owner) => {
          runtimeOwners.set(teamName, owner);
        },
        getRuntimeAdapterRunByTeam: (teamName) => runtimeOwners.get(teamName),
        deleteRuntimeAdapterRunByTeamIfOwned: (teamName, expectedOwner) => {
          if (runtimeOwners.get(teamName) !== expectedOwner) return false;
          return runtimeOwners.delete(teamName);
        },
        publishRuntimeAdapterStopState: (input) => {
          runtimeProgress.set(input.runId, {
            ...runtimeProgress.get(input.runId)!,
            state: input.state,
            message: input.message,
          });
        },
      }
    );
    await stopStarted.promise;

    const exactOwner = runtimeOwners.get('team-a');
    expect(exactOwner).toMatchObject({
      runId: failedResult.runId,
      providerId: 'opencode',
      cwd: '/repo',
    });
    expect(runtimeProgress.get(failedResult.runId)?.state).toBe('disconnected');
    expect(delivery.canDeliverToTrackedRuntimeRun('team-a', failedResult.runId)).toBe(false);
    expect(delivery.canDeliverToOpenCodeRuntimeForTeam('team-a')).toBe(false);

    stopRelease.resolve();
    await expect(launching).resolves.toBe(failedResult);
    expect(runtimeOwners.get('team-a')).toBe(exactOwner);
    expect(runtimeProgress.get(failedResult.runId)?.state).toBe('failed');
  });

  it('does not replace or mutate past a newer owner after failed primary cleanup', async () => {
    const failedResult = {
      runId: 'run-failed',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {},
      warnings: [],
      diagnostics: ['runtime failed'],
    } satisfies TeamRuntimeLaunchResult;
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    let runtimeOwner:
      | Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
      | undefined;
    const newerOwner: Parameters<
      LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']
    >[1] = {
      runId: 'run-newer',
      providerId: 'opencode',
      cwd: '/newer-repo',
      members: {},
    };
    const adapterStop = vi.fn(async () => {
      runtimeOwner = newerOwner;
      throw new Error('cleanup transport failed');
    });
    const setRuntimeAdapterRunByTeam = vi.fn<
      LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']
    >((_teamName, nextOwner) => {
      runtimeOwner = nextOwner;
    });
    const syncOpenCodeRuntimeToolApprovals =
      vi.fn<LaunchOpenCodeAggregatePrimaryLanePorts['syncOpenCodeRuntimeToolApprovals']>();
    const laneIndexStates: string[] = [];

    await expect(
      launchOpenCodeAggregatePrimaryLane(
        {
          run: {
            runId: 'run-failed',
            teamName: 'team-a',
            request,
            effectiveMembers: request.members,
            memberSpawnStatuses: new Map(),
          },
          adapter: {
            launch: vi.fn(async () => failedResult),
            stop: adapterStop,
          } as unknown as TeamLaunchRuntimeAdapter,
          prompt: 'launch',
          previousLaunchState: null,
        },
        {
          getTeamsBasePath: () => '/workspace/teams',
          getOpenCodeRuntimeLaunchCwd: () => '/repo',
          migrateLegacyOpenCodeRuntimeState: async () => ({}),
          upsertOpenCodeRuntimeLaneIndexEntry: async (input) => {
            laneIndexStates.push(input.state);
          },
          setOpenCodeRuntimeActiveRunManifest: async () => undefined,
          clearOpenCodeRuntimeLaneStorage: async () => true,
          persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
            persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
              createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
              nowIso: () => '2026-01-01T00:00:00.000Z',
              writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
            }),
          syncOpenCodeRuntimeToolApprovals,
          setRuntimeAdapterRunByTeam,
          getRuntimeAdapterRunByTeam: () => runtimeOwner,
        }
      )
    ).rejects.toThrow('ownership changed while failed cleanup was pending');

    expect(runtimeOwner).toBe(newerOwner);
    expect(setRuntimeAdapterRunByTeam).toHaveBeenCalledTimes(1);
    expect(syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(laneIndexStates).toEqual(['active']);
  });

  it('retains a degraded primary runtime when a sibling still has recoverable evidence', async () => {
    const partialResult: TeamRuntimeLaunchResult = {
      runId: 'run-partial',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          diagnostics: ['Cursor usage limit'],
        },
        bob: confirmedMemberEvidence('bob', 'minimax-m2.5-free'),
      },
      warnings: [],
      diagnostics: ['Cursor usage limit'],
    };
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => ({
      runId: stopInput.runId,
      teamName: stopInput.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const runtimeOwners = new Map<
      string,
      Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
    >();
    const setRuntimeAdapterRunByTeam = vi.fn<
      LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']
    >((teamName, owner) => {
      runtimeOwners.set(teamName, owner);
    });
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [
        { name: 'alice', role: 'Engineer', providerId: 'opencode' },
        { name: 'bob', role: 'Engineer', providerId: 'opencode' },
      ],
    } as TeamCreateRequest;

    await launchOpenCodeAggregatePrimaryLane(
      {
        run: {
          runId: 'run-partial',
          teamName: 'team-a',
          request,
          effectiveMembers: request.members,
          memberSpawnStatuses: new Map(),
        },
        adapter: {
          launch: vi.fn(async () => partialResult),
          stop: adapterStop,
        } as unknown as TeamLaunchRuntimeAdapter,
        prompt: 'launch',
        previousLaunchState: null,
      },
      {
        getTeamsBasePath: () => '/workspace/teams',
        getOpenCodeRuntimeLaunchCwd: () => '/repo',
        migrateLegacyOpenCodeRuntimeState: async () => ({}),
        upsertOpenCodeRuntimeLaneIndexEntry: async () => undefined,
        setOpenCodeRuntimeActiveRunManifest: async () => undefined,
        clearOpenCodeRuntimeLaneStorage: async () => true,
        persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
          persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
            createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
            nowIso: () => '2026-01-01T00:00:00.000Z',
            writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
          }),
        syncOpenCodeRuntimeToolApprovals: vi.fn(),
        setRuntimeAdapterRunByTeam,
      }
    );

    expect(adapterStop).not.toHaveBeenCalled();
    expect(setRuntimeAdapterRunByTeam).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ runId: 'run-partial', providerId: 'opencode', cwd: '/repo' })
    );
  });

  it('registers a retainable partial primary before a degraded-index write can fail', async () => {
    const partialResult: TeamRuntimeLaunchResult = {
      runId: 'run-partial',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        alice: confirmedMemberEvidence('alice', 'minimax-m2.5-free'),
      },
      warnings: [],
      diagnostics: ['secondary bootstrap failed'],
    };
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const adapterStop = vi.fn(async () => undefined);
    const runtimeRuns = new Map<
      string,
      Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
    >();
    let indexWrites = 0;

    await expect(
      launchOpenCodeAggregatePrimaryLane(
        {
          run: {
            runId: 'run-partial',
            teamName: 'team-a',
            request,
            effectiveMembers: request.members,
            memberSpawnStatuses: new Map(),
          },
          adapter: {
            launch: vi.fn(async () => partialResult),
            stop: adapterStop,
          } as unknown as TeamLaunchRuntimeAdapter,
          prompt: 'launch',
          previousLaunchState: null,
        },
        {
          getTeamsBasePath: () => '/workspace/teams',
          getOpenCodeRuntimeLaunchCwd: () => '/repo',
          migrateLegacyOpenCodeRuntimeState: async () => ({}),
          upsertOpenCodeRuntimeLaneIndexEntry: async () => {
            indexWrites += 1;
            if (indexWrites === 2) throw new Error('degraded index failed');
          },
          setOpenCodeRuntimeActiveRunManifest: async () => undefined,
          clearOpenCodeRuntimeLaneStorage: async () => true,
          persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
            persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
              createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
              nowIso: () => '2026-01-01T00:00:00.000Z',
              writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
            }),
          syncOpenCodeRuntimeToolApprovals: vi.fn(),
          setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
            runtimeRuns.set(teamName, runtimeRun);
          },
        }
      )
    ).rejects.toThrow('degraded index failed');

    expect(runtimeRuns.get('team-a')).toMatchObject({
      runId: 'run-partial',
      providerId: 'opencode',
      cwd: '/repo',
    });
    expect(adapterStop).not.toHaveBeenCalled();
  });

  it('stops the exact unretainable candidate before a degraded-index write can fail', async () => {
    const failedResult: TeamRuntimeLaunchResult = {
      runId: 'run-failed',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          memberName: 'alice',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          diagnostics: ['runtime failed'],
        },
      },
      warnings: [],
      diagnostics: ['runtime failed'],
    };
    const request = {
      teamName: 'team-a',
      cwd: '/repo',
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const adapterStop = vi.fn(async (stopInput: TeamRuntimeStopInput) => ({
      runId: stopInput.runId,
      teamName: stopInput.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const runtimeOwners = new Map<
      string,
      Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
    >();
    const setRuntimeAdapterRunByTeam = vi.fn<
      LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']
    >((teamName, owner) => {
      runtimeOwners.set(teamName, owner);
    });
    const clearOpenCodeRuntimeLaneStorage = vi.fn(async () => true);
    let indexWrites = 0;

    await expect(
      launchOpenCodeAggregatePrimaryLane(
        {
          run: {
            runId: 'run-failed',
            teamName: 'team-a',
            request,
            effectiveMembers: request.members,
            memberSpawnStatuses: new Map(),
          },
          adapter: {
            launch: vi.fn(async () => failedResult),
            stop: adapterStop,
          } as unknown as TeamLaunchRuntimeAdapter,
          prompt: 'launch',
          previousLaunchState: null,
        },
        {
          getTeamsBasePath: () => '/workspace/teams',
          getOpenCodeRuntimeLaunchCwd: () => '/repo',
          migrateLegacyOpenCodeRuntimeState: async () => ({}),
          upsertOpenCodeRuntimeLaneIndexEntry: async () => {
            indexWrites += 1;
            if (indexWrites === 2) throw new Error('degraded index failed');
          },
          setOpenCodeRuntimeActiveRunManifest: async () => undefined,
          clearOpenCodeRuntimeLaneStorage,
          persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
            persistOpenCodeRuntimeAdapterLaunchResult(result, input, {
              createOpenCodeRuntimeBootstrapEvidencePorts: bootstrapEvidencePorts,
              nowIso: () => '2026-01-01T00:00:00.000Z',
              writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
            }),
          syncOpenCodeRuntimeToolApprovals: vi.fn(),
          setRuntimeAdapterRunByTeam,
          getRuntimeAdapterRunByTeam: (teamName) => runtimeOwners.get(teamName),
          deleteRuntimeAdapterRunByTeamIfOwned: (teamName, expectedOwner) => {
            if (runtimeOwners.get(teamName) !== expectedOwner) return false;
            return runtimeOwners.delete(teamName);
          },
        }
      )
    ).rejects.toThrow('degraded index failed');

    expect(adapterStop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-failed',
        teamName: 'team-a',
        laneId: 'primary',
        cwd: '/repo',
        reason: 'cleanup',
        force: true,
      })
    );
    expect(clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/workspace/teams',
      teamName: 'team-a',
      laneId: 'primary',
      expectedRunId: 'run-failed',
    });
    expect(setRuntimeAdapterRunByTeam).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ runId: 'run-failed', providerId: 'opencode' })
    );
    expect(runtimeOwners.has('team-a')).toBe(false);
  });

  it.each([
    [
      'stale copied primary evidence',
      (lane: MixedSecondaryRuntimeLaneState) => {
        lane.state = 'queued';
        lane.runId = null;
        lane.result = null;
      },
    ],
    [
      'a stale lane runId',
      (lane: MixedSecondaryRuntimeLaneState) => {
        lane.result = { ...lane.result!, runId: 'stale-secondary-run' };
      },
    ],
    [
      'an unfinished lane',
      (lane: MixedSecondaryRuntimeLaneState) => {
        lane.state = 'launching';
      },
    ],
    [
      'wrong member evidence',
      (lane: MixedSecondaryRuntimeLaneState) => {
        lane.result = {
          ...lane.result!,
          members: {
            bob: {
              ...lane.result!.members.bob,
              memberName: 'not-bob',
            },
          },
        };
      },
    ],
  ])('does not report a secondary alive from %s', async (_caseName, invalidateLane) => {
    const { lane, primaryResult, runtimeRun } = await launchAggregateRuntimeEvidenceFixture();
    const validLaneState = lane.state;
    const validLaneRunId = lane.runId;
    const validLaneResult = lane.result;

    expect(runtimeRun.members).toMatchObject({
      alice: { memberName: 'alice', model: 'primary-alice-model' },
      bob: { memberName: 'bob', model: 'secondary-bob-model' },
    });
    expect(primaryResult.members.bob).toMatchObject({ model: 'stale-primary-bob-model' });

    invalidateLane(lane);

    expect(runtimeRun.members.alice).toMatchObject({
      memberName: 'alice',
      model: 'primary-alice-model',
    });
    expect(runtimeRun.members.bob).toBeUndefined();
    expect(primaryResult.members.bob).toMatchObject({ model: 'stale-primary-bob-model' });

    lane.state = validLaneState;
    lane.runId = validLaneRunId;
    lane.result = validLaneResult;
    expect(runtimeRun.members.bob).toMatchObject({
      memberName: 'bob',
      model: 'secondary-bob-model',
    });
  });
});
