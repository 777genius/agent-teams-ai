import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadOpenCodeProjectModels,
  resolveOpenCodeLocalModelLimitSuggestion,
} from './openCodeLocalModelLimits';
import { OpenCodeLocalModelLimitsCard } from './OpenCodeLocalModelLimitsCard';

import type {
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderModelDto,
} from '../contracts';

const mocks = vi.hoisted(() => ({
  configureModelLimits: vi.fn(),
  loadModels: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      configureModelLimits: mocks.configureModelLimits,
      loadModels: mocks.loadModels,
    },
  },
}));

function makeModel(
  modelId: string,
  overrides: Partial<RuntimeProviderModelDto> = {}
): RuntimeProviderModelDto {
  const providerId = modelId.slice(0, modelId.indexOf('/'));
  return {
    modelId,
    providerId,
    displayName: modelId.slice(modelId.indexOf('/') + 1),
    sourceLabel: providerId,
    free: false,
    default: false,
    availability: 'untested',
    accessKind: 'configured_authless',
    routeKind: 'configured_local',
    proofState: 'needs_probe',
    requiresExecutionProof: true,
    accessReason: null,
    catalogContextTokens: 32_768,
    catalogOutputTokens: 8_192,
    managedContextTokens: null,
    managedOutputTokens: null,
    managedUpdatedAt: null,
    ...overrides,
  };
}

function modelsResponse(
  models: RuntimeProviderModelDto[]
): RuntimeProviderManagementModelsResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: models[0]?.providerId ?? 'local',
      models,
      defaultModelId: null,
      diagnostics: [],
    },
  };
}

async function renderCard(input: {
  model: string;
  projectPath: string;
}): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OpenCodeLocalModelLimitsCard {...input} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

describe('OpenCodeLocalModelLimitsCard', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.configureModelLimits.mockReset();
    mocks.loadModels.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('derives detected and saved limits only for configured local routes', () => {
    expect(
      resolveOpenCodeLocalModelLimitSuggestion(
        [makeModel('llama.cpp/qwen-test:0.5b')],
        'llama.cpp/qwen-test:0.5b'
      )
    ).toMatchObject({
      providerId: 'llama.cpp',
      contextTokens: 32_768,
      outputTokens: 8_192,
      managed: false,
    });
    expect(
      resolveOpenCodeLocalModelLimitSuggestion(
        [
          makeModel('llama.cpp/qwen-test:0.5b', {
            managedContextTokens: 16_384,
            managedOutputTokens: 4_096,
          }),
        ],
        'llama.cpp/qwen-test:0.5b'
      )
    ).toMatchObject({ contextTokens: 16_384, outputTokens: 4_096, managed: true });
    expect(
      resolveOpenCodeLocalModelLimitSuggestion(
        [makeModel('openrouter/model', { routeKind: 'connected_provider' })],
        'openrouter/model'
      )
    ).toBeNull();
  });

  it('deduplicates project-scoped model loading for repeated teammate cards', async () => {
    mocks.loadModels.mockResolvedValue(modelsResponse([makeModel('local/qwen')]));
    const input = {
      projectPath: '/tmp/local-limits-dedupe',
      providerId: 'local',
      modelId: 'local/qwen',
    };

    await Promise.all([loadOpenCodeProjectModels(input), loadOpenCodeProjectModels(input)]);

    expect(mocks.loadModels).toHaveBeenCalledTimes(1);
    expect(mocks.loadModels).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'local',
      projectPath: '/tmp/local-limits-dedupe',
      query: 'local/qwen',
      limit: 50,
    });
  });

  it('rehydrates saved limits and completes Apply & verify through the scoped API', async () => {
    const projectPath = '/tmp/local-limits-rehydrate';
    mocks.loadModels.mockResolvedValue(
      modelsResponse([
        makeModel('llama.cpp/qwen-test:0.5b', {
          managedContextTokens: 16_384,
          managedOutputTokens: 4_096,
        }),
      ])
    );
    mocks.configureModelLimits.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'llama.cpp',
        modelId: 'llama.cpp/qwen-test:0.5b',
        contextTokens: 16_384,
        outputTokens: 4_096,
        saved: true,
        verified: true,
        message: 'Model probe passed',
        diagnostics: [],
      },
    });
    const { host, root } = await renderCard({
      model: 'llama.cpp/qwen-test:0.5b',
      projectPath,
    });

    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('input'));
    expect(inputs.map((input) => input.value)).toEqual(['16384', '4096']);
    expect(host.textContent).toContain('openCodeLocalModelLimits.saved');

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.configureModelLimits).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      contextTokens: 16_384,
      outputTokens: 4_096,
      projectPath,
    });
    expect(host.textContent).toContain('openCodeLocalModelLimits.verified');
    act(() => root.unmount());
  });

  it('ignores a completed probe after the selected model changes', async () => {
    let resolveProbe: ((value: unknown) => void) | null = null;
    const probePromise = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    mocks.loadModels.mockResolvedValue(
      modelsResponse([
        makeModel('local/model-a'),
        makeModel('local/model-b', {
          catalogContextTokens: 65_536,
          catalogOutputTokens: 16_384,
        }),
      ])
    );
    mocks.configureModelLimits.mockReturnValue(probePromise);
    const projectPath = '/tmp/local-limits-stale-request';
    const { host, root } = await renderCard({ model: 'local/model-a', projectPath });

    act(() => {
      host
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      root.render(<OpenCodeLocalModelLimitsCard model="local/model-b" projectPath={projectPath} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveProbe?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'local',
          modelId: 'local/model-a',
          contextTokens: 32_768,
          outputTokens: 8_192,
          saved: true,
          verified: true,
          message: 'Model probe passed',
          diagnostics: [],
        },
      });
      await probePromise;
    });

    expect(host.textContent).not.toContain('openCodeLocalModelLimits.verified');
    expect(
      Array.from(host.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value)
    ).toEqual(['65536', '16384']);
    act(() => root.unmount());
  });
});
