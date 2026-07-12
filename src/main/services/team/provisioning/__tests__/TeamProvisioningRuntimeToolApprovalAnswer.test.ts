import { describe, expect, it, vi } from 'vitest';

import {
  answerOpenCodeRuntimeToolApproval,
  type OpenCodeRuntimePermissionAnswerRun,
  type OpenCodeRuntimeToolApprovalAnswerPorts,
} from '../TeamProvisioningRuntimeToolApprovalAnswer';

import type { RuntimeToolApprovalEntry } from '../../approvals/RuntimeToolApprovalCoordinator';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberSpec,
  TeamRuntimePermissionAnswerInput,
} from '../../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot, TeamChangeEvent } from '@shared/types';

interface TestRun extends OpenCodeRuntimePermissionAnswerRun {
  runId: string;
  teamName: string;
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
}

interface TestPorts extends OpenCodeRuntimeToolApprovalAnswerPorts<TestRun> {
  events: string[];
  runtimeAdapterRunByTeam: Map<string, unknown>;
  aliveRunByTeam: Map<string, string>;
  emittedTeamChanges: TeamChangeEvent[];
}

const expectedMembers: TeamRuntimeMemberSpec[] = [
  {
    name: 'Worker',
    role: 'Build',
    providerId: 'opencode',
    cwd: '/repo',
  },
];

const previousLaunchState = {
  teamName: 'team-a',
  launchPhase: 'active',
  teamLaunchState: 'partial_pending',
  expectedMembers: ['Worker'],
  members: {},
  summary: {
    totalMembers: 1,
    runningMembers: 0,
    failedMembers: 0,
    pendingMembers: 1,
    completedMembers: 0,
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as PersistedTeamLaunchSnapshot;

function makeEntry(input: Partial<RuntimeToolApprovalEntry> = {}): RuntimeToolApprovalEntry {
  return {
    providerId: 'opencode',
    providerRequestId: 'provider-request-a',
    laneId: 'primary',
    memberName: 'Worker',
    cwd: '/repo',
    expectedMembers,
    approval: {
      requestId: 'opencode:run-a:provider-request-a',
      runId: 'run-a',
      teamName: 'team-a',
      providerId: 'opencode',
      source: 'Worker',
      toolName: 'Bash',
      toolInput: {},
      receivedAt: '2026-01-01T00:00:01.000Z',
      teamDisplayName: 'Team A',
      teamColor: '#123456',
      runtimePermission: {
        providerId: 'opencode',
        laneId: input.laneId ?? 'primary',
        memberName: 'Worker',
        providerRequestId: 'provider-request-a',
        sessionId: 'session-a',
      },
    },
    ...input,
  };
}

function makeResult(input: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a',
    teamName: 'team-a',
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    members: {
      Worker: {
        memberName: 'Worker',
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
    ...input,
  };
}

function makeLane(
  input: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary-worker',
    providerId: 'opencode',
    member: {
      name: 'Worker',
      role: 'Build',
      providerId: 'opencode',
      cwd: '/repo',
    },
    runId: 'run-secondary',
    state: 'launching',
    result: null,
    warnings: [],
    diagnostics: [],
    ...input,
  };
}

function makeAdapter(
  answerRuntimePermission?: TeamLaunchRuntimeAdapter['answerRuntimePermission']
): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
    ...(answerRuntimePermission ? { answerRuntimePermission } : {}),
  } as unknown as TeamLaunchRuntimeAdapter;
}

