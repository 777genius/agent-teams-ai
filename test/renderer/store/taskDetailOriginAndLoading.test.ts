import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectTaskDetailResourceEntry } from '../../../src/renderer/store/slices/taskDetailResourcesSlice';
import { __resetTeamSliceModuleStateForTests } from '../../../src/renderer/store/slices/teamSlice';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import { createTestStore } from './storeTestUtils';

import type { AppState } from '../../../src/renderer/store/types';
import type { TeamViewSnapshot } from '../../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  teams: {
    list: vi.fn(),
    getAllTasks: vi.fn(),
    getData: vi.fn(),
    getTask: vi.fn(),
    getTaskActivity: vi.fn(),
    getMessagesPage: vi.fn(),
    getMemberActivityMeta: vi.fn(),
    getMemberSpawnStatuses: vi.fn(),
    getTeamAgentRuntime: vi.fn(),
    getTaskChangePresence: vi.fn(),
    deleteTeam: vi.fn(),
    restoreTeam: vi.fn(),
    updateToolApprovalSettings: vi.fn(async () => undefined),
    showMessageNotification: vi.fn(async () => undefined),
  },
  review: {
    invalidateTaskChangeSummaries: vi.fn(async () => undefined),
  },
  crossTeam: {
    listTargets: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({ api: apiMock }));

function snapshot(projectPath: string, taskId = 'X'): TeamViewSnapshot {
  return {
    teamName: 'shared-team',
    config: { name: 'shared-team', projectPath },
    tasks: [{ id: taskId, subject: taskId, status: 'in_progress', changePresence: 'no_changes' }],
    members: [],
    kanbanState: { teamName: 'shared-team', reviewers: [], tasks: {} },
    processes: [],
  };
}

