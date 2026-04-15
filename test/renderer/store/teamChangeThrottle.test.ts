import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  onTeamChangeCb: null as
    | ((event: unknown, data: { type?: string; teamName: string; detail?: string }) => void)
    | null,
  onProvisioningProgressCb: null as
    | ((event: unknown, data: { runId: string; teamName: string }) => void)
    | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
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
      get: vi.fn(async () => ({
        notifications: [],
        total: 0,
        totalCount: 0,
        unreadCount: 0,
        hasMore: false,
      })),
    },
    teams: {
      setChangePresenceTracking: vi.fn(async () => undefined),
      setToolActivityTracking: vi.fn(async () => undefined),
      onTeamChange: vi.fn(
        (
          cb: (event: unknown, data: { teamName: string; type?: string; detail?: string }) => void
        ): (() => void) => {
          hoisted.onTeamChangeCb = cb;
          return () => {
            hoisted.onTeamChangeCb = null;
          };
        }
      ),
      onProvisioningProgress: vi.fn(
        (cb: (event: unknown, data: { runId: string; teamName: string }) => void): (() => void) => {
          hoisted.onProvisioningProgressCb = cb;
          return () => {
            hoisted.onProvisioningProgressCb = null;
          };
        }
      ),
      getAllTasks: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    schedules: {
      list: vi.fn(async () => []),
      onScheduleChange: vi.fn(() => () => undefined),
    },
  },
}));

import { initializeNotificationListeners, useStore } from '../../../src/renderer/store';
import { __resetTeamSliceModuleStateForTests } from '../../../src/renderer/store/slices/teamSlice';
import { api } from '@renderer/api';

