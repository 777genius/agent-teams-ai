import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useTeamGroupChats } from '../../../src/features/team-group-chats/renderer/hooks/useTeamGroupChats';

const ports = vi.hoisted(() => ({
  list: vi.fn(),
  change: undefined as
    | undefined
    | ((event: unknown, change: { teamName: string; type: string }) => void),
}));
vi.mock('@renderer/api', () => ({
  api: {
    teamGroupChats: { list: ports.list },
    teams: {
      onTeamChange: (callback: typeof ports.change) => {
        ports.change = callback;
        return () => {
          ports.change = undefined;
        };
      },
    },
  },
}));

it('coalesces catalog event bursts and keeps a new context independent of pending work', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const releases: (() => void)[] = [];
  ports.list.mockImplementation(
    () =>
      new Promise<[]>((resolve) => {
        releases.push(() => resolve([]));
      })
  );
  let state: ReturnType<typeof useTeamGroupChats>;
  function Probe({ context = 'a' }: { context?: string }) {
    state = useTeamGroupChats('sandbox', context, 'roster');
    return null;
  }
  const view = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      view.render(<Probe />);
    });
    expect(ports.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        void state!.refresh();
        ports.change?.(null, { teamName: 'sandbox', type: 'inbox' });
      }
    });
    expect(ports.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      releases.shift()!();
    });
    expect(ports.list).toHaveBeenCalledTimes(2); // One trailing refresh for all events.
    await act(async () => {
      view.render(<Probe context="b" />);
    });
    expect(ports.list).toHaveBeenCalledTimes(3);
    await act(async () => {
      releases.shift()!();
    });
    expect(state!.loading).toBe(true); // Old context cannot publish its result.
    await act(async () => {
      releases.shift()!();
    });
    expect(state!.loading).toBe(false);
    await act(async () => {
      void state!.refresh();
    });
    expect(ports.list).toHaveBeenCalledTimes(4); // No settled-result cache.
    await act(async () => {
      releases.shift()!();
    });
  } finally {
    await act(async () => {
      view.unmount();
    });
    vi.unstubAllGlobals();
  }
});
