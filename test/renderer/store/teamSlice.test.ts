import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __getTeamScopedTransientStateForTests,
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
  getCurrentProvisioningProgressForTeam,
  selectMemberMessagesForTeamMember,
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
} from '../../../src/renderer/store/slices/teamSlice';

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  getData: vi.fn(),
  getMessagesPage: vi.fn(),
  getMemberActivityMeta: vi.fn(),
  createTeam: vi.fn(),
  launchTeam: vi.fn(),
  getProvisioningStatus: vi.fn(),
  getMemberSpawnStatuses: vi.fn(),
  getTeamAgentRuntime: vi.fn(),
  cancelProvisioning: vi.fn(),
  deleteTeam: vi.fn(),
  restoreTeam: vi.fn(),
  permanentlyDeleteTeam: vi.fn(),
  sendMessage: vi.fn(),
  restartMember: vi.fn(),
  requestReview: vi.fn(),
  updateKanban: vi.fn(),
  invalidateTaskChangeSummaries: vi.fn(),
  onProvisioningProgress: vi.fn(() => () => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      list: hoisted.list,
      getData: hoisted.getData,
      getMessagesPage: hoisted.getMessagesPage,
      getMemberActivityMeta: hoisted.getMemberActivityMeta,
      createTeam: hoisted.createTeam,
      launchTeam: hoisted.launchTeam,
      getProvisioningStatus: hoisted.getProvisioningStatus,
      getMemberSpawnStatuses: hoisted.getMemberSpawnStatuses,
      getTeamAgentRuntime: hoisted.getTeamAgentRuntime,
      cancelProvisioning: hoisted.cancelProvisioning,
      deleteTeam: hoisted.deleteTeam,
      restoreTeam: hoisted.restoreTeam,
      permanentlyDeleteTeam: hoisted.permanentlyDeleteTeam,
      sendMessage: hoisted.sendMessage,
      restartMember: hoisted.restartMember,
      requestReview: hoisted.requestReview,
      updateKanban: hoisted.updateKanban,
      onProvisioningProgress: hoisted.onProvisioningProgress,
    },
    review: {
      invalidateTaskChangeSummaries: hoisted.invalidateTaskChangeSummaries,
    },
  },
}));

vi.mock('../../../src/renderer/utils/unwrapIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/utils/unwrapIpc')>();
  return {
    ...actual,
    unwrapIpc: async <T>(_operation: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new actual.IpcError('mock-op', message, error);
      }
    },
  };
});

function createSliceStore() {
  return create<any>()((set, get, store) => ({
    ...createTeamSlice(set as never, get as never, store as never),
    paneLayout: {
      focusedPaneId: 'pane-default',
      panes: [
        {
          id: 'pane-default',
          widthFraction: 1,
          tabs: [],
          activeTabId: null,
        },
      ],
    },
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabLabel: vi.fn(),
    getAllPaneTabs: vi.fn(() => []),
    warmTaskChangeSummaries: vi.fn(async () => undefined),
    invalidateTaskChangePresence: vi.fn(),
    fetchTeams: vi.fn(async () => undefined),
    fetchAllTasks: vi.fn(async () => undefined),
  }));
}

function createTeamSnapshot(
  overrides: Record<string, unknown> = {}
): {
  teamName: string;
  config: { name: string; members?: unknown[]; projectPath?: string };
  tasks: unknown[];
  members: unknown[];
  kanbanState: { teamName: string; reviewers: unknown[]; tasks: Record<string, unknown> };
  processes: unknown[];
  isAlive?: boolean;
} {
  return {
    teamName: 'my-team',
    config: { name: 'My Team' },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

function createMemberSpawnStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    error: undefined,
    updatedAt: '2026-03-12T10:00:00.000Z',
    runtimeAlive: true,
    livenessSource: 'heartbeat',
    bootstrapConfirmed: true,
    hardFailure: false,
    firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
    lastHeartbeatAt: '2026-03-12T10:00:00.000Z',
    ...overrides,
  };
}