describe('team change throttling', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    __resetTeamSliceModuleStateForTests();
    const fetchTeams = vi.fn(async () => undefined);
    const fetchMemberSpawnStatuses = vi.fn(async () => undefined);
    const refreshTeamData = vi.fn(async () => undefined);
    const refreshTeamMessagesHead = vi.fn(async () => ({
      feedChanged: true,
      headChanged: true,
      feedRevision: 'rev-1',
    }));
    const refreshMemberActivityMeta = vi.fn(async () => undefined);
    const refreshTeamChangePresence = vi.fn(async () => undefined);

    useStore.setState({
      fetchTeams,
      fetchMemberSpawnStatuses,
      refreshTeamData,
      refreshTeamMessagesHead,
      refreshMemberActivityMeta,
      refreshTeamChangePresence,
      selectedTeamName: null,
      selectedTeamData: null,
      teamDataCacheByName: {},
      memberActivityMetaByTeam: {},
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    cleanup = initializeNotificationListeners();

    // Flush microtask queue so the sequential init chain completes
    // before test assertions start (prevents init calls from leaking into spies).
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetTeamSliceModuleStateForTests();
    vi.mocked(console.warn).mockClear();
    vi.useRealTimers();
  });

  it('throttles both team list and detail refresh', async () => {
    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    // Fire 3 rapid events
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });

    // Both are throttled — nothing called synchronously
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    // Detail refresh fires at 800ms
    await vi.advanceTimersByTimeAsync(799);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    // List refresh fires at 2000ms
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);
  });

  it('allows next refresh after throttle window passes', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);

    // Second event after throttle window
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(2);
  });

  it('lead-message refreshes message head only, not team list, tasks, or structural detail', async () => {
    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(state, 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(state, 'refreshMemberActivityMeta');

    // Emit a lead-message event
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Should NOT trigger fetchTeams
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledTimes(1);
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('my-team');
  });

  it('lead-message refreshes visible graph tabs even when the team is not selected', async () => {
    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
  });

  it('lead-message refreshes hidden teams with an active pending-reply wait state', async () => {
    useStore.getState().syncTeamPendingReplyRefresh('other-team', true, 60_000);
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('other-team');
  });

  it('lead-message does not refresh hidden inactive teams without pending replies', async () => {
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamMessagesHeadSpy).not.toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).not.toHaveBeenCalledWith('other-team');
  });

  it('member-spawn refreshes spawn statuses without forcing structural refresh', async () => {
    const fetchMemberSpawnStatusesSpy = vi.spyOn(useStore.getState(), 'fetchMemberSpawnStatuses');
    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { type: 'member-spawn', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('inbox/config/process do not refresh member spawn statuses by default', async () => {
    const fetchMemberSpawnStatusesSpy = vi.spyOn(useStore.getState(), 'fetchMemberSpawnStatuses');

    hoisted.onTeamChangeCb?.({}, { type: 'inbox', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'config', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'process', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMemberSpawnStatusesSpy).not.toHaveBeenCalled();
  });

  it('lead-message does not call fetchAllTasks', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchAllTasksSpy).not.toHaveBeenCalled();
  });

  it('fallback polling refreshes hidden teams with an active pending-reply wait state', async () => {
    useStore.getState().syncTeamPendingReplyRefresh('other-team', true, 60_000);
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('other-team');
  });

  it('log-source-change refreshes only task change presence', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamChangePresenceSpy = vi.spyOn(state, 'refreshTeamChangePresence');

    hoisted.onTeamChangeCb?.({}, { type: 'log-source-change', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(399);
    expect(refreshTeamChangePresenceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
  });

  it('log-source-change refreshes visible graph tab change presence for non-selected teams', async () => {
    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team', members: [], projectPath: '/repo' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    const refreshTeamChangePresenceSpy = vi.spyOn(useStore.getState(), 'refreshTeamChangePresence');

    hoisted.onTeamChangeCb?.({}, { type: 'log-source-change', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(400);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledWith('my-team');
  });

  it('polls unknown in-progress tasks in round-robin order without starving later tasks', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(async () => undefined);

    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [
          {
            id: 'task-1',
            owner: 'alice',
            status: 'in_progress',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
            historyEvents: [],
            reviewState: 'none',
            changePresence: 'unknown',
          },
          {
            id: 'task-2',
            owner: 'alice',
            status: 'in_progress',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
            historyEvents: [],
            reviewState: 'none',
            changePresence: 'unknown',
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    } as never);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkTaskHasChanges).toHaveBeenNthCalledWith(
      1,
      'my-team',
      'task-1',
      expect.objectContaining({ status: 'in_progress', owner: 'alice' })
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkTaskHasChanges).toHaveBeenNthCalledWith(
      2,
      'my-team',
      'task-2',
      expect.objectContaining({ status: 'in_progress', owner: 'alice' })
    );
  });

  it('polls visible non-selected graph teams from cached team data', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(async () => undefined);

    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team', members: [], projectPath: '/repo' },
          tasks: [
            {
              id: 'task-1',
              owner: 'alice',
              status: 'in_progress',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
              historyEvents: [],
              reviewState: 'none',
              changePresence: 'unknown',
            },
            {
              id: 'task-2',
              owner: 'alice',
              status: 'in_progress',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
              historyEvents: [],
              reviewState: 'none',
              changePresence: 'unknown',
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    } as never);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkTaskHasChanges).toHaveBeenNthCalledWith(
      1,
      'my-team',
      'task-1',
      expect.objectContaining({ status: 'in_progress', owner: 'alice' })
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkTaskHasChanges).toHaveBeenNthCalledWith(
      2,
      'my-team',
      'task-2',
      expect.objectContaining({ status: 'in_progress', owner: 'alice' })
    );
  });

  it('per-team throttling: busy team does not block another visible team', async () => {
    // Add a second visible team tab
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 0.5,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
          {
            id: 'p2',
            widthFraction: 0.5,
            tabs: [{ id: 't2', type: 'team', teamName: 'other-team', label: 'other-team' }],
            activeTabId: 't2',
          },
        ],
      },
    } as never);

    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(state, 'refreshTeamMessagesHead');

    // Fire rapid events for my-team (throttled)
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Fire event for other-team — should NOT be blocked by my-team's throttle
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);

    // Both teams should get exactly 1 refresh each
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(2);
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
  });

  it('keeps auto change presence tracking disabled even after selected team data is hydrated', async () => {
    const setChangePresenceTrackingSpy = vi.mocked(api.teams.setChangePresenceTracking);
    setChangePresenceTrackingSpy.mockClear();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();

    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
    } as never);

    await Promise.resolve();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();

    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: null,
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't2', type: 'team', teamName: 'other-team', label: 'other-team' }],
            activeTabId: 't2',
          },
        ],
      },
    } as never);

    await Promise.resolve();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();
  });

  it('tracks visible team tabs for tool activity and disables tracking when tab disappears', async () => {
    const setToolActivityTrackingSpy = vi.mocked(api.teams.setToolActivityTracking);
    setToolActivityTrackingSpy.mockClear();

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', true);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', false);
  });

  it('tracks visible graph tabs for tool activity and disables tracking when graph tab disappears', async () => {
    const setToolActivityTrackingSpy = vi.mocked(api.teams.setToolActivityTracking);
    setToolActivityTrackingSpy.mockClear();

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', true);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', false);
  });

  it('applies targeted tool resets without clearing sibling tools', async () => {
    useStore.setState({
      activeToolsByTeam: {
        'my-team': {
          alice: {
            'tool-a': {
              memberName: 'alice',
              toolUseId: 'tool-a',
              toolName: 'Read',
              startedAt: '2026-03-28T10:00:00.000Z',
              state: 'running',
              source: 'runtime',
            },
            'tool-b': {
              memberName: 'alice',
              toolUseId: 'tool-b',
              toolName: 'Bash',
              startedAt: '2026-03-28T10:00:01.000Z',
              state: 'running',
              source: 'runtime',
            },
          },
        },
      },
    } as never);

    hoisted.onTeamChangeCb?.({}, {
      type: 'tool-activity',
      teamName: 'my-team',
      detail: JSON.stringify({
        action: 'reset',
        memberName: 'alice',
        toolUseIds: ['tool-a'],
      }),
    });

    expect(useStore.getState().activeToolsByTeam['my-team']?.alice?.['tool-a']).toBeUndefined();
    expect(useStore.getState().activeToolsByTeam['my-team']?.alice?.['tool-b']).toBeDefined();
  });
});
