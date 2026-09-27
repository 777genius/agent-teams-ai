import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, expect, it, vi } from 'vitest';

import { useOpenCodePassiveStatusPrefetch } from './useOpenCodePassiveStatusPrefetch';

const storeSnapshot = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeSnapshot.current),
}));

afterEach(() => {
  storeSnapshot.current = {};
});

it('recovers a stored partial OpenCode status left behind by an interrupted request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projectPath = '/sandbox/opencode-picker-prefetch-test';
  const fetchCliProviderStatus = vi.fn(async () => false);
  storeSnapshot.current = {
    cliStatus: { flavor: 'agent_teams_orchestrator' },
    cliProviderStatusScopeRevision: 0,
    cliProviderStatusByScope: {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: {
        providerId: 'opencode',
        statusCheckOutcome: 'pending',
        statusCheckErrorCode: 'partial_response',
        modelCatalogRefreshState: 'idle',
        modelCatalog: null,
      },
    },
    fetchCliProviderStatus,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const Probe = (): null => {
    useOpenCodePassiveStatusPrefetch({ enabled: true, projectPath });
    return null;
  };
  try {
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
