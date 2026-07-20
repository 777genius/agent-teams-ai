import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useOpenCodeCatalogPrefetch } from '@renderer/hooks/useOpenCodeCatalogPrefetch';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  cliStatus: {
    flavor: 'agent_teams_orchestrator',
  } as unknown,
  cliProviderStatusByScope: {} as Record<string, unknown>,
  cliProviderStatusScopeRevision: 0,
  fetchCliProviderStatus: vi.fn(),
};

function resolveCatalogFetchSuccessfully(): Promise<boolean> {
  const projectPath = '/tmp/catalog-prefetch-project';
  storeState.cliProviderStatusByScope = {
    ...storeState.cliProviderStatusByScope,
    [getCliProviderStatusScopeKey('opencode', projectPath)]: {
      providerId: 'opencode',
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        providerId: 'opencode',
        status: 'ready',
        staleAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  };
  return Promise.resolve(true);
}

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

function PrefetchHarness({
  enabled = true,
  projectPath = '/tmp/catalog-prefetch-project',
  priority = 'required',
  deferBackground = false,
}: {
  enabled?: boolean;
  projectPath?: string;
  priority?: 'background' | 'required';
  deferBackground?: boolean;
}): React.JSX.Element {
  const state = useOpenCodeCatalogPrefetch({ enabled, projectPath, priority, deferBackground });
  return <div data-required-catalog-pending={String(state.requiredCatalogPending)}>ready</div>;
}

describe('useOpenCodeCatalogPrefetch', () => {
  storeState.fetchCliProviderStatus.mockImplementation(resolveCatalogFetchSuccessfully);

  afterEach(() => {
    document.body.innerHTML = '';
    storeState.cliProviderStatusByScope = {};
    storeState.cliProviderStatusScopeRevision = 0;
    storeState.fetchCliProviderStatus.mockClear();
    storeState.fetchCliProviderStatus.mockImplementation(resolveCatalogFetchSuccessfully);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('warms a required missing project catalog silently once after the dialog paints', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/tmp/catalog-prefetch-project',
    });

    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('reuses a fresh scoped catalog without another provider check', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    const projectPath = '/tmp/catalog-prefetch-project';
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: {
        providerId: 'opencode',
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          providerId: 'opencode',
          status: 'ready',
          staleAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness projectPath={projectPath} />);
      await Promise.resolve();
    });
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('refreshes the same mounted project when its catalog TTL expires', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    const projectPath = '/tmp/catalog-prefetch-project';
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: {
        providerId: 'opencode',
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          providerId: 'opencode',
          status: 'ready',
          staleAt: new Date(Date.now() + 1_000).toISOString(),
        },
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness projectPath={projectPath} />);
      await Promise.resolve();
    });
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('defers a background catalog while launch preflight is active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness priority="background" deferBackground />);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<PrefetchHarness priority="background" deferBackground={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('retries the same project after the dialog closes and reopens following a failed prefetch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.fetchCliProviderStatus.mockResolvedValue(false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<PrefetchHarness enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<PrefetchHarness enabled />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it('does not duplicate an in-flight project request when switching away and back', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.fetchCliProviderStatus.mockImplementation(() => new Promise(() => {}));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    for (const projectPath of ['/tmp/project-a', '/tmp/project-b', '/tmp/project-a']) {
      await act(async () => {
        root.render(<PrefetchHarness projectPath={projectPath} />);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(
      storeState.fetchCliProviderStatus.mock.calls.map((call) => call[1]?.projectPath)
    ).toEqual(['/tmp/project-a', '/tmp/project-b']);

    await act(async () => root.unmount());
  });

  it('starts a fresh scoped request after invalidation without waiting for the old request', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.fetchCliProviderStatus.mockImplementation(() => new Promise(() => {}));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    storeState.cliProviderStatusScopeRevision += 1;
    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('keeps required preflight pending until catalog retries are exhausted', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    storeState.fetchCliProviderStatus.mockResolvedValue(false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-required-catalog-pending')).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (const retryDelay of [2_000, 5_000, 10_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryDelay);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(4);
    expect(host.firstElementChild?.getAttribute('data-required-catalog-pending')).toBe('false');

    storeState.cliProviderStatusScopeRevision += 1;
    await act(async () => {
      root.render(<PrefetchHarness />);
      await Promise.resolve();
    });
    expect(host.firstElementChild?.getAttribute('data-required-catalog-pending')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledTimes(5);

    await act(async () => root.unmount());
  });
});
