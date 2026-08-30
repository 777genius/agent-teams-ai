import { describe, expect, it, vi } from 'vitest';

import {
  buildAgentTeamsMcpValidationError,
  buildRuntimeProviderReadinessWarning,
  type CliHelpOutputPorts,
  extractAuthStatusReadiness,
  getCliHelpOutputForProvisioning,
  resolveProviderCompatibilityModel,
  verifySelectedProviderModelsForProvisioning,
} from '../TeamProvisioningProviderPreflight';

import type { RuntimeProviderLaunchFacts } from '../TeamProvisioningRuntimeLaunchSelection';

function buildRuntimeFacts(
  overrides: Partial<RuntimeProviderLaunchFacts> = {}
): RuntimeProviderLaunchFacts {
  return {
    defaultModel: 'default-model',
    modelIds: new Set(['default-model', 'provider/known-model']),
    modelListParsed: true,
    modelCatalog: null,
    runtimeCapabilities: null,
    providerStatus: null,
    ...overrides,
  };
}

describe('provider preflight model compatibility', () => {
  it('resolves exact and unambiguous provider-scoped model ids', () => {
    const facts = buildRuntimeFacts();

    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'provider/known-model',
        runtimeFacts: facts,
        limitContext: false,
      })
    ).toEqual({ kind: 'available', resolvedModelId: 'provider/known-model' });

    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'known-model',
        runtimeFacts: facts,
        limitContext: false,
      })
    ).toEqual({ kind: 'available', resolvedModelId: 'provider/known-model' });
  });

  it('keeps dynamic Codex catalogs launch-compatible without blocking unknown models', () => {
    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'new-codex-model',
        runtimeFacts: buildRuntimeFacts({
          modelIds: new Set(),
          runtimeCapabilities: { modelCatalog: { dynamic: true } },
        }),
        limitContext: false,
      })
    ).toEqual({ kind: 'available', resolvedModelId: 'new-codex-model' });
  });

  it('blocks stale Codex selections when a dynamic live catalog has current models', () => {
    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'gpt-5.4-mini',
        runtimeFacts: buildRuntimeFacts({
          defaultModel: 'gpt-5.6-sol',
          modelIds: new Set(['gpt-5.6-sol', 'gpt-5.6-terra']),
          runtimeCapabilities: { modelCatalog: { dynamic: true } },
        }),
        limitContext: false,
      })
    ).toEqual({
      kind: 'unavailable',
      reason: 'Selected model gpt-5.4-mini was not found in the live provider catalog.',
    });
  });

  it('blocks catalog-listed Codex models the runtime reports as ChatGPT-unsupported', () => {
    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'gpt-5.2',
        runtimeFacts: buildRuntimeFacts({
          defaultModel: 'gpt-5.6-sol',
          modelIds: new Set(['gpt-5.6-sol', 'gpt-5.2']),
          providerStatus: {
            providerId: 'codex',
            authMethod: 'chatgpt',
            modelAvailability: [
              {
                modelId: 'gpt-5.2',
                status: 'unavailable',
                reason:
                  "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.",
              },
            ],
          },
        }),
        limitContext: false,
      })
    ).toEqual({
      kind: 'unavailable',
      reason:
        "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account. " +
        'Switch Codex authentication to an API key or pick a ChatGPT-supported Codex model.',
    });
  });

  it('blocks ambiguous scoped matches and authoritative catalog misses', () => {
    expect(
      resolveProviderCompatibilityModel({
        providerId: 'codex',
        requestedModelId: 'same',
        runtimeFacts: buildRuntimeFacts({
          modelIds: new Set(['a/same', 'b/same']),
        }),
        limitContext: false,
      })
    ).toEqual({
      kind: 'unavailable',
      reason: 'Selected model same matched multiple live provider models: a/same, b/same',
    });

    expect(
      resolveProviderCompatibilityModel({
        providerId: 'anthropic',
        requestedModelId: 'missing-model',
        runtimeFacts: buildRuntimeFacts(),
        limitContext: false,
      })
    ).toEqual({
      kind: 'unavailable',
      reason: 'Selected model missing-model was not found in the live provider catalog.',
    });
  });
});

