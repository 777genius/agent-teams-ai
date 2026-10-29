import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
} from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useOpenCodeDashboardStatus } from './useOpenCodeDashboardStatus';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { ElectronAPI } from '@shared/types/api';
import type { StateCreator, StoreApi } from 'zustand';

const mocks = vi.hoisted(() => ({ store: null as StoreApi<CliInstallerSlice> | null }));
vi.mock('@renderer/store', async () => {
  const { useStore } = await import('zustand');
  return {
    useStore: (selector: (state: CliInstallerSlice) => unknown) => useStore(mocks.store!, selector),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const projectPath = '/TEST/installed-v2-project';
const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
const ready: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'app-managed',
  state: 'ready',
  version: '2.2.0',
  v2Support: 'ready',
};
function provider(model: string): CliProviderStatus {
  return {
    ...createLoadingMultimodelCliStatus().providers.find(
      (value) => value.providerId === 'opencode'
    )!,
    supported: true,
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: null,
    models: [model],
    modelAvailability: [],
  };
}
const originalApi = window.electronAPI;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  await mocks.store?.getState().invalidateCliStatus();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  vi.mocked(console.warn).mockClear();
  vi.unstubAllGlobals();
});

describe('installation and the selected-project dashboard read', () => {
  it.each(['success', 'failure'] as const)(
    'automatically settles the project after the post-install refresh %s and ignores its older read',
    async (outcome) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const invalidation = deferred<void>();
      const oldRead = deferred<CliProviderStatus>();
      let projectReads = 0;
      const fresh = provider('opencode/new-v2-model');
      const getProviderStatus = vi.fn(async (_id: string, options?: { projectPath?: string }) => {
        if (!options?.projectPath) return fresh;
        projectReads += 1;
        return projectReads === 1 ? oldRead.promise : fresh;
      });
      const verifyProviderModels = vi.fn();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          openCodeRuntime: {
            install: vi.fn(async () => ready),
            invalidateStatus: () => invalidation.promise,
          },
          cliInstaller: {
            invalidateStatus: vi.fn(async () => undefined),
            getProviderStatus,
            verifyProviderModels,
          },
        } as unknown as ElectronAPI,
      });
      const store = createStore<CliInstallerSlice>()(
        createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
      );
      mocks.store = store;
      store.setState({
        cliStatus: { ...createLoadingMultimodelCliStatus(), installed: true },
        openCodeRuntimeStatus: { installed: false, source: 'missing', state: 'idle' },
      });
      const Probe = () => {
        const cliStatus = useStore(store, (state) => state.cliStatus);
        const runtimeStatus = useStore(store, (state) => state.openCodeRuntimeStatus);
        const status = useOpenCodeDashboardStatus({
          enabled: true,
          projectPath,
          cliStatus,
          runtimeStatus,
        });
        return <span>{status.providerStatus?.models.join(',')}</span>;
      };
      const host = document.createElement('div');
      root = createRoot(host);
      await act(async () => root!.render(<Probe />));
      let installation!: Promise<void>;
      await act(async () => {
        installation = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      });
      expect(projectReads).toBe(1);
      await act(async () => {
        if (outcome === 'success') invalidation.resolve();
        else invalidation.reject(new Error('Post-install status refresh unavailable'));
        await installation;
      });
      await act(async () => {
        oldRead.resolve(provider('opencode/stale-native-model'));
        await oldRead.promise;
      });
      expect(projectReads).toBe(2);
      expect(store.getState().cliProviderStatusByScope[scopeKey]?.models).toEqual(fresh.models);
      expect(host.textContent).toBe('opencode/new-v2-model');
      expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
      expect(store.getState().cliProviderStatusLoading.opencode).toBe(false);
      expect(verifyProviderModels).not.toHaveBeenCalled();
    }
  );
});
