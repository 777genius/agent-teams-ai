import { describe, expect, it, vi } from 'vitest';

import { addAndTestOpenCodeLocalModel } from './openCodeLocalModelSetup';

import type { OpenCodeLocalModelSetupDependencies } from './openCodeLocalModelSetup';

const target = {
  providerId: 'ollama',
  modelId: 'qwen3-30b-32k',
  modelRoute: 'ollama/qwen3-30b-32k',
  presetId: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434/v1',
  privateNetworkApproved: false,
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
    prepareProvisioning: vi.fn(async () => ({ ready: true, message: 'Ready.' })),
    ...overrides,
  };
}

describe('addAndTestOpenCodeLocalModel', () => {
  it('adds a custom Qwen to project scope and verifies it with one deep check', async () => {
    const deps = dependencies();
    const onConfigured = vi.fn();

    const result = await addAndTestOpenCodeLocalModel({
      projectPath: '/tmp/test-project',
      target,
      dependencies: deps,
      onConfigured,
    });

    expect(result).toEqual({ status: 'ready', message: 'Ready.' });
    expect(deps.configureLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        projectPath: '/tmp/test-project',
        defaultModelId: 'qwen3-30b-32k',
        setAsDefault: false,
        allowPrivateNetwork: false,
      })
    );
    expect(deps.prepareProvisioning).toHaveBeenCalledWith(
      '/tmp/test-project',
      'opencode',
      ['opencode'],
      ['ollama/qwen3-30b-32k'],
      false,
      'deep'
    );
    expect(deps.prepareProvisioning).toHaveBeenCalledOnce();
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it('returns the exact hard compatibility reason from the deep check', async () => {
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
            code: 'local_tools_unsupported',
            message: 'gemma3:27b does not support tool calls required by Agent Teams.',
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
      message: 'gemma3:27b does not support tool calls required by Agent Teams.',
    });
    expect(deps.prepareProvisioning).toHaveBeenCalledOnce();
  });

  it('keeps a warning-only deep check in needs verification', async () => {
    const deps = dependencies({
      prepareProvisioning: vi.fn(async () => ({
        ready: true,
        message: 'Ready with warning.',
        warnings: ['Coordination probe was unavailable and will be retried before launch.'],
      })),
    });

    await expect(
      addAndTestOpenCodeLocalModel({
        projectPath: '/tmp/test-project',
        target,
        dependencies: deps,
      })
    ).resolves.toEqual({
      status: 'needs_verification',
      message: 'Coordination probe was unavailable and will be retried before launch.',
    });
    expect(deps.prepareProvisioning).toHaveBeenCalledOnce();
  });

  it('reuses approval only for an already approved private-network provider', async () => {
    const deps = dependencies();

    await addAndTestOpenCodeLocalModel({
      projectPath: '/tmp/test-project',
      target: {
        ...target,
        baseUrl: 'http://192.168.1.20:11434/v1',
        privateNetworkApproved: true,
      },
      dependencies: deps,
    });

    expect(deps.configureLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://192.168.1.20:11434/v1',
        allowPrivateNetwork: true,
      })
    );
  });
});