describe('provider model verification normalization', () => {
  it('deduplicates checks and reports available and unavailable model outcomes', async () => {
    const debugEvents: string[] = [];
    const buildProvisioningEnv = vi.fn().mockResolvedValue({ env: { PATH: '/bin' } });
    const readRuntimeProviderLaunchFacts = vi.fn().mockResolvedValue(
      buildRuntimeFacts({
        modelIds: new Set(['available-model']),
      })
    );

    const result = await verifySelectedProviderModelsForProvisioning({
      claudePath: '/fake/claude',
      cwd: '/repo',
      providerId: 'codex',
      modelIds: ['available-model', 'missing-model', 'missing-model'],
      limitContext: false,
      ports: {
        buildProvisioningEnv,
        readRuntimeProviderLaunchFacts,
        appendPreflightDebugLog: (event) => debugEvents.push(event),
      },
    });

    expect(buildProvisioningEnv).toHaveBeenCalledOnce();
    expect(readRuntimeProviderLaunchFacts).toHaveBeenCalledWith({
      claudePath: '/fake/claude',
      cwd: '/repo',
      providerId: 'codex',
      env: { PATH: '/bin' },
      providerArgs: [],
      limitContext: false,
    });
    expect(result.details).toEqual(['Selected model available-model is available for launch.']);
    expect(result.blockingMessages).toEqual([
      'Selected model missing-model is unavailable. Selected model missing-model was not found in the live provider catalog.',
    ]);
    expect(result.issues).toEqual([
      {
        providerId: 'codex',
        modelId: 'missing-model',
        scope: 'model',
        severity: 'blocking',
        code: 'model_unavailable',
        message: 'Selected model missing-model was not found in the live provider catalog.',
      },
    ]);
    expect(debugEvents).toEqual([
      'provider_model_catalog_check_start',
      'provider_model_catalog_check_complete',
    ]);
  });

  it('fails the model check when the deep ChatGPT probe reports the selection unsupported', async () => {
    const chatGptFacts = buildRuntimeFacts({
      defaultModel: 'gpt-5.6-sol',
      modelIds: new Set(['gpt-5.6-sol', 'gpt-5.2']),
      providerStatus: { providerId: 'codex', authMethod: 'chatgpt' },
    });
    const probeCodexChatGptModelSupport = vi.fn().mockResolvedValue({
      outcome: 'unsupported',
      message: "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.",
    });

    const result = await verifySelectedProviderModelsForProvisioning({
      claudePath: '/fake/claude',
      cwd: '/repo',
      providerId: 'codex',
      modelIds: ['gpt-5.2', 'gpt-5.2'],
      limitContext: false,
      modelVerificationMode: 'deep',
      ports: {
        buildProvisioningEnv: vi
          .fn()
          .mockResolvedValue({ env: { PATH: '/bin' }, providerArgs: ['--provider-arg'] }),
        readRuntimeProviderLaunchFacts: vi.fn().mockResolvedValue(chatGptFacts),
        appendPreflightDebugLog: () => undefined,
        probeCodexChatGptModelSupport,
      },
    });

    expect(probeCodexChatGptModelSupport).toHaveBeenCalledOnce();
    expect(probeCodexChatGptModelSupport).toHaveBeenCalledWith({
      claudePath: '/fake/claude',
      cwd: '/repo',
      env: { PATH: '/bin' },
      providerArgs: ['--provider-arg'],
      modelId: 'gpt-5.2',
    });
    expect(result.blockingMessages).toEqual([
      'Selected model gpt-5.2 is unavailable. ' +
        "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account. " +
        'Switch Codex authentication to an API key or pick a ChatGPT-supported Codex model.',
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        providerId: 'codex',
        modelId: 'gpt-5.2',
        severity: 'blocking',
        code: 'model_unavailable',
      }),
    ]);
  });

  it('skips the ChatGPT probe outside ChatGPT auth or outside deep verification', async () => {
    const probeCodexChatGptModelSupport = vi.fn();
    const buildVerifyInput = (
      authMethod: string,
      modelVerificationMode?: 'compatibility' | 'deep'
    ) => ({
      claudePath: '/fake/claude',
      cwd: '/repo',
      providerId: 'codex' as const,
      modelIds: ['gpt-5.2'],
      limitContext: false,
      ...(modelVerificationMode ? { modelVerificationMode } : {}),
      ports: {
        buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { PATH: '/bin' } }),
        readRuntimeProviderLaunchFacts: vi.fn().mockResolvedValue(
          buildRuntimeFacts({
            defaultModel: 'gpt-5.6-sol',
            modelIds: new Set(['gpt-5.6-sol', 'gpt-5.2']),
            providerStatus: { providerId: 'codex', authMethod },
          })
        ),
        appendPreflightDebugLog: () => undefined,
        probeCodexChatGptModelSupport,
      },
    });

    const apiKeyResult = await verifySelectedProviderModelsForProvisioning(
      buildVerifyInput('api_key', 'deep')
    );
    const compatibilityResult = await verifySelectedProviderModelsForProvisioning(
      buildVerifyInput('chatgpt', 'compatibility')
    );

    expect(probeCodexChatGptModelSupport).not.toHaveBeenCalled();
    expect(apiKeyResult.blockingMessages).toEqual([]);
    expect(apiKeyResult.details).toEqual(['Selected model gpt-5.2 is available for launch.']);
    expect(compatibilityResult.blockingMessages).toEqual([]);
    expect(compatibilityResult.details).toEqual([
      'Selected model gpt-5.2 is available for launch.',
    ]);
  });
});

