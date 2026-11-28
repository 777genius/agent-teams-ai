import { TeamGraphAdapter } from '@features/agent-graph/renderer/adapters/TeamGraphAdapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { activityEvent } from '../../../src/features/agent-backend/main/adapters/output/projectRuntimeActivity';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { BackendLaunchSnapshot } from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendActivityEvent,
  BackendActivitySnapshot,
  BackendOperationRequest,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamChangeEvent, ToolActivityEventPayload } from '../../../src/shared/types/team';
import type { TeamGraphData } from '@features/agent-graph/renderer/adapters/TeamGraphAdapter';

const ui = vi.hoisted(() => ({ teams: {} as TeamsAPI }));
vi.mock('@renderer/api', () => ({
  api: {
    get teams() {
      return ui.teams;
    },
    externalAgentConnection: {
      getConnectionInfo: vi.fn(async () => ({
        context: {
          appInstanceId: 'TEST-app',
          dataRootFingerprint: 'TEST-root',
          connectionGeneration: 1,
        },
      })),
    },
    config: {
      get: vi.fn(async () => ({
        general: { theme: 'dark' },
        notifications: { enabled: true, triggers: [] },
      })),
    },
    getRepositoryGroups: vi.fn(async () => []),
    notifications: {
      onNew: vi.fn(() => () => undefined),
      onUpdated: vi.fn(() => () => undefined),
      onClicked: vi.fn(() => () => undefined),
      setViewedTeam: vi.fn(async () => true),
      get: vi.fn(async () => ({
        notifications: [],
        total: 0,
        totalCount: 0,
        unreadCount: 0,
        hasMore: false,
      })),
    },
    schedules: { list: vi.fn(async () => []), onScheduleChange: vi.fn(() => () => undefined) },
  },
}));

import { initializeNotificationListeners, useStore } from '../../../src/renderer/store';