function createMemberSpawnSnapshot(overrides: Record<string, unknown> = {}) {
  const typedOverrides = overrides as {
    statuses?: Record<string, ReturnType<typeof createMemberSpawnStatus>>;
  };
  return {
    runId: 'runtime-run',
    teamLaunchState: 'clean_success',
    launchPhase: 'finished',
    expectedMembers: ['alice'],
    updatedAt: '2026-03-12T10:00:00.000Z',
    summary: {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    source: 'merged',
    statuses: typedOverrides.statuses ?? { alice: createMemberSpawnStatus() },
    ...overrides,
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRuntimeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    teamName: 'my-team',
    updatedAt: '2026-03-12T10:00:00.000Z',
    runId: 'runtime-run',
    members: {
      alice: {
        memberName: 'alice',
        alive: true,
        restartable: true,
        backendType: 'tmux',
        pid: 4242,
        runtimeModel: 'gpt-5.4-mini',
        rssBytes: 256 * 1024 * 1024,
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

describe('teamSlice actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTeamSliceModuleStateForTests();
    hoisted.list.mockResolvedValue([]);
    hoisted.getData.mockResolvedValue(createTeamSnapshot());
    hoisted.getMessagesPage.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });
    hoisted.getMemberActivityMeta.mockResolvedValue({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {},
      feedRevision: 'rev-1',
    });
    hoisted.sendMessage.mockResolvedValue({ deliveredToInbox: true, messageId: 'm1' });
    hoisted.requestReview.mockResolvedValue(undefined);
    hoisted.updateKanban.mockResolvedValue(undefined);
    hoisted.createTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.launchTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.invalidateTaskChangeSummaries.mockResolvedValue(undefined);
    hoisted.getProvisioningStatus.mockResolvedValue({
      runId: 'run-1',
      teamName: 'my-team',
      state: 'spawning',
      message: 'Starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    hoisted.getMemberSpawnStatuses.mockResolvedValue({ statuses: {}, runId: null });
    hoisted.getTeamAgentRuntime.mockResolvedValue(createRuntimeSnapshot({ runId: null, members: {} }));
    hoisted.cancelProvisioning.mockResolvedValue(undefined);
    hoisted.deleteTeam.mockResolvedValue(undefined);
    hoisted.restoreTeam.mockResolvedValue(undefined);
    hoisted.permanentlyDeleteTeam.mockResolvedValue(undefined);
    hoisted.restartMember.mockResolvedValue(undefined);
  });

  it('maps inbox verify failure to user-friendly text', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockRejectedValue(new Error('Failed to verify inbox write'));

    await expect(
      store.getState().sendTeamMessage('my-team', { member: 'alice', text: 'hello' })
    ).rejects.toThrow('Failed to verify inbox write');

    expect(store.getState().sendMessageError).toBe(
      'Message was written but not verified (race). Please try again.'
    );
  });

  it('keeps send dialog result non-terminal when OpenCode runtime delivery fails after inbox persistence', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockResolvedValue({
      deliveredToInbox: true,
      messageId: 'm-opencode-1',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        reason: 'opencode_runtime_not_active',
      },
    });

    const result = await store.getState().sendTeamMessage('my-team', {
      member: 'bob',
      text: 'hello',
    });

    expect(result.messageId).toBe('m-opencode-1');
    expect(store.getState().lastSendMessageResult).toBeNull();
    expect(store.getState().sendMessageError).toBeNull();
    expect(store.getState().sendMessageWarning).toContain('OpenCode runtime delivery failed');
  });

  it('maps task status verify failure in updateKanban and rethrows', async () => {
    const store = createSliceStore();
    hoisted.updateKanban.mockRejectedValue(new Error('Task status update verification failed: 12'));

    await expect(
      store.getState().updateKanban('my-team', '12', { op: 'request_changes' })
    ).rejects.toThrow('Task status update verification failed: 12');

    expect(store.getState().reviewActionError).toBe(
      'Failed to update task status (possible agent conflict).'
    );
  });

  it('maps task status verify failure in requestReview and rethrows', async () => {
    const store = createSliceStore();
    hoisted.requestReview.mockRejectedValue(
      new Error('Task status update verification failed: 22')
    );

    await expect(store.getState().requestReview('my-team', '22')).rejects.toThrow(
      'Task status update verification failed: 22'
    );
    expect(store.getState().reviewActionError).toBe(
      'Failed to update task status (possible agent conflict).'
    );
  });

  it('does not warm task-change summaries on team open', async () => {
    const store = createSliceStore();
    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [
        {
          id: 'completed-1',
          owner: 'alice',
          status: 'completed',
          createdAt: '2026-03-20T08:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    });

    await store.getState().selectTeam('my-team');

    expect(store.getState().warmTaskChangeSummaries).not.toHaveBeenCalled();
  });

  it('commits owner slot drops in the current session while persistence is disabled', () => {
    const store = createSliceStore();

    store.getState().commitTeamGraphOwnerSlotDrop(
      'my-team',
      'agent-alice',
      { ringIndex: 0, sectorIndex: 2 },
      'agent-bob',
      { ringIndex: 0, sectorIndex: 1 }
    );

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 2 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: null,
    });
  });

  it('replaces persisted slot assignments with defaults while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 3 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
  });

  it('seeds first-open cardinal slot defaults for small visible teams with no saved placements', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('uses config member order instead of transient visible member array order for defaults', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments(
      'my-team',
      [
        { name: 'jack', agentId: 'agent-jack' },
        { name: 'tom', agentId: 'agent-tom' },
        { name: 'alice', agentId: 'agent-alice' },
        { name: 'bob', agentId: 'agent-bob' },
      ],
      [
        { name: 'alice', agentId: 'agent-alice' },
        { name: 'bob', agentId: 'agent-bob' },
        { name: 'tom', agentId: 'agent-tom' },
        { name: 'jack', agentId: 'agent-jack' },
      ]
    );

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-tom': { ringIndex: 0, sectorIndex: 2 },
      'agent-jack': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('ignores the lead member when deriving small-team cardinal defaults', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'team-lead', agentId: 'lead-id' },
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
  });

  it('drops hidden persisted slot assignments and reseeds visible members while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-hidden': { ringIndex: 2, sectorIndex: 4 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'hidden', agentId: 'agent-hidden', removedAt: '2026-04-16T08:00:00.000Z' },
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
  });

  it('resets stale slot assignments when slot layout version mismatches', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'legacy-layout-version',
      slotAssignmentsByTeam: {
        'other-team': {
          'agent-old': { ringIndex: 9, sectorIndex: 9 },
        },
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
    ]);

    expect(store.getState().slotLayoutVersion).toBe('stable-slots-v1');
    expect(store.getState().slotAssignmentsByTeam).toEqual({
      'my-team': {
        'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      },
    });
  });

  it('ignores hidden-member persisted slot assignments while persistence is disabled', () => {
    const store = createSliceStore();
    store.setState({
      slotLayoutVersion: 'stable-slots-v1',
      slotAssignmentsByTeam: {
        'my-team': {
          'agent-hidden': { ringIndex: 1, sectorIndex: 5 },
          'agent-visible': { ringIndex: 0, sectorIndex: 2 },
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'visible', agentId: 'agent-visible' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-visible': { ringIndex: 0, sectorIndex: 0 },
    });
  });

  it('reseeds defaults again while the team remains in default mode and visible owners change', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'default',
      signature: 'agent-alice|agent-bob|agent-jack|agent-tom',
    });
  });

  it('does not reshuffle existing owners after the team enters manual mode', () => {
    const store = createSliceStore();

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);

    store.getState().setTeamGraphOwnerSlotAssignment('my-team', 'agent-alice', {
      ringIndex: 1,
      sectorIndex: 4,
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 1, sectorIndex: 4 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: 'agent-alice|agent-bob',
    });
  });

  it('resets graph slot assignments back to defaults when reopening the graph surface', () => {
    const store = createSliceStore();
    store.setState({
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [
            { name: 'alice', agentId: 'agent-alice' },
            { name: 'bob', agentId: 'agent-bob' },
            { name: 'tom', agentId: 'agent-tom' },
            { name: 'jack', agentId: 'agent-jack' },
          ],
          messages: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    store.getState().ensureTeamGraphSlotAssignments('my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
      { name: 'tom', agentId: 'agent-tom' },
      { name: 'jack', agentId: 'agent-jack' },
    ]);

    store.getState().commitTeamGraphOwnerSlotDrop(
      'my-team',
      'agent-alice',
      { ringIndex: 0, sectorIndex: 2 },
      'agent-jack',
      { ringIndex: 0, sectorIndex: 0 }
    );

    store.getState().resetTeamGraphSlotAssignmentsToDefaults('my-team');

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
      'agent-jack': { ringIndex: 0, sectorIndex: 2 },
      'agent-tom': { ringIndex: 0, sectorIndex: 3 },
    });
    expect(store.getState().graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'default',
      signature: 'agent-alice|agent-bob|agent-jack|agent-tom',
    });
  });

  it('syncs both team and graph tab labels when the team display name changes', async () => {
    const store = createSliceStore();
    const getAllPaneTabs = vi.fn(() => [
      { id: 'team-tab', type: 'team', teamName: 'my-team', label: 'my-team' },
      { id: 'graph-tab', type: 'graph', teamName: 'my-team', label: 'my-team Graph' },
    ]);
    const updateTabLabel = vi.fn();

    store.setState({
      getAllPaneTabs,
      updateTabLabel,
    });

    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'Northstar', members: [], projectPath: '/repo' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });

    await store.getState().selectTeam('my-team');

    expect(updateTabLabel).toHaveBeenCalledWith('team-tab', 'Northstar');
    expect(updateTabLabel).toHaveBeenCalledWith('graph-tab', 'Northstar Graph');
  });

  it('clears stale selectedTeamData immediately when selecting an uncached team', async () => {
    const store = createSliceStore();
    const nextTeamData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    store.setState({
      selectedTeamName: 'alpha-team',
      selectedTeamData: createTeamSnapshot({
        teamName: 'alpha-team',
        config: { name: 'Alpha Team' },
      }),
    });

    hoisted.getData.mockImplementationOnce(async () => nextTeamData.promise);

    const selectPromise = store.getState().selectTeam('beta-team');

    expect(store.getState().selectedTeamName).toBe('beta-team');
    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamData).toBeNull();

    nextTeamData.resolve(
      createTeamSnapshot({
        teamName: 'beta-team',
        config: { name: 'Beta Team' },
      })
    );
    await selectPromise;

    expect(store.getState().selectedTeamData?.teamName).toBe('beta-team');
  });

  it('repoints selectedTeamData to the cached snapshot immediately on team switch', async () => {
    const store = createSliceStore();
    const nextTeamData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const cachedBeta = createTeamSnapshot({
      teamName: 'beta-team',
      config: { name: 'Beta Team' },
    });

    store.setState({
      selectedTeamName: 'alpha-team',
      selectedTeamData: createTeamSnapshot({
        teamName: 'alpha-team',
        config: { name: 'Alpha Team' },
      }),
      teamDataCacheByName: {
        'beta-team': cachedBeta,
      },
    });

    hoisted.getData.mockImplementationOnce(async () => nextTeamData.promise);

    const selectPromise = store.getState().selectTeam('beta-team');

    expect(store.getState().selectedTeamName).toBe('beta-team');
    expect(store.getState().selectedTeamData).toBe(cachedBeta);

    nextTeamData.resolve(cachedBeta);
    await selectPromise;

    expect(store.getState().selectedTeamData).toBe(cachedBeta);
  });

  it('distinguishes historical feed changes from visible head changes in refreshTeamMessagesHead', async () => {
    const store = createSliceStore();
    const existingMessages = [
      {
        from: 'team-lead',
        text: 'Stable head',
        timestamp: '2026-03-20T08:00:00.000Z',
        read: true,
        source: 'lead_session',
        messageId: 'msg-1',
      },
    ];

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: existingMessages,
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-1',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockResolvedValueOnce({
      messages: existingMessages.map((message) => ({ ...message })),
      nextCursor: 'cursor-1',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    const result = await store.getState().refreshTeamMessagesHead('my-team');
    const nextEntry = store.getState().teamMessagesByName['my-team'];

    expect(result).toEqual({
      feedChanged: true,
      headChanged: false,
      feedRevision: 'rev-2',
    });
    expect(nextEntry?.canonicalMessages).toBe(existingMessages);
    expect(nextEntry?.feedRevision).toBe('rev-2');
    expect(nextEntry?.nextCursor).toBe('cursor-1');
    expect(nextEntry?.hasMore).toBe(true);
  });

  it('keeps loaded older tail when head refresh updates only the visible top slice', async () => {
    const store = createSliceStore();
    const existingMessages = [
      {
        from: 'team-lead',
        text: 'Head 2',
        timestamp: '2026-03-20T08:00:03.000Z',
        read: true,
        source: 'lead_session',
        messageId: 'msg-4',
      },
      {
        from: 'alice',
        text: 'Head 1',
        timestamp: '2026-03-20T08:00:02.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-3',
      },
      {
        from: 'bob',
        text: 'Older 1',
        timestamp: '2026-03-20T08:00:01.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-2',
      },
      {
        from: 'carol',
        text: 'Older 2',
        timestamp: '2026-03-20T08:00:00.000Z',
        read: true,
        source: 'inbox',
        messageId: 'msg-1',
      },
    ];

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: existingMessages,
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-tail',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'team-lead',
          text: 'Fresh head',
          timestamp: '2026-03-20T08:00:04.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-5',
        },
        existingMessages[0],
        existingMessages[1],
      ],
      nextCursor: 'cursor-head',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    const result = await store.getState().refreshTeamMessagesHead('my-team');
    const nextEntry = store.getState().teamMessagesByName['my-team'];

    expect(result).toEqual({
      feedChanged: true,
      headChanged: true,
      feedRevision: 'rev-2',
    });
    expect(
      nextEntry?.canonicalMessages.map((message: { messageId?: string }) => message.messageId)
    ).toEqual([
      'msg-5',
      'msg-4',
      'msg-3',
      'msg-2',
      'msg-1',
    ]);
    expect(nextEntry?.nextCursor).toBe('cursor-tail');
    expect(nextEntry?.hasMore).toBe(true);
  });

  it('single-flights concurrent head refreshes and runs one fresh follow-up pass', async () => {
    const store = createSliceStore();
    const firstRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: null,
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: false,
        },
      },
    });

    hoisted.getMessagesPage
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'team-lead',
            text: 'Newest head',
            timestamp: '2026-03-20T08:00:01.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-2',
          },
        ],
        nextCursor: 'cursor-2',
        hasMore: true,
        feedRevision: 'rev-2',
      });

    const p1 = store.getState().refreshTeamMessagesHead('my-team');
    const p2 = store.getState().refreshTeamMessagesHead('my-team');

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);

    firstRequest.resolve({
      messages: [
        {
          from: 'team-lead',
          text: 'Old head',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-1',
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: true,
      feedRevision: 'rev-1',
    });

    await p1;
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(store.getState().teamMessagesByName['my-team']).toMatchObject({
      feedRevision: 'rev-2',
      nextCursor: 'cursor-2',
      hasMore: true,
      loadingHead: false,
      headHydrated: true,
    });
    expect(store.getState().teamMessagesByName['my-team']?.canonicalMessages[0]?.messageId).toBe(
      'msg-2'
    );
  });

  it('serializes head refresh behind an in-flight older-page load', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
            {
              from: 'alice',
              text: 'Head 0',
              timestamp: '2026-03-20T08:00:01.000Z',
              read: true,
              source: 'inbox',
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage
      .mockImplementationOnce(() => olderRequest.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'team-lead',
            text: 'Fresh head',
            timestamp: '2026-03-20T08:00:03.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-4',
          },
          {
            from: 'team-lead',
            text: 'Head 1',
            timestamp: '2026-03-20T08:00:02.000Z',
            read: true,
            source: 'lead_session',
            messageId: 'msg-3',
          },
        ],
        nextCursor: 'cursor-head',
        hasMore: true,
        feedRevision: 'rev-2',
      });

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    const headPromise = store.getState().refreshTeamMessagesHead('my-team');

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(hoisted.getMessagesPage.mock.calls[0]).toEqual([
      'my-team',
      { cursor: 'cursor-older', limit: 50 },
    ]);

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    await headPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(hoisted.getMessagesPage.mock.calls[1]).toEqual(['my-team', { limit: 50 }]);
    expect(
      store
        .getState()
        .teamMessagesByName['my-team']?.canonicalMessages.map(
          (message: { messageId?: string }) => message.messageId
        )
    ).toEqual(['msg-4', 'msg-3', 'msg-2', 'msg-1']);
  });

  it('drops a queued head refresh behind an older-page load when launch invalidates the team epoch', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
            {
              from: 'alice',
              text: 'Head 0',
              timestamp: '2026-03-20T08:00:01.000Z',
              read: true,
              source: 'inbox',
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => olderRequest.promise);

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    const queuedHeadPromise = store.getState().refreshTeamMessagesHead('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    await expect(queuedHeadPromise).resolves.toEqual({
      feedChanged: false,
      headChanged: false,
      feedRevision: null,
    });

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-1');
  });

  it('does not continue an older-page fetch with a stale cursor after launch invalidates while waiting for head refresh', async () => {
    const store = createSliceStore();
    const headRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              text: 'Head 1',
              timestamp: '2026-03-20T08:00:02.000Z',
              read: true,
              source: 'lead_session',
              messageId: 'msg-3',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => headRequest.promise);

    const headPromise = store.getState().refreshTeamMessagesHead('my-team');
    const olderPromise = store.getState().loadOlderTeamMessages('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    headRequest.resolve({
      messages: [
        {
          from: 'team-lead',
          text: 'Fresh head',
          timestamp: '2026-03-20T08:00:03.000Z',
          read: true,
          source: 'lead_session',
          messageId: 'msg-4',
        },
      ],
      nextCursor: 'cursor-head',
      hasMore: true,
      feedRevision: 'rev-2',
    });

    await headPromise;
    await olderPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-1');
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);
  });

  it('schedules pending-reply refresh through store-owned timers', async () => {
    vi.useFakeTimers();
    try {
      const store = createSliceStore();
      const refreshTeamMessagesHeadSpy = vi
        .spyOn(store.getState(), 'refreshTeamMessagesHead')
        .mockResolvedValue({
          feedChanged: true,
          headChanged: true,
          feedRevision: 'rev-2',
        });
      const refreshMemberActivityMetaSpy = vi
        .spyOn(store.getState(), 'refreshMemberActivityMeta')
        .mockResolvedValue(undefined);

      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);

      await vi.advanceTimersByTimeAsync(999);
      expect(refreshTeamMessagesHeadSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemberActivityMetaSpy).toHaveBeenCalledTimes(1);

      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);
      store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pending-reply refresh ownership active while another source still waits for the same team', () => {
    const store = createSliceStore();

    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', true, 1_000);
    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-b', true, 1_000);
    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-b', false);

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(true);
    expect(getActiveTeamPendingReplyWaits()).toEqual(new Set(['my-team']));

    store.getState().syncTeamPendingReplyRefresh('my-team', 'tab-a', false);

    expect(hasActiveTeamPendingReplyWait('my-team')).toBe(false);
    expect(getActiveTeamPendingReplyWaits().size).toBe(0);
  });

  it('single-flights concurrent member activity refreshes and re-fetches after feed revision changes', async () => {
    const store = createSliceStore();
    const firstRequest = createDeferredPromise<{
      teamName: string;
      computedAt: string;
      members: Record<string, unknown>;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {},
    });

    hoisted.getMemberActivityMeta
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce({
        teamName: 'my-team',
        computedAt: '2026-03-12T10:00:01.000Z',
        members: {
          alice: {
            memberName: 'alice',
            lastAuthoredMessageAt: '2026-03-12T10:00:01.000Z',
            messageCountExact: 3,
            latestAuthoredMessageSignalsTermination: false,
          },
        },
        feedRevision: 'rev-2',
      });

    const p1 = store.getState().refreshMemberActivityMeta('my-team');

    store.setState((state: any) => ({
      teamMessagesByName: {
        ...state.teamMessagesByName,
        'my-team': {
          ...state.teamMessagesByName['my-team'],
          feedRevision: 'rev-2',
        },
      },
    }));

    const p2 = store.getState().refreshMemberActivityMeta('my-team');

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledTimes(1);

    firstRequest.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
      feedRevision: 'rev-1',
    });

    await p1;
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.getMemberActivityMeta).toHaveBeenCalledTimes(2);
    expect(store.getState().memberActivityMetaByTeam['my-team']).toMatchObject({
      feedRevision: 'rev-2',
      members: {
        alice: {
          messageCountExact: 3,
        },
      },
    });
  });

  it('reuses member activity facts and resolved member refs when only meta wrapper fields change', async () => {
    const store = createSliceStore();
    const initialMetaMembers = {
      alice: {
        memberName: 'alice',
        lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
        messageCountExact: 2,
        latestAuthoredMessageSignalsTermination: false,
      },
    };

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: createTeamSnapshot({
        members: [
          {
            name: 'alice',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
      }),
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              currentTaskId: null,
              taskCount: 0,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-2',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          members: initialMetaMembers,
          feedRevision: 'rev-1',
        },
      },
      leadActivityByTeam: {
        'my-team': 'active',
      },
      leadContextByTeam: {
        'my-team': {
          currentTokens: 12,
          contextWindow: 100,
          percent: 12,
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      memberSpawnStatusesByTeam: {
        'my-team': {
          alice: createMemberSpawnStatus(),
        },
      },
      memberSpawnSnapshotsByTeam: {
        'my-team': createMemberSpawnSnapshot(),
      },
    });

    const initialResolvedMembers = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    hoisted.getMemberActivityMeta.mockResolvedValueOnce({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:05.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 2,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
      feedRevision: 'rev-2',
    });

    await store.getState().refreshMemberActivityMeta('my-team');

    const nextMeta = store.getState().memberActivityMetaByTeam['my-team'];
    const nextResolvedMembers = selectResolvedMembersForTeamName(store.getState(), 'my-team');

    expect(nextMeta?.feedRevision).toBe('rev-2');
    expect(nextMeta?.members).toBe(initialMetaMembers);
    expect(nextResolvedMembers).toBe(initialResolvedMembers);
  });

  it('memoizes team-scoped member messages selectors over the merged message feed', () => {
    const store = createSliceStore();
    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              to: 'alice',
              text: 'Ping Alice',
              summary: 'Ping Alice',
              timestamp: '2026-03-12T10:00:00.000Z',
              read: false,
              messageId: 'msg-1',
            },
            {
              from: 'team-lead',
              to: 'bob',
              text: 'Ping Bob',
              summary: 'Ping Bob',
              timestamp: '2026-03-12T10:00:01.000Z',
              read: false,
              messageId: 'msg-2',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const first = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');
    const second = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    expect(first).toBe(second);
    expect(first.map((message) => message.messageId)).toEqual(['msg-1']);

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [
            {
              from: 'team-lead',
              to: 'alice',
              text: 'Ping Alice',
              summary: 'Ping Alice',
              timestamp: '2026-03-12T10:00:00.000Z',
              read: false,
              messageId: 'msg-1',
            },
            {
              from: 'alice',
              to: 'team-lead',
              text: 'Reply from Alice',
              summary: 'Reply from Alice',
              timestamp: '2026-03-12T10:00:02.000Z',
              read: false,
              messageId: 'msg-3',
            },
          ],
          optimisticMessages: [],
          feedRevision: 'rev-2',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 1,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const third = selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');
    expect(third).not.toBe(first);
    expect(third.map((message) => message.messageId)).toEqual(['msg-3', 'msg-1']);
  });

  it('removes non-selected team cache entries on permanent delete', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
        'other-team': {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().permanentlyDeleteTeam('my-team');

    expect(hoisted.permanentlyDeleteTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
    expect(store.getState().teamDataCacheByName['other-team']).toBeDefined();
  });

  it('clears selected team state and cache on soft delete', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(hoisted.deleteTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().selectedTeamName).toBeNull();
    expect(store.getState().selectedTeamData).toBeNull();
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
  });

  it('drops stale cache on restore so the next open refetches fresh data', async () => {
    const store = createSliceStore();
    store.setState({
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().restoreTeam('my-team');

    expect(hoisted.restoreTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
  });

  it('clears team-scoped selector and transient caches on delete and restore flows', async () => {
    const store = createSliceStore();
    const message = {
      from: 'alice',
      to: 'team-lead',
      text: 'hello',
      timestamp: '2026-03-12T10:00:00.000Z',
      messageId: 'm-1',
      source: 'inbox' as const,
    };

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: createTeamSnapshot({
        members: [
          {
            name: 'alice',
            role: 'developer',
            currentTaskId: null,
          },
        ],
      }),
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              role: 'developer',
              currentTaskId: null,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [message],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-1',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          feedRevision: 'rev-1',
          members: {
            alice: {
              memberName: 'alice',
              lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
              messageCountExact: 1,
              latestAuthoredMessageSignalsTermination: false,
            },
          },
        },
      },
    });

    selectResolvedMembersForTeamName(store.getState(), 'my-team');
    selectResolvedMemberForTeamName(store.getState(), 'my-team', 'alice');
    selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    await store.getState().refreshTeamData('my-team', { withDedup: false });
    store.getState().syncTeamPendingReplyRefresh('my-team', 'test-source', true);

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 1,
      hasMergedMessagesSelector: true,
      memberMessagesSelectorCount: 1,
      hasLastResolvedTeamDataRefresh: true,
    });

    await store.getState().deleteTeam('my-team');

    expect(__getTeamScopedTransientStateForTests('my-team')).toEqual({
      hasResolvedMembersSelector: false,
      resolvedMemberSelectorCount: 0,
      hasMergedMessagesSelector: false,
      memberMessagesSelectorCount: 0,
      hasPendingFreshTeamDataRefresh: false,
      hasQueuedHeadRefreshAfterOlder: false,
      hasPendingFreshMessagesHeadRefresh: false,
      hasPendingFreshMemberActivityMetaRefresh: false,
      hasLastResolvedTeamDataRefresh: false,
      hasCurrentLocalStateEpoch: true,
      hasMemberSpawnStatusesIpcBackoff: false,
      hasTeamRefreshBurstDiagnostics: false,
      hasMemberSpawnUiEqualLastWarn: false,
    });
    expect(store.getState().leadActivityByTeam['my-team']).toBeUndefined();
    expect(store.getState().leadContextByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();

    store.setState({
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [
            {
              name: 'alice',
              role: 'developer',
              currentTaskId: null,
            },
          ],
        }),
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [message],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-1',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          feedRevision: 'rev-1',
          members: {
            alice: {
              memberName: 'alice',
              lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
              messageCountExact: 1,
              latestAuthoredMessageSignalsTermination: false,
            },
          },
        },
      },
      leadActivityByTeam: {
        'my-team': 'active',
      },
      leadContextByTeam: {
        'my-team': {
          currentTokens: 12,
          contextWindow: 100,
          percent: 12,
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      memberSpawnStatusesByTeam: {
        'my-team': {
          alice: createMemberSpawnStatus(),
        },
      },
      memberSpawnSnapshotsByTeam: {
        'my-team': createMemberSpawnSnapshot(),
      },
    });
    selectResolvedMembersForTeamName(store.getState(), 'my-team');
    selectResolvedMemberForTeamName(store.getState(), 'my-team', 'alice');
    selectMemberMessagesForTeamMember(store.getState(), 'my-team', 'alice');

    expect(__getTeamScopedTransientStateForTests('my-team')).toMatchObject({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 1,
      hasMergedMessagesSelector: true,
      memberMessagesSelectorCount: 1,
    });

    await store.getState().restoreTeam('my-team');

    expect(__getTeamScopedTransientStateForTests('my-team')).toEqual({
      hasResolvedMembersSelector: false,
      resolvedMemberSelectorCount: 0,
      hasMergedMessagesSelector: false,
      memberMessagesSelectorCount: 0,
      hasPendingFreshTeamDataRefresh: false,
      hasQueuedHeadRefreshAfterOlder: false,
      hasPendingFreshMessagesHeadRefresh: false,
      hasPendingFreshMemberActivityMetaRefresh: false,
      hasLastResolvedTeamDataRefresh: false,
      hasCurrentLocalStateEpoch: true,
      hasMemberSpawnStatusesIpcBackoff: false,
      hasTeamRefreshBurstDiagnostics: false,
      hasMemberSpawnUiEqualLastWarn: false,
    });
    expect(store.getState().leadActivityByTeam['my-team']).toBeUndefined();
    expect(store.getState().leadContextByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();
  });

  it('ignores stale async team snapshot and message refreshes after delete invalidates the team', async () => {
    const store = createSliceStore();
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const deferredMessages = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredMeta = createDeferredPromise<{
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<
        string,
        {
          memberName: string;
          lastAuthoredMessageAt: string | null;
          messageCountExact: number;
          latestAuthoredMessageSignalsTermination: boolean;
        }
      >;
    }>();

    hoisted.getData.mockImplementation(() => deferredData.promise);
    hoisted.getMessagesPage.mockImplementation(() => deferredMessages.promise);
    hoisted.getMemberActivityMeta.mockImplementation(() => deferredMeta.promise);

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-0',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    const refreshDataPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    const refreshMessagesPromise = store.getState().refreshTeamMessagesHead('my-team');
    const refreshMetaPromise = store.getState().refreshMemberActivityMeta('my-team');

    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    deferredData.resolve(
      createTeamSnapshot({
        members: [{ name: 'alice', role: 'developer', currentTaskId: null }],
      })
    );
    deferredMessages.resolve({
      messages: [
        {
          from: 'alice',
          text: 'late-message',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'late-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-late',
    });
    deferredMeta.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'rev-late',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 1,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    });

    await Promise.all([refreshDataPromise, refreshMessagesPromise, refreshMetaPromise]);

    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
    expect(store.getState().teamMessagesByName['my-team']).toBeUndefined();
    expect(store.getState().memberActivityMetaByTeam['my-team']).toBeUndefined();
  });

  it('ignores stale async team refreshes after launch starts a new local epoch for the same team', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Before Launch' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const existingMeta: {
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<
        string,
        {
          memberName: string;
          lastAuthoredMessageAt: string | null;
          messageCountExact: number;
          latestAuthoredMessageSignalsTermination: boolean;
        }
      >;
    } = {
      teamName: 'my-team',
      computedAt: '2026-03-12T09:59:00.000Z',
      feedRevision: 'rev-0',
      members: {
        lead: {
          memberName: 'lead',
          lastAuthoredMessageAt: '2026-03-12T09:59:00.000Z',
          messageCountExact: 1,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    };
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const deferredMessages = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredMeta = createDeferredPromise<typeof existingMeta>();

    hoisted.getData.mockImplementation(() => deferredData.promise);
    hoisted.getMessagesPage.mockImplementation(() => deferredMessages.promise);
    hoisted.getMemberActivityMeta.mockImplementation(() => deferredMeta.promise);

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: existingData,
      teamDataCacheByName: {
        'my-team': existingData,
      },
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-0',
          lastFetchedAt: Date.now(),
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
      memberActivityMetaByTeam: {
        'my-team': existingMeta,
      },
    });

    const refreshDataPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    const refreshMessagesPromise = store.getState().refreshTeamMessagesHead('my-team');
    const refreshMetaPromise = store.getState().refreshMemberActivityMeta('my-team');

    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().teamMessagesByName['my-team']?.loadingHead).toBe(false);

    deferredData.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale After Launch' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    deferredMessages.resolve({
      messages: [
        {
          from: 'alice',
          text: 'stale-after-launch',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'stale-after-launch-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-stale-after-launch',
    });
    deferredMeta.resolve({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'rev-stale-after-launch',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 3,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    });

    await Promise.all([refreshDataPromise, refreshMessagesPromise, refreshMetaPromise]);

    expect(store.getState().selectedTeamData).toBe(existingData);
    expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-0');
    expect(store.getState().memberActivityMetaByTeam['my-team']).toEqual(existingMeta);
  });

  it('clears stale selectedTeamLoading when launch invalidates an in-flight selectTeam request', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Cached' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementationOnce(() => deferredData.promise);

    store.setState({
      teamDataCacheByName: {
        'my-team': existingData,
      },
    });

    const selectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();

    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamData).toEqual(existingData);

    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamError).toBeNull();
    expect(store.getState().selectedTeamData).toEqual(existingData);

    deferredData.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale Select' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    await selectPromise;

    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamData).toEqual(existingData);
  });

  it('clears stale loadingOlder when launch invalidates an in-flight older messages request', async () => {
    const store = createSliceStore();
    const olderRequest = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        read: boolean;
        source: string;
        messageId: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      feedRevision: string;
    }>();

    store.setState({
      teamMessagesByName: {
        'my-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-1',
          nextCursor: 'cursor-older',
          hasMore: true,
          lastFetchedAt: 123,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    });

    hoisted.getMessagesPage.mockImplementationOnce(() => olderRequest.promise);

    const olderPromise = store.getState().loadOlderTeamMessages('my-team');
    await Promise.resolve();
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(true);

    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);

    olderRequest.resolve({
      messages: [
        {
          from: 'bob',
          text: 'Older tail',
          timestamp: '2026-03-20T08:00:00.000Z',
          read: true,
          source: 'inbox',
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    await olderPromise;
    expect(store.getState().teamMessagesByName['my-team']?.loadingOlder).toBe(false);
  });

  it('ignores stale refreshTeamData failures after launch starts a new local epoch', async () => {
    const store = createSliceStore();
    const existingData = createTeamSnapshot({
      config: { name: 'My Team Stable' },
      members: [{ name: 'lead', role: 'lead', currentTaskId: null }],
    });
    const deferredData = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();

    hoisted.getData.mockImplementation(() => deferredData.promise);

    store.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: existingData,
      teamDataCacheByName: {
        'my-team': existingData,
      },
      selectedTeamError: null,
    });

    const refreshPromise = store.getState().refreshTeamData('my-team', { withDedup: false });
    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    deferredData.reject(new Error('TEAM_DRAFT'));
    await refreshPromise;

    expect(store.getState().selectedTeamData).toBe(existingData);
    expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
    expect(store.getState().selectedTeamError).toBeNull();
  });

  it('keeps the newer messages-head request pinned when a stale pre-launch request settles', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();
    const deferredNew = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();

    hoisted.getMessagesPage
      .mockImplementationOnce(() => deferredOld.promise)
      .mockImplementationOnce(() => deferredNew.promise);

    const firstPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();
    await store.getState().launchTeam({
      teamName: 'my-team',
      cwd: '/tmp/project',
    });

    const secondPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();

    deferredOld.reject(new Error('stale head failed'));
    await expect(firstPromise).resolves.toEqual({
      feedChanged: false,
      headChanged: false,
      feedRevision: null,
    });

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);

    deferredNew.resolve({
      messages: [
        {
          from: 'bob',
          text: 'fresh-after-launch',
          timestamp: '2026-03-12T10:00:01.000Z',
          messageId: 'fresh-after-launch-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-fresh-after-launch',
    });

    await secondPromise;

    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe(
      'rev-fresh-after-launch'
    );
  });

  it('does not reuse a pre-delete in-flight team snapshot request after the same team is reselected', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<ReturnType<typeof createTeamSnapshot>>();
    const freshSnapshot = createTeamSnapshot({
      config: { name: 'My Team Reloaded' },
      members: [{ name: 'bob', role: 'developer', currentTaskId: null }],
    });

    hoisted.getData
      .mockImplementationOnce(() => deferredOld.promise)
      .mockResolvedValueOnce(freshSnapshot);

    const firstSelectPromise = store.getState().selectTeam('my-team');
    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    const secondSelectPromise = store.getState().selectTeam('my-team');
    await secondSelectPromise;

    expect(hoisted.getData).toHaveBeenCalledTimes(2);
    expect(store.getState().selectedTeamData).toEqual(freshSnapshot);

    deferredOld.resolve(
      createTeamSnapshot({
        config: { name: 'My Team Stale' },
        members: [{ name: 'alice', role: 'reviewer', currentTaskId: null }],
      })
    );
    await firstSelectPromise;

    expect(store.getState().selectedTeamData).toEqual(freshSnapshot);
  });

  it('does not reuse a pre-delete in-flight messages head request after the same team is reselected', async () => {
    const store = createSliceStore();
    const deferredOld = createDeferredPromise<{
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId: string;
        source: 'inbox';
      }>;
      nextCursor: null;
      hasMore: false;
      feedRevision: string;
    }>();

    hoisted.getMessagesPage
      .mockImplementationOnce(() => deferredOld.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            from: 'bob',
            text: 'fresh-message',
            timestamp: '2026-03-12T10:00:01.000Z',
            messageId: 'fresh-1',
            source: 'inbox',
          },
        ],
        nextCursor: null,
        hasMore: false,
        feedRevision: 'rev-fresh',
      });

    const firstHeadPromise = store.getState().refreshTeamMessagesHead('my-team');
    await Promise.resolve();
    await store.getState().deleteTeam('my-team');

    const secondHeadPromise = store.getState().refreshTeamMessagesHead('my-team');
    await secondHeadPromise;

    expect(hoisted.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-fresh');
    expect(store.getState().teamMessagesByName['my-team']?.canonicalMessages).toEqual([
      {
        from: 'bob',
        text: 'fresh-message',
        timestamp: '2026-03-12T10:00:01.000Z',
        messageId: 'fresh-1',
        source: 'inbox',
      },
    ]);

    deferredOld.resolve({
      messages: [
        {
          from: 'alice',
          text: 'stale-message',
          timestamp: '2026-03-12T10:00:00.000Z',
          messageId: 'stale-1',
          source: 'inbox',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-stale',
    });
    await firstHeadPromise;

    expect(store.getState().teamMessagesByName['my-team']?.feedRevision).toBe('rev-fresh');
  });

  it('tombstones current progress runs when delete clears a team so late progress cannot resurrect it', async () => {
    const store = createSliceStore();
    store.setState({
      provisioningRuns: {
        'run-live': {
          runId: 'run-live',
          teamName: 'my-team',
          state: 'assembling',
          message: 'Live run',
          startedAt: '2026-03-12T10:00:00.000Z',
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
      currentProvisioningRunIdByTeam: {
        'my-team': 'run-live',
      },
      currentRuntimeRunIdByTeam: {
        'my-team': 'run-live',
      },
      provisioningStartedAtFloorByTeam: {
        'my-team': '2026-03-12T10:00:00.000Z',
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(store.getState().ignoredProvisioningRunIds['run-live']).toBe('my-team');
    expect(store.getState().ignoredRuntimeRunIds['run-live']).toBe('my-team');
    expect(store.getState().provisioningStartedAtFloorByTeam['my-team']).toBeTruthy();

    store.getState().onProvisioningProgress({
      runId: 'run-live',
      teamName: 'my-team',
      state: 'ready',
      message: 'Late zombie progress',
      startedAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T10:00:05.000Z',
    });

    expect(store.getState().provisioningRuns['run-live']).toBeUndefined();
    expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
    expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
  });

  it('stores runtime snapshots and suppresses semantic no-op refreshes', async () => {
    const store = createSliceStore();
    const snapshot = createRuntimeSnapshot();
    hoisted.getTeamAgentRuntime.mockResolvedValue(snapshot);

    await store.getState().fetchTeamAgentRuntime('my-team');
    const firstSnapshot = store.getState().teamAgentRuntimeByTeam['my-team'];

    expect(firstSnapshot).toEqual(snapshot);

    hoisted.getTeamAgentRuntime.mockResolvedValue({
      ...snapshot,
      updatedAt: '2026-03-12T10:00:05.000Z',
      members: {
        alice: {
          ...snapshot.members.alice,
          updatedAt: '2026-03-12T10:00:05.000Z',
        },
      },
    });

    await store.getState().fetchTeamAgentRuntime('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toBe(firstSnapshot);
  });

  it('restartMember refreshes spawn statuses and runtime snapshot', async () => {
    const store = createSliceStore();
    hoisted.getMemberSpawnStatuses.mockResolvedValue({
      statuses: {
        alice: createMemberSpawnStatus({ status: 'spawning', launchState: 'starting' }),
      },
      runId: 'runtime-run',
    });
    hoisted.getTeamAgentRuntime.mockResolvedValue(createRuntimeSnapshot());

    await store.getState().restartMember('my-team', 'alice');

    expect(hoisted.restartMember).toHaveBeenCalledWith('my-team', 'alice');
    expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
      alice: expect.objectContaining({ status: 'spawning', launchState: 'starting' }),
    });
    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toEqual(createRuntimeSnapshot());
  });

  it('restartMember refreshes spawn statuses and runtime snapshot even when restart fails', async () => {
    const store = createSliceStore();
    const refreshSpawnStatuses = vi.fn(async (_teamName: string) => undefined);
    const refreshRuntimeSnapshot = vi.fn(async (_teamName: string) => undefined);
    store.setState({
      fetchMemberSpawnStatuses: refreshSpawnStatuses,
      fetchTeamAgentRuntime: refreshRuntimeSnapshot,
    });
    hoisted.restartMember.mockRejectedValueOnce(new Error('restart failed'));

    await expect(store.getState().restartMember('my-team', 'alice')).rejects.toThrow('restart failed');

    expect(refreshSpawnStatuses).toHaveBeenCalledWith('my-team');
    expect(refreshRuntimeSnapshot).toHaveBeenCalledWith('my-team');
  });

  it('clears stale runtime snapshots on delete', async () => {
    const store = createSliceStore();
    store.setState({
      teamAgentRuntimeByTeam: {
        'my-team': createRuntimeSnapshot(),
      },
    });

    await store.getState().deleteTeam('my-team');

    expect(store.getState().teamAgentRuntimeByTeam['my-team']).toBeUndefined();
  });

  describe('refreshTeamData provisioning safety', () => {
    it('does not set fatal error on TEAM_PROVISIONING', async () => {
      const store = createSliceStore();
      // First, select a team so selectedTeamName is set
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        },
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_PROVISIONING'));

      await store.getState().refreshTeamData('my-team');

      // Should NOT set error — team is still provisioning
      expect(store.getState().selectedTeamError).toBeNull();
      // Should preserve existing data
      expect(store.getState().selectedTeamData).not.toBeNull();
      expect(store.getState().selectedTeamData?.teamName).toBe('my-team');
    });

    it('preserves existing data on transient refresh error', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      const existingData = {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      };
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('Network timeout'));

      await store.getState().refreshTeamData('my-team');

      // Should NOT replace data with error — preserve existing data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).toEqual(existingData);
    });

  it('reuses the existing selectedTeamData ref on a semantic no-op refresh', async () => {
      const store = createSliceStore();
      const existingData = createTeamSnapshot({
        tasks: [
          {
            id: 'task-1',
            subject: 'Stable task',
            status: 'pending',
            createdAt: '2026-03-20T08:00:00.000Z',
            updatedAt: '2026-03-20T08:00:00.000Z',
          },
        ],
        members: [
          {
            name: 'alice',
            currentTaskId: 'task-1',
            taskCount: 1,
          },
        ],
      });

      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        teamDataCacheByName: {
          'my-team': existingData,
        },
        selectedTeamError: 'stale error',
      });

      hoisted.getData.mockResolvedValue({
        ...existingData,
        tasks: existingData.tasks.map((task: any) => ({ ...task })),
        members: existingData.members.map((member: any) => ({ ...member })),
        kanbanState: {
          ...existingData.kanbanState,
          reviewers: [...existingData.kanbanState.reviewers],
          tasks: { ...existingData.kanbanState.tasks },
        },
        processes: [...existingData.processes],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().selectedTeamData).toBe(existingData);
      expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
      expect(store.getState().selectedTeamError).toBeNull();
  });

  it('memoizes focused resolved member selection against unrelated member activity churn', () => {
    const aliceSnapshot = {
      name: 'alice',
      currentTaskId: null,
      taskCount: 0,
      role: 'Reviewer',
    };
    const bobSnapshot = {
      name: 'bob',
      currentTaskId: null,
      taskCount: 0,
      role: 'Builder',
    };
    const baseState = {
      selectedTeamName: 'my-team',
      selectedTeamData: null,
      teamDataCacheByName: {
        'my-team': createTeamSnapshot({
          members: [aliceSnapshot, bobSnapshot],
        }),
      },
      memberActivityMetaByTeam: {
        'my-team': {
          teamName: 'my-team',
          computedAt: '2026-03-12T10:00:00.000Z',
          feedRevision: 'rev-1',
          members: {
            alice: {
              memberName: 'alice',
              lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
              messageCountExact: 3,
              latestAuthoredMessageSignalsTermination: false,
            },
            bob: {
              memberName: 'bob',
              lastAuthoredMessageAt: '2026-03-12T10:01:00.000Z',
              messageCountExact: 1,
              latestAuthoredMessageSignalsTermination: false,
            },
          },
        },
      },
    };

    const firstAlice = selectResolvedMemberForTeamName(baseState as never, 'my-team', 'alice');
    const nextState = {
      ...baseState,
      memberActivityMetaByTeam: {
        'my-team': {
          ...baseState.memberActivityMetaByTeam['my-team'],
          computedAt: '2026-03-12T10:02:00.000Z',
          feedRevision: 'rev-2',
          members: {
            ...baseState.memberActivityMetaByTeam['my-team'].members,
            bob: {
              ...baseState.memberActivityMetaByTeam['my-team'].members.bob,
              messageCountExact: 2,
            },
          },
        },
      },
    };

    const secondAlice = selectResolvedMemberForTeamName(nextState as never, 'my-team', 'alice');

    expect(firstAlice).not.toBeNull();
    expect(secondAlice).toBe(firstAlice);
  });

  it('re-canonicalizes selectedTeamData into the cache on a no-op refresh', async () => {
      const store = createSliceStore();
      const existingData = createTeamSnapshot({
        tasks: [
          {
            id: 'task-1',
            subject: 'Stable task',
            status: 'pending',
            createdAt: '2026-03-20T08:00:00.000Z',
            updatedAt: '2026-03-20T08:00:00.000Z',
          },
        ],
      });

      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        teamDataCacheByName: {},
      });

      hoisted.getData.mockResolvedValue({
        ...existingData,
        tasks: existingData.tasks.map((task: any) => ({ ...task })),
        members: existingData.members.map((member: any) => ({ ...member })),
        kanbanState: {
          ...existingData.kanbanState,
          reviewers: [...existingData.kanbanState.reviewers],
          tasks: { ...existingData.kanbanState.tasks },
        },
        processes: [...existingData.processes],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBe(existingData);
      expect(store.getState().selectedTeamData).toBe(existingData);
    });

    it('clears non-selected cache on TEAM_DRAFT refresh failure', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
            processes: [],
          },
        },
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_DRAFT'));

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
      expect(store.getState().selectedTeamData?.teamName).toBe('other-team');
    });

    it('clears non-selected cache when the team no longer exists', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
            processes: [],
          },
        },
      });

      hoisted.getData.mockRejectedValue(new Error('Team not found: my-team'));

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
      expect(store.getState().selectedTeamData?.teamName).toBe('other-team');
    });

    it('clears stale selectedTeamError when TEAM_PROVISIONING with existing data', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        },
        selectedTeamError: 'Previous failure',
      });

      hoisted.getData.mockRejectedValue(new Error('TEAM_PROVISIONING'));

      await store.getState().refreshTeamData('my-team');

      // Stale error should be cleared even though provisioning prevents new data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).not.toBeNull();
    });

    it('clears stale selectedTeamError on transient error when data exists', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      const existingData = {
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      };
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: existingData,
        selectedTeamError: 'Old stale error',
      });

      hoisted.getData.mockRejectedValue(new Error('Network timeout'));

      await store.getState().refreshTeamData('my-team');

      // Stale error should be cleared because we still have usable data
      expect(store.getState().selectedTeamError).toBeNull();
      expect(store.getState().selectedTeamData).toEqual(existingData);
    });

    it('sets error when no previous data exists', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: null,
        selectedTeamError: null,
      });

      hoisted.getData.mockRejectedValue(new Error('Team not found'));

      await store.getState().refreshTeamData('my-team');

      // No previous data — error should be shown
      expect(store.getState().selectedTeamError).toBe('Team not found');
    });

    it('invalidates changed task summaries without warming task availability on refresh', async () => {
      const store = createSliceStore();
      const invalidateTaskChangePresence = vi.fn();
      const warmTaskChangeSummaries = vi.fn(async () => undefined);
      store.setState({
        selectedTeamName: 'my-team',
        invalidateTaskChangePresence,
        warmTaskChangeSummaries,
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [
            {
              id: 'task-1',
              subject: 'Old completed',
              status: 'completed',
              owner: 'alice',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [],
              comments: [],
              attachments: [],
            },
            {
              id: 'task-2',
              subject: 'Still approved',
              status: 'completed',
              owner: 'bob',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [
                {
                  id: 'evt-approved',
                  type: 'review_approved',
                  to: 'approved',
                  timestamp: '2026-03-01T10:10:00.000Z',
                },
              ],
              comments: [],
              attachments: [],
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      });

      hoisted.getData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [
          {
            id: 'task-1',
            subject: 'Moved to review',
            status: 'completed',
            owner: 'alice',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T11:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [
              {
                id: 'evt-review',
                type: 'review_requested',
                to: 'review',
                timestamp: '2026-03-01T11:00:00.000Z',
              },
            ],
            comments: [],
            attachments: [],
          },
          {
            id: 'task-2',
            subject: 'Still approved',
            status: 'completed',
            owner: 'bob',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [
              {
                id: 'evt-approved',
                type: 'review_approved',
                to: 'approved',
                timestamp: '2026-03-01T10:10:00.000Z',
              },
            ],
            comments: [],
            attachments: [],
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      await store.getState().refreshTeamData('my-team');

      expect(hoisted.invalidateTaskChangeSummaries).toHaveBeenCalledWith('my-team', ['task-1']);
      expect(invalidateTaskChangePresence).toHaveBeenCalledTimes(1);
      expect(warmTaskChangeSummaries).not.toHaveBeenCalled();
    });

    it('preserves known task changePresence across refresh when task change signature is unchanged', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'my-team',
        selectedTeamData: {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [
            {
              id: 'task-1',
              subject: 'Known changes',
              status: 'in_progress',
              owner: 'alice',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
              historyEvents: [],
              comments: [],
              attachments: [],
              changePresence: 'has_changes',
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      });

      hoisted.getData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [
          {
            id: 'task-1',
            subject: 'Known changes',
            status: 'in_progress',
            owner: 'alice',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
            historyEvents: [],
            comments: [],
            attachments: [],
            changePresence: 'unknown',
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().selectedTeamData?.tasks[0]?.changePresence).toBe('has_changes');
    });
  });

  describe('provisioning run scoping', () => {
    it('persists providerBackendId into createTeam launch params', async () => {
      const store = createSliceStore();

      await store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
      });

      expect(store.getState().launchParamsByTeam['my-team']).toEqual({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        limitContext: false,
      });
    });

    it('persists providerBackendId into launchTeam launch params', async () => {
      const store = createSliceStore();

      await store.getState().launchTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
      });

      expect(store.getState().launchParamsByTeam['my-team']).toEqual({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        limitContext: false,
      });
    });

    it('rolls back optimistic pending run on early createTeam failure', async () => {
      const store = createSliceStore();
      hoisted.createTeam.mockRejectedValue(new Error('create failed'));

      await expect(
        store.getState().createTeam({
          teamName: 'my-team',
          cwd: '/tmp/project',
          members: [],
        })
      ).rejects.toThrow('create failed');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
      expect(Object.values(store.getState().provisioningRuns)).toHaveLength(0);
      expect(store.getState().provisioningErrorByTeam['my-team']).toBe('create failed');
    });

    it('hydrates visible non-selected graph tabs when config becomes ready', () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        paneLayout: {
          focusedPaneId: 'pane-default',
          panes: [
            {
              id: 'pane-default',
              widthFraction: 1,
              tabs: [{ id: 'graph-1', type: 'graph', teamName: 'my-team', label: 'My Team' }],
              activeTabId: 'graph-1',
            },
          ],
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
      });

      const refreshTeamDataSpy = vi.spyOn(store.getState(), 'refreshTeamData');
      const selectTeamSpy = vi.spyOn(store.getState(), 'selectTeam');

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        configReady: true,
        message: 'Config written',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
      expect(selectTeamSpy).not.toHaveBeenCalled();
    });

    it('refreshes visible non-selected graph tabs when the canonical run reaches ready', () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        paneLayout: {
          focusedPaneId: 'pane-default',
          panes: [
            {
              id: 'pane-default',
              widthFraction: 1,
              tabs: [{ id: 'graph-1', type: 'graph', teamName: 'my-team', label: 'My Team' }],
              activeTabId: 'graph-1',
            },
          ],
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
      });

      const refreshTeamDataSpy = vi.spyOn(store.getState(), 'refreshTeamData');
      const selectTeamSpy = vi.spyOn(store.getState(), 'selectTeam');

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'ready',
        message: 'Ready',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:02.000Z',
      });

      expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
      expect(selectTeamSpy).not.toHaveBeenCalled();
    });

    it('keeps the current run pinned when stale progress from another run arrives', () => {
      const store = createSliceStore();
      const startedAt = '2026-03-12T10:00:00.000Z';

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'spawning',
        message: 'Current run',
        startedAt,
        updatedAt: startedAt,
      });

      store.getState().onProvisioningProgress({
        runId: 'run-stale',
        teamName: 'my-team',
        state: 'failed',
        message: 'Stale failure',
        error: 'stale',
        startedAt: '2026-03-12T10:00:01.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().provisioningErrorByTeam['my-team']).toBeUndefined();
      expect(store.getState().provisioningRuns['run-stale']).toBeUndefined();
    });

    it('promotes a pending run to a real run without throwing', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
      });

      expect(() =>
        store.getState().onProvisioningProgress({
          runId: 'run-real',
          teamName: 'my-team',
          state: 'assembling',
          message: 'Real run',
          startedAt: '2026-03-12T10:00:01.000Z',
          updatedAt: '2026-03-12T10:00:01.000Z',
        })
      ).not.toThrow();

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-real');
      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().provisioningRuns['run-real']).toEqual(
        expect.objectContaining({
          runId: 'run-real',
          state: 'assembling',
        })
      );
    });

    it('clears orphaned runs when polling reports Unknown runId', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
        currentRuntimeRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
        memberSpawnStatusesByTeam: {
          'my-team': {
            alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
          },
        },
      });

      store.getState().clearMissingProvisioningRun('pending:my-team:1');

      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(store.getState().ignoredProvisioningRunIds['pending:my-team:1']).toBe('my-team');
      expect(store.getState().ignoredRuntimeRunIds['pending:my-team:1']).toBe('my-team');
    });

    it('does not resurrect a cleared missing run when late progress arrives', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'pending:my-team:1': {
            runId: 'pending:my-team:1',
            teamName: 'my-team',
            state: 'spawning',
            message: 'Launching',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'pending:my-team:1',
        },
      });

      store.getState().clearMissingProvisioningRun('pending:my-team:1');
      store.getState().onProvisioningProgress({
        runId: 'pending:my-team:1',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Late zombie progress',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:02.000Z',
      });

      expect(store.getState().provisioningRuns['pending:my-team:1']).toBeUndefined();
      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBeUndefined();
    });

    it('keeps runtime run id separate from provisioning run id when fetching spawn statuses', async () => {
      const store = createSliceStore();
      store.setState({
        currentProvisioningRunIdByTeam: {
          'my-team': 'provisioning-run',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'runtime-run',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('provisioning-run');
      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('runtime-run');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
        alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
      });
    });

    it('suppresses renderer rewrites when only lastHeartbeatAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              lastHeartbeatAt: '2026-03-12T10:00:09.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('suppresses renderer rewrites when only firstSpawnAcceptedAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              firstSpawnAcceptedAt: '2026-03-12T09:59:35.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('suppresses renderer rewrites when only updatedAt changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          updatedAt: '2026-03-12T10:00:11.000Z',
          statuses: {
            alice: createMemberSpawnStatus({
              updatedAt: '2026-03-12T10:00:11.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('rewrites renderer state when runtimeAlive changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        statuses: {
          alice: createMemberSpawnStatus({
            launchState: 'runtime_pending_bootstrap',
            livenessSource: 'process',
            bootstrapConfirmed: false,
          }),
        },
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot();
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when error semantics change', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
          }),
        },
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            error: 'bootstrap failed',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when only hard failure reason changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'initial failure',
          }),
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_failure',
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'resolved runtime reported missing auth',
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual(nextSnapshot.statuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('rewrites renderer state when top-level launch summary changes', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            launchState: 'runtime_pending_bootstrap',
            livenessSource: 'process',
            bootstrapConfirmed: false,
          }),
        },
      });
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'clean_success',
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toEqual(nextSnapshot);
    });

    it('preserves spawn snapshot references while still updating bookkeeping on suppressed snapshots', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot();
      const previousStatuses = previousSnapshot.statuses;

      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
        memberSpawnStatusesByTeam: {
          'my-team': previousStatuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          statuses: {
            alice: createMemberSpawnStatus({
              lastHeartbeatAt: '2026-03-12T10:00:09.000Z',
            }),
          },
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('runtime-run');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
    });

    it('does not suppress spawn snapshots when pending permission request ids change', async () => {
      const store = createSliceStore();
      const previousSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        launchPhase: 'active',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
            lastHeartbeatAt: undefined,
          }),
        },
      });

      store.setState({
        memberSpawnStatusesByTeam: {
          'my-team': previousSnapshot.statuses,
        },
        memberSpawnSnapshotsByTeam: {
          'my-team': previousSnapshot,
        },
      });

      const nextSnapshot = createMemberSpawnSnapshot({
        teamLaunchState: 'partial_pending',
        launchPhase: 'active',
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          alice: createMemberSpawnStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            livenessSource: undefined,
            bootstrapConfirmed: false,
            firstSpawnAcceptedAt: '2026-03-12T09:59:30.000Z',
            lastHeartbeatAt: undefined,
            pendingPermissionRequestIds: ['perm-1'],
          }),
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue(nextSnapshot);

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).not.toBe(previousSnapshot);
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).not.toBe(
        previousSnapshot.statuses
      );
      expect(
        store.getState().memberSpawnStatusesByTeam['my-team']?.alice?.pendingPermissionRequestIds
      ).toEqual(['perm-1']);
    });

    it('ignores stale spawn-status fetches after runtime already went offline', async () => {
      const store = createSliceStore();
      store.setState({
        currentProvisioningRunIdByTeam: {
          'my-team': 'provisioning-run',
        },
        leadActivityByTeam: {
          'my-team': 'offline',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'old-runtime-run',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    });

    it('tombstones the previous runtime run and clears tool layers before creating a new run', async () => {
      const store = createSliceStore();
      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-old',
        },
        activeToolsByTeam: {
          'my-team': {
            'team-lead': {
              'tool-a': {
                memberName: 'team-lead',
                toolUseId: 'tool-a',
                toolName: 'Read',
                startedAt: '2026-03-12T10:00:00.000Z',
                state: 'running',
                source: 'runtime',
              },
            },
          },
        },
        finishedVisibleByTeam: {
          'my-team': {
            'team-lead': {
              'tool-b': {
                memberName: 'team-lead',
                toolUseId: 'tool-b',
                toolName: 'Bash',
                startedAt: '2026-03-12T10:00:01.000Z',
                finishedAt: '2026-03-12T10:00:02.000Z',
                state: 'complete',
                source: 'runtime',
              },
            },
          },
        },
        toolHistoryByTeam: {
          'my-team': {
            'team-lead': [
              {
                memberName: 'team-lead',
                toolUseId: 'tool-b',
                toolName: 'Bash',
                startedAt: '2026-03-12T10:00:01.000Z',
                finishedAt: '2026-03-12T10:00:02.000Z',
                state: 'complete',
                source: 'runtime',
              },
            ],
          },
        },
      });

      await store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
      });

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-1');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().activeToolsByTeam['my-team']).toBeUndefined();
      expect(store.getState().finishedVisibleByTeam['my-team']).toBeUndefined();
      expect(store.getState().toolHistoryByTeam['my-team']).toBeUndefined();
    });

    it('keeps tombstoned runtime ids ignored during createTeam startup before the new run is pinned', async () => {
      const store = createSliceStore();
      const createDeferred = createDeferredPromise<{ runId: string }>();
      hoisted.createTeam.mockImplementation(() => createDeferred.promise);
      store.setState({
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-live',
        },
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });

      const createPromise = store.getState().createTeam({
        teamName: 'my-team',
        cwd: '/tmp/project',
        members: [],
      });

      await Promise.resolve();

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
      expect(store.getState().ignoredRuntimeRunIds['runtime-live']).toBe('my-team');

      hoisted.getMemberSpawnStatuses.mockResolvedValue(
        createMemberSpawnSnapshot({
          runId: 'runtime-old',
        })
      );

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBeUndefined();

      createDeferred.resolve({ runId: 'run-1' });
      await createPromise;
    });

    it('keeps older tombstoned runtime ids after canonical provisioning progress arrives', () => {
      const store = createSliceStore();
      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Current run',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBe('my-team');
    });

    it('ignores tombstoned runtime spawn-status snapshots', async () => {
      const store = createSliceStore();
      store.setState({
        ignoredRuntimeRunIds: {
          'runtime-old': 'my-team',
        },
      });
      hoisted.getMemberSpawnStatuses.mockResolvedValue({
        runId: 'runtime-old',
        statuses: {
          alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
        },
      });

      await store.getState().fetchMemberSpawnStatuses('my-team');

      expect(store.getState().currentRuntimeRunIdByTeam['my-team']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
    });

    it('preserves current spawn statuses when clearing a non-canonical missing run', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'run-current': {
            runId: 'run-current',
            teamName: 'my-team',
            state: 'assembling',
            message: 'Current run',
            startedAt: '2026-03-12T10:00:00.000Z',
            updatedAt: '2026-03-12T10:00:00.000Z',
          },
          'run-stale': {
            runId: 'run-stale',
            teamName: 'my-team',
            state: 'failed',
            message: 'Stale run',
            startedAt: '2026-03-12T10:00:01.000Z',
            updatedAt: '2026-03-12T10:00:01.000Z',
          },
        },
        currentProvisioningRunIdByTeam: {
          'my-team': 'run-current',
        },
        memberSpawnStatusesByTeam: {
          'my-team': {
            alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
          },
        },
      });

      store.getState().clearMissingProvisioningRun('run-stale');

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toEqual({
        alice: { status: 'spawning', updatedAt: '2026-03-12T10:00:00.000Z' },
      });
    });

    it('keeps the terminal canonical run pinned and does not fall back to other team runs', () => {
      const store = createSliceStore();
      const startedAt = '2026-03-12T10:00:00.000Z';

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'assembling',
        message: 'Current run',
        startedAt,
        updatedAt: startedAt,
      });

      store.getState().onProvisioningProgress({
        runId: 'run-current',
        teamName: 'my-team',
        state: 'disconnected',
        message: 'Disconnected',
        startedAt,
        updatedAt: '2026-03-12T10:00:01.000Z',
      });

      store.setState((state: ReturnType<typeof store.getState>) => ({
        provisioningRuns: {
          ...state.provisioningRuns,
          'run-stale': {
            runId: 'run-stale',
            teamName: 'my-team',
            state: 'failed',
            message: 'Stale run',
            startedAt: '2026-03-12T10:00:02.000Z',
            updatedAt: '2026-03-12T10:00:02.000Z',
          },
        },
      }));

      expect(store.getState().currentProvisioningRunIdByTeam['my-team']).toBe('run-current');
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBeUndefined();
      expect(getCurrentProvisioningProgressForTeam(store.getState(), 'my-team')).toEqual(
        expect.objectContaining({
          runId: 'run-current',
          state: 'disconnected',
        })
      );
    });

    it('does not fall back to a team-wide latest run when no current run is pinned', () => {
      expect(
        getCurrentProvisioningProgressForTeam(
          {
            currentProvisioningRunIdByTeam: {},
            provisioningRuns: {
              'run-stale': {
                runId: 'run-stale',
                teamName: 'my-team',
                state: 'failed',
                message: 'Stale run',
                startedAt: '2026-03-12T10:00:00.000Z',
                updatedAt: '2026-03-12T10:00:00.000Z',
              },
            },
          },
          'my-team'
        )
      ).toBeNull();
    });
  });
});
