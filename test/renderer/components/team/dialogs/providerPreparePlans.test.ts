import { buildProviderPreparePlans } from '@renderer/components/team/dialogs/providerPreparePlans';
import { describe, expect, it } from 'vitest';

import type {
  CliProviderStatus,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';

type RuntimeSignatureProvider = {
  providerId: TeamProviderId;
  [key: string]: unknown;
};

function providerStatusMap(
  entries: readonly (readonly [TeamProviderId, RuntimeSignatureProvider])[]
): ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined> {
  return new Map(entries) as unknown as ReadonlyMap<
    TeamProviderId,
    CliProviderStatus | null | undefined
  >;
}

function modelChecksMap(
  entries: readonly (readonly [TeamProviderId, readonly TeamProvisioningModelCheckRequest[]])[]
): ReadonlyMap<TeamProviderId, readonly TeamProvisioningModelCheckRequest[]> {
  return new Map(entries);
}

describe('providerPreparePlans', () => {
  it('separates cache and request identity by backend checks and override decision', () => {
    const base = {
      cwd: '/tmp/project',
      providerIds: ['codex' as const],
      backendSummaryByProvider: new Map([['codex' as const, 'Codex']]),
      limitContext: false,
      runtimeProviderStatusById: providerStatusMap([]),
      cachedModelResultsByCacheKey: new Map(),
    };
    const plan = (providerBackendId: 'adapter' | 'codex-native', allow = false) =>
      buildProviderPreparePlans({
        ...base,
        selectedModelChecksByProvider: modelChecksMap([
          ['codex', [{ providerId: 'codex', providerBackendId, model: 'gpt-5', effort: 'high' }]],
        ]),
        allowExperimentalLocalModels: allow,
      })[0];
    expect(plan('adapter').cacheKey).not.toBe(plan('codex-native').cacheKey);
    expect(plan('adapter').requestSignature).not.toBe(plan('adapter', true).requestSignature);
    expect(plan('adapter').cacheKey).not.toBe(plan('adapter', true).cacheKey);
  });

  it('keeps unchanged provider signatures and cache keys stable when another provider changes', () => {
    const providerIds: TeamProviderId[] = ['codex', 'opencode'];
    const selectedModelChecksByProvider = modelChecksMap([
      ['codex', [{ providerId: 'codex', model: 'gpt-5.5' }]],
      ['opencode', [{ providerId: 'opencode', model: 'opencode/big-pickle' }]],
    ]);
    const backendSummaryByProvider = new Map<TeamProviderId, string | null>([
      ['codex', 'Codex native'],
      ['opencode', 'OpenCode CLI'],
    ]);
    const first = buildProviderPreparePlans({
      cwd: '/tmp/project',
      providerIds,
      selectedModelChecksByProvider,
      backendSummaryByProvider,
      limitContext: false,
      runtimeProviderStatusById: providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: true,
            authMethod: 'chatgpt',
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
          },
        ],
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
          },
        ],
      ]),
      cachedModelResultsByCacheKey: new Map(),
    });
    const second = buildProviderPreparePlans({
      cwd: '/tmp/project',
      providerIds,
      selectedModelChecksByProvider,
      backendSummaryByProvider,
      limitContext: false,
      runtimeProviderStatusById: providerStatusMap([
        [
          'codex',
          {
            providerId: 'codex',
            supported: true,
            authenticated: false,
            authMethod: null,
            selectedBackendId: 'codex-native',
            resolvedBackendId: 'codex-native',
          },
        ],
        [
          'opencode',
          {
            providerId: 'opencode',
            supported: true,
            authenticated: true,
            authMethod: 'oauth',
            selectedBackendId: 'opencode-cli',
            resolvedBackendId: 'opencode-cli',
          },
        ],
      ]),
      cachedModelResultsByCacheKey: new Map(),
    });

    const firstByProvider = new Map(first.map((plan) => [plan.providerId, plan]));
    const secondByProvider = new Map(second.map((plan) => [plan.providerId, plan]));

    expect(firstByProvider.get('codex')?.requestSignature).not.toBe(
      secondByProvider.get('codex')?.requestSignature
    );
    expect(firstByProvider.get('opencode')?.requestSignature).toBe(
      secondByProvider.get('opencode')?.requestSignature
    );
    expect(firstByProvider.get('opencode')?.cacheKey).toBe(
      secondByProvider.get('opencode')?.cacheKey
    );
  });

  it('does not reuse a terminal model result across provider proof generations', () => {
    const input = {
      cwd: '/tmp/project',
      providerIds: ['opencode' as const],
      selectedModelChecksByProvider: modelChecksMap([
        [
          'opencode',
          [
            {
              providerId: 'opencode',
              providerBackendId: 'opencode-cli',
              model: 'openrouter/qwen',
            },
          ],
        ],
      ]),
      backendSummaryByProvider: new Map([['opencode' as const, 'OpenCode CLI']]),
      limitContext: false,
      runtimeProviderStatusById: providerStatusMap([
        ['opencode', { providerId: 'opencode', supported: true, authenticated: true }],
      ]),
      cachedModelResultsByCacheKey: new Map(),
    };
    const first = buildProviderPreparePlans({
      ...input,
      runtimeProviderGenerationById: new Map([['opencode', 'epoch-1:request-1']]),
    })[0]!;
    const second = buildProviderPreparePlans({
      ...input,
      runtimeProviderGenerationById: new Map([['opencode', 'epoch-1:request-2']]),
    })[0]!;

    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.requestSignature).toBe(first.requestSignature);
  });
});
