import { describe, expect, it, vi } from 'vitest';

import {
  createTeamDirectoryRendererSlice,
  TeamDirectoryRefreshCoordinator,
} from '../../../../src/features/team-view-read-model/renderer';

import type {
  TeamDirectoryRendererState,
  TeamDirectoryTransportPort,
} from '../../../../src/features/team-view-read-model/renderer';
import type { GlobalTask, TeamSummary } from '../../../../src/shared/types';

interface RequestScope {
  contextId: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function teamSummary(teamName: string, input: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    projectPath: `/projects/${teamName}`,
    ...input,
  } as TeamSummary;
}

function globalTask(teamName: string, id: string): GlobalTask {
  return {
    id,
    subject: id,
    status: 'in_progress',
    owner: 'alice',
    teamName,
    teamDisplayName: teamName,
    projectPath: `/projects/${teamName}`,
    comments: [],
    attachments: [],
    historyEvents: [],
  };
}

function structurallyShare<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function createHarness(input?: {
  globalTasks?: GlobalTask[];
  globalTasksInitialized?: boolean;
  initialNotification?: boolean;
  teams?: TeamSummary[];
}) {
  let currentContextId = 'local';
  let initialNotification = input?.initialNotification ?? true;
  const coordinator = new TeamDirectoryRefreshCoordinator<RequestScope>();
  const state: TeamDirectoryRendererState = {
    appConfig: null,
    branchByPath: {},
    globalTasks: input?.globalTasks ?? [],
    globalTasksError: null,
    globalTasksInitialized: input?.globalTasksInitialized ?? false,
    globalTasksLoading: false,
    provisioningSnapshotByTeam: {},
    teamByName: {},
    teamBySessionId: {},
    teams: input?.teams ?? [],
    teamsError: null,
    teamsLoading: false,
  };
  const transport: TeamDirectoryTransportPort = {
    getAllTasks: vi.fn(),
    getProjectBranch: vi.fn(),
    listTeams: vi.fn(),
  };
  const processNotifications = vi.fn();
  const delay = vi.fn(async () => undefined);
  const slice = createTeamDirectoryRendererSlice<TeamDirectoryRendererState, RequestScope>({
    coordinator,
    notifications: {
      consumeInitialFetch: () => {
        const current = initialNotification;
        initialNotification = false;
        return current;
      },
      process: processNotifications,
    },
    paths: {
      normalize: (path) => path.trim().toLowerCase(),
    },
    requestScope: {
      capture: () => ({ contextId: currentContextId }),
      isCurrent: (scope) => scope.contextId === currentContextId,
    },
    scheduler: { delay },
    state: {
      getState: () => state,
      setState: (update) => {
        Object.assign(state, typeof update === 'function' ? update(state) : update);
      },
    },
    structuralSharing: { share: structurallyShare },
    transport,
  });

  return {
    coordinator,
    delay,
    processNotifications,
    setContext: (contextId: string) => {
      currentContextId = contextId;
    },
    slice,
    state,
    transport,
  };
}

