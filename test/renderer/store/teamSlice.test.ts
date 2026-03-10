import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createTeamSlice } from '../../../src/renderer/store/slices/teamSlice';

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  getData: vi.fn(),
  createTeam: vi.fn(),
  getProvisioningStatus: vi.fn(),
  cancelProvisioning: vi.fn(),
  sendMessage: vi.fn(),
  requestReview: vi.fn(),
  updateKanban: vi.fn(),
  onProvisioningProgress: vi.fn(() => () => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      list: hoisted.list,
      getData: hoisted.getData,
      createTeam: hoisted.createTeam,
      getProvisioningStatus: hoisted.getProvisioningStatus,
      cancelProvisioning: hoisted.cancelProvisioning,
      sendMessage: hoisted.sendMessage,
      requestReview: hoisted.requestReview,
      updateKanban: hoisted.updateKanban,
      onProvisioningProgress: hoisted.onProvisioningProgress,
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
    hoisted.getProvisioningStatus.mockResolvedValue({
      runId: 'run-1',
      teamName: 'my-team',
      state: 'spawning',
      message: 'Starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
  });
});
