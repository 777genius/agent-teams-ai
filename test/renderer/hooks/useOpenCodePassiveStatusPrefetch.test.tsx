import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useOpenCodePassiveStatusPrefetch } from '@renderer/hooks/useOpenCodePassiveStatusPrefetch';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  cliStatus: { flavor: 'agent_teams_orchestrator' } as unknown,
  cliProviderStatusByScope: {} as Record<string, unknown>,
  cliProviderStatusScopeRevision: 0,
  fetchCliProviderStatus: vi.fn(async () => true),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

function Harness({
  enabled = true,
  projectPath = '/tmp/passive-status-project',
}: {
  enabled?: boolean;
  projectPath?: string;
}): null {
  useOpenCodePassiveStatusPrefetch({ enabled, projectPath });
  return null;
}

describe('useOpenCodePassiveStatusPrefetch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    storeState.cliProviderStatusScopeRevision = 0;
    storeState.cliProviderStatusByScope = {};
    storeState.fetchCliProviderStatus.mockReset();
    storeState.fetchCliProviderStatus.mockResolvedValue(true);
  });

  it('loads one passive project status without catalog retries', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/tmp/passive-status-project',
    });
    await act(async () => root.unmount());
  });

  it('loads again only after scope invalidation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    storeState.cliProviderStatusScopeRevision = 1;
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('reuses an existing scoped passive status on first mount', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', '/tmp/passive-status-project')]: {
        providerId: 'opencode',
        statusCheckOutcome: 'model_only',
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does nothing while the OpenCode scope is not selected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
