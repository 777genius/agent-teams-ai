import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDashboardStatusRefresh } from '@renderer/components/dashboard/useDashboardStatusRefresh';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectedCatalogSourceIds,
  useOpenCodeConnectedModelCatalog,
} from './useOpenCodeConnectedModelCatalog';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';
import type { CliProviderStatus } from '@shared/types';

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  models: vi.fn(),
  cancel: vi.fn(async () => undefined),
}));
vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    runtimeProviderManagement: {
      loadProviderDirectory: (...args: unknown[]) => mocks.directory(...args),
      loadModels: (...args: unknown[]) => mocks.models(...args),
      cancelModelLoad: mocks.cancel,
    },
  },
}));

const passive = {
  providerId: 'opencode',
  supported: false,
  authenticated: false,
  capabilities: { teamLaunch: false, oneShot: false },
  models: [],
  statusCheckOutcome: 'model_only',
} as unknown as CliProviderStatus;
let observed: ReturnType<typeof useOpenCodeConnectedModelCatalog>;
const Probe = ({
  enabled = true,
  projectPath = '/sandbox/a',
  refreshRevision,
  periodic = false,
}: {
  enabled?: boolean;
  projectPath?: string;
  refreshRevision?: number;
  periodic?: boolean;
}) => {
  observed = useOpenCodeConnectedModelCatalog({
    enabled,
    projectPath,
    passiveProviderStatus: passive,
    refreshRevision,
  });
  useDashboardStatusRefresh(periodic, observed.refresh);
  return null;
};
function directory(providers = ['opencode', 'openrouter']) {
  const entries = [
    ...providers.map((providerId) => ({ providerId, state: 'connected', metadata: {} })),
    { providerId: 'unconnected', state: 'not-connected', metadata: {} },
  ];
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries,
      totalCount: entries.length,
      returnedCount: entries.length,
      cursor: null,
      nextCursor: null,
    },
  };
}
function models(providerId: string, count = 1) {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId,
      catalogState: 'fresh',
      defaultModelId: null,
      models: Array.from({ length: count }, (_, index) => ({
        providerId,
        modelId: `model-${index}`,
        displayName: `Model ${index}`,
        sourceLabel: providerId,
        default: false,
        free: providerId === 'opencode',
        availability: 'available',
      })),
    },
  };
}
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.directory.mockResolvedValue(directory());
  mocks.models.mockImplementation(async ({ providerId }) => models(providerId));
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('connected OpenCode dashboard catalog', () => {
  it('loads built-in free models before slower connected sources', () => {
    expect(
      connectedCatalogSourceIds(
        directory(['xai', 'opencode', 'openrouter']).directory
          .entries as RuntimeProviderDirectoryEntryDto[]
      )
    ).toEqual(['opencode', 'openrouter', 'xai']);
  });

  it('recovers an initial failure on the periodic tick and reloads changed connected sources', async () => {
    vi.useFakeTimers();
    try {
      mocks.directory.mockRejectedValueOnce(new Error('Runtime unavailable'));
      await act(async () => root.render(<Probe periodic />));
      expect(observed.providerStatus?.modelCatalogRefreshState).toBe('error');
      expect(observed.providerStatus?.modelCatalog?.diagnostics.message).toContain(
        'Runtime unavailable'
      );
      mocks.directory.mockResolvedValue(directory(['opencode', 'xai']));
      await act(async () => vi.advanceTimersByTime(10 * 60_000));
      expect(mocks.directory).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
      expect(observed.providerStatus?.modelCatalogRefreshState).toBe('ready');
      expect(observed.providerStatus?.modelCatalog?.diagnostics.message).toBeNull();
      expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'xai/model-0']);
      mocks.directory.mockResolvedValue(directory(['opencode', 'openrouter']));
      await act(async () => vi.advanceTimersByTime(10 * 60_000));
      expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'openrouter/model-0']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps the last completed catalog visible while the same scope refreshes', async () => {
    await act(async () => root.render(<Probe />));
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'openrouter/model-0']);

    let completeRefresh!: (value: unknown) => void;
    mocks.models.mockImplementation(
      ({ providerId }) =>
        new Promise((resolve) => {
          if (providerId === 'opencode') completeRefresh = resolve;
          else resolve(models(providerId));
        })
    );
    await act(async () => observed.refresh());

    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('loading');
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'openrouter/model-0']);

    await act(async () => completeRefresh(models('opencode', 2)));
    expect(observed.providerStatus?.models).toEqual([
      'opencode/model-0',
      'opencode/model-1',
      'openrouter/model-0',
    ]);
  });
  it('keeps the scoped catalog visible while provider refresh pauses catalog I/O', async () => {
    await act(async () => root.render(<Probe />));
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'openrouter/model-0']);

    await act(async () => root.render(<Probe enabled={false} />));
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0', 'openrouter/model-0']);
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('ready');

    await act(async () => root.render(<Probe enabled={false} projectPath="/sandbox/b" />));
    expect(observed.providerStatus).toBe(passive);
  });
  it.each(['not-connected', 'available', 'ignored'])(
    'includes built-in OpenCode models in %s state without granting readiness',
    async (state) => {
      const response = directory();
      response.directory.entries[0].state = state;
      mocks.directory.mockResolvedValue(response);
      await act(async () => root.render(<Probe />));
      expect(mocks.models.mock.calls.map(([input]) => input.providerId)).toEqual([
        'opencode',
        'openrouter',
      ]);
      expect(observed.providerStatus?.models).toContain('opencode/model-0');
      expect(observed.providerStatus?.supported).toBe(false);
      expect(observed.providerStatus?.authenticated).toBe(false);
      expect(observed.providerStatus?.capabilities.teamLaunch).toBe(false);
      expect(observed.providerStatus?.modelCatalog?.status).toBe('degraded');
    }
  );
  it('reuses model cache on mount and remount but bypasses it for explicit refreshes', async () => {
    await act(async () => root.render(<Probe key="first" refreshRevision={5} />));
    expect(mocks.models.mock.calls.map(([input]) => input.refresh)).toEqual([false, false]);
    expect(mocks.directory).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
    mocks.models.mockClear();
    await act(async () => observed.refresh());
    expect(mocks.models.mock.calls.map(([input]) => input.refresh)).toEqual([true, true]);
    mocks.models.mockClear();
    await act(async () => root.render(<Probe key="first" refreshRevision={6} />));
    expect(mocks.models.mock.calls.map(([input]) => input.refresh)).toEqual([true, true]);
    mocks.models.mockClear();
    await act(async () => root.render(<Probe key="reopened" refreshRevision={6} />));
    expect(mocks.models.mock.calls.map(([input]) => input.refresh)).toEqual([false, false]);
    expect(mocks.directory).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
  });
  it('loads only connected sources and preserves qualified identities and all models', async () => {
    mocks.models.mockImplementation(async ({ providerId }) => models(providerId, 18));
    await act(async () => root.render(<Probe />));
    expect(mocks.directory).toHaveBeenCalledWith(
      expect.objectContaining({ summary: true, projectPath: '/sandbox/a' })
    );
    expect(mocks.models.mock.calls.map(([input]) => input.providerId)).toEqual([
      'opencode',
      'openrouter',
    ]);
    expect(new Set(mocks.models.mock.calls.map(([input]) => input.requestGroupId)).size).toBe(2);
    expect(observed.providerStatus?.models).toHaveLength(36);
    expect(observed.providerStatus?.models).toContain('opencode/model-0');
    expect(observed.providerStatus?.models).toContain('openrouter/model-0');
    expect(observed.providerStatus?.modelCatalog?.status).toBe('degraded');
  });
  it('loads connected sources sequentially to avoid competing OpenCode runtime processes', async () => {
    mocks.directory.mockResolvedValue(directory(['opencode', 'openrouter', 'xai']));
    const completions = new Map<string, (value: unknown) => void>();
    mocks.models.mockImplementation(
      ({ providerId }) =>
        new Promise((resolve) => {
          completions.set(providerId, resolve);
        })
    );

    await act(async () => root.render(<Probe />));
    expect(mocks.models).toHaveBeenCalledTimes(1);
    expect(mocks.models.mock.calls[0]?.[0].providerId).toBe('opencode');

    await act(async () => {
      completions.get('opencode')?.(models('opencode'));
      await vi.waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(2));
    });
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0']);
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('loading');
    expect(mocks.models.mock.calls[1]?.[0].providerId).toBe('openrouter');

    await act(async () => {
      completions.get('openrouter')?.(models('openrouter'));
      await vi.waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(3));
    });
    expect(mocks.models.mock.calls[2]?.[0].providerId).toBe('xai');

    await act(async () => {
      completions.get('xai')?.(models('xai'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('ready');
  });
  it('keeps successful sources and real timeout errors, then retries the same scope', async () => {
    mocks.models.mockImplementation(async ({ providerId }) => {
      if (providerId === 'openrouter') throw new Error('Timed out after 90000ms');
      return models(providerId);
    });
    await act(async () => root.render(<Probe />));
    expect(observed.providerStatus?.models).toEqual(['opencode/model-0']);
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('error');
    expect(observed.providerStatus?.modelCatalog?.diagnostics.message).toContain(
      'openrouter: Timed out after 90000ms'
    );
    mocks.models.mockImplementation(async ({ providerId }) => models(providerId));
    await act(async () => observed.refresh());
    expect(observed.providerStatus?.models).toHaveLength(2);
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('ready');
    expect(observed.providerStatus?.modelCatalog?.diagnostics.message).toBeNull();
  });
  it('does not accept foreign model identities', async () => {
    mocks.models.mockResolvedValue(models('foreign'));
    await act(async () => root.render(<Probe />));
    expect(observed.providerStatus?.models).toEqual([]);
    expect(observed.providerStatus?.modelCatalogRefreshState).toBe('error');
  });
  it('rejects a truncated directory instead of silently omitting providers', async () => {
    const response = directory();
    response.directory.totalCount += 1;
    mocks.directory.mockResolvedValue(response);
    await act(async () => root.render(<Probe />));
    expect(mocks.models).not.toHaveBeenCalled();
    expect(observed.providerStatus?.modelCatalog?.diagnostics.message).toContain(
      'Incomplete provider directory'
    );
  });
  it('ignores a previous project completion and cancels its model requests', async () => {
    let complete!: (value: unknown) => void;
    mocks.models.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    await act(async () => root.render(<Probe />));
    await act(async () => root.render(<Probe projectPath="/sandbox/b" />));
    await act(async () => complete(models('opencode', 5)));
    expect(observed.providerStatus?.models).toHaveLength(2);
    expect(mocks.cancel).toHaveBeenCalled();
  });
});
