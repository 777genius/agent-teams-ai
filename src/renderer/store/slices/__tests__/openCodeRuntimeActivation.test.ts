import { createCliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { ElectronAPI } from '@shared/types/api';
import type { OpenCodeRuntimeStatus } from '@shared/types/cliInstaller';
import type { StateCreator } from 'zustand';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const missing: OpenCodeRuntimeStatus = { installed: false, source: 'missing', state: 'idle' };
const ready: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'app-managed',
  state: 'ready',
  version: '2.1.4',
  binaryPath: '/TEST/managed-opencode',
  v2Support: 'ready',
  compatibleV2Version: '2.1.4',
};
const required: OpenCodeRuntimeStatus = {
  ...ready,
  source: 'path',
  state: 'idle',
  v2Support: 'required',
  error: 'OpenCode V2 support download required.',
};

const originalApi = window.electronAPI;
afterEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: originalApi,
  });
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

function setup(overrides: Partial<ElectronAPI['openCodeRuntime']> = {}) {
  const runtime = {
    getStatus: vi.fn(async () => missing),
    install: vi.fn(async () => ready),
    invalidateStatus: vi.fn(async () => undefined),
    onProgress: () => () => undefined,
    ...overrides,
  };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { openCodeRuntime: runtime },
  });
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  return { store, runtime };
}

describe('OpenCode installation without restarting the renderer', () => {
  it.each(['success', 'failure'] as const)(
    'ignores a pre-install status %s after V2 is ready',
    async (outcome) => {
      const old = deferred<OpenCodeRuntimeStatus>();
      const { store } = setup({ getStatus: () => old.promise });
      const checking = store.getState().fetchOpenCodeRuntimeStatus();
      await store.getState().installOpenCodeRuntime({ generation: 'v2' });
      if (outcome === 'success') old.resolve(missing);
      else old.reject(new Error('old status transport failed'));
      await checking;
      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatus: ready,
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: null,
      });
    }
  );

  it('a pre-install status response cannot clear the installation busy state', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const installing = deferred<OpenCodeRuntimeStatus>();
    const { store } = setup({ getStatus: () => old.promise, install: () => installing.promise });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    const install = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    old.resolve(missing);
    await checking;
    const duringInstall = {
      status: store.getState().openCodeRuntimeStatus?.state,
      loading: store.getState().openCodeRuntimeStatusLoading,
    };
    installing.resolve(ready);
    await install;
    expect(duringInstall).toEqual({ status: 'checking', loading: true });
  });

  it('preserves missing support and its retry action when install IPC fails', async () => {
    const { store } = setup({
      install: async () => {
        throw new Error('download IPC disconnected');
      },
    });
    store.setState({ openCodeRuntimeStatus: required });
    await store.getState().installOpenCodeRuntime({ generation: 'v2', supportOnly: true });
    expect(store.getState().openCodeRuntimeStatus).toMatchObject({
      installed: true,
      state: 'failed',
      v2Support: 'required',
      compatibleV2Version: '2.1.4',
      error: 'download IPC disconnected',
    });
  });

  it('preserves missing support when a readiness refresh fails', async () => {
    const { store } = setup({
      getStatus: async () => {
        throw new Error('status IPC disconnected');
      },
    });
    store.setState({ openCodeRuntimeStatus: required });
    await store.getState().fetchOpenCodeRuntimeStatus();
    expect(store.getState().openCodeRuntimeStatus).toMatchObject({
      state: 'failed',
      v2Support: 'required',
      compatibleV2Version: '2.1.4',
    });
  });

  it('keeps an installed V2 ready if the follow-up provider refresh is unavailable', async () => {
    const { store } = setup({
      invalidateStatus: async () => {
        throw new Error('provider refresh IPC disconnected');
      },
    });
    await store.getState().installOpenCodeRuntime({ generation: 'v2' });
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: ready,
      openCodeRuntimeStatusLoading: false,
      openCodeRuntimeError: null,
    });
  });

  it('does not reuse a status read started before explicit invalidation', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const getStatus = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(ready);
    const { store } = setup({ getStatus });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    await store.getState().invalidateOpenCodeRuntimeStatus();
    const refreshed = store.getState().fetchOpenCodeRuntimeStatus();
    old.resolve(missing);
    await Promise.all([checking, refreshed]);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
  });

  it('a delayed poll cannot replace progress delivered by the main process', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const { store } = setup({ getStatus: () => old.promise });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    const downloading: OpenCodeRuntimeStatus = {
      ...required,
      state: 'downloading',
      progress: { phase: 'downloading', percent: 42 },
      error: undefined,
    };
    store.getState().applyOpenCodeRuntimeProgress(downloading);
    old.resolve(required);
    await checking;
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: downloading,
      openCodeRuntimeStatusLoading: true,
      openCodeRuntimeError: null,
    });
    store.getState().applyOpenCodeRuntimeProgress(ready);
    expect(store.getState().openCodeRuntimeStatusLoading).toBe(false);
  });

  it('shares a repeated install request until the first installation settles', async () => {
    const result = deferred<OpenCodeRuntimeStatus>();
    const install = vi.fn(() => result.promise);
    const { store } = setup({ install });
    const first = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    const second = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    expect(install).toHaveBeenCalledTimes(1);
    result.resolve(ready);
    await Promise.all([first, second]);
    expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
  });

  it('retains newer main-process progress when an earlier post-install refresh finishes', async () => {
    const refresh = deferred<void>();
    const invalidateStatus = vi.fn(() => refresh.promise);
    const { store } = setup({ invalidateStatus });
    const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    await vi.waitFor(() => expect(invalidateStatus).toHaveBeenCalledTimes(1));
    const downloading: OpenCodeRuntimeStatus = {
      ...ready,
      state: 'downloading',
      progress: { phase: 'downloading', percent: 12 },
    };
    store.getState().applyOpenCodeRuntimeProgress(downloading);
    refresh.resolve();
    await installing;
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: downloading,
      openCodeRuntimeStatusLoading: true,
    });
    store.getState().applyOpenCodeRuntimeProgress(ready);
  });
});
