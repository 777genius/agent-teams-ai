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
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';
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
function provider(id: CliProviderId = 'opencode', marker = 'global'): CliProviderStatus {
  return {
    ...createLoadingMultimodelCliStatus().providers.find((value) => value.providerId === id)!,
    supported: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
    statusMessage: marker,
    models: [`${id}/${marker}`],
  };
}
function metadata(): CliInstallationStatus {
  const initial = createLoadingMultimodelCliStatus();
  return {
    ...initial,
    installed: true,
    providers: initial.providers.map((value) => provider(value.providerId)),
  };
}
const projectPath = '/TEST/full-refresh-project';
const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
const originalApi = window.electronAPI;
let root: Root | undefined;
let cleanup = async () => {};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  await cleanup();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  vi.mocked(console.warn).mockClear();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const scoped: ReturnType<typeof deferred<CliProviderStatus>>[] = [];
  const globalReads: { id: CliProviderId; read: ReturnType<typeof deferred<CliProviderStatus>> }[] =
    [];
  const getStatus = vi.fn(async () => metadata());
  const invalidateStatus = vi.fn(async (): Promise<void> => undefined);
  const verifyProviderModels = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      cliInstaller: {
        getStatus,
        invalidateStatus,
        verifyProviderModels,
        getProviderStatus: vi.fn((id: CliProviderId, options?: { projectPath?: string }) => {
          const read = deferred<CliProviderStatus>();
          if (options?.projectPath) scoped.push(read);
          else globalReads.push({ id, read });
          return read.promise;
        }),
      },
    } as unknown as ElectronAPI,
  });
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  mocks.store = store;
  store.setState({
    cliStatus: metadata(),
    openCodeRuntimeStatus: {
      installed: true,
      source: 'app-managed',
      state: 'ready',
      version: '2.2.0',
      v2Support: 'ready',
    },
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
  cleanup = async () => {
    invalidateStatus.mockResolvedValue(undefined);
    await store.getState().invalidateCliStatus();
    for (const read of scoped) read.resolve(provider('opencode', 'obsolete'));
    for (const { id, read } of globalReads) read.resolve(provider(id, 'obsolete'));
    await Promise.all([
      ...scoped.map((read) => read.promise),
      ...globalReads.map(({ read }) => read.promise),
    ]);
  };
  await act(async () => root!.render(<Probe />));
  const settle = async () => {
    const latest = scoped.at(-1)!;
    await act(async () => {
      for (const read of scoped.slice(0, -1)) read.resolve(provider('opencode', 'obsolete'));
      latest.resolve(provider('opencode', 'project-current'));
      for (const { id, read } of globalReads) read.resolve(provider(id, 'hydrated-current'));
    });
    expect(store.getState().cliProviderStatusByScope[scopeKey]?.models).toEqual([
      'opencode/project-current',
    ]);
    expect(host.textContent).toBe('opencode/project-current');
    expect(verifyProviderModels).not.toHaveBeenCalled();
  };
  return { store, scoped, globalReads, getStatus, invalidateStatus, settle };
}

describe('scoped reads across full CLI refresh lifecycles', () => {
  it.each(['bootstrap', 'fetch'] as const)(
    'replaces the previous scoped read when a direct %s starts a new metadata epoch',
    async (mode) => {
      const test = await setup();
      await act(async () => {
        if (mode === 'bootstrap') await test.store.getState().bootstrapCliStatus();
        else await test.store.getState().fetchCliStatus();
      });
      expect(test.scoped).toHaveLength(2);
      await test.settle();
      if (mode === 'fetch') {
        expect(test.globalReads.length).toBeGreaterThan(0);
        for (const { id } of test.globalReads) {
          expect(
            test.store.getState().cliStatus?.providers.find((value) => value.providerId === id)
              ?.statusMessage
          ).toBe('hydrated-current');
        }
      }
    }
  );

  it('does not coalesce new unscoped hydration with a promise from an earlier epoch', async () => {
    const test = await setup();
    const oldRead = test.store.getState().fetchCliProviderStatus('opencode', { silent: true });
    const old = test.globalReads[0];
    await act(async () => {
      await test.store.getState().fetchCliStatus();
    });
    expect(test.globalReads.filter((value) => value.id === 'opencode')).toHaveLength(2);
    await act(async () => {
      old.read.resolve(provider('opencode', 'obsolete'));
      expect(await oldRead).toBe(false);
    });
    await test.settle();
    expect(
      test.store.getState().cliStatus?.providers.find((value) => value.providerId === 'opencode')
        ?.statusMessage
    ).toBe('hydrated-current');
  });

  it('settles the selected project after invalidate IPC followed by bootstrap', async () => {
    const test = await setup();
    const invalidation = deferred<void>();
    test.invalidateStatus.mockReturnValueOnce(invalidation.promise);
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = (async () => {
        await test.store.getState().invalidateCliStatus();
        await test.store.getState().bootstrapCliStatus();
      })();
    });
    await act(async () => {
      invalidation.resolve();
      await refresh;
    });
    await test.settle();
    expect(test.scoped.length).toBeLessThanOrEqual(4);
  });

  it('detaches a read made before a rejected invalidation IPC and retries only once afterward', async () => {
    const test = await setup();
    const invalidation = deferred<void>();
    test.invalidateStatus.mockReturnValueOnce(invalidation.promise);
    let refresh!: Promise<unknown>;
    await act(async () => {
      refresh = test.store
        .getState()
        .invalidateCliStatus()
        .catch((error) => error);
    });
    const countBeforeCompletion = test.scoped.length;
    await act(async () => {
      invalidation.reject(new Error('Invalidation IPC unavailable'));
      expect(await refresh).toBeInstanceOf(Error);
    });
    expect(test.scoped).toHaveLength(countBeforeCompletion + 1);
    await test.settle();
  });

  it.each(['success', 'failure'] as const)(
    'keeps the latest scope when an older bootstrap finishes with %s',
    async (outcome) => {
      const test = await setup();
      const firstMetadata = deferred<CliInstallationStatus>();
      const secondMetadata = deferred<CliInstallationStatus>();
      test.getStatus
        .mockReturnValueOnce(firstMetadata.promise)
        .mockReturnValueOnce(secondMetadata.promise);
      let first!: Promise<void>;
      let second!: Promise<void>;
      await act(async () => {
        first = test.store.getState().bootstrapCliStatus();
      });
      await act(async () => {
        second = test.store.getState().bootstrapCliStatus();
      });
      await act(async () => {
        secondMetadata.resolve(metadata());
        await second;
      });
      await act(async () => {
        if (outcome === 'success') firstMetadata.resolve(metadata());
        else firstMetadata.reject(new Error('Old metadata refresh failed'));
      });
      expect(test.globalReads).toHaveLength(0);
      await act(async () => {
        await first;
      });
      expect(test.scoped).toHaveLength(3);
      await test.settle();
    }
  );

  it('rechecks scoped reads after an older invalidation completes behind a newer bootstrap', async () => {
    const test = await setup();
    const invalidation = deferred<void>();
    test.invalidateStatus.mockReturnValueOnce(invalidation.promise);
    let first!: Promise<void>;
    await act(async () => {
      first = test.store.getState().invalidateCliStatus();
    });
    await act(async () => {
      await test.store.getState().bootstrapCliStatus();
    });
    const beforeCompletion = test.scoped.length;
    await act(async () => {
      invalidation.resolve();
      await first;
    });
    expect(test.scoped).toHaveLength(beforeCompletion + 1);
    await test.settle();
  });
});
