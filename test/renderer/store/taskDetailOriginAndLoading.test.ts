import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { HostReviewOperationError } from '../../../src/features/agent-backend/renderer/HostReviewOperationError';
import { selectTaskDetailResourceEntry } from '../../../src/renderer/store/slices/taskDetailResourcesSlice';
import { __resetTeamSliceModuleStateForTests } from '../../../src/renderer/store/slices/teamSlice';
import {
  captureTaskDetailReadScope,
  isTaskDetailTeamUnavailable,
} from '../../../src/renderer/store/team/taskDetailReadAuthority';
import { selectTaskDetailReadDemands } from '../../../src/renderer/store/team/taskDetailReadInterest';
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

  it('keeps fresh Host Task authority after assignment when derived review cache invalidation is held', async () => {
    const store = createTestStore();
    const teamName = hostTeamSelectionKey('TEST-review-cache-hold');
    const identity = { contextId: 'local', teamName, taskId: 'X' };
    const key = taskDetailKey(identity);
    const original = {
      id: 'X',
      subject: 'TEST assigned Task',
      status: 'pending' as const,
      needsClarification: 'user' as const,
    };
    const assigned = { ...original, owner: 'alice' };
    const metadata = (task: typeof original): TeamViewSnapshot => {
      const base = snapshot('/TEST-review-cache-hold');
      return {
        ...base,
        teamName,
        config: { ...base.config, name: teamName },
        tasks: [task],
        kanbanState: { ...base.kanbanState, teamName },
      };
    };
    store.setState({ activeContextId: identity.contextId, selectedTeamName: teamName });
    apiMock.teams.getData
      .mockResolvedValueOnce(metadata(original))
      .mockResolvedValueOnce(metadata(assigned));
    apiMock.teams.getTask.mockResolvedValueOnce(original).mockResolvedValueOnce(assigned);
    await store.getState().ensureTaskDetail(identity);
    expect(store.getState().taskDetailById[key]).toMatchObject({ phase: 'ready', full: original });
    const reviewHold = new HostReviewOperationError('hold', 'unknown', {
      handle: { handleId: 'TEST-review-cache-hold' },
      commandId: 'TEST-derived-invalidation',
      operation: 'review.invalidateSummaries',
      payload: { taskIds: ['X'] },
    });
    apiMock.review.invalidateTaskChangeSummaries.mockRejectedValueOnce(reviewHold);

    await store.getState().ensureTaskDetail(identity);

    expect(apiMock.review.invalidateTaskChangeSummaries).toHaveBeenCalledWith(teamName, ['X']);
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(2);
    expect(store.getState().taskDetailById[key]).toMatchObject({
      phase: 'ready',
      error: null,
      full: assigned,
    });
    expect(store.getState().selectedTeamData?.tasks[0].owner).toBe('alice');
    expect(
      isTaskDetailTeamUnavailable(
        store.getState(),
        teamName,
        captureTaskDetailReadScope(teamName, identity.contextId)
      )
    ).toBe(false);
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

  it.each(['cold metadata absent', 'stale metadata after failed refresh'] as const)(
    'keeps a retained task non-editable when %s until a live snapshot and fresh full read are accepted',
    async (metadataState) => {
      const store = createTestStore();
      const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
      const key = taskDetailKey(identity);
      const stale = metadataState === 'stale metadata after failed refresh';
      store.setState({ activeContextId: 'local' });
      if (stale) {
        apiMock.teams.getData.mockResolvedValueOnce(snapshot('/TEST-previous-accepted'));
        apiMock.teams.getTask.mockResolvedValueOnce({
          id: 'X',
          subject: 'TEST prior accepted full task',
          status: 'deleted',
        });
        await store.getState().ensureTaskDetail(identity);
        expect(store.getState().taskDetailById[key].full).toMatchObject({
          id: 'X',
          subject: 'TEST prior accepted full task',
          status: 'deleted',
        });
        expect(
          store
            .getState()
            .setTaskDetailDeletionIntent(
              identity,
              'restoring',
              captureTaskDetailReadScope(identity.teamName, identity.contextId)
            )
        ).toBe(true);
      }
      const retainedFull = store.getState().taskDetailById[key]?.full ?? null;
      store.getState().updateTaskDetailSessionPart(identity, 'commentText', 'TEST retained draft');

      apiMock.teams.getData.mockRejectedValueOnce(new Error('TEAM_NOT_FOUND'));
      apiMock.teams.getTask.mockResolvedValue({
        id: 'X',
        subject: 'TEST retained full task',
        status: 'in_progress',
      });
      await store.getState().ensureTaskDetail(identity);

      const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
      vi.mocked(console.error).mockClear();
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(stale ? 1 : 0);
      expect(store.getState().taskDetailById[key]).toMatchObject({
        phase: 'unavailable',
        deletionIntent: stale ? 'restoring' : null,
      });
      expect(store.getState().taskDetailById[key].full).toBe(retainedFull);
      expect(isTaskDetailTeamUnavailable(store.getState(), identity.teamName, scope)).toBe(true);
      expect(store.getState().taskDetailSessionById[key].commentText).toBe('TEST retained draft');
      vi.mocked(console.error).mockClear();

      apiMock.teams.getData.mockResolvedValueOnce(snapshot('/accepted-live'));
      await store.getState().ensureTaskDetail(identity);

      expect(apiMock.teams.getData).toHaveBeenCalledTimes(stale ? 3 : 2);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(stale ? 2 : 1);
      expect(store.getState().taskDetailById[key]).toMatchObject({
        phase: 'ready',
        deletionIntent: null,
        full: { id: 'X', subject: 'TEST retained full task' },
      });
      expect(isTaskDetailTeamUnavailable(store.getState(), identity.teamName, scope)).toBe(false);
      expect(store.getState().taskDetailSessionById[key].commentText).toBe('TEST retained draft');
    }
  );

  it('keeps an unselected provisioning task distinct from another team error', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const key = taskDetailKey(identity);
    store.setState({
      activeContextId: 'local',
      selectedTeamName: 'other-team',
      selectedTeamError: 'TEST other team failure',
    });
    apiMock.teams.getData.mockRejectedValueOnce(new Error('TEAM_PROVISIONING'));
    await store.getState().ensureTaskDetail(identity);
    vi.mocked(console.error).mockClear();
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();
    expect(store.getState().taskDetailById[key]).toMatchObject({
      phase: 'provisioning',
      error: null,
      full: null,
    });
    expect(store.getState().selectedTeamName).toBe('other-team');
    expect(store.getState().selectedTeamError).toBe('TEST other team failure');
  });

  it('keeps a newer metadata failure closed after an older thin success', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    apiMock.teams.getData.mockResolvedValueOnce(snapshot('/TEST-first-accepted'));
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'TEST current full task',
      status: 'in_progress',
    });
    await store.getState().ensureTaskDetail(identity);
    const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
    expect(isTaskDetailTeamUnavailable(store.getState(), identity.teamName, scope)).toBe(false);
    const thin = deferred<TeamViewSnapshot>();
    const full = deferred<TeamViewSnapshot>();
    apiMock.teams.getData.mockReturnValueOnce(thin.promise).mockReturnValueOnce(full.promise);
    const selection = store.getState().selectTeam(identity.teamName);
    const refresh = store.getState().refreshTeamData(identity.teamName, { withDedup: false });
    try {
      full.reject(new Error('TEST newest metadata failed'));
      await refresh;
      vi.mocked(console.error).mockClear();
      vi.mocked(console.warn).mockClear();
      expect(isTaskDetailTeamUnavailable(store.getState(), identity.teamName, scope)).toBe(true);
      expect.soft(store.getState().selectedTeamLoading).toBe(false);
      thin.resolve(snapshot('/TEST-older-success'));
      await selection;
      expect(store.getState().selectedTeamData?.config.projectPath).toBe('/TEST-first-accepted');
      expect(isTaskDetailTeamUnavailable(store.getState(), identity.teamName, scope)).toBe(true);
    } finally {
      thin.resolve(snapshot('/TEST-older-success'));
      full.resolve(snapshot('/TEST-unused-cleanup'));
      await Promise.allSettled([selection, refresh]);
    }
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
  it('does not reuse a retired metadata predecessor after a newer full snapshot was accepted', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const key = taskDetailKey(identity);
    const older = deferred<TeamViewSnapshot>();
    const newer = deferred<TeamViewSnapshot>();
    apiMock.teams.getData
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
      .mockResolvedValue(snapshot('/TEST-detail-current'));
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'TEST current full task',
      status: 'in_progress',
    });
    const predecessor = store.getState().refreshTeamData(identity.teamName, { withDedup: true });
    const replacement = store.getState().refreshTeamData(identity.teamName, { withDedup: false });
    let detail: Promise<void> | undefined;
    try {
      newer.resolve(snapshot('/TEST-newer-accepted'));
      await replacement;
      expect(store.getState().teamDataCacheByName[identity.teamName]?.config.projectPath).toBe(
        '/TEST-newer-accepted'
      );
      detail = store.getState().ensureTaskDetail(identity);
      older.resolve(snapshot('/TEST-retired-predecessor'));
      await Promise.all([predecessor, detail]);
      expect(apiMock.teams.getData).toHaveBeenCalledTimes(3);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
      expect(store.getState().taskDetailById[key]).toMatchObject({
        phase: 'ready',
        error: null,
        full: { id: 'X', subject: 'TEST current full task' },
      });
      expect(store.getState().teamDataCacheByName[identity.teamName]?.config.projectPath).toBe(
        '/TEST-detail-current'
      );
    } finally {
      older.resolve(snapshot('/TEST-retired-predecessor'));
      newer.resolve(snapshot('/TEST-newer-accepted'));
      await Promise.allSettled([predecessor, replacement, detail]);
    }
  });

  it('waits for queued live metadata before reading a cold task behind a thin selection', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const key = taskDetailKey(identity);
    const thin = deferred<TeamViewSnapshot>();
    const full = deferred<TeamViewSnapshot>();
    apiMock.teams.getData.mockReturnValueOnce(thin.promise).mockReturnValueOnce(full.promise);
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'TEST accepted full task',
      status: 'in_progress',
    });
    store.getState().updateTaskDetailSessionPart(identity, 'commentText', 'TEST queued draft');
    const selection = store.getState().selectTeam(identity.teamName);
    const detail = store.getState().ensureTaskDetail(identity);
    try {
      await Promise.resolve();
      expect(apiMock.teams.getTask).not.toHaveBeenCalled();
      expect(store.getState().taskDetailById[key]).toMatchObject({
        phase: 'hydrating',
        loading: true,
      });
      thin.resolve(snapshot('/TEST-thin'));
      await selection;
      full.resolve(snapshot('/TEST-accepted-full'));
      await vi.waitFor(() =>
        expect(store.getState().selectedTeamData?.config.projectPath).toBe('/TEST-accepted-full')
      );
      await detail;
      expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
      expect(store.getState().taskDetailById[key]).toMatchObject({
        phase: 'ready',
        full: { id: 'X', subject: 'TEST accepted full task' },
      });
      expect(store.getState().taskDetailSessionById[key].commentText).toBe('TEST queued draft');
    } finally {
      thin.resolve(snapshot('/TEST-thin'));
      full.resolve(snapshot('/TEST-accepted-full'));
      await Promise.allSettled([selection, detail]);
      await vi.waitFor(() => expect(store.getState().selectedTeamLoading).toBe(false));
    }
  });

  it('retains a visible read demand when metadata is invalidated before it settles', async () => {
    const store = createTestStore();
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const first = deferred<TeamViewSnapshot>();
    const next = deferred<TeamViewSnapshot>();
    apiMock.teams.getData.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'TEST successor full',
      status: 'in_progress',
    });
    store.getState().setTaskDetailSurfaceInterest('TEST-tab', identity);
    store.getState().setTaskDetailVisibleResourceDemand('TEST-tab', identity, 'detail', true);
    store.getState().updateTaskDetailSessionPart(identity, 'commentText', 'TEST event draft');
    const initial = store.getState().ensureTaskDetail(identity);
    let successor: Promise<void> | undefined;
    try {
      store
        .getState()
        .invalidateTaskDetailTeamSource(identity.contextId, identity.teamName, identity.taskId);
      first.resolve(snapshot('/TEST-retired-metadata'));
      await initial;
      expect(apiMock.teams.getTask).not.toHaveBeenCalled();
      expect(selectTaskDetailReadDemands(store.getState())).toContainEqual(
        expect.objectContaining({
          teamName: 'shared-team',
          taskId: 'X',
          visible: true,
          needsRead: true,
        })
      );
      successor = store.getState().ensureTaskDetail(identity);
      next.resolve(snapshot('/TEST-successor-metadata'));
      await successor;
      expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
      expect(store.getState().taskDetailById[taskDetailKey(identity)]).toMatchObject({
        phase: 'ready',
        full: { subject: 'TEST successor full' },
      });
      expect(store.getState().taskDetailSessionById[taskDetailKey(identity)].commentText).toBe(
        'TEST event draft'
      );
    } finally {
      first.resolve(snapshot('/TEST-retired-metadata'));
      next.resolve(snapshot('/TEST-successor-metadata'));
      await Promise.allSettled([initial, successor]);
    }
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
