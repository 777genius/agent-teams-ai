import {
  extractOpenCodeCatalogProviderId,
  findEquivalentOpenRouterModelIds,
  getOpenCodeCatalogProviderIds,
  prepareSelectedOpenCodeModelsForProvisioning,
  resolveOpenCodeCompatibilityModel,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeModelPreparation';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { openCodeProviderStatus } from './fixtures/openCodeProviderStatus';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

type PrepareMock = Mock<TeamLaunchRuntimeAdapter['prepare']>;

type TestAdapter = TeamLaunchRuntimeAdapter & {
  prepare: PrepareMock;
  readProviderStatus: Mock;
  getLastOpenCodeTeamLaunchReadiness?: Mock<(cwd: string) => { availableModels?: string[] }>;
};

function createAdapter(input: { prepare: PrepareMock; availableModels?: string[] }): TestAdapter {
  return {
    providerId: 'opencode',
    prepare: input.prepare,
    readProviderStatus: vi
      .fn()
      .mockResolvedValue(openCodeProviderStatus(input.availableModels ?? [])),
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
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['openrouter/qwen/qwen3-coder', 'missing-model'],
      verificationMode: 'compatibility',
      appendPreflightDebugLog: (event) => debugEvents.push(event),
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.readProviderStatus).toHaveBeenCalledExactlyOnceWith({
      cwd: '/workspace/project',
    });
    expect(result.details).toEqual([
      'Selected model openrouter/qwen/qwen3-coder is compatible. Deep verification pending.',
      'Selected model missing-model is unavailable. Selected model missing-model was not found in the live provider catalog.',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.blockingMessages).toEqual([
      'Selected model missing-model is unavailable. Selected model missing-model was not found in the live provider catalog.',
    ]);
    expect(debugEvents).toContain('opencode_compatibility_batch_catalog');
    expect(debugEvents).toContain('opencode_compatibility_batch_complete');
  });

  it('skips all compatibility processing when no models are selected', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
    const adapter = createAdapter({ prepare, availableModels: ['anthropic/sonnet'] });
    const inspectLocalModelRuntime = vi.fn();
    const appendPreflightDebugLog = vi.fn();

    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: [],
      verificationMode: 'compatibility',
      inspectLocalModelRuntime,
      appendPreflightDebugLog,
    });

    expect(result).toEqual({
      details: [],
      warnings: [],
      blockingMessages: [],
      issues: [],
      supportDiagnostics: [],
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.readProviderStatus).not.toHaveBeenCalled();
    expect(inspectLocalModelRuntime).not.toHaveBeenCalled();
    expect(appendPreflightDebugLog).not.toHaveBeenCalled();
  });

  it.each([
    'stale',
    'malformed',
    'empty',
    'null',
    'error',
    'wrong-provider',
    'unauthenticated',
    'refresh-error',
  ])('fails closed for %s catalog without consulting launch readiness', async (kind) => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>();
    const adapter = createAdapter({ prepare, availableModels: ['anthropic/sonnet'] });
    const provider = openCodeProviderStatus(['anthropic/sonnet']);
    if (kind === 'stale') provider.modelCatalog!.staleAt = new Date(0).toISOString();
    if (kind === 'malformed') provider.modelCatalog!.models[0].launchModel = '';
    if (kind === 'empty') provider.modelCatalog!.models = [];
    if (kind === 'wrong-provider') provider.providerId = 'codex';
    if (kind === 'unauthenticated') provider.authenticated = false;
    if (kind === 'refresh-error') provider.modelCatalogRefreshState = 'error';
    adapter.readProviderStatus.mockResolvedValue(kind === 'null' ? null : provider);
    if (kind === 'error')
      adapter.readProviderStatus.mockRejectedValue(new Error('catalog timed out'));
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });
    expect(result.blockingMessages).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.getLastOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
  });

  it('defers model-only passive status to strict deep verification without minting compatibility proof', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'anthropic/sonnet',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const passiveStatus = openCodeProviderStatus(['anthropic/other-model']);
    passiveStatus.statusCheckOutcome = 'model_only';
    passiveStatus.verificationState = 'unknown';
    passiveStatus.authenticated = false;
    passiveStatus.modelCatalog = null;
    passiveStatus.modelCatalogRefreshState = 'idle';
    adapter.readProviderStatus.mockResolvedValue(passiveStatus);

    const compatibility = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });

    expect(compatibility).toMatchObject({
      details: ['Selected model anthropic/sonnet requires strict deep verification.'],
      warnings: [
        'OpenCode passive status cannot prove catalog authority. Compatibility is deferred to strict deep verification.',
      ],
      blockingMessages: [],
      issues: [],
    });
    expect(prepare).not.toHaveBeenCalled();

    const deep = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'deep',
    });

    expect(deep.blockingMessages).toEqual([]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: '/workspace/project',
        model: 'anthropic/sonnet',
        runtimeOnly: false,
        expectedMembers: [],
      })
    );
  });

  it('never promotes a previous launch snapshot when the catalog reader is missing', async () => {
    const adapter = createAdapter({ prepare: vi.fn(), availableModels: ['anthropic/sonnet'] });
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      cwd: '/workspace/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });
    expect(result.blockingMessages).toHaveLength(1);
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.getLastOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
  });

  it('reads a fresh catalog for each project instead of reusing another project snapshot', async () => {
    const adapter = createAdapter({ prepare: vi.fn(), availableModels: ['anthropic/sonnet'] });
    adapter.readProviderStatus
      .mockResolvedValueOnce(openCodeProviderStatus(['anthropic/sonnet']))
      .mockResolvedValueOnce(openCodeProviderStatus(['anthropic/haiku']));
    const first = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/sandbox/first',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });
    const second = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/sandbox/second',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });
    expect(first.blockingMessages).toEqual([]);
    expect(second.blockingMessages).toHaveLength(1);
    expect(adapter.readProviderStatus.mock.calls).toEqual([
      [{ cwd: '/sandbox/first' }],
      [{ cwd: '/sandbox/second' }],
    ]);
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it('keeps deep execution separate and invokes its strict adapter once', async () => {
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      modelId: 'anthropic/sonnet',
      diagnostics: [],
      warnings: [],
    });
    const adapter = createAdapter({ prepare });
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/sandbox/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'deep',
    });
    expect(result.blockingMessages).toEqual([]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runtimeOnly: false, model: 'anthropic/sonnet' })
    );
    expect(adapter.readProviderStatus).not.toHaveBeenCalled();
  });

  it('blocks selected route access failures in an otherwise healthy catalog', async () => {
    const adapter = createAdapter({ prepare: vi.fn(), availableModels: ['anthropic/sonnet'] });
    const provider = openCodeProviderStatus(['anthropic/sonnet']);
    provider.modelCatalog!.models[0].metadata = {
      opencode: {
        providerId: 'anthropic',
        modelId: 'sonnet',
        sourceLabel: null,
        accessKind: 'not_authenticated',
        routeKind: 'connected_provider',
        proofState: 'failed',
        requiresExecutionProof: true,
        reason: 'Credentials revoked',
      },
    };
    adapter.readProviderStatus.mockResolvedValue(provider);
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['anthropic/sonnet'],
      verificationMode: 'compatibility',
    });
    expect(result.blockingMessages).toEqual(['Credentials revoked']);
    expect(adapter.prepare).not.toHaveBeenCalled();
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
        readProviderStatus: adapter.readProviderStatus,
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

  it('reads catalog without starting a host when Cursor and cloud models are selected', async () => {
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
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['cursor-acp/auto', 'openrouter/qwen/qwen3-coder'],
      verificationMode: 'compatibility',
    });

    expect(prepare).not.toHaveBeenCalled();
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
      readProviderStatus: adapter.readProviderStatus,
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

    adapter.readProviderStatus.mockResolvedValue({
      ...openCodeProviderStatus(['anthropic/claude-sonnet']),
      authenticated: false,
    });
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter,
      readProviderStatus: adapter.readProviderStatus,
      cwd: '/workspace/project',
      modelIds: ['local-lab/team-model', 'anthropic/claude-sonnet'],
      verificationMode: 'compatibility',
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(result.blockingMessages).toHaveLength(1);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'catalog_unavailable', severity: 'blocking' }),
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
      readProviderStatus: adapter.readProviderStatus,
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

  it('blocks expired OAuth despite busy and cached-proof notes from the same execution probe', async () => {
    const authFailure =
      'Latest assistant message failed with UnknownError - Token refresh failed: 401';
    const prepare = vi.fn<TeamLaunchRuntimeAdapter['prepare']>().mockResolvedValue({
      ok: false,
      providerId: 'opencode',
      reason: 'not_authenticated',
      retryable: true,
      diagnostics: [
        'OpenCode session status busy',
        authFailure,
        'OpenCode retry/error payload exposed a terminal provider failure before polling completed in 5490ms',
        'opencode_app_mcp_tool_proof_persisted_cache_hit',
        'Token refresh failed: 401',
      ],
      warnings: [],
    });
    const result = await prepareSelectedOpenCodeModelsForProvisioning({
      adapter: createAdapter({ prepare }),
      cwd: '/sandbox/project',
      modelIds: ['openai/gpt-5.4'],
      verificationMode: 'deep',
    });
    expect(result.blockingMessages).toEqual(['Token refresh failed: 401']);
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'not_authenticated',
        scope: 'provider',
        severity: 'blocking',
        message: 'Token refresh failed: 401',
      }),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
      readProviderStatus: adapter.readProviderStatus,
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
