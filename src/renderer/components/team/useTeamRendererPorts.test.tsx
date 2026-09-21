import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTeamRendererPorts } from './useTeamRendererPorts';

const launchTeam = vi.fn(() => Promise.resolve('run-alpha'));
const listAliveTeams = vi.fn(() => Promise.resolve(['alpha']));
const legacyApi = {
  teams: {
    aliveList: listAliveTeams,
    deleteDraft: vi.fn(() => Promise.resolve()),
    getData: vi.fn(() => Promise.resolve({ teamName: 'alpha', members: [] })),
    getSavedRequest: vi.fn(() => Promise.resolve(null)),
    replaceMembers: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  },
};

function LifecycleReadHarness(): React.JSX.Element | null {
  const ports = useTeamRendererPorts(legacyApi as never, launchTeam);
  useEffect(() => {
    void ports.lifecycle.listAliveTeams();
  }, [ports.lifecycle]);
  return null;
}

describe('useTeamRendererPorts', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    host = null;
    root = null;
    vi.clearAllMocks();
  });

  it('does not repeat lifecycle reads when its owner rerenders', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(<LifecycleReadHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      root!.render(<LifecycleReadHarness />);
      await Promise.resolve();
    });

    expect(listAliveTeams).toHaveBeenCalledTimes(1);
  });
});
