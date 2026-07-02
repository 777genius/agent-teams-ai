import { describe, expect, it, vi } from 'vitest';

import {
  buildAgentTeamsMcpValidationError,
  buildRuntimeProviderReadinessWarning,
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

    const cache = { output: null, cachedAtMs: 0 };
    const ports = {
      getCachedOrProbeResult: vi.fn().mockResolvedValue({ claudePath: '/fake/claude' }),
      buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { PATH: '/bin' } }),
      spawnProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Usage', stderr: 'Flags' }),
    };

    await expect(
      getCliHelpOutputForProvisioning({
        cwd: '/repo',
        cache,
        ports,
        now: () => 1000,
      })
    ).resolves.toBe('Usage\nFlags');

    ports.spawnProbe.mockClear();
    await expect(
      getCliHelpOutputForProvisioning({
        cwd: '/repo',
        cache,
        ports,
        now: () => 1001,
      })
    ).resolves.toBe('Usage\nFlags');
    expect(ports.spawnProbe).not.toHaveBeenCalled();
  });
});