const handleId = 'TEST-tool-owner';
const teamName = hostTeamSelectionKey(handleId);
const startedAt = '2026-11-26T10:00:00.000Z';
const finishedAt = '2026-11-26T10:00:01.000Z';
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T11:00:00Z'));
});
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) stop();
  await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function start(sequence = 1, inputId = 'TEST-input'): BackendActivityEvent {
  return {
    sequence,
    eventId: `TEST-start-${sequence}`,
    inputId,
    observedAt: startedAt,
    data: {
      kind: 'tool',
      messageRef: 'TEST-message',
      toolRef: 'TEST-tool',
      name: 'Bash',
      input: { command: 'echo TEST OPENAI_API_KEY=TEST-secret' },
    },
  };
}
function finish(): BackendActivityEvent {
  return {
    sequence: 2,
    eventId: 'TEST-result',
    inputId: 'TEST-input',
    observedAt: finishedAt,
    data: { kind: 'tool-result', toolRef: 'TEST-tool', isError: false, content: 'TEST done' },
  };
}
function fixture() {
  const f = {
    context: 0,
    gap: false,
    events: [] as BackendActivityEvent[],
    latest: [start()] as BackendActivityEvent[],
    afterRead: undefined as ((request: BackendOperationRequest) => void) | undefined,
    connections: {
      state: 'ready',
      bindings: [
        {
          handle: { handleId },
          label: 'TEST team',
          members: [{ memberId: 'TEST-member', label: 'alice' }],
        },
      ],
    } as BackendConnectionSnapshot,
    launch: {
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-roster',
      status: 'ready',
      ready: 1,
      expected: 1,
      retryCapability: 'same-binding-no-allocation-only',
      members: [
        {
          memberId: 'TEST-member',
          generation: 'TEST-generation',
          attemptId: 'TEST-attempt',
          status: 'ready',
          nativeReady: true,
          usable: true,
          controlAvailable: true,
          noAllocation: false,
          reason: 'context-applied',
        },
      ],
    } as BackendLaunchSnapshot,
    runtime: {
      memberId: 'TEST-member',
      generation: 'TEST-generation',
      phase: 'allocated',
      custody: 'owned',
      sealed: false,
      attached: true,
      nativeReady: true,
      inputs: [{ inputId: 'TEST-input', phase: 'consumed' }],
      interactions: [],
    } as BackendRuntimeSnapshot,
  };
  const state: BackendActivitySnapshot['state'] = {
    phase: 'allocated',
    custody: 'owned',
    sealed: false,
    nativeReady: true,
    queuedInputs: 0,
    activeInputs: 1,
    partial: false,
    control: null,
    diagnostic: null,
    interactions: [],
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => structuredClone(f.connections)),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      let value;
      if (request.operation === 'team.changes.read')
        return { ok: false, code: 'hold', outcome: 'unknown' };
      if (request.operation === 'team.launch.read') value = structuredClone(f.launch);
      else if (request.operation === 'runtime.read') value = structuredClone(f.runtime);
      else if (request.operation === 'runtime.activity.snapshot')
        value = {
          memberId: 'TEST-member',
          cursor: 'TEST_cursor',
          retainedFrom: 1,
          events: [],
          hasMore: false,
          ...(f.gap ? { gap: { reason: 'retention' as const } } : {}),
          state: structuredClone(state),
          latest: {
            text: [],
            tools: f.latest.map(activityEvent),
            usage: [],
            compaction: null,
            interactions: [],
          },
        };
      else if (request.operation === 'runtime.activity.feed')
        value = {
          memberId: 'TEST-member',
          cursor: 'TEST_cursor',
          retainedFrom: 1,
          events: f.events.splice(0).map(activityEvent),
          hasMore: false,
          ...(f.gap ? { gap: { reason: 'retention' as const } } : {}),
        };
      else throw new Error(`Unexpected effect ${request.operation}`);
      f.afterRead?.(request);
      return { ok: true, value };
    }),
  };
  const legacy = {
    onTeamChange: vi.fn(() => () => undefined),
    onProvisioningProgress: vi.fn(() => () => undefined),
    onToolApprovalEvent: vi.fn(() => () => undefined),
    setToolActivityTracking: vi.fn(async () => undefined),
    setTaskLogStreamTracking: vi.fn(async () => undefined),
    setChangePresenceTracking: vi.fn(async () => undefined),
    updateToolApprovalSettings: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    getAllTasks: vi.fn(async () => []),
  } as unknown as TeamsAPI;
  const readOrder = new TeamProductReadOrder();
  const teams = createHostTeamsApi(
    legacy,
    backend,
    () => {
      const captured = f.context;
      return () => captured === f.context;
    },
    readOrder
  );
  const changes: TeamChangeEvent[] = [];
  cleanups.push(
    teams.onTeamChange((_event, change) => {
      if (change.type === 'tool-activity') changes.push(change);
    })
  );
  return {
    source: f,
    backend,
    teams,
    legacy,
    readOrder,
    changes,
    payloads: () => changes.map((event) => JSON.parse(event.detail!) as ToolActivityEventPayload),
  };
}
async function tick() {
  await vi.advanceTimersByTimeAsync(1000);
}

