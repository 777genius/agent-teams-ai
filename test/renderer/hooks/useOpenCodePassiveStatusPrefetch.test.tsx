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

const NOW = Date.parse('2026-09-06T15:00:00.000Z');
const PROJECT = '/tmp/passive-status-project';

function cachedCatalog(staleAt: number) {
  return {
    providerId: 'opencode',
    statusCheckOutcome: 'authoritative',
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      providerId: 'opencode',
      status: 'ready',
      fetchedAt: new Date(staleAt - 600_000).toISOString(),
      staleAt: new Date(staleAt).toISOString(),
    },
  };
}

describe('useOpenCodePassiveStatusPrefetch', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    storeState.cliProviderStatusScopeRevision = 0;
    storeState.cliProviderStatusByScope = {};
    storeState.fetchCliProviderStatus.mockReset();
    storeState.fetchCliProviderStatus.mockResolvedValue(true);
  });

  it.each(['success', 'false', 'rejected'] as const)(
    'refreshes an expired cached catalog once without spinning after %s with unchanged evidence',
    async (result) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      storeState.cliProviderStatusByScope = {
        [getCliProviderStatusScopeKey('opencode', PROJECT)]: cachedCatalog(NOW - 1),
      };
      if (result === 'rejected')
        storeState.fetchCliProviderStatus.mockRejectedValue(new Error('offline'));
      else storeState.fetchCliProviderStatus.mockResolvedValue(result === 'success');
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => root.render(<Harness />));
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        root.render(<Harness />);
      });
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
      storeState.cliProviderStatusScopeRevision += 1;
      await act(async () => root.render(<Harness />));
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
      await act(async () => root.unmount());
    }
  );

  it('refreshes at each fresh catalog expiry while enabled without reusing the old deadline', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const key = getCliProviderStatusScopeKey('opencode', PROJECT);
    storeState.cliProviderStatusByScope = { [key]: cachedCatalog(NOW + 1000) };
    storeState.fetchCliProviderStatus.mockImplementation(async () => {
      storeState.cliProviderStatusByScope = { [key]: cachedCatalog(Date.now() + 2000) };
      return true;
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it.each(['error', 'loading'] as const)(
    'does not refresh retained expired evidence during %s until invalidation or recovery',
    async (refreshState) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const scopeKey = getCliProviderStatusScopeKey('opencode', PROJECT);
      const expired = cachedCatalog(NOW - 1);
      const retained = { ...expired, modelCatalogRefreshState: refreshState };
      storeState.cliProviderStatusByScope = { [scopeKey]: retained };
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => root.render(<Harness />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        root.render(<Harness />);
      });
      expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

      // Store reconciliation also marks retained catalogs stale after a failed check.
      storeState.cliProviderStatusByScope = {
        [scopeKey]: { ...retained, modelCatalog: { ...expired.modelCatalog, status: 'stale' } },
      };
      await act(async () => root.render(<Harness />));
      expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
      storeState.cliProviderStatusScopeRevision += 1;
      await act(async () => root.render(<Harness />));
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledOnce();

      storeState.cliProviderStatusByScope = { [scopeKey]: cachedCatalog(Date.now() + 1000) };
      await act(async () => root.render(<Harness />));
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
      await act(async () => root.unmount());
    }
  );

  it('cancels expiry while disabled and refreshes the expired scope when enabled again', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', PROJECT)]: cachedCatalog(NOW + 1000),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness />));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('cancels the previous scope timer and ignores its late rejected completion', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const otherProject = '/tmp/other-passive-status-project';
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', PROJECT)]: cachedCatalog(NOW + 1000),
      [getCliProviderStatusScopeKey('opencode', otherProject)]: cachedCatalog(NOW + 2000),
    };
    let rejectOldRequest!: (error: Error) => void;
    storeState.fetchCliProviderStatus.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectOldRequest = reject;
        })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness projectPath={otherProject} />));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness />));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledOnce();
    storeState.cliProviderStatusScopeRevision += 1;
    await act(async () => root.render(<Harness projectPath={otherProject} />));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    await act(async () => rejectOldRequest(new Error('old scope cancelled')));
    await act(async () => root.render(<Harness projectPath={otherProject} />));
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it.each(['success', 'false', 'rejected'] as const)(
    'loads one absent passive project status without retries after %s',
    async (result) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      if (result === 'rejected')
        storeState.fetchCliProviderStatus.mockRejectedValue(new Error('offline'));
      else storeState.fetchCliProviderStatus.mockResolvedValue(result === 'success');
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
    }
  );

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

  it('refetches a previously observed scope after bounded-cache eviction and remount', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const projectPath = '/tmp/passive-status-project';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    const providerStatus = {
      providerId: 'opencode',
      statusCheckOutcome: 'model_only',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness projectPath={projectPath} />);
      await Promise.resolve();
    });

    storeState.cliProviderStatusByScope = { [scopeKey]: providerStatus };
    await act(async () => {
      root.render(<Harness projectPath={projectPath} />);
      await Promise.resolve();
    });

    storeState.cliProviderStatusByScope = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        getCliProviderStatusScopeKey('opencode', '/tmp/cache-filler-' + index),
        providerStatus,
      ])
    );
    await act(async () => {
      root.render(<Harness projectPath="/tmp/cache-filler-11" />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness projectPath={projectPath} />);
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(storeState.fetchCliProviderStatus).toHaveBeenLastCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    });
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
