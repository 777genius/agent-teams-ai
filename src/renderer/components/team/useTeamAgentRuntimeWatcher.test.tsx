import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  state: {
    leadActivityByTeam: {} as Record<string, 'active' | 'idle' | undefined>,
    teamDataByName: {} as Record<string, { isAlive?: boolean } | undefined>,
    provisioningActiveByTeam: {} as Record<string, boolean | undefined>,
    fetchTeamAgentRuntime: vi.fn(async (_teamName: string): Promise<void> => undefined),
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: <T,>(selector: (state: typeof hoisted.state) => T): T => selector(hoisted.state),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: (state: typeof hoisted.state, teamName: string): boolean =>
    state.provisioningActiveByTeam[teamName] === true,
  selectTeamDataForName: (
    state: typeof hoisted.state,
    teamName: string
  ): { isAlive?: boolean } | undefined => state.teamDataByName[teamName],
}));

import {
  __resetTeamAgentRuntimeWatcherForTests,
  useTeamAgentRuntimeWatcher,
} from './useTeamAgentRuntimeWatcher';

interface HookProbeProps {
  teamName: string;
  enabled: boolean;
  isTeamProvisioning?: boolean;
  isTeamAlive?: boolean;
}

const HookProbe = (props: HookProbeProps): null => {
  useTeamAgentRuntimeWatcher(props);
  return null;
};

const mountedRoots: Root[] = [];

async function renderWatcher(props: HookProbeProps): Promise<Root> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);

  await act(async () => {
    root.render(React.createElement(HookProbe, props));
    await Promise.resolve();
  });

  return root;
}

describe('useTeamAgentRuntimeWatcher', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    __resetTeamAgentRuntimeWatcherForTests();
    hoisted.state.leadActivityByTeam = {};
    hoisted.state.teamDataByName = {};
    hoisted.state.provisioningActiveByTeam = {};
    hoisted.state.fetchTeamAgentRuntime.mockReset();
    hoisted.state.fetchTeamAgentRuntime.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = '';
    __resetTeamAgentRuntimeWatcherForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('backs off polling for an alive idle team', async () => {
    hoisted.state.teamDataByName['team-a'] = { isAlive: true };

    await renderWatcher({ teamName: 'team-a', enabled: true });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);
    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledWith('team-a');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(2);
  });

  it('keeps active teams on the fast polling cadence', async () => {
    hoisted.state.leadActivityByTeam['team-a'] = 'active';

    await renderWatcher({ teamName: 'team-a', enabled: true });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not overlap runtime refreshes for the same team', async () => {
    hoisted.state.leadActivityByTeam['team-a'] = 'active';
    let resolveFirstRefresh: () => void = () => undefined;
    const firstRefresh = new Promise<void>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    hoisted.state.fetchTeamAgentRuntime
      .mockImplementationOnce(() => firstRefresh)
      .mockResolvedValue(undefined);

    await renderWatcher({ teamName: 'team-a', enabled: true });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRefresh();
      await firstRefresh;
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(2);
  });

  it('coalesces multiple mounted watchers for one team', async () => {
    hoisted.state.leadActivityByTeam['team-a'] = 'active';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(HookProbe, { teamName: 'team-a', enabled: true }),
          React.createElement(HookProbe, { teamName: 'team-a', enabled: true })
        )
      );
      await Promise.resolve();
    });

    expect(hoisted.state.fetchTeamAgentRuntime).toHaveBeenCalledTimes(1);
  });
});
