import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type RuntimeProviderQuickConnectDirectoryState,
  useRuntimeProviderQuickConnect,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect';

import type { RuntimeProviderManagementDirectoryResponse } from '../../../../src/features/runtime-provider-management/contracts';
import type { ElectronAPI } from '../../../../src/shared/types/api';

function directoryResponse(): RuntimeProviderManagementDirectoryResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      totalCount: 1,
      returnedCount: 1,
      query: null,
      filter: 'all',
      limit: 100,
      cursor: null,
      nextCursor: null,
      entries: [
        {
          providerId: 'zai-coding-plan',
          displayName: 'Z.AI Coding Plan',
          state: 'available',
          connectedAuthHint: null,
          setupKind: 'connect-api-key',
          ownership: [],
          recommended: false,
          modelCount: 5,
          authMethods: ['api'],
          defaultModelId: null,
          sources: ['seed'],
          sourceLabel: 'Agent Teams catalog',
          providerSource: null,
          detail: null,
          actions: [],
          metadata: {
            hasKnownModels: true,
            requiresManualConfig: false,
            supportedInlineAuth: true,
            configuredAuthless: false,
          },
        },
      ],
      diagnostics: [],
      fetchedAt: new Date(0).toISOString(),
    },
  };
}

describe('useRuntimeProviderQuickConnect', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: RuntimeProviderQuickConnectDirectoryState | null = null;
  let loadProviderDirectory: ReturnType<typeof vi.fn>;

  function Harness({ enabled = true, refreshKey = 0 }: { enabled?: boolean; refreshKey?: number }) {
    current = useRuntimeProviderQuickConnect({
      enabled,
      refreshKey,
      projectPath: '/tmp/test-project',
    });
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    loadProviderDirectory = vi.fn(() => Promise.resolve(directoryResponse()));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: { loadProviderDirectory },
      } as unknown as ElectronAPI,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, 'electronAPI');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    current = null;
  });

  it('loads the full provider directory once after a short startup defer', async () => {
    await act(async () => root.render(React.createElement(Harness)));
    expect(loadProviderDirectory).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
    expect(loadProviderDirectory).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/test-project',
      query: null,
      filter: 'all',
      limit: 100,
      cursor: null,
      refresh: false,
    });
    expect(current?.loaded).toBe(true);
    expect(current?.entries[0]?.providerId).toBe('zai-coding-plan');
  });

  it('does not query OpenCode while the prerequisite is unavailable', async () => {
    await act(async () => root.render(React.createElement(Harness, { enabled: false })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(loadProviderDirectory).not.toHaveBeenCalled();
  });

  it('forces a fresh directory read after provider settings close', async () => {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    await act(async () => root.render(React.createElement(Harness, { refreshKey: 1 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(loadProviderDirectory.mock.calls[1]?.[0]).toMatchObject({ refresh: true });
  });

  it('surfaces directory errors without discarding the last successful entries', async () => {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    loadProviderDirectory.mockResolvedValueOnce({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: { code: 'runtime-unhealthy', message: 'OpenCode probe failed', recoverable: true },
    });

    await act(async () => current?.refresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(current?.error).toBe('OpenCode probe failed');
    expect(current?.entries[0]?.providerId).toBe('zai-coding-plan');
  });
});