function makePorts(
  input: {
    adapter?: TeamLaunchRuntimeAdapter | null;
    adapterResult?: TeamRuntimeLaunchResult;
    committedResult?: TeamRuntimeLaunchResult;
    guardedResult?: TeamRuntimeLaunchResult;
    trackedRunId?: string;
    run?: TestRun;
  } = {}
): TestPorts {
  const events: string[] = [];
  const runtimeAdapterRunByTeam = new Map<string, unknown>([['team-a', { runId: 'old-run' }]]);
  const aliveRunByTeam = new Map<string, string>();
  const emittedTeamChanges: TeamChangeEvent[] = [];
  const answerRuntimePermission =
    input.adapter?.answerRuntimePermission ??
    vi.fn(async () => {
      events.push('answerRuntimePermission');
      return input.adapterResult ?? makeResult();
    });
  const adapter =
    Object.prototype.hasOwnProperty.call(input, 'adapter') && input.adapter !== undefined
      ? input.adapter
      : makeAdapter(answerRuntimePermission);

  return {
    events,
    runtimeAdapterRunByTeam,
    aliveRunByTeam,
    emittedTeamChanges,
    getOpenCodeRuntimeAdapter: vi.fn(() => adapter ?? null),
    readLaunchState: vi.fn(async () => {
      events.push('readLaunchState');
      return previousLaunchState;
    }),
    buildOpenCodeRuntimePermissionAnswerInput: vi.fn(
      (
        entry: RuntimeToolApprovalEntry,
        allow: boolean,
        state: PersistedTeamLaunchSnapshot | null
      ) => {
        events.push('buildAnswerInput');
        return {
          runId: entry.approval.runId,
          laneId: entry.laneId,
          teamName: entry.approval.teamName,
          cwd: entry.cwd ?? '',
          providerId: 'opencode',
          memberName: entry.memberName,
          requestId: entry.providerRequestId,
          decision: allow ? 'allow' : 'reject',
          expectedMembers: entry.expectedMembers ?? [],
          previousLaunchState: state,
        } satisfies TeamRuntimePermissionAnswerInput;
      }
    ),
    buildOpenCodeRuntimePermissionLaunchInput: vi.fn(
      (entry: RuntimeToolApprovalEntry, state: PersistedTeamLaunchSnapshot | null) => {
        events.push('buildLaunchInput');
        return {
          runId: entry.approval.runId,
          laneId: entry.laneId,
          teamName: entry.approval.teamName,
          cwd: entry.cwd ?? '',
          providerId: 'opencode',
          skipPermissions: false,
          expectedMembers: entry.expectedMembers ?? [],
          previousLaunchState: state,
        } satisfies TeamRuntimeLaunchInput;
      }
    ),
    persistOpenCodeRuntimeAdapterLaunchResult: vi.fn(async () => {
      events.push('persistLaunchResult');
      return { result: input.committedResult ?? makeResult() };
    }),
    deleteRuntimeAdapterRunByTeam: vi.fn((teamName: string) => {
      events.push('deleteRuntimeAdapterRun');
      runtimeAdapterRunByTeam.delete(teamName);
    }),
    setRuntimeAdapterRunByTeam: vi.fn((teamName, runtimeRun) => {
      events.push('setRuntimeAdapterRun');
      runtimeAdapterRunByTeam.set(teamName, runtimeRun);
    }),
    setAliveRunId: vi.fn((teamName, runId) => {
      events.push('setAliveRunId');
      aliveRunByTeam.set(teamName, runId);
    }),
    getTrackedRunId: vi.fn(() => input.trackedRunId),
    getRun: vi.fn((runId) => (runId === input.trackedRunId ? input.run : undefined)),
    guardCommittedOpenCodeSecondaryLaneEvidence: vi.fn(async () => {
      events.push('guardEvidence');
      return input.guardedResult ?? makeResult();
    }),
    publishMixedSecondaryLaneStatusChange: vi.fn(async (_run, lane) => {
      events.push(`publishStatus:${lane.state}:${lane.warnings.join(',')}`);
    }),
    syncOpenCodeRuntimeToolApprovals: vi.fn(() => {
      events.push('syncApprovals');
    }),
    emitTeamChange: vi.fn((event) => {
      events.push(`emitTeamChange:${event.detail ?? ''}`);
      emittedTeamChanges.push(event);
    }),
  };
}

