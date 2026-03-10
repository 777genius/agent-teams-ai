import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  onTeamChangeCb: null as
    | ((event: unknown, data: { type?: string; teamName: string }) => void)
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
      onTeamChange: vi.fn(
        (cb: (event: unknown, data: { teamName: string }) => void): (() => void) => {
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

describe('team change throttling', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    const fetchTeams = vi.fn(async () => undefined);
    const refreshTeamData = vi.fn(async () => undefined);

    useStore.setState({
      fetchTeams,
      refreshTeamData,
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
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team');

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

  it('lead-message refreshes detail only, not team list or tasks', async () => {
    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    // Emit a lead-message event
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Should NOT trigger fetchTeams
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();

    // Should trigger refreshTeamData at 800ms
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team');
  });

  it('lead-message does not call fetchAllTasks', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchAllTasksSpy).not.toHaveBeenCalled();
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

    // Fire rapid events for my-team (throttled)
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Fire event for other-team — should NOT be blocked by my-team's throttle
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);

    // Both teams should get exactly 1 refresh each
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(2);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('other-team');
  });
});