describe('provider runtime readiness normalization', () => {
  it('normalizes runtime status and auth fallback readiness', () => {
    expect(
      buildRuntimeProviderReadinessWarning('codex', {
        authenticated: false,
        statusMessage: 'Login required',
        detailMessage: 'Run auth login',
      })
    ).toBe('Codex provider is not authenticated. Login required Run auth login');

    expect(
      extractAuthStatusReadiness('codex', {
        loggedIn: true,
        providers: {
          codex: { authenticated: false },
        },
      })
    ).toEqual({
      authenticated: false,
      providerStatus: { authenticated: false },
    });
  });

  it('builds normalized MCP validation errors and CLI help cache results', async () => {
    expect(
      buildAgentTeamsMcpValidationError('api error: 429 retry later', (text) =>
        text.replace(/^api error:\s*\d+\s*/i, '').trim()
      )
    ).toBe('agent-teams MCP preflight failed before team launch. Details: retry later');

    const normalizedError =
      'agent-teams MCP preflight failed before team launch. Details: retry later';
    expect(buildAgentTeamsMcpValidationError(normalizedError, (text) => `normalized:${text}`)).toBe(
      normalizedError
    );

    const cache = { output: null, cachedAtMs: 0 };
    const spawnProbe = vi
      .fn<CliHelpOutputPorts['spawnProbe']>()
      .mockResolvedValue({ exitCode: 0, stdout: 'Usage', stderr: 'Flags' });
    const ports: CliHelpOutputPorts = {
      getCachedOrProbeResult: vi.fn().mockResolvedValue({ claudePath: '/fake/claude' }),
      buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { PATH: '/bin' } }),
      spawnProbe,
    };

    await expect(
      getCliHelpOutputForProvisioning({
        cwd: '/repo',
        cache,
        ports,
        now: () => 1000,
      })
    ).resolves.toBe('Usage\nFlags');

    spawnProbe.mockClear();
    await expect(
      getCliHelpOutputForProvisioning({
        cwd: '/repo',
        cache,
        ports,
        now: () => 1001,
      })
    ).resolves.toBe('Usage\nFlags');
    expect(spawnProbe).not.toHaveBeenCalled();
  });
});
