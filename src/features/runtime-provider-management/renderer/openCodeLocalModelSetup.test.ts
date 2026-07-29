/* eslint-disable sonarjs/no-clear-text-protocols -- Plain-HTTP local Ollama URLs are the behavior under test. */
import { describe, expect, it, vi } from 'vitest';

import { addAndTestOpenCodeLocalModel } from './openCodeLocalModelSetup';

import type { OpenCodeLocalModelSetupDependencies } from './openCodeLocalModelSetup';

const projectPath = '/workspace/test-project';

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
        configPath: `${projectPath}/opencode.json`,
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
      projectPath,
      target,
      dependencies: deps,
      onConfigured,
    });

    expect(result).toEqual({ status: 'ready', message: 'Ready.' });
    expect(deps.configureLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        projectPath,
        defaultModelId: 'qwen3-30b-32k',
        modelIds: ['qwen3-30b-32k'],
        setAsDefault: false,
        allowPrivateNetwork: false,
      })
    );
    expect(deps.prepareProvisioning).toHaveBeenCalledWith(
      projectPath,
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
      projectPath,
      target,
      dependencies: deps,
    });

    expect(result).toEqual({
      status: 'incompatible',
      message: 'gemma3:27b does not support tool calls required by Agent Teams.',
    });
    expect(deps.prepareProvisioning).toHaveBeenCalledOnce();
  });

  it('preserves an experimental override offered by the deep check', async () => {
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
            code: 'local_execution_failed',
            message: 'The execution probe failed, but an experimental override is available.',
            experimentalOverrideAvailable: true,
          },
        ],
      })),
    });

    await expect(
      addAndTestOpenCodeLocalModel({
        projectPath,
        target,
        dependencies: deps,
      })
    ).resolves.toEqual({
      status: 'experimental',
      message: 'The execution probe failed, but an experimental override is available.',
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
        projectPath,
        target,
        dependencies: deps,
      })
    ).resolves.toEqual({
      status: 'needs_verification',
      message: 'Coordination probe was unavailable and will be retried before launch.',
    });
    expect(deps.prepareProvisioning).toHaveBeenCalledOnce();
  });

  it('forwards approval only when the caller confirms the exact project target', async () => {
    const deps = dependencies();

    await addAndTestOpenCodeLocalModel({
      projectPath,
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
        modelIds: ['qwen3-30b-32k'],
        allowPrivateNetwork: true,
      })
    );
  });
});

/* eslint-enable sonarjs/no-clear-text-protocols -- Re-enable after local Ollama URL fixtures. */