describe('task detail origin and loading postconditions', () => {
  beforeEach(() => {
    __resetTeamSliceModuleStateForTests();
    vi.clearAllMocks();
  });

  it.each(['deleteTeam', 'restoreTeam'] as const)(
    'keeps context B task data and pending draft when context A %s finishes late',
    async (action) => {
      const store = createTestStore();
      const pending = deferred<void>();
      apiMock.teams[action].mockReturnValue(pending.promise);
      apiMock.teams.list.mockResolvedValue([]);
      apiMock.teams.getAllTasks.mockResolvedValue([]);
      store.setState({ activeContextId: 'A' });
      const request = store.getState()[action]('shared-team');
      invalidateContextScopedRequestEpoch();
      const identity = { contextId: 'B', teamName: 'shared-team', taskId: 'X' };
      const key = taskDetailKey(identity);
      const current = snapshot('/TEST-context-B/project');
      store.setState({
        activeContextId: 'B',
        selectedTeamName: 'shared-team',
        selectedTeamData: current,
        teamDataCacheByName: { 'shared-team': current },
        taskDetailById: {
          [key]: {
            ...createTaskDetailReadEntry(identity),
            phase: 'ready',
            full: { id: 'X', subject: 'TEST current task', status: 'pending' },
          },
        },
      });
      store.getState().updateTaskDetailSessionPart(identity, 'commentText', 'TEST current draft');
      store.getState().beginTaskDetailSubmitSession(identity);
      pending.resolve(undefined);
      await request;
      expect(store.getState().selectedTeamData?.config.projectPath).toBe('/TEST-context-B/project');
      expect(store.getState().taskDetailById[key].phase).toBe('ready');
      expect(store.getState().taskDetailSessionById[key]).toMatchObject({
        commentText: 'TEST current draft',
        submitPending: true,
      });
      expect(apiMock.teams.list).not.toHaveBeenCalled();
      expect(apiMock.teams.getAllTasks).not.toHaveBeenCalled();
    }
  );

  it('keeps inactive old identities side-effect free while B is active', async () => {
    const store = createTestStore();
    store.setState({ activeContextId: 'B' } as Partial<AppState>);
    await store.getState().ensureTaskDetail({
      contextId: 'A',
      teamName: 'shared-team',
      taskId: 'X',
    });
    expect(apiMock.teams.getData).not.toHaveBeenCalled();
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();
    expect(store.getState().taskDetailById).toEqual({});
  });

  it('rejects deferred A/B/A stale callbacks after an epoch reset', async () => {
    const store = createTestStore();
    const staleData = deferred<TeamViewSnapshot>();
    const currentData = deferred<TeamViewSnapshot>();
    apiMock.teams.getData
      .mockReturnValueOnce(staleData.promise)
      .mockReturnValueOnce(currentData.promise);
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'X',
      status: 'in_progress',
    });

    store.setState({ activeContextId: 'A' } as Partial<AppState>);
    const stale = store.getState().ensureTaskDetail({
      contextId: 'A',
      teamName: 'shared-team',
      taskId: 'X',
    });
    store.setState({ activeContextId: 'B' } as Partial<AppState>);
    invalidateContextScopedRequestEpoch();
    store.setState({ activeContextId: 'A' } as Partial<AppState>);
    const current = store.getState().ensureTaskDetail({
      contextId: 'A',
      teamName: 'shared-team',
      taskId: 'X',
    });
    expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
    staleData.reject(new Error('stale callback error'));
    await stale;
    expect(console.error).toHaveBeenCalledWith(
      '[Renderer:unwrapIpc]',
      '[team:getData] stale callback error'
    );
    vi.mocked(console.error).mockClear();
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();
    currentData.resolve(snapshot('/current'));
    await current;
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
    expect(store.getState().taskDetailById['["A","shared-team","X"]']?.full).toMatchObject({
      id: 'X',
      subject: 'X',
    });
  });

  it.each(['success', 'error'] as const)(
    'retires an old thin %s while the newer full snapshot is still pending',
    async (outcome) => {
      const store = createTestStore();
      const thin = deferred<TeamViewSnapshot>();
      const full = deferred<TeamViewSnapshot>();
      apiMock.teams.getData.mockReturnValueOnce(thin.promise).mockReturnValueOnce(full.promise);

      const selection = store.getState().selectTeam('shared-team');
      expect(store.getState().selectedTeamLoading).toBe(true);
      const refresh = store.getState().refreshTeamData('shared-team', { withDedup: false });
      expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
      if (outcome === 'success') thin.resolve(snapshot('/outdated'));
      else thin.reject(new Error('outdated select failed'));
      await selection;
      if (outcome === 'error') {
        expect(console.error).toHaveBeenCalledWith(
          '[Renderer:unwrapIpc]',
          '[team:getData] outdated select failed'
        );
        vi.mocked(console.error).mockClear();
      }
      const pendingState = {
        data: store.getState().selectedTeamData,
        loading: store.getState().selectedTeamLoading,
        error: store.getState().selectedTeamError,
      };
      full.resolve(snapshot('/current'));
      await refresh;

      expect(pendingState).toEqual({ data: null, loading: true, error: null });
      expect(store.getState().selectedTeamData?.config.projectPath).toBe('/current');
      expect(store.getState().selectedTeamLoading).toBe(false);
      expect(store.getState().selectedTeamError).toBeNull();
    }
  );

  it('lets a newer full refresh finish loading when a pending thin select is structurally identical', async () => {
    const store = createTestStore();
    const thin = deferred<TeamViewSnapshot>();
    const full = deferred<TeamViewSnapshot>();
    apiMock.teams.getData.mockReturnValueOnce(thin.promise).mockReturnValueOnce(full.promise);
    const before = snapshot('/same');
    store.setState({
      activeContextId: 'local',
      selectedTeamName: 'shared-team',
      selectedTeamData: before,
      selectedTeamLoading: false,
      teamDataCacheByName: { 'shared-team': before },
    } as Partial<AppState>);

    const selection = store.getState().selectTeam('shared-team');
    const refresh = store.getState().refreshTeamData('shared-team', { withDedup: false });
    full.resolve(snapshot('/same'));
    await refresh;
    expect(store.getState().selectedTeamData).toBe(before);
    expect(store.getState().selectedTeamLoading).toBe(false);
    thin.resolve(snapshot('/same'));
    await selection;
    expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
    expect(store.getState().selectedTeamData).toBe(before);
    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamError).toBeNull();
    expect(apiMock.teams.updateToolApprovalSettings).toHaveBeenCalledWith(
      'shared-team',
      expect.objectContaining({ timeoutAction: 'wait', timeoutSeconds: 30 })
    );
  });
  it('shares one physical resource read across surfaces and keeps other teams independent', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'team-a', taskId: '1' };
    const other = { ...identity, teamName: 'team-b' };
    const response = deferred<[]>();
    apiMock.teams.getTaskActivity.mockReturnValue(response.promise);
    for (const surface of ['dialog', 'tab'])
      store.getState().setTaskDetailVisibleResourceDemand(surface, identity, 'activity', true);
    store.getState().setTaskDetailVisibleResourceDemand('other', other, 'activity', true);
    const revision = store.getState().taskDetailResourcesRevision;
    store.getState().setTaskDetailVisibleResourceDemand('tab', identity, 'activity', true);
    expect(store.getState().taskDetailResourcesRevision).toBe(revision);
    const first = store.getState().ensureTaskDetailActivity(identity);
    const joined = store.getState().ensureTaskDetailActivity(identity);
    const independent = store.getState().ensureTaskDetailActivity(other);
    await Promise.resolve();
    expect(first).toBe(joined);
    expect(apiMock.teams.getTaskActivity).toHaveBeenCalledTimes(2);
    store.getState().setTaskDetailVisibleResourceDemand('dialog', identity, 'activity', false);
    response.resolve([]);
    await Promise.all([first, joined, independent]);
    expect(selectTaskDetailResourceEntry(store.getState(), identity, 'activity')?.loaded).toBe(
      true
    );
    expect(selectTaskDetailResourceEntry(store.getState(), other, 'activity')?.loaded).toBe(true);
  });

  it('retires a dirty pending read before starting its one successor', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'team-a', taskId: '1' };
    const old = deferred<[]>();
    apiMock.teams.getTaskActivity.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    store.getState().setTaskDetailVisibleResourceDemand('tab', identity, 'activity', true);
    const first = store.getState().ensureTaskDetailActivity(identity);
    await Promise.resolve();
    store.getState().invalidateTaskDetailResources(identity);
    const joined = store.getState().ensureTaskDetailActivity(identity);
    expect(joined).toBe(first);
    expect(apiMock.teams.getTaskActivity).toHaveBeenCalledTimes(1);
    old.resolve([]);
    await first;
    expect(selectTaskDetailResourceEntry(store.getState(), identity, 'activity')).toMatchObject({
      loaded: false,
      loading: false,
      refreshPending: true,
    });
    await store.getState().refreshTaskDetailVisibleResources();
    expect(apiMock.teams.getTaskActivity).toHaveBeenCalledTimes(2);
    expect(selectTaskDetailResourceEntry(store.getState(), identity, 'activity')).toMatchObject({
      loaded: true,
      refreshPending: false,
    });
  });

  it('blocks hidden and foreign reads and ignores A/B/A responses from the retired epoch', async () => {
    const store = createTestStore();
    const identity = { contextId: 'A', teamName: 'team-a', taskId: '1' };
    store.getState().setTaskDetailVisibleResourceDemand('tab', identity, 'activity', true);
    await store.getState().ensureTaskDetailActivity(identity);
    expect(apiMock.teams.getTaskActivity).not.toHaveBeenCalled();
    store.setState({ activeContextId: 'A' });
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await store.getState().ensureTaskDetailActivity(identity);
    expect(apiMock.teams.getTaskActivity).not.toHaveBeenCalled();
    hidden.mockRestore();
    const old = deferred<[]>();
    apiMock.teams.getTaskActivity.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const pending = store.getState().ensureTaskDetailActivity(identity);
    await Promise.resolve();
    store.setState({ activeContextId: 'B' });
    invalidateContextScopedRequestEpoch();
    store.setState({ activeContextId: 'A' });
    expect(selectTaskDetailResourceEntry(store.getState(), identity, 'activity')).toBeUndefined();
    await store.getState().ensureTaskDetailActivity(identity);
    const current = selectTaskDetailResourceEntry(store.getState(), identity, 'activity');
    old.resolve([]);
    await pending;
    expect(selectTaskDetailResourceEntry(store.getState(), identity, 'activity')).toBe(current);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
