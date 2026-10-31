import { describe, expect, it } from 'vitest';

import {
  findOpenCodeModelsBlockedOnV2,
  readLoadedOpenCodeV2Catalog,
} from '../../../../src/features/runtime-provider-management/core/domain/openCodeV2ModelCatalog';

import type { CliProviderStatus } from '../../../../src/shared/types';

const V1_KIMI = 'kimi-for-coding/kimi-for-coding';

/** A V2 model_only status as main and the renderer project it: catalog stale, refresh error. */
function v2Status(models: string[]): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    canLoginFromUi: false,
    models,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'unsupported', ownership: 'provider-scoped' },
        skills: { status: 'unsupported', ownership: 'provider-scoped' },
        apiKeys: { status: 'unsupported', ownership: 'provider-scoped' },
      },
    },
    modelCatalogRefreshState: 'error',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'stale',
      fetchedAt: '2026-10-30T18:20:00.000Z',
      staleAt: '2026-10-30T18:20:00.000Z',
      defaultModelId: null,
      defaultLaunchModel: null,
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
        message: 'capabilities_pending',
        code: 'capabilities_pending',
      },
      models: models.map((id) => ({
        id,
        launchModel: id,
        displayName: id,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      })),
    },
  };
}

function blocked(
  provider: CliProviderStatus,
  modelIds: string[],
  generation: 'v1' | 'v2' = 'v2'
): Record<string, string> {
  return Object.fromEntries(
    findOpenCodeModelsBlockedOnV2({
      generation,
      catalog: readLoadedOpenCodeV2Catalog(provider),
      modelIds,
    }).map((entry) => [entry.modelId, entry.reason])
  );
}

describe('findOpenCodeModelsBlockedOnV2', () => {
  it('tells to pick the listed V2 Kimi route for a V1 Kimi id', () => {
    expect(blocked(v2Status(['kimi-code-plan-global/kimi-for-coding']), [V1_KIMI])).toEqual({
      [V1_KIMI]:
        'Kimi Code Membership uses a different provider id in OpenCode V2 ' +
        '(kimi-code-plan-cn / kimi-code-plan-global), so this V1 model id cannot run there. ' +
        'Pick its model under kimi-code-plan-global in the V2 catalog instead.',
    });
  });

  it('tells to connect Kimi on V2 when no Kimi route is in the catalog', () => {
    expect(blocked(v2Status(['opencode/big-pickle']), [V1_KIMI])).toEqual({
      [V1_KIMI]:
        'Kimi Code Membership uses a different provider id in OpenCode V2 ' +
        '(kimi-code-plan-cn / kimi-code-plan-global), so this V1 model id cannot run there. ' +
        'Connect Kimi Code Membership for OpenCode V2 in the provider settings ' +
        '(kimi.com or kimi.ai), then pick its model.',
    });
  });

  it('blocks a model missing from a provider the catalog lists', () => {
    expect(blocked(v2Status(['zai-coding-plan/glm-5.1']), ['zai-coding-plan/glm-9'])).toEqual({
      'zai-coding-plan/glm-9':
        'OpenCode V2 lists the provider zai-coding-plan, but not this model. ' +
        'Pick one of its models from the V2 catalog.',
    });
  });

  it('leaves every case it cannot prove to deep verification', () => {
    const status = v2Status([
      'kimi-code-plan-global/kimi-for-coding',
      'openrouter/anthropic/claude-sonnet-5',
      'qwen/qwen3-coder',
      'zai-coding-plan/glm-5.1',
      'ollama/llama3',
    ]);
    expect(
      blocked(status, [
        'kimi-code-plan-global/kimi-for-coding', // listed
        'zai-coding-plan/glm-5.1', // listed
        'openrouter/qwen/qwen3-coder', // listed provider, OpenRouter equivalent is listed
        'anthropic/claude-sonnet-5', // provider unknown to the catalog
        'kimi-code-plan-cn/kimi-for-coding', // V2 route not in the catalog, not a V1 plan id
        'ollama/qwen3-coder', // local route, even with its provider listed
        'kimi-for-coding', // unqualified
      ])
    ).toEqual({});
  });

  it('judges nothing on V1 or when the status cannot say the V2 catalog was read', () => {
    const listed = ['kimi-code-plan-global/kimi-for-coding'];
    const cases: Array<[string, CliProviderStatus | null, 'v1' | 'v2']> = [
      ['V1 runtime', v2Status(listed), 'v1'],
      ['no status', null, 'v2'],
      ['empty catalog', v2Status([]), 'v2'],
      [
        'status error code',
        { ...v2Status(listed), statusCheckErrorCode: 'partial_response' },
        'v2',
      ],
      ['not model_only', { ...v2Status(listed), statusCheckOutcome: 'transient_error' }, 'v2'],
      ['unsupported', { ...v2Status(listed), supported: false }, 'v2'],
      [
        'failed read',
        {
          ...v2Status(listed),
          modelCatalog: {
            ...v2Status(listed).modelCatalog!,
            diagnostics: { configReadState: 'failed', appServerState: 'incompatible' },
          },
        },
        'v2',
      ],
      ['no catalog', { ...v2Status(listed), modelCatalog: null }, 'v2'],
    ];
    for (const [name, status, generation] of cases) {
      expect({
        name,
        blocked: blocked(status as CliProviderStatus, [V1_KIMI], generation),
      }).toEqual({ name, blocked: {} });
    }
  });
});
