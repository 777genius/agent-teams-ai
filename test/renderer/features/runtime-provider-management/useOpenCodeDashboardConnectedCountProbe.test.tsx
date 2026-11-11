import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenCodeDashboardConnectedCountProbe } from '../../../../src/features/runtime-provider-management/renderer/hooks/useOpenCodeDashboardConnectedCountProbe';
import {
  getRuntimeProviderConnectedCountEvidence,
  getRuntimeProviderConnectedCountObservation,
  invalidateRuntimeProviderDirectoryScopeReads,
  resetRuntimeProviderDirectoryCacheForTests,
} from '../../../../src/features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';

import type { RuntimeProviderManagementDirectoryResponse } from '../../../../src/features/runtime-provider-management/contracts';
import type { ElectronAPI } from '../../../../src/shared/types/api';
import type { OpenCodeRuntimeStatus } from '../../../../src/shared/types';

const ready = (version = '1.18.31') => ({
  installed: true,
  state: 'ready',
  version,
  binaryPath: '/test/opencode',
} as OpenCodeRuntimeStatus);

function response(input: {
  state?: 'connected' | 'available' | 'error';
  totalCount?: number;
  nextCursor?: string | null;
  diagnostics?: string[];
  entries?: number;
  filter?: 'all' | 'connected';
} = {}): RuntimeProviderManagementDirectoryResponse {
  const count = input.entries ?? 1;
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      filter: input.filter ?? 'connected',
      query: null,
      cursor: null,
      nextCursor: input.nextCursor ?? null,
      totalCount: input.totalCount ?? count,
      returnedCount: count,
      limit: 100,
      fetchedAt: new Date().toISOString(),
      diagnostics: input.diagnostics ?? [],
      entries: Array.from({ length: count }, (_, i) => ({
        providerId: i === 0 ? 'deepinfra' : 'source-' + i,
        displayName: i === 0 ? 'DeepInfra' : 'Test source ' + i,
        state: input.state ?? 'connected',
        connectedAuthHint: 'TEST-only-key',
        setupKind: 'connected' as const,
        ownership: [],
        recommended: false,
        modelCount: 0,
        authMethods: ['api' as const],
        defaultModelId: null,
        sources: ['seed' as const],
        sourceLabel: 'Test fixture',
        providerSource: null,
        detail: null,
        actions: [],
        metadata: {
          hasKnownModels: false,
          requiresManualConfig: false,
          supportedInlineAuth: true,
          configuredAuthless: false,
        },
      })),
    },
  };
}

interface Props {
  enabled?: boolean;
  projectPath?: string | null;
  runtimeStatus?: OpenCodeRuntimeStatus | null;
  connectedCount?: number | null;
}

