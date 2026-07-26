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

function createAdapter(input: { prepare: PrepareMock; availableModels?: unknown[] }): TestAdapter {
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
      resolveOpenCodeCompatibilityModel('qwen/qwen3-coder', ['openrouter/qwen/qwen3-coder'])
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
      cwd: '/workspace/project',
      modelIds: ['openrouter/qwen/qwen3-coder', 'missing-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      model: 'openrouter/qwen/qwen3-coder',
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
      cwd: '/workspace/project',
      modelIds: ['first-model', 'second-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      model: 'first-model',
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

  it.each(['ollama/qwen3-coder:30b', 'cursor-acp/auto', 'kiro/auto'])(
    'defers authless execution route %s directly to deep verification',
    async (modelId) => {
      const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
      const adapter = createAdapter({
        prepare,
        availableModels: [modelId, 'opencode/big-pickle'],
      });

      const result = await prepareSelectedOpenCodeModelsForProvisioning({
        adapter,
        cwd: '/workspace/project',
        modelIds: [modelId],
        verificationMode: 'compatibility',
      });

      expect(result).toMatchObject({
        details: [`Selected model ${modelId} is compatible. Deep verification pending.`],
        blockingMessages: [],
        issues: [],
      });
      expect(prepare).not.toHaveBeenCalled();
    }
  );

  it('uses a provider-backed route for shared auth when Cursor also is selected', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'openrouter/qwen/qwen3-coder',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({
      prepare,
      availableModels: ['cursor-acp/auto', 'openrouter/qwen/qwen3-coder'],
    });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['cursor-acp/auto', 'openrouter/qwen/qwen3-coder'],
      verificationMode: 'compatibility',
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openrouter/qwen/qwen3-coder', runtimeOnly: true })
    );
    expect(result.blockingMessages).toEqual([]);
    expect(result.details).toEqual([
      'Selected model cursor-acp/auto is compatible. Deep verification pending.',
      'Selected model openrouter/qwen/qwen3-coder is compatible. Deep verification pending.',
    ]);
  });

  it('defers a provider-scoped route missing from the general catalog to deep verification', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
    const adapter = createAdapter({
      prepare,
      availableModels: ['anthropic/claude-sonnet'],
    });
    const inspectLocalModelRuntime = vi.fn().mockResolvedValue({
      providerId: 'local-lab',
      modelId: 'team-model',
      presetId: 'custom',
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'warning',
      code: 'local_runtime_unverified',
      message: 'Configured local route. Deep verification pending.',
    });
    const debugEvents: string[] = [];

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['local-lab/team-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
      inspectLocalModelRuntime,
    });

    expect(result).toMatchObject({
      details: ['Selected model local-lab/team-model is compatible. Deep verification pending.'],
      blockingMessages: [],
      issues: [],
    });
    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/workspace/project',
      modelRoute: 'local-lab/team-model',
      classificationOnly: true,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(debugEvents).toContain('opencode_compatibility_batch_local_routes_deferred');
  });

  it('still checks catalog authentication when custom and cloud models mix', async () => {
    const prepare = vi
      .fn<TeamLaunchRuntimeAdapter['prepare']>()
      .mockResolvedValueOnce({
        ok: false,
        providerId: 'opencode',
        reason: 'not_authenticated',
        retryable: true,
        diagnostics: ['No connected OpenCode provider found'],
        warnings: [],
      })
      .mockResolvedValueOnce({
        ok: false,
        providerId: 'opencode',
        reason: 'not_authenticated',
        retryable: true,
        diagnostics: ['No connected OpenCode provider found'],
        warnings: [],
      });
    const adapter = createAdapter({
      prepare,
      availableModels: ['anthropic/claude-sonnet'],
    });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['local-lab/team-model', 'anthropic/claude-sonnet'],
      verificationMode: 'compatibility',
    });

    expect(prepare.mock.calls.map(([input]) => input.model)).toEqual([
      'local-lab/team-model',
      'anthropic/claude-sonnet',
    ]);
    expect(result.blockingMessages).toEqual(['No connected OpenCode provider found']);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'not_authenticated', severity: 'blocking' }),
    ]);
  });

  it('still blocks a missing model when its provider is present in the live catalog', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'local-lab/missing-model',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({
      prepare,
      availableModels: ['local-lab/team-model'],
    });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['local-lab/missing-model'],
      verificationMode: 'compatibility',
    });

    expect(result.blockingMessages).toEqual([
      expect.stringContaining('local-lab/missing-model was not found in the live provider catalog'),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        modelId: 'local-lab/missing-model',
        code: 'model_unavailable',
        severity: 'blocking',
      }),
    ]);
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
      cwd: '/workspace/project',
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

  it('blocks the provider after the shared OpenCode readiness timeout is exhausted', async () => {
    const rootCause = 'Failed to query OpenCode agents: OpenCode command timed out after 10000ms';
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: true,
      diagnostics: [
        rootCause,
        'Failed to query OpenCode models: OpenCode command timed out after 10000ms',
        '/config request failed: request timed out after 15000ms',
        'OpenCode raw model id "zai-coding-plan/glm-5.1" was not found in live provider catalog',
      ],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['zai-coding-plan/glm-5.1'],
      verificationMode: 'deep',
    });

    expect(result.blockingMessages).toEqual([rootCause]);
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'unknown_error',
        message: rootCause,
      },
    ]);
  });

  it('does not present a local model response probe as proof of team tool coordination', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'ollama/qwen2.5:0.5b',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['ollama/qwen2.5:0.5b'],
      verificationMode: 'deep',
    });

    expect(result.details).toEqual(['Selected model ollama/qwen2.5:0.5b verified for launch.']);
    expect(result.blockingMessages).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('Agent Teams task and messaging tools are not proven'),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        providerId: 'opencode',
        modelId: 'ollama/qwen2.5:0.5b',
        scope: 'model',
        severity: 'warning',
        code: 'local_team_tools_unverified',
      }),
    ]);
  });

  it('blocks a local model when Ollama proves that its effective context is too small', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'ollama/qwen2.5:0.5b',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const inspectLocalModelRuntime = vi.fn().mockResolvedValue({
      providerId: 'ollama',
      modelId: 'qwen2.5:0.5b',
      presetId: 'ollama',
      toolCapable: true,
      trainedContextTokens: 32_768,
      configuredContextTokens: null,
      effectiveContextTokens: 4_096,
      severity: 'blocking',
      code: 'local_context_too_small',
      message:
        'Ollama is running ollama/qwen2.5:0.5b with 4K context. Agent Teams requires at least 16K.',
    } as const);

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['ollama/qwen2.5:0.5b'],
      verificationMode: 'deep',
      inspectLocalModelRuntime,
    });

    expect(result.details).toEqual([
      expect.stringContaining('Selected model ollama/qwen2.5:0.5b is unavailable.'),
    ]);
    expect(result.blockingMessages).toEqual([
      expect.stringContaining('Agent Teams requires at least 16K'),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'blocking',
        code: 'local_context_too_small',
      }),
    ]);
    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/workspace/project',
      modelRoute: 'ollama/qwen2.5:0.5b',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('marks a local model ready only after the coordination probe passes', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'ollama/qwen3:8b',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const inspectLocalModelRuntime = vi.fn().mockResolvedValue({
      providerId: 'ollama',
      modelId: 'qwen3:8b',
      presetId: 'ollama',
      toolCapable: true,
      parameterCount: 8_000_000_000,
      trainedContextTokens: 32_768,
      configuredContextTokens: 32_768,
      effectiveContextTokens: 32_768,
      coordinationProbeStatus: 'passed',
      severity: 'ready',
      code: 'local_coordination_verified',
      message: 'Agent Teams coordination probe passed.',
    } as const);

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['ollama/qwen3:8b'],
      verificationMode: 'deep',
      inspectLocalModelRuntime,
    });

    expect(result.details).toEqual([
      'Selected model ollama/qwen3:8b verified for launch with Agent Teams tool coordination.',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.blockingMessages).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('defers an unavailable local runtime inspection to the real OpenCode execution probe', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'ollama/qwen3:8b',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const inspectLocalModelRuntime = vi
      .fn()
      .mockRejectedValue(new Error('local provider inventory unavailable'));

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['ollama/qwen3:8b'],
      verificationMode: 'deep',
      inspectLocalModelRuntime,
    });

    expect(result.blockingMessages).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('does not prove that the model is unsupported'),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'local_runtime_inspection_failed',
      }),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('preflights a configured custom local source before the OpenCode execution probe', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
    const adapter = createAdapter({ prepare });
    const inspectLocalModelRuntime = vi.fn().mockResolvedValue({
      providerId: 'local-lab',
      modelId: 'team-model',
      presetId: 'custom',
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: 'failed',
      severity: 'blocking',
      code: 'local_coordination_probe_failed',
      message: 'Custom local model did not complete message_send coordination.',
      experimentalOverrideAvailable: true,
    } as const);

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['local-lab/team-model'],
      verificationMode: 'deep',
      inspectLocalModelRuntime,
    });

    expect(result.blockingMessages).toEqual([
      expect.stringContaining('did not complete message_send coordination'),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'local_coordination_probe_failed',
        experimentalOverrideAvailable: true,
      }),
    ]);
    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/workspace/project',
      modelRoute: 'local-lab/team-model',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
