import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createContextScopedExtensionApi } from '../../../src/renderer/api/createContextScopedExtensionApi';
import { createExtensionsSlice } from '../../../src/renderer/store/slices/extensionsSlice';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';
import { extensionInitialState } from '../../../src/renderer/store/utils/extensionsContext';

import type { AppState } from '../../../src/renderer/store/types';
import type { EnrichedPlugin, InstalledMcpEntry } from '../../../src/shared/types/extensions';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getReadme: vi.fn(),
  getInstalled: vi.fn(),
  diagnose: vi.fn(),
  install: vi.fn(),
}));
vi.mock('@renderer/api', () => ({
  api: {
    plugins: { getAll: mocks.getAll, getReadme: mocks.getReadme },
    mcpRegistry: {
      getInstalled: mocks.getInstalled,
      diagnose: mocks.diagnose,
      install: mocks.install,
    },
  },
}));
afterEach(() => {
  invalidateContextScopedRequestEpoch();
  vi.clearAllMocks();
});
const fixture = () =>
  createStore<AppState>()(
    (...args) => ({ ...createExtensionsSlice(...args), isContextSwitching: false }) as AppState
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const installed = (name: string): InstalledMcpEntry => ({ name, scope: 'user' });

it('same project in a new context starts a separate real slice request and rejects the old completion', async () => {
  const store = fixture();
  const old = deferred<EnrichedPlugin[]>();
  mocks.getAll.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
  const oldRequest = store.getState().fetchPluginCatalog('/TEST/same-project');
  invalidateContextScopedRequestEpoch();
  store.setState(extensionInitialState());
  await store.getState().fetchPluginCatalog('/TEST/same-project');
  expect(mocks.getAll).toHaveBeenCalledTimes(2);
  old.resolve([{ pluginId: 'TEST-old-owner' } as EnrichedPlugin]);
  await oldRequest;
  expect(store.getState().pluginCatalog).toEqual([]);
  expect(store.getState().pluginCatalogLoading).toBe(false);
  expect(store.getState().pluginCatalogError).toBeNull();
});
it('late MCP failure cannot replace the new context inventory or error state', async () => {
  const store = fixture();
  const old = deferred<InstalledMcpEntry[]>();
  mocks.getInstalled
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([installed('TEST-new-owner')]);
  const pending = store.getState().mcpFetchInstalled('/TEST/same-project');
  invalidateContextScopedRequestEpoch();
  store.setState(extensionInitialState());
  await store.getState().mcpFetchInstalled('/TEST/same-project');
  old.reject(new Error('TEST-old-owner failure'));
  await pending;
  expect(store.getState().mcpInstalledServers).toEqual([installed('TEST-new-owner')]);
  expect(store.getState().mcpDiagnosticsError).toBeNull();
});
it('same-project diagnostics from another context cannot deduplicate or overwrite the new read', async () => {
  const store = fixture();
  const old = deferred<[]>();
  mocks.diagnose.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
  const pending = store.getState().runMcpDiagnostics('/TEST/same-project');
  invalidateContextScopedRequestEpoch();
  store.setState(extensionInitialState());
  await store.getState().runMcpDiagnostics('/TEST/same-project');
  expect(mocks.diagnose).toHaveBeenCalledTimes(2);
  old.resolve([]);
  await pending;
  expect(store.getState().mcpDiagnosticsLoading).toBe(false);
});
it('an existing context transition cannot dispatch an original extension action', async () => {
  const store = fixture();
  store.setState({ isContextSwitching: true });
  await store.getState().mcpFetchInstalled();
  expect(mocks.getInstalled).not.toHaveBeenCalled();
});
it('the original API group preserves method receiver and refuses stale success/error replies', async () => {
  let current = true;
  const old = deferred<string>();
  const original = {
    owner: 'TEST-owner',
    read() {
      expect(this).toBe(original);
      return old.promise;
    },
  };
  const scoped = createContextScopedExtensionApi(original, () => () => current);
  const pending = scoped.read();
  current = false;
  old.resolve('TEST-old');
  await expect(pending).rejects.toThrow('Extensions context changed');
  const failure = deferred<string>();
  current = true;
  original.read = () => failure.promise;
  const rejected = scoped.read();
  current = false;
  failure.reject(new Error('TEST-old failure'));
  await expect(rejected).rejects.toThrow('Extensions context changed');
});
it('wraps frozen contextBridge function properties without bypassing original context or errors', async () => {
  let current = true;
  let dispatched = 0;
  let reply = Promise.resolve('TEST-current');
  const original = Object.freeze({
    owner: 'TEST-frozen-owner',
    read() {
      expect(this).toBe(original);
      dispatched++;
      return reply;
    },
  });
  expect(Object.getOwnPropertyDescriptor(original, 'read')).toMatchObject({
    writable: false,
    configurable: false,
  });
  const scoped = createContextScopedExtensionApi(original, () => () => current);
  expect(scoped.owner).toBe('TEST-frozen-owner');
  await expect(scoped.read()).resolves.toBe('TEST-current');
  current = false;
  await expect(scoped.read()).rejects.toThrow('Extensions context changed');
  expect(dispatched).toBe(1);
  current = true;
  const success = deferred<string>();
  reply = success.promise;
  const pending = scoped.read();
  current = false;
  success.resolve('TEST-stale');
  await expect(pending).rejects.toThrow('Extensions context changed');
  current = true;
  const nativeError = new Error('TEST-current failure');
  const failure = deferred<string>();
  reply = failure.promise;
  const rejected = scoped.read();
  failure.reject(nativeError);
  await expect(rejected).rejects.toBe(nativeError);
  const staleFailure = deferred<string>();
  reply = staleFailure.promise;
  const staleRejected = scoped.read();
  current = false;
  staleFailure.reject(new Error('TEST-old failure'));
  await expect(staleRejected).rejects.toThrow('Extensions context changed');
  expect(dispatched).toBe(4);
});
it('resets inventories, errors and secret-adjacent drafts with independent fresh containers', () => {
  const first = extensionInitialState(),
    second = extensionInitialState();
  first.installErrors['TEST-old'] = 'old';
  first.pluginReadmes['TEST-old'] = 'old';
  expect(second.installErrors).toEqual({});
  expect(second.pluginReadmes).toEqual({});
  expect(second.apiKeys).toEqual([]);
  expect(second.skillsDetailsById).toEqual({});
});
