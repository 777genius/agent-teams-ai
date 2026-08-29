import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));

vi.mock('@renderer/store', () => ({ useStore: useStoreMock }));

import { useOpenCodeCatalogPrefetch } from './useOpenCodeCatalogPrefetch';

describe('useOpenCodeCatalogPrefetch request ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useStoreMock.mockReset();
    document.body.innerHTML = '';
  });

  it('coordinates project catalog hydration as an explicitly passive scoped request', async () => {
    const fetchCliProviderStatus = vi.fn(async () => false);
    const storeState = {
      cliStatus: createLoadingMultimodelCliStatus(),
      cliProviderStatusScopeRevision: 3,
      cliProviderStatusByScope: {},
      fetchCliProviderStatus,
    };
    useStoreMock.mockImplementation((selector) => selector(storeState));
    const snapshots: boolean[] = [];
    const Probe = (): null => {
      const snapshot = useOpenCodeCatalogPrefetch({
        enabled: true,
        projectPath: '/project/catalog',
        priority: 'required',
      });
      useEffect(() => {
        snapshots.push(snapshot.requiredCatalogPending);
      }, [snapshot]);
      return null;
    };
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    expect(fetchCliProviderStatus).toHaveBeenCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/project/catalog',
      intent: 'passive',
    });
    expect(snapshots.at(-1)).toBe(true);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
