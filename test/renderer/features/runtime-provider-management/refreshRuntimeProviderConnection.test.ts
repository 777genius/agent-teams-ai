import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshRuntimeProviderConnection } from '../../../../src/features/runtime-provider-management/renderer/hooks/refreshRuntimeProviderConnection';
import {
  getRuntimeProviderDirectoryReadToken,
  resetRuntimeProviderDirectoryCacheForTests,
} from '../../../../src/features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';

const loadProviderDirectory = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({
  api: { runtimeProviderManagement: { loadProviderDirectory } },
}));

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let complete!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value) => complete(value) };
}

describe('refreshRuntimeProviderConnection', () => {
  afterEach(() => {
    loadProviderDirectory.mockReset();
    resetRuntimeProviderDirectoryCacheForTests();
  });

  it('waits for both the provider view and directory before reporting refresh complete', async () => {
    const view = deferredBoolean();
    const directory = deferredBoolean();

    const refresh = refreshRuntimeProviderConnection({
      runtimeId: 'opencode',
      projectPath: '/tmp/TEST-project',
      runtimeRevision: null,
      directorySupported: false,
      isContextCurrent: () => true,
      isRuntimeRevisionCurrent: () => true,
      refreshExternal: async () => undefined,
      refreshView: () => view.promise,
      refreshDirectory: () => directory.promise,
    });

    let completed = false;
    void refresh.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    view.resolve(true);
    await Promise.resolve();
    expect(completed).toBe(false);
    directory.resolve(true);

    expect(await refresh).toBe('refreshed');
    expect(completed).toBe(true);
  });

  it('starts post-mutation directory recovery after a failing shared summary', async () => {
    const projectPath = '/tmp/TEST-post-mutation-summary-failure';
    let resolveSummary!: (response: unknown) => void;
    loadProviderDirectory.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSummary = resolve; })
    );
    const refreshDirectory = vi.fn(async () => true);
    const refresh = refreshRuntimeProviderConnection({
      runtimeId: 'opencode',
      projectPath,
      runtimeRevision: 'runtime-v1',
      directorySupported: true,
      isContextCurrent: () => true,
      isRuntimeRevisionCurrent: () => true,
      refreshExternal: async () => undefined,
      refreshView: async () => true,
      refreshDirectory,
    });

    await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledOnce());
    const tokenBeforeFailure = getRuntimeProviderDirectoryReadToken(projectPath);
    expect(refreshDirectory).not.toHaveBeenCalled();
    resolveSummary({ error: { code: 'runtime-unhealthy', message: 'Summary read failed' } });

    expect(await refresh).toBe('warning');
    expect(refreshDirectory).toHaveBeenCalledOnce();
    expect(getRuntimeProviderDirectoryReadToken(projectPath)).not.toBe(tokenBeforeFailure);
  });

  it('keeps a replacement directory read valid when the view fails first', async () => {
    const projectPath = '/tmp/TEST-view-failure-does-not-invalidate-directory';
    const directory = deferredBoolean();
    const refreshDirectory = vi.fn(() => directory.promise);
    let completed = false;
    const refresh = refreshRuntimeProviderConnection({
      runtimeId: 'opencode',
      projectPath,
      runtimeRevision: null,
      directorySupported: false,
      isContextCurrent: () => true,
      isRuntimeRevisionCurrent: () => true,
      refreshExternal: async () => undefined,
      refreshView: async () => { throw new Error('View failed'); },
      refreshDirectory,
    }).then((value) => { completed = true; return value; });

    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledOnce());
    const token = getRuntimeProviderDirectoryReadToken(projectPath);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(getRuntimeProviderDirectoryReadToken(projectPath)).toBe(token);

    directory.resolve(true);
    expect(await refresh).toBe('warning');
    expect(getRuntimeProviderDirectoryReadToken(projectPath)).toBe(token);
  });

  it('still starts the directory refresh when the provider view rejects', async () => {
    const refreshDirectory = vi.fn(async () => true);
    const result = await refreshRuntimeProviderConnection({
      runtimeId: 'opencode',
      projectPath: '/tmp/TEST-view-fails',
      runtimeRevision: null,
      directorySupported: false,
      isContextCurrent: () => true,
      isRuntimeRevisionCurrent: () => true,
      refreshExternal: async () => undefined,
      refreshView: async () => {
        throw new Error('View unavailable');
      },
      refreshDirectory,
    });
    expect(result).toBe('warning');
    expect(refreshDirectory).toHaveBeenCalledOnce();
  });
});
