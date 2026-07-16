import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __getTeamScopedTransientStateForTests,
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
} from '../../../src/renderer/store/slices/teamSlice';
import { invalidateTeamLocalStateEpoch } from '../../../src/renderer/store/team/teamLocalStateEpoch';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type { AppState } from '../../../src/renderer/store/types';

const apiMock = vi.hoisted(() => ({
  teams: {
    list: vi.fn(),
    getAllTasks: vi.fn(),
    getData: vi.fn(),
    getMessagesPage: vi.fn(),
    getMemberActivityMeta: vi.fn(),
    getMemberSpawnStatuses: vi.fn(),
    getTeamAgentRuntime: vi.fn(),
    getTaskChangePresence: vi.fn(),
    showMessageNotification: vi.fn(async () => undefined),
  },
  review: {
    invalidateTaskChangeSummaries: vi.fn(async () => undefined),
  },
  crossTeam: {
    listTargets: vi.fn(),
  },
}));

interface TeamSummaryLike {
  teamName: string;
  displayName: string;
  projectPath: string;
  leadSessionId?: string;
  sessionHistory?: string[];
}

interface GlobalTaskLike {
  id: string;
  subject: string;
  status: string;
  teamName: string;
  teamDisplayName: string;
  projectPath: string;
  comments: [];
}

interface TeamSnapshotLike {
  teamName: string;
  config: {
    name: string;
    projectPath: string;
  };
  tasks: Array<{
    id: string;
    changePresence?: string;
  }>;
  members: [];
  kanbanState: {
    teamName: string;
    reviewers: [];
    tasks: Record<string, never>;
  };
  processes: [];
}

interface CrossTeamTargetLike {
  teamName: string;
  displayName: string;
}

const teamSnapshot = (
  teamName: string,
  projectPath: string,
  tasks: TeamSnapshotLike['tasks'] = []
): TeamSnapshotLike => ({
  teamName,
  config: {
    name: teamName,
    projectPath,
  },
  tasks,
  members: [],
  kanbanState: {
    teamName,
    reviewers: [],
    tasks: {},
  },
  processes: [],
});

const memberSpawnSnapshot = {
  runId: 'runtime-run',
  statuses: {
    lead: {
      status: 'online',
      launchState: 'confirmed_alive',
    },
  },
};

const runtimeSnapshot = {
  teamName: 'shared-team',
  updatedAt: '2026-03-12T10:00:00.000Z',
  runId: 'runtime-run',
  members: {
    lead: {
      memberName: 'lead',
      alive: true,
      restartable: true,
      updatedAt: '2026-03-12T10:00:00.000Z',
    },
  },
};

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createSliceStore() {
  return create<AppState>()(
    (set, get, store) =>
      ({
        ...createTeamSlice(set as never, get as never, store as never),
        activeContextId: 'local',
        appConfig: null,
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
        projects: [],
        repositoryGroups: [],
        selectedProjectId: null,
        selectedWorktreeId: null,
        fetchSessionsInitial: vi.fn(async () => undefined),
      }) as unknown as AppState
  );
}

