import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type RuntimeProviderQuickConnectDirectoryState,
  useRuntimeProviderQuickConnect,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect';
import {
  getRuntimeProviderDirectoryCacheSnapshot,
  resetRuntimeProviderDirectoryCacheForTests,
} from '../../../../src/features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';

import type { RuntimeProviderManagementDirectoryResponse } from '../../../../src/features/runtime-provider-management/contracts';
import type { ElectronAPI } from '../../../../src/shared/types/api';

function directoryResponse(
  providerId = 'zai-coding-plan'
): RuntimeProviderManagementDirectoryResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      totalCount: 1,
      returnedCount: 1,
      query: null,
      filter: 'all',
      limit: 250,
      cursor: null,
      nextCursor: null,
      entries: [
        {
          providerId,
          displayName: providerId,
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

  function Harness({
    enabled = true,
    refreshKey = 0,
    projectPath = '/tmp/test-project',
  }: {
    enabled?: boolean;
    refreshKey?: number;
    projectPath?: string;
  }) {
    current = useRuntimeProviderQuickConnect({
      enabled,
      refreshKey,
      projectPath,
    });
    return null;
  }

  beforeEach(() => {
    resetRuntimeProviderDirectoryCacheForTests();
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
    resetRuntimeProviderDirectoryCacheForTests();
    current = null;
  });

  it('loads a lightweight summary before silently reconciling it with the live host', async () => {
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('zai-coding-plan'))
      .mockResolvedValueOnce(directoryResponse('github-copilot'));
    await act(async () => root.render(React.createElement(Harness)));
    expect(loadProviderDirectory).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
    expect(loadProviderDirectory).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      summary: true,
      projectPath: '/tmp/test-project',
      query: null,
      filter: 'all',
      limit: 100,
      cursor: null,
      refresh: false,
    });
    expect(current?.loaded).toBe(true);
    expect(current?.authoritativeLoaded).toBe(false);
    expect(current?.authoritativePending).toBe(true);
    expect(current?.entries[0]?.providerId).toBe('zai-coding-plan');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(loadProviderDirectory.mock.calls[1]?.[0]).toEqual({
      runtimeId: 'opencode',
      summary: false,
      projectPath: '/tmp/test-project',
      query: null,
      filter: 'all',
      limit: 250,
      cursor: null,
      refresh: false,
    });
    expect(current?.entries[0]?.providerId).toBe('github-copilot');
    expect(current?.authoritativeLoaded).toBe(true);
    expect(current?.authoritativePending).toBe(false);
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/test-project')).toMatchObject({
      authoritative: true,
      entries: [{ providerId: 'github-copilot' }],
    });
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
    expect(loadProviderDirectory.mock.calls[1]?.[0]).toMatchObject({
      summary: false,
      limit: 250,
      refresh: true,
    });
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

  it('keeps the fast snapshot when the delayed live reconciliation is unavailable', async () => {
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('github-copilot'))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message: 'OpenCode host is starting',
          recoverable: true,
        },
      });

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(current?.entries[0]?.providerId).toBe('github-copilot');
    expect(current?.authoritativeLoaded).toBe(false);
    expect(current?.authoritativePending).toBe(true);
    expect(current?.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(3);
    expect(current?.authoritativeLoaded).toBe(true);
    expect(current?.authoritativePending).toBe(false);
  });

  it('bounds recoverable authoritative retries and reports the final failure', async () => {
    const recoverableFailure = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      error: {
        code: 'runtime-unhealthy',
        message: 'OpenCode host is still starting',
        recoverable: true,
      },
    };
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('openrouter'))
      .mockResolvedValueOnce(recoverableFailure)
      .mockResolvedValueOnce(recoverableFailure)
      .mockResolvedValueOnce(recoverableFailure);

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(current?.authoritativePending).toBe(true);
    expect(current?.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(3);
    expect(current?.authoritativePending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(4);
    expect(current?.authoritativeLoaded).toBe(false);
    expect(current?.authoritativePending).toBe(false);
    expect(current?.error).toBe('OpenCode host is still starting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(4);
  });

  it('does not retry a terminal authoritative failure', async () => {
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('openrouter'))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'invalid-request',
          message: 'Provider directory request is unsupported',
          recoverable: false,
        },
      });

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(current?.authoritativePending).toBe(false);
    expect(current?.error).toBe('Provider directory request is unsupported');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
  });

  it('recovers automatically when the cold-start summary probe fails', async () => {
    loadProviderDirectory
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message: 'OpenCode host is starting',
          recoverable: true,
        },
      })
      .mockResolvedValueOnce(directoryResponse('openrouter'));

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(current?.error).toBe('OpenCode host is starting');
    expect(current?.authoritativePending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(loadProviderDirectory.mock.calls[1]?.[0]).toMatchObject({
      summary: false,
      refresh: true,
    });
    expect(current?.error).toBeNull();
    expect(current?.entries[0]?.providerId).toBe('openrouter');
    expect(current?.authoritativeLoaded).toBe(true);
    expect(current?.authoritativePending).toBe(false);
  });

  it('clears project-scoped provider entries before loading a different project', async () => {
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('openrouter'))
      .mockResolvedValueOnce(directoryResponse('vercel'));

    await act(async () =>
      root.render(React.createElement(Harness, { projectPath: '/tmp/project-a' }))
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(current?.entries[0]?.providerId).toBe('openrouter');

    await act(async () =>
      root.render(React.createElement(Harness, { projectPath: '/tmp/project-b' }))
    );
    expect(current?.entries).toEqual([]);
    expect(current?.loaded).toBe(false);
    expect(current?.authoritativePending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loadProviderDirectory.mock.calls[1]?.[0]).toMatchObject({
      projectPath: '/tmp/project-b',
    });
    expect(current?.entries[0]?.providerId).toBe('vercel');
  });

  it('does not publish an obsolete response after the picker closes and reopens', async () => {
    let resolveObsolete!: (value: RuntimeProviderManagementDirectoryResponse) => void;
    const obsoleteResponse = new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
      resolveObsolete = resolve;
    });
    loadProviderDirectory
      .mockReturnValueOnce(obsoleteResponse)
      .mockResolvedValueOnce(directoryResponse('github-copilot'));

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(current?.loading).toBe(true);

    await act(async () => root.render(React.createElement(Harness, { enabled: false })));
    expect(current?.loading).toBe(false);

    await act(async () => {
      resolveObsolete(directoryResponse('obsolete-provider'));
      await Promise.resolve();
    });
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/test-project')).toBeNull();

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(current?.entries[0]?.providerId).toBe('github-copilot');
    expect(
      getRuntimeProviderDirectoryCacheSnapshot('/tmp/test-project')?.entries[0]?.providerId
    ).toBe('github-copilot');
  });

  it('keeps project scopes isolated during a rapid A to B to A transition', async () => {
    let resolveProjectB!: (value: RuntimeProviderManagementDirectoryResponse) => void;
    const projectBResponse = new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
      resolveProjectB = resolve;
    });
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse('project-a-provider'))
      .mockReturnValueOnce(projectBResponse);

    await act(async () =>
      root.render(React.createElement(Harness, { projectPath: '/tmp/project-a' }))
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(current?.entries[0]?.providerId).toBe('project-a-provider');

    await act(async () =>
      root.render(React.createElement(Harness, { projectPath: '/tmp/project-b' }))
    );
    expect(current?.entries).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () =>
      root.render(React.createElement(Harness, { projectPath: '/tmp/project-a' }))
    );
    expect(current?.entries[0]?.providerId).toBe('project-a-provider');

    await act(async () => {
      resolveProjectB(directoryResponse('project-b-provider'));
      await Promise.resolve();
    });
    expect(current?.entries[0]?.providerId).toBe('project-a-provider');
    expect(getRuntimeProviderDirectoryCacheSnapshot('/tmp/project-b')).toBeNull();
  });
});