describe('answerOpenCodeRuntimeToolApproval', () => {
  it('rejects non-opencode providers with the existing error text', async () => {
    const ports = makePorts();
    await expect(
      answerOpenCodeRuntimeToolApproval(
        makeEntry({ providerId: 'anthropic' as RuntimeToolApprovalEntry['providerId'] }),
        true,
        ports
      )
    ).rejects.toThrow('Runtime approval provider is not supported: anthropic');

    expect(ports.getOpenCodeRuntimeAdapter).not.toHaveBeenCalled();
  });

  it('rejects a missing answer bridge with the existing error text', async () => {
    const ports = makePorts({ adapter: makeAdapter() });

    await expect(answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports)).rejects.toThrow(
      'OpenCode runtime permission answer bridge is not available'
    );

    expect(ports.readLaunchState).not.toHaveBeenCalled();
  });

  it('deletes the primary runtime adapter run and syncs approvals on partial failure', async () => {
    const entry = makeEntry();
    const committedResult = makeResult({ teamLaunchState: 'partial_failure' });
    const ports = makePorts({ committedResult });

    await answerOpenCodeRuntimeToolApproval(entry, true, ports);

    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.setAliveRunId).not.toHaveBeenCalled();
    expect(ports.buildOpenCodeRuntimePermissionAnswerInput).toHaveBeenCalledWith(
      entry,
      true,
      previousLaunchState
    );
    expect(ports.buildOpenCodeRuntimePermissionLaunchInput).toHaveBeenCalledWith(
      entry,
      previousLaunchState
    );
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith({
      teamName: 'team-a',
      runId: 'run-a',
      laneId: 'primary',
      cwd: '/repo',
      members: committedResult.members,
      expectedMembers,
      teamDisplayName: 'Team A',
      teamColor: '#123456',
    });
    expect(ports.events.indexOf('readLaunchState')).toBeLessThan(
      ports.events.indexOf('answerRuntimePermission')
    );
  });

  it('sets the primary runtime adapter run, alive run id, syncs approvals, and emits allowed', async () => {
    const committedResult = makeResult({ teamLaunchState: 'clean_success' });
    const ports = makePorts({ committedResult });

    await answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);

    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toEqual({
      runId: 'run-a',
      providerId: 'opencode',
      cwd: '/repo',
      members: committedResult.members,
    });
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-a');
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ members: committedResult.members })
    );
    expect(ports.emittedTeamChanges.at(-1)).toEqual({
      type: 'process',
      teamName: 'team-a',
      runId: 'run-a',
      detail: 'permission-allowed',
    });
  });

  it('emits denied on a successful primary deny answer', async () => {
    const ports = makePorts({ committedResult: makeResult({ teamLaunchState: 'clean_success' }) });

    await answerOpenCodeRuntimeToolApproval(makeEntry(), false, ports);

    expect(ports.emittedTeamChanges.at(-1)).toEqual({
      type: 'process',
      teamName: 'team-a',
      runId: 'run-a',
      detail: 'permission-denied',
    });
  });

  it('throws the existing error text when the secondary run is missing', async () => {
    const ports = makePorts({ trackedRunId: undefined });

    await expect(
      answerOpenCodeRuntimeToolApproval(makeEntry({ laneId: 'secondary-worker' }), true, ports)
    ).rejects.toThrow('Run not found for team "team-a"');
  });

  it('throws the existing error text when the secondary lane is missing', async () => {
    const ports = makePorts({
      trackedRunId: 'run-a',
      run: {
        runId: 'run-a',
        teamName: 'team-a',
        mixedSecondaryLanes: [],
      },
    });

    await expect(
      answerOpenCodeRuntimeToolApproval(makeEntry({ laneId: 'secondary-worker' }), true, ports)
    ).rejects.toThrow('OpenCode secondary lane secondary-worker was not found for team "team-a"');
  });

  it('guards, mutates, publishes, syncs, and emits for a successful secondary answer', async () => {
    const lane = makeLane();
    const run: TestRun = {
      runId: 'run-a',
      teamName: 'team-a',
      mixedSecondaryLanes: [lane],
    };
    const guardedResult = makeResult({
      warnings: ['guarded-warning'],
      diagnostics: ['guarded-diagnostic'],
    });
    const ports = makePorts({
      trackedRunId: 'run-a',
      run,
      guardedResult,
    });

    await answerOpenCodeRuntimeToolApproval(makeEntry({ laneId: 'secondary-worker' }), true, ports);

    expect(ports.guardCommittedOpenCodeSecondaryLaneEvidence).toHaveBeenCalledWith({
      teamName: 'team-a',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      result: expect.objectContaining({ runId: 'run-a' }),
    });
    expect(lane.result).toBe(guardedResult);
    expect(lane.warnings).toEqual(['guarded-warning']);
    expect(lane.diagnostics).toEqual(['guarded-diagnostic']);
    expect(lane.state).toBe('finished');
    expect(ports.events).toEqual([
      'readLaunchState',
      'buildAnswerInput',
      'answerRuntimePermission',
      'guardEvidence',
      'publishStatus:finished:guarded-warning',
      'syncApprovals',
      'emitTeamChange:permission-allowed',
    ]);
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith({
      teamName: 'team-a',
      runId: 'run-a',
      laneId: 'secondary-worker',
      cwd: '/repo',
      members: guardedResult.members,
      expectedMembers,
      teamDisplayName: 'Team A',
      teamColor: '#123456',
    });
  });

  it('rejects a secondary result when the tracked run changes while the answer is in flight', async () => {
    const oldLane = makeLane();
    const newLane = makeLane();
    const runs = new Map<string, TestRun>([
      [
        'run-old',
        {
          runId: 'run-old',
          teamName: 'team-a',
          mixedSecondaryLanes: [oldLane],
        },
      ],
      [
        'run-new',
        {
          runId: 'run-new',
          teamName: 'team-a',
          mixedSecondaryLanes: [newLane],
        },
      ],
    ]);
    let signalAnswerStarted!: () => void;
    const answerStarted = new Promise<void>((resolve) => {
      signalAnswerStarted = resolve;
    });
    let resolveAnswer!: (result: TeamRuntimeLaunchResult) => void;
    const answerResult = new Promise<TeamRuntimeLaunchResult>((resolve) => {
      resolveAnswer = resolve;
    });
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          signalAnswerStarted();
          return answerResult;
        })
      ),
    });
    let trackedRunId = 'run-old';
    vi.mocked(ports.getTrackedRunId).mockImplementation(() => trackedRunId);
    vi.mocked(ports.getRun).mockImplementation((runId) => runs.get(runId));
    const baseEntry = makeEntry({ laneId: 'secondary-worker' });
    const entry = makeEntry({
      laneId: 'secondary-worker',
      approval: {
        ...baseEntry.approval,
        requestId: 'opencode:run-old:provider-request-a',
        runId: 'run-old',
      },
    });

    const answer = answerOpenCodeRuntimeToolApproval(entry, true, ports);
    await answerStarted;
    trackedRunId = 'run-new';
    resolveAnswer(makeResult({ runId: 'run-old' }));

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked runId mismatch for team "team-a" (expected run-old, got run-new)'
    );
    expect(oldLane).toMatchObject({
      result: null,
      warnings: [],
      diagnostics: [],
      state: 'launching',
    });
    expect(newLane).toMatchObject({
      result: null,
      warnings: [],
      diagnostics: [],
      state: 'launching',
    });
    expect(ports.guardCommittedOpenCodeSecondaryLaneEvidence).not.toHaveBeenCalled();
    expect(ports.publishMixedSecondaryLaneStatusChange).not.toHaveBeenCalled();
    expect(ports.syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });
});