describe('Host live tool activity in the ordinary graph', () => {
  it('updates the real store and graph with original start/result evidence through the actual Team API', async () => {
    const f = fixture();
    ui.teams = f.teams;
    useStore.setState({
      fetchTeams: vi.fn(async () => undefined),
      fetchAllTasks: vi.fn(async () => undefined),
      refreshTeamData: vi.fn(async () => undefined),
      refreshTeamMessagesHead: vi.fn(async () => undefined),
      fetchMemberSpawnStatuses: vi.fn(async () => undefined),
      fetchTeamAgentRuntime: vi.fn(async () => undefined),
      refreshMemberActivityMeta: vi.fn(async () => undefined),
      refreshTeamChangePresence: vi.fn(async () => undefined),
      connectionMode: 'local',
      selectedTeamName: teamName,
      selectedTeamData: null,
      teamDataCacheByName: {},
      provisioningRuns: {},
      currentProvisioningRunIdByTeam: {},
      currentRuntimeRunIdByTeam: {},
      ignoredProvisioningRunIds: {},
      ignoredRuntimeRunIds: {},
      toolApprovalSettingsByTeam: {},
      activeToolsByTeam: {},
      finishedVisibleByTeam: {},
      toolHistoryByTeam: {},
      paneLayout: {
        focusedPaneId: 'TEST-pane',
        panes: [
          {
            id: 'TEST-pane',
            widthFraction: 1,
            activeTabId: 'TEST-tab',
            tabs: [{ id: 'TEST-tab', type: 'team', teamName, label: 'TEST team' }],
          },
        ],
      },
    } as never);
    cleanups.push(initializeNotificationListeners());
    await tick();
    const graphData: TeamGraphData = {
      teamName,
      config: { name: 'TEST team', members: [{ name: 'alice' }] },
      members: [
        {
          name: 'alice',
          agentType: 'team-lead',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      tasks: [],
      messageFeed: [],
      processes: [],
      isAlive: true,
      kanbanState: { teamName, reviewers: [], tasks: {} },
    };
    const graph = () => {
      const state = useStore.getState();
      return TeamGraphAdapter.create().adapt(
        graphData,
        teamName,
        undefined,
        'active',
        undefined,
        undefined,
        state.activeToolsByTeam[teamName],
        state.finishedVisibleByTeam[teamName],
        state.toolHistoryByTeam[teamName]
      );
    };
    expect(graph().nodes.find((node) => node.kind === 'lead')).toMatchObject({
      state: 'tool_calling',
      activeTool: { name: 'Bash', state: 'running', startedAt, source: 'runtime' },
    });
    expect(JSON.stringify(graph())).not.toContain('TEST-secret');
    expect(f.changes[0]).toMatchObject({
      teamName,
      runId: hostTeamRunId(handleId, 'TEST-launch', 'TEST-roster'),
    });
    expect(Object.keys(f.changes[0]).sort()).toEqual(['detail', 'runId', 'teamName', 'type']);
    f.source.events = [finish()];
    f.source.runtime.inputs[0].terminal = 'succeeded';
    await tick();
    expect(graph().nodes.find((node) => node.kind === 'lead')).toMatchObject({
      state: 'active',
      activeTool: {
        name: 'Bash',
        state: 'complete',
        startedAt,
        finishedAt,
        resultPreview: 'TEST done',
      },
    });
    expect(useStore.getState().toolHistoryByTeam[teamName]?.alice).toHaveLength(1);
    expect(f.legacy.setToolActivityTracking).not.toHaveBeenCalled();
  });

  it('shares the approval poll, isolates faulty subscribers, and stops tool reads after disabling', async () => {
    const f = fixture();
    await f.teams.setToolActivityTracking(teamName, true);
    cleanups.push(f.teams.onToolApprovalEvent(vi.fn()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.payloads().filter((p) => p.action === 'start')).toHaveLength(1);
    const faulty = f.teams.onTeamChange(() => {
      throw new Error('TEST observer');
    });
    cleanups.push(faulty);
    const initial = vi
      .mocked(f.backend.invoke)
      .mock.calls.filter(([r]) => r.operation === 'runtime.activity.snapshot');
    expect(initial).toHaveLength(1);
    f.source.events = [finish()];
    await tick();
    expect(f.payloads().filter((p) => p.action === 'finish')).toHaveLength(1);
    await f.teams.setToolActivityTracking(teamName, false);
    vi.mocked(f.backend.invoke).mockClear();
    await tick();
    expect(
      vi.mocked(f.backend.invoke).mock.calls.filter(([r]) => r.operation === 'runtime.read')
    ).toHaveLength(0);
    await f.teams.setToolActivityTracking('legacy-team', true);
    expect(f.legacy.setToolActivityTracking).toHaveBeenCalledWith('legacy-team', true);
  });

  it.each(['missing-start-time', 'missing-result-time', 'retention', 'settled-input'])(
    'does not invent activity when %s evidence is unavailable',
    async (caseName) => {
      const f = fixture();
      if (caseName === 'missing-start-time') delete f.source.latest[0].observedAt;
      if (caseName === 'settled-input') {
        f.source.runtime.inputs[0].terminal = 'cancelled';
        f.source.runtime.inputs.push({ inputId: 'TEST-later-input', phase: 'consumed' });
      }
      await f.teams.setToolActivityTracking(teamName, true);
      await vi.advanceTimersByTimeAsync(0);
      if (caseName === 'missing-start-time' || caseName === 'settled-input') {
        expect(f.payloads()).toEqual([]);
        return;
      }
      expect(f.payloads()[0].action).toBe('start');
      if (caseName === 'missing-result-time') {
        const result = finish();
        delete result.observedAt;
        f.source.events = [result];
      } else f.source.gap = true;
      await tick();
      expect(f.payloads().at(-1)?.action).toBe('reset');
      expect(f.payloads().some((p) => p.action === 'finish')).toBe(false);
    }
  );

  it.each(['context', 'owner', 'generation', 'roster', 'mutation', 'disabled'])(
    'drops an observation crossing %s change',
    async (change) => {
      const f = fixture();
      f.source.afterRead = (request) => {
        if (request.operation !== 'runtime.read') return;
        if (change === 'context') f.source.context++;
        if (change === 'owner')
          f.source.connections.bindings[0].ownerResourceRef = 'TEST-replacement-owner';
        if (change === 'generation')
          f.source.launch.members[0].generation = 'TEST-replacement-generation';
        if (change === 'roster') f.source.launch.rosterRevision = 'TEST-replacement-roster';
        if (change === 'mutation') f.readOrder.invalidateReads(handleId);
        if (change === 'disabled') void f.teams.setToolActivityTracking(teamName, false);
      };
      await f.teams.setToolActivityTracking(teamName, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.payloads()).toEqual([]);
    }
  );

  it('keeps activity on the selected physical project and uses a new identity for its replacement generation', async () => {
    const f = fixture();
    f.source.connections.bindings.unshift({
      handle: { handleId: 'TEST-logical' },
      label: 'TEST logical',
      members: [],
      ownerResourceRef: 'TEST-owner',
      teamResourceRef: 'TEST-logical-team',
      projectContextMode: 'per_project',
    });
    Object.assign(f.source.connections.bindings[1], {
      ownerResourceRef: 'TEST-owner',
      teamResourceRef: 'TEST-child-team',
      projectContext: {
        logicalHandleId: 'TEST-logical',
        projectPath: '/TEST/project',
        workContextId: 'TEST-work',
      },
    });
    await f.teams.setToolActivityTracking(teamName, true);
    await vi.advanceTimersByTimeAsync(0);
    const original = f.payloads()[0].activity!.toolUseId;
    f.source.launch.members[0].generation = 'TEST-new-generation';
    f.source.runtime.generation = 'TEST-new-generation';
    await tick();
    expect(f.changes.every((event) => event.teamName === teamName)).toBe(true);
    expect(f.payloads().some((p) => p.action === 'reset' && p.toolUseIds?.includes(original))).toBe(
      true
    );
    expect(
      f
        .payloads()
        .filter((p) => p.action === 'start')
        .at(-1)?.activity?.toolUseId
    ).not.toBe(original);
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.filter(([r]) => r.operation.startsWith('runtime.'))
        .every(([r]) => r.handle.handleId === handleId)
    ).toBe(true);
  });

  it('validates original observation times at the Main projection boundary without adding times to old events', () => {
    expect(activityEvent({ ...start(), operationRef: 'TEST-private-native' })).toEqual(start());
    const old = start();
    delete old.observedAt;
    expect(activityEvent(old)).not.toHaveProperty('observedAt');
    for (const observedAt of ['yesterday', '2026-11-26', 1, null, '2026-02-31T10:00:00.000Z'])
      expect(() => activityEvent({ ...start(), observedAt })).toThrow('observation time');
  });
});