describe('cold Dashboard OpenCode count-only probe', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let loadProviderDirectory: ReturnType<typeof vi.fn>;
  let loadModels: ReturnType<typeof vi.fn>;

  function Harness({
    enabled = true,
    projectPath = null,
    runtimeStatus = ready(),
    connectedCount = null,
  }: Props): null {
    useOpenCodeDashboardConnectedCountProbe({
      enabled, projectPath, runtimeStatus, connectedCount,
    });
    return null;
  }

  async function render(props: Props = {}): Promise<void> {
    await act(async () => root.render(React.createElement(Harness, props)));
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetRuntimeProviderDirectoryCacheForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    loadProviderDirectory = vi.fn(async () => response());
    loadModels = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: { loadProviderDirectory, loadModels },
      } as unknown as ElectronAPI,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, 'electronAPI');
    resetRuntimeProviderDirectoryCacheForTests();
    vi.unstubAllGlobals();
  });

  it('loads a single connected summary without models or full directory on cold Dashboard', async () => {
    await render();
    expect(loadProviderDirectory).toHaveBeenCalledExactlyOnceWith({
      runtimeId: 'opencode',
      summary: true,
      projectPath: null,
      query: null,
      filter: 'connected',
      limit: 100,
      cursor: null,
      refresh: false,
    });
    expect(getRuntimeProviderConnectedCountObservation(null)).toMatchObject({
      connected: 1, source: 'summary-connected',
    });
    expect(loadModels).not.toHaveBeenCalled();
    await render(); // No extra subprocess on an unrelated re-render.
    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a failed count across Dashboard remounts or rapid scope switches', async () => {
    loadProviderDirectory.mockRejectedValue(new Error('test-only directory timeout'));
    await render({ projectPath: '/test/A' });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ projectPath: '/test/A' });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);

    await render({ projectPath: '/test/B' });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    await render({ projectPath: '/test/A' });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
  });

  it('retries expired or failed evidence after cooldown while the pane remains active', async () => {
    vi.useFakeTimers();
    try {
      loadProviderDirectory.mockRejectedValueOnce(new Error('test-only transient failure'));
      await render();
      expect(getRuntimeProviderConnectedCountEvidence(null).checking).not.toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(119_999);
      });
      expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11);
      });
      expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
      expect(getRuntimeProviderConnectedCountObservation(null)?.connected).toBe(1);
      expect(loadModels).not.toHaveBeenCalled();
      await render({ enabled: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240_000);
      });
      expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a genuine complete empty connected summary as zero', async () => {
    loadProviderDirectory.mockResolvedValue(response({ entries: 0 }));
    await render();
    expect(getRuntimeProviderConnectedCountObservation(null)?.connected).toBe(0);
  });

  it('does not read for hidden, missing, unqualified runtime or known counts', async () => {
    await render({ enabled: false });
    await render({ runtimeStatus: null });
    await render({ runtimeStatus: { ...ready(), state: 'checking' } as OpenCodeRuntimeStatus });
    await render({ runtimeStatus: { ...ready(), installed: false } as OpenCodeRuntimeStatus });
    await render({ runtimeStatus: { ...ready(), v2Support: 'required' } as OpenCodeRuntimeStatus });
    await render({ connectedCount: 2 });
    expect(loadProviderDirectory).not.toHaveBeenCalled();
  });

  it('fails closed on truncated, unfiltered, error and diagnostic-bearing summaries', async () => {
    for (const input of [
      { entries: 1, totalCount: 101, nextCursor: '100' },
      { state: 'available' as const },
      { state: 'error' as const },
      { diagnostics: ['inventory probe timed out'] },
      { filter: 'all' as const },
    ]) {
      // Use a fresh project generation for each independent failed read.
      const projectPath = '/test/' + JSON.stringify(input);
      loadProviderDirectory.mockResolvedValue(response(input));
      await render({ projectPath });
      expect(getRuntimeProviderConnectedCountObservation(projectPath)).toBeNull();
    }
    expect(loadModels).not.toHaveBeenCalled();
  });

  it('rejects a pre-mutation response but publishes the new project generation', async () => {
    let resolveOld!: (response: RuntimeProviderManagementDirectoryResponse) => void;
    loadProviderDirectory.mockImplementation((input: { projectPath: string | null }) =>
      input.projectPath === '/test/A'
        ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve(response())
    );
    await render({ projectPath: '/test/A' });
    expect(getRuntimeProviderConnectedCountEvidence('/test/A').checking).toBe(true);
    invalidateRuntimeProviderDirectoryScopeReads('/test/A');
    await render({ projectPath: '/test/B' });
    expect(getRuntimeProviderConnectedCountObservation('/test/B')?.connected).toBe(1);
    await act(async () => resolveOld(response()));
    expect(getRuntimeProviderConnectedCountObservation('/test/A')).toBeNull();
    expect(loadModels).not.toHaveBeenCalled();
  });

  it('rejects an old runtime response after replacement', async () => {
    let resolveOld!: (response: RuntimeProviderManagementDirectoryResponse) => void;
    loadProviderDirectory.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveOld = resolve; })
    );
    await render({ runtimeStatus: ready('1.18.31') });
    await render({ runtimeStatus: ready('1.18.32') });
    expect(getRuntimeProviderConnectedCountObservation(null)?.connected).toBe(1);
    await act(async () => resolveOld(response()));
    expect(getRuntimeProviderConnectedCountObservation(null)?.runtimeRevision)
      .toContain('1.18.32');
  });

  it('reuses a running count after hiding the pane rather than launching another subprocess', async () => {
    let resolveRead!: (response: RuntimeProviderManagementDirectoryResponse) => void;
    loadProviderDirectory.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveRead = resolve; })
    );
    await render({ enabled: true });
    await render({ enabled: false });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
    await act(async () => resolveRead(response()));
    expect(getRuntimeProviderConnectedCountObservation(null)?.connected).toBe(1);
    await render({ enabled: true, connectedCount: 1 });
    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
  });
});
