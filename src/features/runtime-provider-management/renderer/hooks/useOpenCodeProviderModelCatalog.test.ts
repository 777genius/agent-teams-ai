import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeModelResponseDiagnostics,
  useOpenCodeProviderModelCatalog,
} from './useOpenCodeProviderModelCatalog';

const apiMock = vi.hoisted(() => ({
  runtimeProviderManagement: {
    loadModels: vi.fn(() => new Promise(() => undefined)),
  },
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
  isElectronMode: () => true,
}));

interface HookProbeProps {
  refreshRevision?: number;
  onResult?: (result: ReturnType<typeof useOpenCodeProviderModelCatalog>) => void;
}

const HookProbe = ({ refreshRevision, onResult }: HookProbeProps): null => {
  const result = useOpenCodeProviderModelCatalog({
    enabled: true,
    sourceProviderId: 'openrouter',
    projectPath: '/sandbox/project',
    refreshRevision,
    passiveProviderStatus: null,
  });
  onResult?.(result);
  return null;
};

function modelCatalogResponse(diagnostic: string) {
  return {
    schemaVersion: 1 as const,
    runtimeId: 'opencode' as const,
    models: {
      runtimeId: 'opencode' as const,
      providerId: 'openrouter',
      models: [],
      defaultModelId: null,
      diagnostics: [diagnostic],
      catalogState: 'fresh' as const,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiMock.runtimeProviderManagement.loadModels.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useOpenCodeProviderModelCatalog', () => {
  it('supports older runtime bridges without cancelModelLoad', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => root.render(React.createElement(HookProbe)));

    expect(apiMock.runtimeProviderManagement.loadModels).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('does not expose a ready catalog from an earlier refresh revision', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const nextRefresh = new Promise<never>(() => undefined);
    const observed: Array<{ revision: number; status: string; catalogState: string | null }> = [];
    const observe = (revision: number) =>
      (result: ReturnType<typeof useOpenCodeProviderModelCatalog>) => {
        observed.push({
          revision,
          status: result.status,
          catalogState: result.catalogState,
        });
      };

    apiMock.runtimeProviderManagement.loadModels
      .mockResolvedValueOnce(modelCatalogResponse('first'))
      .mockReturnValueOnce(nextRefresh);

    await act(async () =>
      root.render(React.createElement(HookProbe, { refreshRevision: 0, onResult: observe(0) }))
    );
    expect(observed.at(-1)).toMatchObject({
      revision: 0,
      status: 'ready',
      catalogState: 'fresh',
    });

    const nextRevisionStart = observed.length;
    await act(async () =>
      root.render(React.createElement(HookProbe, { refreshRevision: 1, onResult: observe(1) }))
    );

    expect(observed.slice(nextRevisionStart)).not.toContainEqual({
      revision: 1,
      status: 'ready',
      catalogState: 'fresh',
    });
    expect(observed.at(-1)).toMatchObject({ revision: 1, status: 'loading' });
    await act(async () => root.unmount());
  });
});

describe('normalizeModelResponseDiagnostics', () => {
  it('treats missing and malformed diagnostics as empty', () => {
    expect(normalizeModelResponseDiagnostics(undefined)).toEqual([]);
    expect(normalizeModelResponseDiagnostics({ length: 1 })).toEqual([]);
  });

  it('keeps only iterable string diagnostics', () => {
    expect(normalizeModelResponseDiagnostics(['ready', null, 7, 'fallback'])).toEqual([
      'ready',
      'fallback',
    ]);
  });
});
