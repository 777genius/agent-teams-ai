import {
  extractOpenCodeCatalogProviderId,
  findEquivalentOpenRouterModelIds,
  getOpenCodeCatalogProviderIds,
  prepareSelectedOpenCodeModelsForProvisioning,
  resolveOpenCodeCompatibilityModel,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeModelPreparation';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

type PrepareMock = Mock<TeamLaunchRuntimeAdapter['prepare']>;

type TestAdapter = TeamLaunchRuntimeAdapter & {
  prepare: PrepareMock;
  getLastOpenCodeTeamLaunchReadiness?: Mock<(cwd: string) => { availableModels?: unknown[] }>;
};

function createAdapter(input: {
  prepare: PrepareMock;
  availableModels?: unknown[];
}): TestAdapter {
  return {
    providerId: 'opencode',
    prepare: input.prepare,
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
    ...(input.availableModels
      ? {
          getLastOpenCodeTeamLaunchReadiness: vi.fn(() => ({
            availableModels: input.availableModels,
          })),
        }
      : {}),
  } as unknown as TestAdapter;
}

describe('TeamProvisioningOpenCodeModelPreparation', () => {
  it('resolves OpenRouter catalog aliases and provider-scoped model ids', () => {
    expect(extractOpenCodeCatalogProviderId(' openrouter/qwen/qwen3-coder ')).toBe('openrouter');
    expect(getOpenCodeCatalogProviderIds(['github/copilot', ' openrouter/qwen '])).toEqual([
      'github',
      'openrouter',
    ]);
    expect(
      findEquivalentOpenRouterModelIds('openrouter/qwen/qwen3-coder', ['qwen/qwen3-coder'])
    ).toEqual(['qwen/qwen3-coder']);
    expect(
      resolveOpenCodeCompatibilityModel('qwen/qwen3-coder', [
        'openrouter/qwen/qwen3-coder',
      ])
    ).toEqual({
      ok: true,
      resolvedModelId: 'openrouter/qwen/qwen3-coder',
    });
    expect(resolveOpenCodeCompatibilityModel('sonnet', ['anthropic/sonnet'])).toEqual({
      ok: true,
      resolvedModelId: 'anthropic/sonnet',
    });
  });

  it('returns specific incompatibility reasons for unavailable OpenRouter models', () => {
    const result = resolveOpenCodeCompatibilityModel('openrouter/qwen/qwen3-coder', [
      'anthropic/sonnet',
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected model to be unavailable');
    }
    expect(result.reason).toContain('OpenCode provider "openrouter"');
    expect(result.reason).toContain('Live catalog providers: anthropic');

    const ambiguous = resolveOpenCodeCompatibilityModel('sonnet', [
      'anthropic/sonnet',
      'github/sonnet',
    ]);
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) {
      throw new Error('expected model to be ambiguous');
    }
    expect(ambiguous.reason).toContain('matched multiple live provider models');
  });

  it('uses compatibility catalog results without probing each selected model', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: null,
      diagnostics: [],
      warnings: ['runtime note'],
    });
    const adapter = createAdapter({
      prepare,
      availableModels: ['qwen/qwen3-coder'],
    });
    const debugEvents: string[] = [];

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/tmp/project',
      modelIds: ['openrouter/qwen/qwen3-coder', 'missing-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      model: undefined,
      runtimeOnly: true,
    });
    expect(result.details).toEqual([
      'Selected model openrouter/qwen/qwen3-coder is compatible. Deep verification pending.',
      'Selected model missing-model is unavailable. Selected model missing-model was not found in the live provider catalog.',
    ]);
    expect(result.warnings).toEqual(['runtime note']);
    expect(result.blockingMessages).toEqual([
      'Selected model missing-model is unavailable. Selected model missing-model was not found in the live provider catalog.',
    ]);
    expect(debugEvents).toContain('opencode_compatibility_batch_catalog');
    expect(debugEvents).toContain('opencode_compatibility_batch_complete');
  });

  it('defers shared compatibility checks when OpenCode is busy', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: true,
      diagnostics: ['OpenCode session status busy'],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const debugEvents: string[] = [];

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/tmp/project',
      modelIds: ['first-model', 'second-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      model: undefined,
      runtimeOnly: true,
    });
    expect(result.blockingMessages).toEqual([]);
    expect(result.warnings).toEqual([
      'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
    ]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'warning',
        code: 'unknown_error',
        message:
          'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
      },
    ]);
    expect(debugEvents).toContain('opencode_compatibility_batch_busy_deferred');
  });

  it('defers remaining deep verification when OpenCode is busy', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: true,
      diagnostics: ['provider busy'],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/tmp/project',
      modelIds: ['first-model', 'second-model'],
      verificationMode: 'deep',
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      model: 'first-model',
      runtimeOnly: false,
    });
    expect(result.blockingMessages).toEqual([]);
    expect(result.warnings).toEqual([
      'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
    ]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'warning',
        code: 'unknown_error',
        message:
          'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
      },
    ]);
  });
});
