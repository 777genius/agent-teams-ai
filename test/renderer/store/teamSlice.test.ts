import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
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
    getAllPaneTabs: vi.fn(() => []),
    warmTaskChangeSummaries: vi.fn(async () => undefined),
    invalidateTaskChangePresence: vi.fn(),
  }));
}

describe('teamSlice actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.list.mockResolvedValue([]);
    hoisted.getData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
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

    it('invalidates changed task summaries and warms only cacheable terminal tasks', async () => {
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
      });

      await store.getState().refreshTeamData('my-team');

      expect(hoisted.invalidateTaskChangeSummaries).toHaveBeenCalledWith('my-team', ['task-1']);
      expect(invalidateTaskChangePresence).toHaveBeenCalledTimes(1);
      expect(warmTaskChangeSummaries).toHaveBeenCalledWith([
        expect.objectContaining({ teamName: 'my-team', taskId: 'task-2' }),
      ]);
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
        state: 'monitoring',
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

    it('preserves current spawn statuses when clearing a non-canonical missing run', () => {
      const store = createSliceStore();
      store.setState({
        provisioningRuns: {
          'run-current': {
            runId: 'run-current',
            teamName: 'my-team',
            state: 'monitoring',
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
        state: 'monitoring',
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
