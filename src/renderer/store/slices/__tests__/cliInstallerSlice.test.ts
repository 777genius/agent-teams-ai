import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  mergeCliStatusPreservingHydratedProviders,
} from '@renderer/store/slices/cliInstallerSlice';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { ElectronAPI } from '@shared/types/api';
import type { CliProviderReasoningEffort } from '@shared/types/cliInstaller';
import type { StateCreator } from 'zustand';

function createCliInstallerStore() {
  return createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
}

function installElectronApi(openCodeRuntime: ElectronAPI['openCodeRuntime']): () => void {
  const previousApi = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { openCodeRuntime } as ElectronAPI,
  });
  return () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: previousApi,
    });
  };
}

describe('mergeCliStatusPreservingHydratedProviders', () => {
  it('returns the previous status reference when a structurally identical clone arrives', () => {
    // This mirrors the real IPC path: `CliInstallerService.cloneCliInstallationStatus()`
    // (called from `publishStatusSnapshot()`) hands the renderer a fresh
    // `CliInstallationStatus` whose `providers` are also freshly-cloned
    // objects, even when nothing has actually changed. The merge function
    // must compare provider content (not just reference) so that no-op
    // progress ticks do not produce a new `cliStatus` identity and trigger
    // a re-render storm across every consumer.
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns the previous status reference when an authenticated clone arrives', () => {
    const base = createLoadingMultimodelCliStatus();
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'oauth' as const,
      providers: base.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              authenticated: true,
              authMethod: 'oauth' as const,
              supported: true,
              verificationState: 'verified' as const,
              statusMessage: null,
              models: ['model-a', 'model-b'],
            }
          : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns a new status when an incoming provider field actually differs', () => {
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);
    incoming.providers[0] = {
      ...incoming.providers[0],
      statusMessage: 'Verifying credentials...',
    };

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[0].statusMessage).toBe('Verifying credentials...');
  });

  it('returns current when a structurally identical populated provider clone arrives', () => {
    // Mirrors the real IPC flow with a fully-populated provider: ChatGPT-Codex
    // authenticated, with a model catalog, model availability records,
    // runtime capabilities, available backends, and a selected backend.
    // None of these fields are reference-stable across IPC clones, so the
    // equality guard must compare them by content, not reference.
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusMessage: null,
      models: ['gpt-5.2'],
      modelAvailability: [
        {
          modelId: 'gpt-5.2',
          status: 'available' as const,
          checkedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      runtimeCapabilities: {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'] as CliProviderReasoningEffort[],
        },
      },
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
      backend: { kind: 'codex-cli' as const, label: 'Codex CLI' },
    };
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'codex_chatgpt' as const,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
    expect(merged.providers[1]).toBe(current.providers[1]);
  });

  it('produces a new status when a cloned populated field actually changed', () => {
    // Negative companion to the populated-clone test: confirms that when a
    // cloned DTO field really differs, the merge does NOT preserve the
    // previous reference (i.e. we never let stale data through).
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      models: ['gpt-5.2'],
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
    };
    const current = {
      ...base,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);
    // Flip a nested DTO field on the cloned snapshot.
    incoming.providers[1].availableBackends![0].available = false;

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[1]).not.toBe(current.providers[1]);
    expect(merged.providers[1].availableBackends?.[0].available).toBe(false);
  });
});

describe('OpenCode runtime rejection state', () => {
  it('surfaces a rejected status check as failed without discarding known runtime identity', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('runtime status IPC unavailable');
      },
      install: async () => {
        throw new Error('not used');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();
    store.setState({
      openCodeRuntimeStatus: {
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'path',
        state: 'ready',
      },
    });

    try {
      await store.getState().fetchOpenCodeRuntimeStatus();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'runtime status IPC unavailable',
        openCodeRuntimeStatus: {
          installed: true,
          binaryPath: '/known/opencode',
          version: '1.16.0',
          source: 'path',
          state: 'failed',
          error: 'runtime status IPC unavailable',
          progress: {
            phase: 'failed',
            detail: 'runtime status IPC unavailable',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });

  it('replaces the temporary checking state with failed when installation rejects', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('not used');
      },
      install: async () => {
        throw new Error('download connection lost');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();

    try {
      await store.getState().installOpenCodeRuntime();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'download connection lost',
        openCodeRuntimeStatus: {
          installed: false,
          source: 'missing',
          state: 'failed',
          error: 'download connection lost',
          progress: {
            phase: 'failed',
            detail: 'download connection lost',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });
});
