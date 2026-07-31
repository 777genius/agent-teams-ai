import { describe, expect, it, vi } from 'vitest';

import { addAndTestOpenCodeLocalModel } from './openCodeLocalModelSetup';

import type { OpenCodeLocalModelSetupDependencies } from './openCodeLocalModelSetup';

const target = {
  providerId: 'ollama',
  modelId: 'llama3.2:latest',
  modelRoute: 'ollama/llama3.2:latest',
  presetId: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434/v1',
};

function dependencies(
  overrides: Partial<OpenCodeLocalModelSetupDependencies> = {}
): OpenCodeLocalModelSetupDependencies {
  return {
    configureLocalProvider: vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      configuration: {
        providerId: 'ollama',
        baseUrl: target.baseUrl,
        modelIds: [target.modelId],
        defaultModelId: target.modelId,
        modelRoute: target.modelRoute,
        configPath: '/tmp/test-project/opencode.json',
        scope: 'project' as const,
        setAsDefault: false,
      },
    })),
    prepareProvisioning: vi.fn(async () => ({
      ready: true,
      message: 'Ready.',
    })),
    testModel: vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: 'ollama',
        modelId: target.modelRoute,
        ok: true,
        availability: 'available' as const,
        message: 'Verified.',
        diagnostics: [],
      },
    })),
    ...overrides,
  };
}

describe('addAndTestOpenCodeLocalModel', () => {
  it('adds a discovered model to project scope and verifies it', async () => {
    const deps = dependencies();
    const onConfigured = vi.fn();

    const result = await addAndTestOpenCodeLocalModel({
      projectPath: '/tmp/test-project',
      target,
      dependencies: deps,
      onConfigured,
    });

    expect(result).toEqual({ status: 'ready', message: 'Verified.' });
    expect(deps.configureLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        projectPath: '/tmp/test-project',
        defaultModelId: 'llama3.2:latest',
        setAsDefault: false,
      })
    );
    expect(deps.prepareProvisioning).toHaveBeenCalledWith(
      '/tmp/test-project',
      'opencode',
      ['opencode'],
      ['ollama/llama3.2:latest'],
      false,
      'deep'
    );
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it('returns the exact hard compatibility reason without executing the model test', async () => {
    const deps = dependencies({
      prepareProvisioning: vi.fn(async () => ({
        ready: false,
        message: 'Not ready.',
        issues: [
          {
            providerId: 'opencode' as const,
            modelId: target.modelRoute,
            scope: 'model' as const,
            severity: 'blocking' as const,
            code: 'local_context_too_small',
            message:
              'Ollama is running ollama/llama3.2:latest with 4K context. Agent Teams requires at least 16K.',
          },
        ],
      })),
    });

    const result = await addAndTestOpenCodeLocalModel({
      projectPath: '/tmp/test-project',
      target,
      dependencies: deps,
    });

    expect(result).toEqual({
      status: 'incompatible',
      message:
        'Ollama is running ollama/llama3.2:latest with 4K context. Agent Teams requires at least 16K.',
    });
    expect(deps.testModel).not.toHaveBeenCalled();
  });

  it('exposes an experimental status when coordination failed with an override path', async () => {
    const deps = dependencies({
      prepareProvisioning: vi.fn(async () => ({
        ready: false,
        message: 'Not ready.',
        issues: [
          {
            providerId: 'opencode' as const,
            modelId: target.modelRoute,
            scope: 'model' as const,
            severity: 'blocking' as const,
            code: 'local_coordination_probe_failed',
            message: 'Coordination failed. Experimental local-model override is available.',
            experimentalOverrideAvailable: true,
          },
        ],
      })),
    });

    await expect(
      addAndTestOpenCodeLocalModel({
        projectPath: '/tmp/test-project',
        target,
        dependencies: deps,
      })
    ).resolves.toEqual({
      status: 'experimental',
      message: 'Coordination failed. Experimental local-model override is available.',
    });
  });
});
