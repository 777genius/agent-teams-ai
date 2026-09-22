import {
  createTeamRuntimeObservationSlice,
  type TeamRuntimeObservationStatePort,
} from '@features/team-provisioning/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { TeamRuntimeObservationState } from '@features/team-provisioning/core/application';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

const TEAM_NAME = 'sandbox-team';

function memberSpawnSnapshot(
  overrides: Partial<MemberSpawnStatusesSnapshot> = {}
): MemberSpawnStatusesSnapshot {
  return {
    runId: 'run-1',
    statuses: {},
    updatedAt: '2026-07-23T10:00:00.000Z',
    ...overrides,
  };
}

function runtimeSnapshot(
  overrides: Partial<TeamAgentRuntimeSnapshot> = {}
): TeamAgentRuntimeSnapshot {
  return {
    teamName: TEAM_NAME,
    runId: 'run-1',
    updatedAt: '2026-07-23T10:00:00.000Z',
    members: {},
    ...overrides,
  };
}

function createState(
  overrides: Partial<TeamRuntimeObservationState> = {}
): TeamRuntimeObservationState {
  return {
    currentRuntimeRunIdByTeam: {},
    ignoredRuntimeRunIds: {},
    leadActivityByTeam: {},
    memberSpawnSnapshotsByTeam: {},
    memberSpawnStatusesByTeam: {},
    teamAgentRuntimeByTeam: {},
    ...overrides,
  };
}

function createStatePort(initialState: TeamRuntimeObservationState): {
  getState(): TeamRuntimeObservationState;
  port: TeamRuntimeObservationStatePort;
} {
  let state = initialState;
  return {
    getState: () => state,
    port: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
  };
}

function createHarness(params: {
  initialState?: TeamRuntimeObservationState;
  memberSpawnResult?: MemberSpawnStatusesSnapshot | null;
  runtimeResult?: TeamAgentRuntimeSnapshot | null;
}) {
  const state = createStatePort(params.initialState ?? createState());
  let currentScope = true;
  const backoff = {
    clearMemberSpawnBackoff: vi.fn(),
    isMemberSpawnBackoffActive: vi.fn(() => false),
    recordMissingMemberSpawnHandler: vi.fn(),
  };
  const memberSpawnPolicy = {
    areSnapshotsEqual: vi.fn(() => false),
    recordEquivalentSnapshot: vi.fn(),
  };
  const runtimeSnapshotPolicy = {
    areVisibleSnapshotsEqual: vi.fn(() => false),
    getFreshnessSnapshot: vi.fn(
      (_teamName, visible: TeamAgentRuntimeSnapshot | undefined) => visible
    ),
    rememberFreshnessSnapshot: vi.fn(),
    stabilizeSnapshot: vi.fn(
      (_previous: TeamAgentRuntimeSnapshot | undefined, incoming: TeamAgentRuntimeSnapshot) =>
        incoming
    ),
  };
  const transport = {
    getMemberSpawnStatuses: vi.fn().mockResolvedValue(params.memberSpawnResult ?? null),
    getTeamAgentRuntime: vi.fn().mockResolvedValue(params.runtimeResult ?? null),
  };
  const slice = createTeamRuntimeObservationSlice({
    backoff,
    memberSpawnPolicy,
    requestScope: {
      capture: () => Symbol('scope'),
      isCurrent: () => currentScope,
    },
    runtimeSnapshotPolicy,
    state: state.port,
    transport,
  });

  return {
    backoff,
    getState: state.getState,
    memberSpawnPolicy,
    runtimeSnapshotPolicy,
    setScopeCurrent: (value: boolean) => {
      currentScope = value;
    },
    slice,
    transport,
  };
}

