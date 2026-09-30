import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeProviderModelDto } from '@features/runtime-provider-management/contracts';
import type { CliProviderStatus } from '@shared/types';

const mocks = vi.hoisted(() => {
  const state = {
    electron: true,
    loadModels: vi.fn(),
    loadProviderDirectory: vi.fn(),
    cancelModelLoad: vi.fn(),
    runtimeProviderManagement: {} as Record<string, unknown>,
  };
  state.cancelModelLoad.mockImplementation(async function (this: unknown) {
    return { ok: this === state.runtimeProviderManagement };
  });
  state.runtimeProviderManagement = {
    loadModels(this: unknown, input: unknown) {
      expect(this).toBe(state.runtimeProviderManagement);
      return state.loadModels(input);
    },
    loadProviderDirectory(this: unknown, input: unknown) {
      expect(this).toBe(state.runtimeProviderManagement);
      return state.loadProviderDirectory(input);
    },
    cancelModelLoad: state.cancelModelLoad,
  };
  return state;
});

vi.mock('@renderer/api', () => ({
  api: { runtimeProviderManagement: mocks.runtimeProviderManagement },
  isElectronMode: () => mocks.electron,
}));

import {
  useOpenCodeConnectedModelCatalog,
  useOpenCodeProviderModelCatalog,
} from '@renderer/hooks/useOpenCodeCatalogs';

const passiveStatus = {
  providerId: 'opencode',
  models: [],
  capabilities: { teamLaunch: false, oneShot: false },
} as unknown as CliProviderStatus;
const model: RuntimeProviderModelDto = {
  modelId: 'model-a',
  providerId: 'opencode',
  displayName: 'Model A',
  sourceLabel: 'OpenCode',
  free: true,
  default: true,
  availability: 'available',
  accessKind: 'builtin_free',
  routeKind: 'builtin_free',
  proofState: 'verified',
  requiresExecutionProof: false,
  accessReason: null,
};

let root: Root;
let providerStatus = '';
let providerError: string | null = null;
let connectedModels: readonly string[] = [];

function ProviderProbe(): null {
  const result = useOpenCodeProviderModelCatalog({
    enabled: true,
    sourceProviderId: 'opencode',
    projectPath: '/sandbox/project',
    passiveProviderStatus: passiveStatus,
  });
  providerStatus = result.status;
  providerError = result.error;
  return null;
}

function ConnectedProbe(): null {
  const result = useOpenCodeConnectedModelCatalog({
    enabled: true,
    projectPath: '/sandbox/project',
    passiveProviderStatus: passiveStatus,
  });
  connectedModels = result.providerStatus?.models ?? [];
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.electron = true;
  mocks.loadModels.mockReset().mockResolvedValue({
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: 'opencode',
      models: [model],
      defaultModelId: 'model-a',
      diagnostics: [],
      catalogState: 'fresh',
      totalCount: 1,
      returnedCount: 1,
      cursor: null,
      nextCursor: null,
    },
  });
  mocks.loadProviderDirectory.mockReset().mockResolvedValue({
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries: [{ providerId: 'opencode', state: 'connected', metadata: {} }],
      totalCount: 1,
      returnedCount: 1,
      cursor: null,
      nextCursor: null,
    },
  });
  mocks.cancelModelLoad.mockClear();
  mocks.runtimeProviderManagement.cancelModelLoad = mocks.cancelModelLoad;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('OpenCode catalog host composition', () => {
  it('loads through both feature hooks without restarting on a stable rerender', async () => {
    await act(async () => root.render(<ProviderProbe />));
    await vi.waitFor(() => expect({ providerStatus, providerError }).toEqual({
      providerStatus: 'ready',
      providerError: null,
    }));
    await act(async () => root.render(<ProviderProbe />));
    expect(mocks.loadModels).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<ConnectedProbe />));
    await vi.waitFor(() => expect(connectedModels).toEqual(['opencode/model-a']));
    expect(mocks.loadProviderDirectory).toHaveBeenCalledOnce();
  });

  it('gates cancellation in browser mode and tolerates an older bridge without cancellation', async () => {
    mocks.loadModels.mockReturnValue(new Promise(() => undefined));
    mocks.electron = false;
    await act(async () => root.render(<ProviderProbe />));
    await act(async () => root.render(null));
    expect(mocks.cancelModelLoad).not.toHaveBeenCalled();

    mocks.electron = true;
    mocks.runtimeProviderManagement.cancelModelLoad = undefined;
    await act(async () => root.render(<ProviderProbe />));
    await expect(act(async () => root.render(null))).resolves.toBeUndefined();
  });
});
