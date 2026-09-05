import { describe, expect, it, vi } from 'vitest';

import {
  launchOpenCodeAggregatePrimaryLane,
  type LaunchOpenCodeAggregatePrimaryLanePorts,
} from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../../runtime';
import type { TeamCreateRequest } from '@shared/types';

const lead = { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' as const };
const ada = { name: 'Ada', role: 'Engineer', providerId: 'opencode' as const };

function primaryResult(): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      'team-lead': {
        memberName: 'team-lead',
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
}

async function runPrimaryLaneLaunch(
  overrides: Partial<LaunchOpenCodeAggregatePrimaryLanePorts> = {},
  launchResult: TeamRuntimeLaunchResult = primaryResult()
): Promise<{ persisted: TeamRuntimeLaunchResult[] }> {
  const persisted: TeamRuntimeLaunchResult[] = [];
  await launchOpenCodeAggregatePrimaryLane(
    {
      run: {
        runId: 'run-a1',
        teamName: 'lane-team',
        request: {
          teamName: 'lane-team',
          cwd: '/fake/project',
          providerId: 'opencode',
          members: [lead, ada],
        } as TeamCreateRequest,
        effectiveMembers: [lead, ada],
        memberSpawnStatuses: new Map(),
        mixedSecondaryLanes: [],
      },
      adapter: { launch: vi.fn(async () => launchResult) } as unknown as TeamLaunchRuntimeAdapter,
      prompt: 'launch',
      previousLaunchState: null,
    },
    {
      getTeamsBasePath: () => '/safe-test/teams',
      getOpenCodeRuntimeLaunchCwd: () => '/fake/project',
      migrateLegacyOpenCodeRuntimeState: async () => ({}),
      upsertOpenCodeRuntimeLaneIndexEntry: async () => {},
      setOpenCodeRuntimeActiveRunManifest: async () => {},
      clearOpenCodeRuntimeLaneStorage: async () => true,
      persistOpenCodeRuntimeAdapterLaunchResult: async (result: TeamRuntimeLaunchResult) => {
        persisted.push(result);
        return { result, snapshot: undefined };
      },
      syncOpenCodeRuntimeToolApprovals: () => {},
      setRuntimeAdapterRunByTeam: () => {},
      ...overrides,
    } as unknown as LaunchOpenCodeAggregatePrimaryLanePorts
  );
  return { persisted };
}

describe('the primary lane passes the same promotion gate as every side lane', () => {
  it('names the primary lane and every expected member, and persists the guarded result', async () => {
    const downgraded = primaryResult();
    downgraded.teamLaunchState = 'partial_pending';
    const guard = vi.fn<
      NonNullable<LaunchOpenCodeAggregatePrimaryLanePorts['guardCommittedOpenCodeLaneEvidence']>
    >(async () => downgraded);

    const { persisted } = await runPrimaryLaneLaunch({
      guardCommittedOpenCodeLaneEvidence: guard,
    });

    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0][0]).toMatchObject({
      teamName: 'lane-team',
      laneId: 'primary',
      memberNames: ['team-lead', 'Ada'],
    });
    // What reaches persistence is the GUARDED result, not the adapter's claim.
    expect(persisted).toEqual([downgraded]);
  });

  // NEGATIVE CONTROL: the gate is an optional port. Without it the primary lane
  // persists exactly what the adapter returned, as it did before this change.
  it('persists the adapter result unchanged when no gate is wired', async () => {
    const launchResult = primaryResult();

    const { persisted } = await runPrimaryLaneLaunch({}, launchResult);

    expect(persisted).toEqual([launchResult]);
  });
});
