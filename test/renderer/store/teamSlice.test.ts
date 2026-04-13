import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
  getCurrentProvisioningProgressForTeam,
} from '../../../src/renderer/store/slices/teamSlice';

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  getData: vi.fn(),
  createTeam: vi.fn(),
  getProvisioningStatus: vi.fn(),
  getMemberSpawnStatuses: vi.fn(),
  cancelProvisioning: vi.fn(),
  deleteTeam: vi.fn(),
  restoreTeam: vi.fn(),
  permanentlyDeleteTeam: vi.fn(),
  sendMessage: vi.fn(),
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
      createTeam: hoisted.createTeam,
      getProvisioningStatus: hoisted.getProvisioningStatus,
      getMemberSpawnStatuses: hoisted.getMemberSpawnStatuses,
      cancelProvisioning: hoisted.cancelProvisioning,
      deleteTeam: hoisted.deleteTeam,
      restoreTeam: hoisted.restoreTeam,
      permanentlyDeleteTeam: hoisted.permanentlyDeleteTeam,
      sendMessage: hoisted.sendMessage,
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

describe('teamSlice actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTeamSliceModuleStateForTests();
    hoisted.list.mockResolvedValue([]);
    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    hoisted.sendMessage.mockResolvedValue({ deliveredToInbox: true, messageId: 'm1' });
    hoisted.requestReview.mockResolvedValue(undefined);
    hoisted.updateKanban.mockResolvedValue(undefined);
    hoisted.createTeam.mockResolvedValue({ runId: 'run-1' });
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
    hoisted.cancelProvisioning.mockResolvedValue(undefined);
    hoisted.deleteTeam.mockResolvedValue(undefined);
    hoisted.restoreTeam.mockResolvedValue(undefined);
    hoisted.permanentlyDeleteTeam.mockResolvedValue(undefined);
  });

  it('maps inbox verify failure to user-friendly text', async () => {
    const store = createSliceStore();
    hoisted.sendMessage.mockRejectedValue(new Error('Failed to verify inbox write'));

    await store.getState().sendTeamMessage('my-team', { member: 'alice', text: 'hello' });

    expect(store.getState().sendMessageError).toBe(
      'Message was written but not verified (race). Please try again.'
    );
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

  it('removes non-selected team cache entries on permanent delete', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team' },
        tasks: [],
        members: [],
        messages: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          messages: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
        'other-team': {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          messages: [],
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
        messages: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          messages: [],
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
          messages: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    });

    await store.getState().restoreTeam('my-team');

    expect(hoisted.restoreTeam).toHaveBeenCalledWith('my-team');
    expect(store.getState().teamDataCacheByName['my-team']).toBeUndefined();
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
          messages: [],
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
        messages: [{ from: 'lead', text: 'Hello', timestamp: '2026-01-01T00:00:00Z' }],
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

    it('clears non-selected cache on TEAM_DRAFT refresh failure', async () => {
      const store = createSliceStore();
      store.setState({
        selectedTeamName: 'other-team',
        selectedTeamData: {
          teamName: 'other-team',
          config: { name: 'Other Team' },
          tasks: [],
          members: [],
          messages: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            messages: [],
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
          messages: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
        teamDataCacheByName: {
          'my-team': {
            teamName: 'my-team',
            config: { name: 'My Team' },
            tasks: [],
            members: [],
            messages: [],
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
          messages: [],
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
        messages: [],
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
          messages: [],
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
        messages: [],
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
          messages: [],
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
        messages: [{ from: 'team-lead', text: 'Ping', timestamp: '2026-03-01T10:10:00.000Z' }],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      await store.getState().refreshTeamData('my-team');

      expect(store.getState().selectedTeamData?.tasks[0]?.changePresence).toBe('has_changes');
    });
  });

  describe('provisioning run scoping', () => {
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
          messages: [],
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
          messages: [],
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
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBeUndefined();
      expect(store.getState().memberSpawnStatusesByTeam['my-team']).toBe(previousStatuses);
      expect(store.getState().memberSpawnSnapshotsByTeam['my-team']).toBe(previousSnapshot);
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
      expect(store.getState().ignoredRuntimeRunIds['runtime-old']).toBeUndefined();
      expect(store.getState().activeToolsByTeam['my-team']).toBeUndefined();
      expect(store.getState().finishedVisibleByTeam['my-team']).toBeUndefined();
      expect(store.getState().toolHistoryByTeam['my-team']).toBeUndefined();
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
