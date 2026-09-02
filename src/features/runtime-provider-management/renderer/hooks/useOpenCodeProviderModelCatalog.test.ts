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

const HookProbe = (): null => {
  useOpenCodeProviderModelCatalog({
    enabled: true,
    sourceProviderId: 'openrouter',
    projectPath: '/sandbox/project',
    passiveProviderStatus: null,
  });
  return null;
};

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