describe('createTeamRuntimeObservationSlice', () => {
  it('pins the first runtime run while suppressing an equivalent member snapshot', async () => {
    const previous = memberSpawnSnapshot();
    const harness = createHarness({
      initialState: createState({
        memberSpawnSnapshotsByTeam: { [TEAM_NAME]: previous },
        memberSpawnStatusesByTeam: { [TEAM_NAME]: previous.statuses },
      }),
      memberSpawnResult: memberSpawnSnapshot({
        updatedAt: '2026-07-23T10:00:01.000Z',
      }),
    });
    harness.memberSpawnPolicy.areSnapshotsEqual.mockReturnValue(true);

    await harness.slice.fetchMemberSpawnStatuses(TEAM_NAME);

    expect(harness.getState().currentRuntimeRunIdByTeam).toEqual({
      [TEAM_NAME]: 'run-1',
    });
    expect(Object.values(harness.getState().memberSpawnSnapshotsByTeam).at(0)).toBe(previous);
    expect(harness.memberSpawnPolicy.recordEquivalentSnapshot).toHaveBeenCalledWith(
      TEAM_NAME,
      'run-1'
    );
    expect(harness.backoff.clearMemberSpawnBackoff).toHaveBeenCalledWith(TEAM_NAME);
  });

  it('does not resurrect tombstoned or offline member-spawn runs', async () => {
    const tombstoned = createHarness({
      initialState: createState({
        ignoredRuntimeRunIds: { 'run-1': TEAM_NAME },
      }),
      memberSpawnResult: memberSpawnSnapshot(),
    });
    await tombstoned.slice.fetchMemberSpawnStatuses(TEAM_NAME);
    expect(tombstoned.getState().memberSpawnSnapshotsByTeam).toEqual({});
    expect(tombstoned.memberSpawnPolicy.areSnapshotsEqual).not.toHaveBeenCalled();

    const offline = createHarness({
      initialState: createState({
        leadActivityByTeam: { [TEAM_NAME]: 'offline' },
      }),
      memberSpawnResult: memberSpawnSnapshot(),
    });
    await offline.slice.fetchMemberSpawnStatuses(TEAM_NAME);
    expect(offline.getState().memberSpawnSnapshotsByTeam).toEqual({});
    expect(offline.memberSpawnPolicy.areSnapshotsEqual).not.toHaveBeenCalled();
  });

  it('does not record backoff for a stale failed request', async () => {
    const harness = createHarness({});
    harness.transport.getMemberSpawnStatuses.mockRejectedValue(
      new Error("No handler registered for 'team:memberSpawnStatuses'")
    );
    harness.setScopeCurrent(false);

    await harness.slice.fetchMemberSpawnStatuses(TEAM_NAME);

    expect(harness.backoff.recordMissingMemberSpawnHandler).not.toHaveBeenCalled();
  });

  it('records missing-handler backoff only for the current request scope', async () => {
    const harness = createHarness({});
    harness.transport.getMemberSpawnStatuses.mockRejectedValue(
      new Error("No handler registered for 'team:memberSpawnStatuses'")
    );

    await harness.slice.fetchMemberSpawnStatuses(TEAM_NAME);

    expect(harness.backoff.recordMissingMemberSpawnHandler).toHaveBeenCalledWith(TEAM_NAME);
  });

  it('remembers stabilized freshness even when the visible runtime snapshot is unchanged', async () => {
    const visible = runtimeSnapshot();
    const incoming = runtimeSnapshot({
      updatedAt: '2026-07-23T10:00:01.000Z',
    });
    const stabilized = runtimeSnapshot({
      updatedAt: '2026-07-23T10:00:00.500Z',
    });
    const harness = createHarness({
      initialState: createState({
        currentRuntimeRunIdByTeam: { [TEAM_NAME]: 'run-1' },
        teamAgentRuntimeByTeam: { [TEAM_NAME]: visible },
      }),
      runtimeResult: incoming,
    });
    harness.runtimeSnapshotPolicy.stabilizeSnapshot.mockReturnValue(stabilized);
    harness.runtimeSnapshotPolicy.areVisibleSnapshotsEqual.mockReturnValue(true);

    await harness.slice.fetchTeamAgentRuntime(TEAM_NAME);

    expect(harness.runtimeSnapshotPolicy.rememberFreshnessSnapshot).toHaveBeenCalledWith(
      TEAM_NAME,
      stabilized
    );
    expect(Object.values(harness.getState().teamAgentRuntimeByTeam).at(0)).toBe(visible);
  });

  it('rejects a non-canonical runtime snapshot before touching freshness state', async () => {
    const harness = createHarness({
      initialState: createState({
        currentRuntimeRunIdByTeam: { [TEAM_NAME]: 'run-current' },
      }),
      runtimeResult: runtimeSnapshot({ runId: 'run-stale' }),
    });

    await harness.slice.fetchTeamAgentRuntime(TEAM_NAME);

    expect(harness.runtimeSnapshotPolicy.getFreshnessSnapshot).not.toHaveBeenCalled();
    expect(harness.runtimeSnapshotPolicy.rememberFreshnessSnapshot).not.toHaveBeenCalled();
    expect(harness.getState().teamAgentRuntimeByTeam).toEqual({});
  });
});