describe('team slice context races', () => {
  beforeEach(() => {
    __resetTeamSliceModuleStateForTests();
    apiMock.teams.list.mockReset();
    apiMock.teams.getAllTasks.mockReset();
    apiMock.teams.getData.mockReset();
    apiMock.teams.getMessagesPage.mockReset();
    apiMock.teams.getMemberActivityMeta.mockReset();
    apiMock.teams.getMemberSpawnStatuses.mockReset();
    apiMock.teams.getTeamAgentRuntime.mockReset();
    apiMock.teams.getTaskChangePresence.mockReset();
    apiMock.teams.showMessageNotification.mockClear();
    apiMock.review.invalidateTaskChangeSummaries.mockClear();
    apiMock.crossTeam.listTargets.mockReset();
  });

  afterEach(() => {
    __resetTeamSliceModuleStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores a team list response loaded for a previous context', async () => {
    const store = createSliceStore();
    const localList = deferred<TeamSummaryLike[]>();
    apiMock.teams.list.mockReturnValueOnce(localList.promise);

    const fetchPromise = store.getState().fetchTeams();
    expect(store.getState().teamsLoading).toBe(true);

    store.setState({
      activeContextId: 'ssh-dev',
      teams: [],
      teamByName: {},
      teamBySessionId: {},
      teamsLoading: false,
    });
    localList.resolve([
      {
        teamName: 'local-team',
        displayName: 'Local Team',
        projectPath: '/local/project',
      },
    ]);
    await fetchPromise;

    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().teamsLoading).toBe(false);
  });

  it('ignores a team list response loaded before a context epoch reset with the same context id', async () => {
    const store = createSliceStore();
    const localList = deferred<TeamSummaryLike[]>();
    apiMock.teams.list.mockReturnValueOnce(localList.promise);

    const fetchPromise = store.getState().fetchTeams();
    expect(store.getState().teamsLoading).toBe(true);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      teams: [],
      teamByName: {},
      teamBySessionId: {},
      teamsLoading: false,
    });
    localList.resolve([
      {
        teamName: 'old-local-team',
        displayName: 'Old Local Team',
        projectPath: '/old-local/project',
      },
    ]);
    await fetchPromise;

    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().teamsLoading).toBe(false);
  });

  it('preserves team list references when a refresh returns unchanged teams', async () => {
    const store = createSliceStore();
    const team = {
      teamName: 'atlas-hq-15',
      displayName: 'Atlas HQ',
      projectPath: '/repo',
      leadSessionId: 'lead-session',
      sessionHistory: ['previous-session'],
    };
    apiMock.teams.list.mockResolvedValueOnce([team]).mockResolvedValueOnce([{ ...team }]);

    await store.getState().fetchTeams();
    const firstTeams = store.getState().teams;
    const firstTeamByName = store.getState().teamByName;
    const firstTeamBySessionId = store.getState().teamBySessionId;

    await store.getState().fetchTeams();

    expect(store.getState().teams).toBe(firstTeams);
    expect(store.getState().teamByName).toBe(firstTeamByName);
    expect(store.getState().teamBySessionId).toBe(firstTeamBySessionId);
    expect(store.getState().teamBySessionId['lead-session']).toBe(firstTeams[0]);
    expect(store.getState().teamBySessionId['previous-session']).toBe(firstTeams[0]);
  });

  it('reruns a pending global task refresh for the current context instead of applying stale tasks', async () => {
    const store = createSliceStore();
    const localTasks = deferred<GlobalTaskLike[]>();
    apiMock.teams.getAllTasks.mockReturnValueOnce(localTasks.promise).mockResolvedValueOnce([
      {
        id: 'ssh-task',
        subject: 'SSH task',
        status: 'todo',
        teamName: 'ssh-team',
        teamDisplayName: 'SSH Team',
        projectPath: '/ssh/project',
        comments: [],
      },
    ]);

    const firstFetch = store.getState().fetchAllTasks();
    expect(store.getState().globalTasksLoading).toBe(true);

    store.setState({
      activeContextId: 'ssh-dev',
      globalTasks: [],
      globalTasksLoading: false,
      globalTasksInitialized: false,
    });
    const secondFetch = store.getState().fetchAllTasks();

    localTasks.resolve([
      {
        id: 'local-task',
        subject: 'Local task',
        status: 'todo',
        teamName: 'local-team',
        teamDisplayName: 'Local Team',
        projectPath: '/local/project',
        comments: [],
      },
    ]);

    await Promise.all([firstFetch, secondFetch]);

    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(2);
    expect(store.getState().globalTasks).toEqual([
      expect.objectContaining({ id: 'ssh-task', teamName: 'ssh-team' }),
    ]);
    expect(store.getState().globalTasksInitialized).toBe(true);
    expect(store.getState().globalTasksLoading).toBe(false);
  });

  it('coalesces concurrent initial global task refreshes for the same context', async () => {
    const store = createSliceStore();
    const initialTasks = deferred<GlobalTaskLike[]>();
    apiMock.teams.getAllTasks.mockReturnValueOnce(initialTasks.promise);

    const firstFetch = store.getState().fetchAllTasks();
    const secondFetch = store.getState().fetchAllTasks();

    initialTasks.resolve([
      {
        id: 'initial-task',
        subject: 'Initial task',
        status: 'todo',
        teamName: 'initial-team',
        teamDisplayName: 'Initial Team',
        projectPath: '/initial/project',
        comments: [],
      },
    ]);

    await Promise.all([firstFetch, secondFetch]);

    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(1);
    expect(store.getState().globalTasks).toEqual([
      expect.objectContaining({ id: 'initial-task', teamName: 'initial-team' }),
    ]);
    expect(store.getState().globalTasksInitialized).toBe(true);
    expect(store.getState().globalTasksLoading).toBe(false);
  });

  it('ignores global tasks loaded before a context epoch reset with the same context id', async () => {
    const store = createSliceStore();
    const localTasks = deferred<GlobalTaskLike[]>();
    apiMock.teams.getAllTasks.mockReturnValueOnce(localTasks.promise);

    const fetchPromise = store.getState().fetchAllTasks();
    expect(store.getState().globalTasksLoading).toBe(true);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      globalTasks: [],
      globalTasksLoading: false,
      globalTasksInitialized: false,
    });
    localTasks.resolve([
      {
        id: 'old-local-task',
        subject: 'Old local task',
        status: 'todo',
        teamName: 'old-local-team',
        teamDisplayName: 'Old Local Team',
        projectPath: '/old-local/project',
        comments: [],
      },
    ]);
    await fetchPromise;

    expect(store.getState().globalTasks).toEqual([]);
    expect(store.getState().globalTasksInitialized).toBe(false);
    expect(store.getState().globalTasksLoading).toBe(false);
  });

  it('ignores cross-team targets loaded for a previous context', async () => {
    const store = createSliceStore();
    const localTargets = deferred<CrossTeamTargetLike[]>();
    apiMock.crossTeam.listTargets.mockReturnValueOnce(localTargets.promise);

    const fetchPromise = store.getState().fetchCrossTeamTargets();
    expect(store.getState().crossTeamTargetsLoading).toBe(true);

    store.setState({
      activeContextId: 'ssh-dev',
      crossTeamTargets: [],
      crossTeamTargetsLoading: false,
    });
    localTargets.resolve([
      {
        teamName: 'local-target',
        displayName: 'Local Target',
      },
    ]);
    await fetchPromise;

    expect(store.getState().crossTeamTargets).toEqual([]);
    expect(store.getState().crossTeamTargetsLoading).toBe(false);
  });

  it('ignores cross-team targets loaded before a context epoch reset with the same context id', async () => {
    const store = createSliceStore();
    const localTargets = deferred<CrossTeamTargetLike[]>();
    apiMock.crossTeam.listTargets.mockReturnValueOnce(localTargets.promise);

    const fetchPromise = store.getState().fetchCrossTeamTargets();
    expect(store.getState().crossTeamTargetsLoading).toBe(true);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      crossTeamTargets: [],
      crossTeamTargetsLoading: false,
    });
    localTargets.resolve([
      {
        teamName: 'old-local-target',
        displayName: 'Old Local Target',
      },
    ]);
    await fetchPromise;

    expect(store.getState().crossTeamTargets).toEqual([]);
    expect(store.getState().crossTeamTargetsLoading).toBe(false);
  });

  it('resolves true after a successful cross-team targets fetch', async () => {
    const store = createSliceStore();
    apiMock.crossTeam.listTargets.mockResolvedValueOnce([
      { teamName: 'peer', displayName: 'Peer' },
    ]);

    const ok = await store.getState().fetchCrossTeamTargets();

    expect(ok).toBe(true);
    expect(store.getState().crossTeamTargets).toEqual([{ teamName: 'peer', displayName: 'Peer' }]);
  });

  it('resolves false when the cross-team targets fetch fails so the composer can retry', async () => {
    const store = createSliceStore();
    apiMock.crossTeam.listTargets.mockRejectedValueOnce(new Error('boom'));

    const ok = await store.getState().fetchCrossTeamTargets();

    expect(ok).toBe(false);
    expect(store.getState().crossTeamTargets).toEqual([]);
    expect(store.getState().crossTeamTargetsLoading).toBe(false);
  });

  it('ignores selected team data loaded for a previous context', async () => {
    const store = createSliceStore();
    const localData = deferred<TeamSnapshotLike>();
    apiMock.teams.getData.mockReturnValueOnce(localData.promise);

    const selectPromise = store.getState().selectTeam('shared-team');
    expect(store.getState().selectedTeamName).toBe('shared-team');

    store.setState({
      activeContextId: 'ssh-dev',
      selectedTeamName: null,
      selectedTeamData: null,
      selectedTeamLoading: false,
      teamDataCacheByName: {},
    });
    localData.resolve(teamSnapshot('shared-team', '/local/project'));
    await selectPromise;

    expect(store.getState().selectedTeamName).toBeNull();
    expect(store.getState().selectedTeamData).toBeNull();
    expect(store.getState().teamDataCacheByName).toEqual({});
  });

  it('ignores selected team data loaded before a context epoch reset with the same context id', async () => {
    const store = createSliceStore();
    const localData = deferred<TeamSnapshotLike>();
    apiMock.teams.getData.mockReturnValueOnce(localData.promise);

    const selectPromise = store.getState().selectTeam('shared-team');
    expect(store.getState().selectedTeamName).toBe('shared-team');

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      selectedTeamName: null,
      selectedTeamData: null,
      selectedTeamLoading: false,
      teamDataCacheByName: {},
    });
    localData.resolve(teamSnapshot('shared-team', '/old-local/project'));
    await selectPromise;

    expect(store.getState().selectedTeamName).toBeNull();
    expect(store.getState().selectedTeamData).toBeNull();
    expect(store.getState().teamDataCacheByName).toEqual({});
  });

  it('does not let a stale silent team refresh overwrite the current context cache', async () => {
    const store = createSliceStore();
    const sshData = teamSnapshot('shared-team', '/ssh/project');
    const localData = deferred<TeamSnapshotLike>();
    apiMock.teams.getData.mockReturnValueOnce(localData.promise);

    const refreshPromise = store.getState().refreshTeamData('shared-team');
    store.setState({
      activeContextId: 'ssh-dev',
      teamDataCacheByName: {
        'shared-team': sshData,
      },
    } as never);

    localData.resolve(teamSnapshot('shared-team', '/local/project'));
    await refreshPromise;

    expect(store.getState().teamDataCacheByName['shared-team']).toBe(sshData);
  });

  it('ignores message head pages loaded for a previous context', async () => {
    const store = createSliceStore();
    const localMessages = deferred<{
      messages: [];
      feedRevision: string;
      nextCursor: null;
      hasMore: false;
    }>();
    apiMock.teams.getMessagesPage.mockReturnValueOnce(localMessages.promise);

    const refreshPromise = store.getState().refreshTeamMessagesHead('shared-team');
    expect(store.getState().teamMessagesByName['shared-team']).toBeDefined();

    store.setState({
      activeContextId: 'ssh-dev',
      teamMessagesByName: {},
    });
    localMessages.resolve({
      messages: [],
      feedRevision: 'local-feed',
      nextCursor: null,
      hasMore: false,
    });
    await refreshPromise;

    expect(store.getState().teamMessagesByName).toEqual({});
  });

  it('ignores member spawn statuses loaded before a same-context team reset', async () => {
    const store = createSliceStore();
    const localStatuses = deferred<typeof memberSpawnSnapshot>();
    apiMock.teams.getMemberSpawnStatuses.mockReturnValueOnce(localStatuses.promise);

    const refreshPromise = store.getState().fetchMemberSpawnStatuses('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    localStatuses.resolve(memberSpawnSnapshot);
    await refreshPromise;

    expect(store.getState().memberSpawnStatusesByTeam).toEqual({});
    expect(store.getState().memberSpawnSnapshotsByTeam).toEqual({});
    expect(store.getState().currentRuntimeRunIdByTeam).toEqual({});
  });

  it('does not let stale member spawn IPC failures poison the next team scope', async () => {
    const store = createSliceStore();
    const staleFailure = deferred<never>();
    apiMock.teams.getMemberSpawnStatuses.mockReturnValueOnce(staleFailure.promise);

    const refreshPromise = store.getState().fetchMemberSpawnStatuses('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    staleFailure.reject(new Error("No handler registered for 'team:memberSpawnStatuses'"));
    await refreshPromise;

    expect(
      __getTeamScopedTransientStateForTests('shared-team').hasMemberSpawnStatusesIpcBackoff
    ).toBe(false);
  });

  it('ignores agent runtime snapshots loaded before a same-context team reset', async () => {
    const store = createSliceStore();
    const localRuntime = deferred<typeof runtimeSnapshot>();
    apiMock.teams.getTeamAgentRuntime.mockReturnValueOnce(localRuntime.promise);

    const refreshPromise = store.getState().fetchTeamAgentRuntime('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    localRuntime.resolve(runtimeSnapshot);
    await refreshPromise;

    expect(store.getState().teamAgentRuntimeByTeam).toEqual({});
  });

  it('does not reuse runtime freshness memory after a context switch clears visible runtime state', async () => {
    vi.useFakeTimers();
    const store = createSliceStore();
    const firstLiveSnapshot = {
      ...runtimeSnapshot,
      updatedAt: '2026-03-12T10:00:00.000Z',
      members: {
        lead: {
          ...runtimeSnapshot.members.lead,
          runtimeLastSeenAt: '2026-03-12T10:00:00.000Z',
          updatedAt: '2026-03-12T10:00:00.000Z',
        },
      },
    };
    vi.setSystemTime(new Date('2026-03-12T10:00:00.000Z'));
    apiMock.teams.getTeamAgentRuntime.mockResolvedValue(firstLiveSnapshot);

    await store.getState().fetchTeamAgentRuntime('shared-team');
    const firstVisibleSnapshot = store.getState().teamAgentRuntimeByTeam['shared-team'];

    // Sub-cadence timestamp-only refresh: remembered, not visible.
    const refreshedLiveSnapshot = {
      ...runtimeSnapshot,
      updatedAt: '2026-03-12T10:00:02.000Z',
      members: {
        lead: {
          ...runtimeSnapshot.members.lead,
          runtimeLastSeenAt: '2026-03-12T10:00:02.000Z',
          updatedAt: '2026-03-12T10:00:02.000Z',
        },
      },
    };
    vi.setSystemTime(new Date('2026-03-12T10:00:02.000Z'));
    apiMock.teams.getTeamAgentRuntime.mockResolvedValue(refreshedLiveSnapshot);

    await store.getState().fetchTeamAgentRuntime('shared-team');

    expect(store.getState().teamAgentRuntimeByTeam['shared-team']).toBe(firstVisibleSnapshot);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'context-dev',
      teamAgentRuntimeByTeam: {},
    });

    const offlineSnapshotAfterSwitch = {
      ...runtimeSnapshot,
      updatedAt: '2026-03-12T10:00:12.000Z',
      members: {
        lead: {
          ...runtimeSnapshot.members.lead,
          alive: false,
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          runtimeDiagnosticSeverity: 'warning',
          runtimeLastSeenAt: undefined,
          updatedAt: '2026-03-12T10:00:12.000Z',
        },
      },
    };
    vi.setSystemTime(new Date('2026-03-12T10:00:12.000Z'));
    apiMock.teams.getTeamAgentRuntime.mockResolvedValue(offlineSnapshotAfterSwitch);

    await store.getState().fetchTeamAgentRuntime('shared-team');

    expect(store.getState().teamAgentRuntimeByTeam['shared-team']).toEqual(
      offlineSnapshotAfterSwitch
    );
    expect(store.getState().teamAgentRuntimeByTeam['shared-team'].members.lead.alive).toBe(false);
  });

  it('ignores change presence loaded before a same-context team reset', async () => {
    const store = createSliceStore();
    const staleData = teamSnapshot('shared-team', '/local/project', [
      { id: 'task-1', changePresence: 'unknown' },
    ]);
    const localPresence = deferred<{ 'task-1': 'has_changes' }>();
    apiMock.teams.getTaskChangePresence.mockReturnValueOnce(localPresence.promise);
    store.setState({
      selectedTeamName: 'shared-team',
      selectedTeamData: staleData,
      teamDataCacheByName: {
        'shared-team': staleData,
      },
    } as never);

    const refreshPromise = store.getState().refreshTeamChangePresence('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    localPresence.resolve({ 'task-1': 'has_changes' });
    await refreshPromise;

    expect(store.getState().selectedTeamData).toBe(staleData);
    expect(store.getState().teamDataCacheByName['shared-team']).toBe(staleData);
  });

  it('does not rerun pending full team data refreshes from a stale scope', async () => {
    const store = createSliceStore();
    const localData = deferred<TeamSnapshotLike>();
    apiMock.teams.getData
      .mockReturnValueOnce(localData.promise)
      .mockResolvedValueOnce(teamSnapshot('shared-team', '/unexpected/project'));

    const firstRefresh = store.getState().refreshTeamData('shared-team', { withDedup: true });
    const secondRefresh = store.getState().refreshTeamData('shared-team', { withDedup: true });
    invalidateTeamLocalStateEpoch('shared-team');
    store.setState({ teamDataCacheByName: {} });
    localData.resolve(teamSnapshot('shared-team', '/local/project'));
    await Promise.all([firstRefresh, secondRefresh]);
    await flushMicrotasks();

    expect(apiMock.teams.getData).toHaveBeenCalledTimes(1);
  });

  it('does not rerun pending message head refreshes from a stale scope', async () => {
    const store = createSliceStore();
    const localMessages = deferred<{
      messages: [];
      feedRevision: string;
      nextCursor: null;
      hasMore: false;
    }>();
    apiMock.teams.getMessagesPage.mockReturnValueOnce(localMessages.promise).mockResolvedValueOnce({
      messages: [],
      feedRevision: 'unexpected-feed',
      nextCursor: null,
      hasMore: false,
    });

    const firstRefresh = store.getState().refreshTeamMessagesHead('shared-team');
    const secondRefresh = store.getState().refreshTeamMessagesHead('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    store.setState({ teamMessagesByName: {} });
    localMessages.resolve({
      messages: [],
      feedRevision: 'local-feed',
      nextCursor: null,
      hasMore: false,
    });
    await Promise.all([firstRefresh, secondRefresh]);
    await flushMicrotasks();

    expect(apiMock.teams.getMessagesPage).toHaveBeenCalledTimes(1);
  });

  it('does not rerun pending member activity meta refreshes from a stale scope', async () => {
    const store = createSliceStore();
    const localMeta = deferred<{
      teamName: string;
      computedAt: string;
      feedRevision: string;
      members: Record<string, never>;
    }>();
    apiMock.teams.getMemberActivityMeta
      .mockReturnValueOnce(localMeta.promise)
      .mockResolvedValueOnce({
        teamName: 'shared-team',
        computedAt: '2026-03-12T10:00:01.000Z',
        feedRevision: 'unexpected-feed',
        members: {},
      });
    store.setState({
      teamMessagesByName: {
        'shared-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'feed-1',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: 0,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    } as never);

    const firstRefresh = store.getState().refreshMemberActivityMeta('shared-team');
    const secondRefresh = store.getState().refreshMemberActivityMeta('shared-team');
    invalidateTeamLocalStateEpoch('shared-team');
    store.setState({ teamMessagesByName: {}, memberActivityMetaByTeam: {} });
    localMeta.resolve({
      teamName: 'shared-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      feedRevision: 'feed-1',
      members: {},
    });
    await Promise.all([firstRefresh, secondRefresh]);
    await flushMicrotasks();

    expect(apiMock.teams.getMemberActivityMeta).toHaveBeenCalledTimes(1);
  });
});
