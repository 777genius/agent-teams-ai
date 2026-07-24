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
  TeamRuntimeStopInput,
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
  secondaryRuntimeRunByTeam: Map<string, Map<string, { runId: string; providerId: 'opencode' }>>;
  aliveRunByTeam: Map<string, string>;
  emittedTeamChanges: TeamChangeEvent[];
  degradedLanes: Array<{ teamName: string; laneId: string; diagnostics: string[] }>;
  logWarnings: string[];
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

function makeSecondaryEntry(runtimeRunId = 'run-secondary'): RuntimeToolApprovalEntry {
  const entry = makeEntry({ laneId: 'secondary-worker' });
  return {
    ...entry,
    approval: {
      ...entry.approval,
      requestId: `opencode:${runtimeRunId}:provider-request-a`,
      runId: runtimeRunId,
    },
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
    stop: vi.fn(async (input: TeamRuntimeStopInput) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    })),
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
  const runtimeAdapterRunByTeam = new Map<string, unknown>([
    ['team-a', { runId: 'run-a', providerId: 'opencode' }],
  ]);
  const secondaryRuntimeRunByTeam = new Map([
    [
      'team-a',
      new Map([['secondary-worker', { runId: 'run-secondary', providerId: 'opencode' as const }]]),
    ],
  ]);
  const aliveRunByTeam = new Map<string, string>();
  const emittedTeamChanges: TeamChangeEvent[] = [];
  const degradedLanes: Array<{ teamName: string; laneId: string; diagnostics: string[] }> = [];
  const logWarnings: string[] = [];
  const trackedRunId = Object.prototype.hasOwnProperty.call(input, 'trackedRunId')
    ? input.trackedRunId
    : 'run-a';
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
    secondaryRuntimeRunByTeam,
    aliveRunByTeam,
    emittedTeamChanges,
    degradedLanes,
    logWarnings,
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
    getRuntimeAdapterRunByTeam: vi.fn(
      (teamName: string) =>
        runtimeAdapterRunByTeam.get(teamName) as
          | { runId: string; providerId: 'opencode' }
          | undefined
    ),
    deleteRuntimeAdapterRunIfOwned: vi.fn((teamName: string, runId: string) => {
      const current = runtimeAdapterRunByTeam.get(teamName) as
        | { runId: string; providerId: 'opencode' }
        | undefined;
      if (current?.providerId !== 'opencode' || current.runId !== runId) return false;
      events.push('deleteRuntimeAdapterRunIfOwned');
      runtimeAdapterRunByTeam.delete(teamName);
      return true;
    }),
    getSecondaryRuntimeRun: vi.fn((teamName: string, laneId: string) =>
      secondaryRuntimeRunByTeam.get(teamName)?.get(laneId)
    ),
    deleteSecondaryRuntimeRunIfOwned: vi.fn((teamName: string, laneId: string, runId: string) => {
      const teamRuns = secondaryRuntimeRunByTeam.get(teamName);
      const current = teamRuns?.get(laneId);
      if (current?.providerId !== 'opencode' || current.runId !== runId) return false;
      events.push(`deleteSecondaryRuntimeRunIfOwned:${laneId}`);
      teamRuns?.delete(laneId);
      if (teamRuns?.size === 0) secondaryRuntimeRunByTeam.delete(teamName);
      return true;
    }),
    markOpenCodeRuntimeLaneDegraded: vi.fn(async (degraded) => {
      events.push(`markDegraded:${degraded.laneId}`);
      degradedLanes.push(degraded);
    }),
    deleteAliveRunIdIfNoRuntime: vi.fn((teamName, expectedTrackedRunId) => {
      if (
        runtimeAdapterRunByTeam.has(teamName) ||
        (secondaryRuntimeRunByTeam.get(teamName)?.size ?? 0) > 0 ||
        aliveRunByTeam.get(teamName) !== expectedTrackedRunId
      ) {
        return false;
      }
      aliveRunByTeam.delete(teamName);
      return true;
    }),
    logWarning: vi.fn((message) => {
      logWarnings.push(message);
    }),
    setRuntimeAdapterRunByTeam: vi.fn((teamName, runtimeRun) => {
      events.push('setRuntimeAdapterRun');
      runtimeAdapterRunByTeam.set(teamName, runtimeRun);
    }),
    setAliveRunId: vi.fn((teamName, runId) => {
      events.push('setAliveRunId');
      aliveRunByTeam.set(teamName, runId);
    }),
    getTrackedRunId: vi.fn(() => trackedRunId),
    getRun: vi.fn((runId) => (runId === trackedRunId ? input.run : undefined)),
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

  it('forwards a supplied approval message to the runtime adapter', async () => {
    const answerRuntimePermission = vi.fn<
      NonNullable<TeamLaunchRuntimeAdapter['answerRuntimePermission']>
    >(async (_input) => makeResult());
    const ports = makePorts({ adapter: makeAdapter(answerRuntimePermission) });

    await answerOpenCodeRuntimeToolApproval(
      makeEntry(),
      true,
      ports,
      'Approved for the requested test command.'
    );

    expect(answerRuntimePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-a',
        teamName: 'team-a',
        laneId: 'primary',
        memberName: 'Worker',
        requestId: 'provider-request-a',
        message: 'Approved for the requested test command.',
      })
    );
  });

  it('keeps approval inputs without a message backward compatible', async () => {
    const answerRuntimePermission = vi.fn<
      NonNullable<TeamLaunchRuntimeAdapter['answerRuntimePermission']>
    >(async (_input) => makeResult());
    const ports = makePorts({ adapter: makeAdapter(answerRuntimePermission) });

    await answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);

    const permissionInput = answerRuntimePermission.mock.calls[0]?.[0];
    expect(permissionInput).toBeDefined();
    expect(Object.hasOwn(permissionInput ?? {}, 'message')).toBe(false);
  });

  it('stops only the unretainable primary lane, removes its exact owner, and marks it degraded', async () => {
    const entry = makeEntry();
    const committedResult = makeResult({
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Cursor usage limit',
          diagnostics: ['Cursor usage limit'],
        },
      },
      diagnostics: ['Cursor usage limit'],
    });
    const ports = makePorts({ committedResult });
    const adapter = ports.getOpenCodeRuntimeAdapter();

    await answerOpenCodeRuntimeToolApproval(entry, true, ports);

    expect(adapter?.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-a',
        teamName: 'team-a',
        laneId: 'primary',
        cwd: '/repo',
        reason: 'cleanup',
        force: true,
      })
    );
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.deleteRuntimeAdapterRunIfOwned).toHaveBeenCalledWith('team-a', 'run-a');
    expect(ports.degradedLanes).toEqual([
      { teamName: 'team-a', laneId: 'primary', diagnostics: ['Cursor usage limit'] },
    ]);
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

  it('keeps the stopped primary owner reserved until its degraded state is persisted', async () => {
    const committedResult = makeResult({
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          diagnostics: ['Runtime rejected the request'],
        },
      },
      diagnostics: ['Runtime rejected the request'],
    });
    let signalDegradedWriteStarted!: () => void;
    const degradedWriteStarted = new Promise<void>((resolve) => {
      signalDegradedWriteStarted = resolve;
    });
    let resolveDegradedWrite!: () => void;
    const degradedWrite = new Promise<void>((resolve) => {
      resolveDegradedWrite = resolve;
    });
    const ports = makePorts({ committedResult });
    vi.mocked(ports.markOpenCodeRuntimeLaneDegraded!).mockImplementation(async () => {
      signalDegradedWriteStarted();
      await degradedWrite;
    });

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), false, ports);
    await degradedWriteStarted;

    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toMatchObject({
      runId: 'run-a',
      providerId: 'opencode',
    });

    resolveDegradedWrite();
    await answer;
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
  });

  it('uses the exact primary owner cwd and retains ownership after cleanup stop fails', async () => {
    const committedResult = makeResult({
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Runtime rejected the request',
          diagnostics: ['Runtime rejected the request'],
        },
      },
      diagnostics: ['Runtime rejected the request'],
    });
    const ports = makePorts({ committedResult });
    ports.runtimeAdapterRunByTeam.set('team-a', {
      runId: 'run-a',
      providerId: 'opencode',
      cwd: '/exact-owner-cwd',
    });
    ports.secondaryRuntimeRunByTeam.clear();
    ports.aliveRunByTeam.set('team-a', 'run-a');
    const adapter = ports.getOpenCodeRuntimeAdapter();
    vi.mocked(adapter!.stop).mockRejectedValueOnce(new Error('cleanup bridge failed'));

    await expect(
      answerOpenCodeRuntimeToolApproval(makeEntry({ cwd: undefined }), true, ports)
    ).resolves.toBeUndefined();

    expect(adapter?.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-a',
        laneId: 'primary',
        cwd: '/exact-owner-cwd',
      })
    );
    expect(ports.logWarnings).toEqual([
      '[team-a] Failed to stop unretainable OpenCode runtime lane primary: cleanup bridge failed',
    ]);
    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toMatchObject({
      runId: 'run-a',
      cwd: '/exact-owner-cwd',
    });
    expect(ports.degradedLanes).toEqual([]);
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalled();
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-a');
    expect(ports.deleteAliveRunIdIfNoRuntime).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).toHaveBeenCalled();
  });

  it('does not attempt post-stop owner cleanup when adapter stop fails', async () => {
    const committedResult = makeResult({
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Runtime rejected the request',
          diagnostics: ['Runtime rejected the request'],
        },
      },
      diagnostics: ['Runtime rejected the request'],
    });
    const ports = makePorts({ committedResult });
    ports.secondaryRuntimeRunByTeam.clear();
    ports.aliveRunByTeam.set('team-a', 'run-a');
    const adapter = ports.getOpenCodeRuntimeAdapter();
    vi.mocked(adapter!.stop).mockRejectedValueOnce(new Error('cleanup bridge failed'));
    vi.mocked(ports.markOpenCodeRuntimeLaneDegraded!).mockRejectedValueOnce(
      new Error('degraded index failed')
    );

    await expect(
      answerOpenCodeRuntimeToolApproval(makeEntry(), false, ports)
    ).resolves.toBeUndefined();

    expect(
      (ports.runtimeAdapterRunByTeam.get('team-a') as { runId?: string } | undefined)?.runId
    ).toBe('run-a');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-a');
    expect(ports.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalled();
    expect(ports.emitTeamChange).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'permission-denied' })
    );
    expect(ports.logWarnings).toEqual([
      '[team-a] Failed to stop unretainable OpenCode runtime lane primary: cleanup bridge failed',
    ]);
    expect(ports.markOpenCodeRuntimeLaneDegraded).not.toHaveBeenCalled();
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

  it('does not send an answer after stop marks the tracked run cancelled while launch state is read', async () => {
    const run: TestRun = {
      runId: 'run-a',
      teamName: 'team-a',
      cancelRequested: false,
      processKilled: false,
    };
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let resolveRead!: (state: PersistedTeamLaunchSnapshot | null) => void;
    const readResult = new Promise<PersistedTeamLaunchSnapshot | null>((resolve) => {
      resolveRead = resolve;
    });
    const ports = makePorts({ run });
    vi.mocked(ports.readLaunchState).mockImplementation(async () => {
      signalReadStarted();
      return readResult;
    });

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await readStarted;
    run.cancelRequested = true;
    run.processKilled = true;
    resolveRead(previousLaunchState);

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked run is stopping for team "team-a"'
    );
    expect(ports.buildOpenCodeRuntimePermissionAnswerInput).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.answerRuntimePermission).not.toHaveBeenCalled();
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not send a primary answer after the tracked run changes while launch state is read', async () => {
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let resolveRead!: (state: PersistedTeamLaunchSnapshot | null) => void;
    const readResult = new Promise<PersistedTeamLaunchSnapshot | null>((resolve) => {
      resolveRead = resolve;
    });
    const ports = makePorts();
    let trackedRunId = 'run-a';
    vi.mocked(ports.getTrackedRunId).mockImplementation(() => trackedRunId);
    vi.mocked(ports.readLaunchState).mockImplementation(async () => {
      signalReadStarted();
      return readResult;
    });

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await readStarted;
    trackedRunId = 'run-new';
    resolveRead(previousLaunchState);

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked runId mismatch for team "team-a" (expected run-a, got run-new)'
    );
    expect(ports.buildOpenCodeRuntimePermissionAnswerInput).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.answerRuntimePermission).not.toHaveBeenCalled();
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not persist a primary answer after the tracked run changes while the bridge is in flight', async () => {
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
    let trackedRunId = 'run-a';
    vi.mocked(ports.getTrackedRunId).mockImplementation(() => trackedRunId);

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await answerStarted;
    trackedRunId = 'run-new';
    resolveAnswer(makeResult());

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked runId mismatch for team "team-a" (expected run-a, got run-new)'
    );
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(ports.setRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(ports.setAliveRunId).not.toHaveBeenCalled();
    expect(ports.syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not apply a committed primary result after the tracked run changes during persistence', async () => {
    let signalPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      signalPersistStarted = resolve;
    });
    let resolvePersist!: (value: { result: TeamRuntimeLaunchResult }) => void;
    const persistResult = new Promise<{ result: TeamRuntimeLaunchResult }>((resolve) => {
      resolvePersist = resolve;
    });
    const ports = makePorts();
    let trackedRunId = 'run-a';
    vi.mocked(ports.getTrackedRunId).mockImplementation(() => trackedRunId);
    vi.mocked(ports.persistOpenCodeRuntimeAdapterLaunchResult).mockImplementation(async () => {
      signalPersistStarted();
      return persistResult;
    });

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await persistStarted;
    trackedRunId = 'run-new';
    resolvePersist({ result: makeResult({ teamLaunchState: 'clean_success' }) });

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked runId mismatch for team "team-a" (expected run-a, got run-new)'
    );
    expect(ports.setRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(ports.deleteRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(ports.setAliveRunId).not.toHaveBeenCalled();
    expect(ports.syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not persist or stop a replacement owner that reuses the run id while the answer bridge is in flight', async () => {
    let signalAnswerStarted!: () => void;
    const answerStarted = new Promise<void>((resolve) => {
      signalAnswerStarted = resolve;
    });
    let resolveAnswer!: (result: TeamRuntimeLaunchResult) => void;
    const answerResult = new Promise<TeamRuntimeLaunchResult>((resolve) => {
      resolveAnswer = resolve;
    });
    const adapter = makeAdapter(
      vi.fn(async () => {
        signalAnswerStarted();
        return answerResult;
      })
    );
    const ports = makePorts({ adapter });
    const replacementOwner = {
      runId: 'run-a',
      providerId: 'opencode' as const,
      cwd: '/replacement-owner',
    };

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await answerStarted;
    ports.runtimeAdapterRunByTeam.set('team-a', replacementOwner);
    resolveAnswer(makeResult({ teamLaunchState: 'partial_failure' }));

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: exact runtime owner changed for team "team-a" lane primary'
    );
    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toBe(replacementOwner);
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(ports.setRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not overwrite or stop a replacement owner that reuses the run id during persistence', async () => {
    let signalPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      signalPersistStarted = resolve;
    });
    let resolvePersist!: (value: { result: TeamRuntimeLaunchResult }) => void;
    const persistResult = new Promise<{ result: TeamRuntimeLaunchResult }>((resolve) => {
      resolvePersist = resolve;
    });
    const ports = makePorts();
    vi.mocked(ports.persistOpenCodeRuntimeAdapterLaunchResult).mockImplementation(async () => {
      signalPersistStarted();
      return persistResult;
    });
    const replacementOwner = {
      runId: 'run-a',
      providerId: 'opencode' as const,
      cwd: '/replacement-owner',
    };

    const answer = answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports);
    await persistStarted;
    ports.runtimeAdapterRunByTeam.set('team-a', replacementOwner);
    resolvePersist({ result: makeResult({ teamLaunchState: 'partial_failure' }) });

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: exact runtime owner changed for team "team-a" lane primary'
    );
    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toBe(replacementOwner);
    expect(ports.getOpenCodeRuntimeAdapter()?.stop).not.toHaveBeenCalled();
    expect(ports.setRuntimeAdapterRunByTeam).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('rejects an approval captured from a stale cwd instead of targeting the current owner', async () => {
    const ports = makePorts();
    ports.runtimeAdapterRunByTeam.set('team-a', {
      runId: 'run-a',
      providerId: 'opencode',
      cwd: '/current-owner',
    });

    await expect(answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports)).rejects.toThrow(
      'Stale runtime approval: runtime owner cwd changed for team "team-a" lane primary'
    );

    expect(ports.readLaunchState).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.answerRuntimePermission).not.toHaveBeenCalled();
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.stop).not.toHaveBeenCalled();
  });

  it('rejects a permission result for a different runtime identity', async () => {
    const ports = makePorts({
      adapterResult: makeResult({ runId: 'run-other', teamName: 'team-other' }),
    });

    await expect(answerOpenCodeRuntimeToolApproval(makeEntry(), true, ports)).rejects.toThrow(
      'Runtime permission answer identity mismatch for team "team-a" (expected runId run-a, got team "team-other" runId run-other)'
    );
    expect(ports.persistOpenCodeRuntimeAdapterLaunchResult).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('throws the existing error text when the secondary run is missing', async () => {
    const ports = makePorts({ trackedRunId: undefined });

    await expect(
      answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), true, ports)
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
      answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), true, ports)
    ).rejects.toThrow('OpenCode secondary lane secondary-worker was not found for team "team-a"');
  });

  it('preserves the distinct tracked run and secondary runtime identities', async () => {
    const lane = makeLane({ runId: 'run-secondary' });
    const run: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [lane],
    };
    const guardedResult = makeResult({
      runId: 'run-secondary',
      warnings: ['guarded-warning'],
      diagnostics: ['guarded-diagnostic'],
    });
    const ports = makePorts({
      adapterResult: makeResult({ runId: 'run-secondary' }),
      trackedRunId: 'run-parent',
      run,
      guardedResult,
    });

    await answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), true, ports);

    expect(ports.guardCommittedOpenCodeSecondaryLaneEvidence).toHaveBeenCalledWith({
      teamName: 'team-a',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      result: expect.objectContaining({ runId: 'run-secondary' }),
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
      runId: 'run-secondary',
      laneId: 'secondary-worker',
      cwd: '/repo',
      members: guardedResult.members,
      expectedMembers,
      teamDisplayName: 'Team A',
      teamColor: '#123456',
    });
  });

  it('stops only an unretainable secondary lane and preserves its sibling owner', async () => {
    const lane = makeLane({ runId: 'run-secondary' });
    const siblingLane = makeLane({
      laneId: 'secondary-sibling',
      member: { name: 'Sibling', providerId: 'opencode', cwd: '/repo' },
      runId: 'run-sibling',
      state: 'finished',
    });
    const run: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [lane, siblingLane],
    };
    const failed = makeResult({
      runId: 'run-secondary',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Cursor usage limit',
          diagnostics: ['Cursor usage limit'],
        },
      },
      diagnostics: ['Cursor usage limit'],
    });
    const ports = makePorts({
      adapterResult: failed,
      guardedResult: failed,
      trackedRunId: 'run-parent',
      run,
    });
    ports.secondaryRuntimeRunByTeam.get('team-a')?.set('secondary-sibling', {
      runId: 'run-sibling',
      providerId: 'opencode',
    });
    const adapter = ports.getOpenCodeRuntimeAdapter();

    await answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), false, ports);

    expect(adapter?.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-secondary',
        laneId: 'secondary-worker',
        reason: 'cleanup',
        force: true,
      })
    );
    expect(ports.secondaryRuntimeRunByTeam.get('team-a')?.has('secondary-worker')).toBe(false);
    expect(ports.secondaryRuntimeRunByTeam.get('team-a')?.has('secondary-sibling')).toBe(true);
    expect(ports.degradedLanes).toEqual([
      {
        teamName: 'team-a',
        laneId: 'secondary-worker',
        diagnostics: ['Cursor usage limit'],
      },
    ]);
  });

  it('rejects a stale secondary approval after the lane runtime is replaced', async () => {
    const run: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [makeLane({ runId: 'run-secondary-new' })],
    };
    const ports = makePorts({ trackedRunId: 'run-parent', run });

    await expect(
      answerOpenCodeRuntimeToolApproval(makeSecondaryEntry('run-secondary-old'), true, ports)
    ).rejects.toThrow(
      'Stale runtime approval: exact runtime owner is no longer current for team "team-a" lane secondary-worker'
    );
    expect(ports.readLaunchState).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.answerRuntimePermission).not.toHaveBeenCalled();
    expect(ports.guardCommittedOpenCodeSecondaryLaneEvidence).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('rejects a secondary result when the tracked run object is replaced during evidence guard', async () => {
    const oldLane = makeLane({ runId: 'run-secondary' });
    const newLane = makeLane({ runId: 'run-secondary' });
    const oldRun: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [oldLane],
    };
    const newRun: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [newLane],
    };
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let resolveGuard!: (result: TeamRuntimeLaunchResult) => void;
    const guardResult = new Promise<TeamRuntimeLaunchResult>((resolve) => {
      resolveGuard = resolve;
    });
    const ports = makePorts({
      adapterResult: makeResult({ runId: 'run-secondary' }),
      trackedRunId: 'run-parent',
      run: oldRun,
    });
    let currentRun = oldRun;
    vi.mocked(ports.getRun).mockImplementation(() => currentRun);
    vi.mocked(ports.guardCommittedOpenCodeSecondaryLaneEvidence).mockImplementation(async () => {
      signalGuardStarted();
      return guardResult;
    });

    const answer = answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), true, ports);
    await guardStarted;
    currentRun = newRun;
    resolveGuard(makeResult({ runId: 'run-secondary' }));

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked run identity changed for team "team-a"'
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
    expect(ports.publishMixedSecondaryLaneStatusChange).not.toHaveBeenCalled();
    expect(ports.syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not mutate a secondary lane when its exact owner is replaced during evidence guard', async () => {
    const lane = makeLane({ runId: 'run-secondary' });
    const run: TestRun = {
      runId: 'run-parent',
      teamName: 'team-a',
      mixedSecondaryLanes: [lane],
    };
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let resolveGuard!: (result: TeamRuntimeLaunchResult) => void;
    const guardResult = new Promise<TeamRuntimeLaunchResult>((resolve) => {
      resolveGuard = resolve;
    });
    const ports = makePorts({
      adapterResult: makeResult({ runId: 'run-secondary' }),
      trackedRunId: 'run-parent',
      run,
    });
    vi.mocked(ports.guardCommittedOpenCodeSecondaryLaneEvidence).mockImplementation(async () => {
      signalGuardStarted();
      return guardResult;
    });
    const replacementOwner = {
      runId: 'run-secondary',
      providerId: 'opencode' as const,
    };

    const answer = answerOpenCodeRuntimeToolApproval(makeSecondaryEntry(), true, ports);
    await guardStarted;
    ports.secondaryRuntimeRunByTeam.get('team-a')?.set('secondary-worker', replacementOwner);
    resolveGuard(makeResult({ runId: 'run-secondary' }));

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: exact runtime owner changed for team "team-a" lane secondary-worker'
    );
    expect(ports.secondaryRuntimeRunByTeam.get('team-a')?.get('secondary-worker')).toBe(
      replacementOwner
    );
    expect(lane).toMatchObject({
      result: null,
      warnings: [],
      diagnostics: [],
      state: 'launching',
    });
    expect(ports.publishMixedSecondaryLaneStatusChange).not.toHaveBeenCalled();
    expect(ports.syncOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.getOpenCodeRuntimeAdapter()?.stop).not.toHaveBeenCalled();
  });

  it('rejects a secondary result when the tracked run changes while the answer is in flight', async () => {
    const oldLane = makeLane({ runId: 'run-secondary' });
    const newLane = makeLane({ runId: 'run-new-secondary' });
    const runs = new Map<string, TestRun>([
      [
        'run-parent-old',
        {
          runId: 'run-parent-old',
          teamName: 'team-a',
          mixedSecondaryLanes: [oldLane],
        },
      ],
      [
        'run-parent-new',
        {
          runId: 'run-parent-new',
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
    let trackedRunId = 'run-parent-old';
    vi.mocked(ports.getTrackedRunId).mockImplementation(() => trackedRunId);
    vi.mocked(ports.getRun).mockImplementation((runId) => runs.get(runId));
    const entry = makeSecondaryEntry();

    const answer = answerOpenCodeRuntimeToolApproval(entry, true, ports);
    await answerStarted;
    trackedRunId = 'run-parent-new';
    resolveAnswer(makeResult({ runId: 'run-secondary' }));

    await expect(answer).rejects.toThrow(
      'Stale runtime approval: tracked runId mismatch for team "team-a" (expected run-parent-old, got run-parent-new)'
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
