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
});
