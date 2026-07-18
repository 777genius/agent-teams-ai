import { describe, expect, it, vi } from 'vitest';

import {
  launchOpenCodeAggregatePrimaryLane,
  type LaunchOpenCodeAggregatePrimaryLanePorts,
  persistOpenCodeRuntimeAdapterLaunchResult,
  type PersistOpenCodeRuntimeAdapterLaunchResultPorts,
  summarizeOpenCodeAggregateLaunchState,
} from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '../../runtime';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { MemberSpawnStatusEntry, TeamCreateRequest } from '@shared/types';

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
      'syncApprovals',
      'setRuntimeRun',
    ]);
    expect(memberSpawnStatuses.get('alice')).toMatchObject({ status: 'online' });
    expect(runtimeRuns.get('team-a')).toMatchObject({
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/repo',
    });
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