describe('createTeamDirectoryRendererSlice', () => {
  it('loads normalized branches independently and preserves the cache on equal results', async () => {
    const harness = createHarness();
    harness.state.branchByPath = { '/existing': 'main' };
    vi.mocked(harness.transport.getProjectBranch).mockImplementation((path) =>
      path.toLowerCase().includes('broken')
        ? Promise.reject(new Error('not a repository'))
        : Promise.resolve('feature/read-model')
    );

    await harness.slice.fetchBranches([' /REPO ', '/BROKEN']);

    expect(harness.state.branchByPath).toEqual({
      '/existing': 'main',
      '/repo': 'feature/read-model',
      '/broken': null,
    });
    const firstCache = harness.state.branchByPath;

    await harness.slice.fetchBranches([' /REPO ', '/BROKEN']);

    expect(harness.state.branchByPath).toBe(firstCache);
  });

  it('atomically indexes teams, removes resolved provisioning snapshots, and shares equal refreshes', async () => {
    const harness = createHarness();
    const team = teamSummary('team-a', {
      leadSessionId: 'lead-session',
      sessionHistory: ['old-session'],
    });
    harness.state.provisioningSnapshotByTeam = {
      'team-a': teamSummary('team-a'),
      'draft-team': teamSummary('draft-team'),
    };
    vi.mocked(harness.transport.listTeams)
      .mockResolvedValueOnce([team])
      .mockResolvedValueOnce([{ ...team }]);

    const initialFetch = harness.slice.fetchTeams();
    expect(harness.state.teamsLoading).toBe(true);
    await initialFetch;

    expect(harness.state.teamByName['team-a']).toBe(harness.state.teams[0]);
    expect(harness.state.teamBySessionId['lead-session']).toBe(harness.state.teams[0]);
    expect(harness.state.teamBySessionId['old-session']).toBe(harness.state.teams[0]);
    expect(harness.state.provisioningSnapshotByTeam).toEqual({
      'draft-team': expect.objectContaining({ teamName: 'draft-team' }),
    });

    const firstTeams = harness.state.teams;
    const firstByName = harness.state.teamByName;
    const firstBySession = harness.state.teamBySessionId;
    await harness.slice.fetchTeams();

    expect(harness.state.teams).toBe(firstTeams);
    expect(harness.state.teamByName).toBe(firstByName);
    expect(harness.state.teamBySessionId).toBe(firstBySession);
  });

  it('fences stale team responses and only exposes initial-load errors', async () => {
    const harness = createHarness();
    const pendingTeams = deferred<TeamSummary[]>();
    vi.mocked(harness.transport.listTeams).mockReturnValueOnce(pendingTeams.promise);

    const staleFetch = harness.slice.fetchTeams();
    harness.setContext('remote');
    harness.state.teamsLoading = false;
    pendingTeams.resolve([teamSummary('stale-team')]);
    await staleFetch;

    expect(harness.state.teams).toEqual([]);
    expect(harness.state.teamsLoading).toBe(false);

    vi.mocked(harness.transport.listTeams).mockRejectedValueOnce('offline');
    await harness.slice.fetchTeams();
    expect(harness.state.teamsError).toBe('Failed to fetch teams');

    harness.state.teams = [teamSummary('visible-team')];
    harness.state.teamsError = 'old error';
    vi.mocked(harness.transport.listTeams).mockRejectedValueOnce(new Error('refresh failed'));
    await harness.slice.fetchTeams();
    expect(harness.state.teams).toEqual([expect.objectContaining({ teamName: 'visible-team' })]);
    expect(harness.state.teamsError).toBeNull();
  });

  it('coalesces concurrent initial global-task refreshes', async () => {
    const harness = createHarness();
    const pendingTasks = deferred<GlobalTask[]>();
    vi.mocked(harness.transport.getAllTasks).mockReturnValueOnce(pendingTasks.promise);

    const first = harness.slice.fetchAllTasks();
    const second = harness.slice.fetchAllTasks();
    pendingTasks.resolve([globalTask('team-a', 'task-1')]);
    await Promise.all([first, second]);

    expect(harness.transport.getAllTasks).toHaveBeenCalledOnce();
    expect(harness.state.globalTasks).toEqual([
      expect.objectContaining({ id: 'task-1', teamName: 'team-a' }),
    ]);
    expect(harness.processNotifications).toHaveBeenCalledOnce();
    expect(harness.processNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ isInitialFetch: true })
    );
    expect(harness.coordinator.getGlobalTasksRefresh()).toBeNull();
  });

  it('serializes a fresh follow-up after an initialized refresh already in flight', async () => {
    const oldTask = globalTask('team-a', 'old-task');
    const firstTask = globalTask('team-a', 'first-task');
    const secondTask = globalTask('team-b', 'second-task');
    const harness = createHarness({
      globalTasks: [oldTask],
      globalTasksInitialized: true,
      initialNotification: false,
    });
    const pendingTasks = deferred<GlobalTask[]>();
    vi.mocked(harness.transport.getAllTasks)
      .mockReturnValueOnce(pendingTasks.promise)
      .mockResolvedValueOnce([secondTask]);

    const first = harness.slice.fetchAllTasks();
    const second = harness.slice.fetchAllTasks();
    pendingTasks.resolve([firstTask]);
    await Promise.all([first, second]);

    expect(harness.transport.getAllTasks).toHaveBeenCalledTimes(2);
    expect(harness.delay).toHaveBeenCalledWith(1_500);
    expect(harness.processNotifications.mock.calls).toEqual([
      [
        expect.objectContaining({
          oldTasks: [oldTask],
          newTasks: [firstTask],
          isInitialFetch: false,
        }),
      ],
      [
        expect.objectContaining({
          oldTasks: [firstTask],
          newTasks: [secondTask],
          isInitialFetch: false,
        }),
      ],
    ]);
    expect(harness.state.globalTasks).toEqual([secondTask]);
  });

  it('reruns a stale in-flight global-task refresh for the current context', async () => {
    const harness = createHarness();
    const pendingLocalTasks = deferred<GlobalTask[]>();
    vi.mocked(harness.transport.getAllTasks)
      .mockReturnValueOnce(pendingLocalTasks.promise)
      .mockResolvedValueOnce([globalTask('remote-team', 'remote-task')]);

    const localFetch = harness.slice.fetchAllTasks();
    harness.setContext('remote');
    Object.assign(harness.state, {
      globalTasks: [],
      globalTasksLoading: false,
      globalTasksInitialized: false,
    });
    const remoteFetch = harness.slice.fetchAllTasks();
    pendingLocalTasks.resolve([globalTask('local-team', 'local-task')]);
    await Promise.all([localFetch, remoteFetch]);

    expect(harness.transport.getAllTasks).toHaveBeenCalledTimes(2);
    expect(harness.delay).toHaveBeenCalledWith(1_500);
    expect(harness.processNotifications).toHaveBeenCalledOnce();
    expect(harness.state.globalTasks).toEqual([
      expect.objectContaining({
        id: 'remote-task',
        teamName: 'remote-team',
      }),
    ]);
  });

  it('preserves visible tasks and suppresses refresh errors after initialization', async () => {
    const visibleTask = globalTask('team-a', 'visible-task');
    const harness = createHarness({
      globalTasks: [visibleTask],
      globalTasksInitialized: true,
      initialNotification: false,
    });
    vi.mocked(harness.transport.getAllTasks).mockRejectedValueOnce(
      new Error('refresh unavailable')
    );

    await harness.slice.fetchAllTasks();

    expect(harness.state.globalTasks).toEqual([visibleTask]);
    expect(harness.state.globalTasksInitialized).toBe(true);
    expect(harness.state.globalTasksLoading).toBe(false);
    expect(harness.state.globalTasksError).toBeNull();
    expect(harness.processNotifications).not.toHaveBeenCalled();
  });

  it('settles the first global-task load with a fallback error for non-Error failures', async () => {
    const harness = createHarness();
    vi.mocked(harness.transport.getAllTasks).mockRejectedValueOnce('offline');

    await harness.slice.fetchAllTasks();

    expect(harness.state.globalTasks).toEqual([]);
    expect(harness.state.globalTasksInitialized).toBe(true);
    expect(harness.state.globalTasksLoading).toBe(false);
    expect(harness.state.globalTasksError).toBe('Failed to fetch tasks');
    expect(harness.processNotifications).not.toHaveBeenCalled();
  });
});
