import {
  canSkipOptionalProviderPreflight,
  canSkipPendingProviderDiscovery,
  canSkipProviderPreflight,
  createProviderSubmissionFence,
  getPendingProviderPreflightIds,
  resumeInterruptedProviderPreflight,
} from '@renderer/components/team/dialogs/optionalProviderPreflight';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProvisioningProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import type {
  CliProviderStatus,
  TeamProviderId,
  TeamProvisioningPrepareResult,
} from '@shared/types';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
function provider(providerId: TeamProviderId): CliProviderStatus {
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: true,
    authMethod: 'test',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    statusMessage: null,
    detailMessage: null,
    models: ['model'],
    modelAvailability: [],
    modelCatalogRefreshState: 'ready',
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(NOW - 1000).toISOString(),
      staleAt: new Date(NOW + 1000).toISOString(),
      defaultModelId: 'model',
      defaultLaunchModel: 'model',
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: [
        {
          id: 'model',
          launchModel: 'model',
          displayName: 'Model',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
    },
  };
}
const check = (
  providerId: TeamProviderId,
  status: ProvisioningProviderCheck['status']
): ProvisioningProviderCheck => ({ providerId, status, details: [] });

describe('optional provider preflight skip', () => {
  afterEach(() => vi.useRealTimers());
  function refreshingCodex(catalog: 'missing' | 'stale' = 'stale'): CliProviderStatus {
    return {
      ...provider('codex'),
      models: ['gpt-5.6-luna'],
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
      modelCatalogRefreshState: 'loading',
      modelCatalog:
        catalog === 'missing' ? null : { ...provider('codex').modelCatalog!, status: 'stale' },
    };
  }
  it.each(['missing', 'stale'] as const)(
    'allows optional Codex skip with %s catalog and ready selected-model check',
    (catalog) => {
      for (const provenance of ['runtime', 'restriction'] as const) {
        const source = refreshingCodex(catalog);
        if (provenance === 'restriction') {
          source.capabilities.teamLaunch = false;
          source.teamLaunchAuthorityRestriction = 'catalog-refresh';
        }
        const effective = {
          ...source,
          capabilities: { ...source.capabilities, teamLaunch: false },
        };
        for (const state of ['idle', 'loading', 'ready'] as const) {
          expect(
            canSkipProviderPreflight(
              state,
              ['codex'],
              new Map([['codex', effective]]),
              new Map([['codex', false]]),
              [check('codex', 'ready')],
              NOW,
              [source]
            )
          ).toBe(true);
        }
        expect(hasEffectiveProviderLaunchAuthority(effective, NOW)).toBe(false);
      }
    }
  );
  it.each([
    'missing-source',
    'unsupported',
    'failed-check',
    'auth-error',
    'runtime-error',
    'catalog-error',
    'settled-stale',
  ] as const)('blocks Codex refresh bypass for %s', (failure) => {
    const source = refreshingCodex();
    if (failure === 'unsupported') source.capabilities.teamLaunch = false;
    if (failure === 'auth-error') source.authenticated = false;
    if (failure === 'runtime-error') source.statusCheckErrorCode = 'unavailable';
    if (failure === 'catalog-error') source.modelCatalogRefreshState = 'error';
    if (failure === 'settled-stale') source.modelCatalogRefreshState = 'ready';
    const effective = { ...source, capabilities: { ...source.capabilities, teamLaunch: false } };
    expect(
      canSkipProviderPreflight(
        'ready',
        ['codex'],
        new Map([['codex', effective]]),
        new Map(),
        [check('codex', failure === 'failed-check' ? 'failed' : 'ready')],
        NOW,
        failure === 'missing-source' ? [] : [source]
      )
    ).toBe(false);
  });
  it.each([
    { authenticated: false },
    { statusCheckErrorCode: 'unavailable' as const },
  ])('rejects effective Codex failure despite valid source refresh provenance: %j', (override) => {
    const source = refreshingCodex();
    source.capabilities.teamLaunch = false;
    source.teamLaunchAuthorityRestriction = 'catalog-refresh';
    const effective = { ...source, ...override };
    expect(
      canSkipProviderPreflight(
        'ready',
        ['codex'],
        new Map([['codex', effective]]),
        new Map(),
        [check('codex', 'ready')],
        NOW,
        [source]
      )
    ).toBe(false);
  });
  it('allows both authenticated native providers to refresh simultaneously', () => {
    const { source: anthropic, statuses, checks } = refreshingAnthropicSelection();
    const codex = refreshingCodex('missing');
    statuses.set('codex', { ...codex, capabilities: { ...codex.capabilities, teamLaunch: false } });
    expect(
      canSkipProviderPreflight('ready', [...statuses.keys()], statuses, new Map(), checks, NOW, [
        anthropic,
        codex,
      ])
    ).toBe(true);
  });
  function refreshingAnthropicSelection(override: Partial<CliProviderStatus> = {}) {
    const source = {
      ...provider('anthropic'),
      modelCatalogRefreshState: 'loading' as const,
      modelCatalog: {
        ...provider('anthropic').modelCatalog!,
        staleAt: new Date(NOW - 1).toISOString(),
      },
      ...override,
    };
    return {
      source,
      statuses: new Map<TeamProviderId, CliProviderStatus>([
        ['anthropic', { ...source, capabilities: { ...source.capabilities, teamLaunch: false } }],
        ['codex', provider('codex')],
        ['opencode', provider('opencode')],
      ]),
      checks: [check('anthropic', 'ready'), check('codex', 'ready'), check('opencode', 'ready')],
    };
  }
  it.each(['idle', 'loading', 'ready'] as const)(
    'allows %s skip during a verified Anthropic catalog refresh without replacing completed checks',
    (state) => {
      const { source, statuses, checks } = refreshingAnthropicSelection();
      expect(
        canSkipProviderPreflight(state, [...statuses.keys()], statuses, new Map(), checks, NOW, [
          source,
        ])
      ).toBe(true);
      expect(checks.every((entry) => entry.status === 'ready')).toBe(true);
    }
  );
  it.each([
    { authenticated: false },
    { supported: false },
    { verificationState: 'error' as const },
    { capabilities: { ...provider('anthropic').capabilities, teamLaunch: false } },
    { statusCheckErrorCode: 'unavailable' as const },
    { statusCheckErrorCode: 'runtime_missing' as const },
    { modelCatalogRefreshState: 'error' as const },
    { modelCatalogRefreshState: 'ready' as const },
    { modelCatalog: { ...provider('anthropic').modelCatalog!, status: 'unavailable' as const } },
  ])('does not bypass Anthropic failure or expiry without refresh: %j', (override) => {
    const { source, statuses, checks } = refreshingAnthropicSelection(override);
    for (const state of ['loading', 'ready'] as const)
      expect(
        canSkipProviderPreflight(state, [...statuses.keys()], statuses, new Map(), checks, NOW, [
          source,
        ])
      ).toBe(false);
  });
  it.each(['pending', 'transient_error'] as const)(
    'allows mixed Anthropic refresh plus %s/partial_response discovery, including a previously ready check',
    (statusCheckOutcome) => {
      for (const state of ['idle', 'loading', 'ready'] as const) {
        const { source, statuses, checks } = refreshingAnthropicSelection();
        statuses.set('codex', {
          ...provider('codex'),
          authenticated: false,
          verificationState: 'unknown',
          statusCheckOutcome,
          statusCheckErrorCode: 'partial_response',
          modelCatalog: null,
          capabilities: { ...provider('codex').capabilities, teamLaunch: false },
        });
        for (const status of ['pending', 'ready'] as const) {
          checks[1].status = status;
          expect(
            canSkipProviderPreflight(
              state,
              [...statuses.keys()],
              statuses,
              new Map(),
              checks,
              NOW,
              [source]
            )
          ).toBe(true);
        }
      }
    }
  );
  it.each([
    { authenticated: false },
    { verificationState: 'error' as const },
    { statusCheckErrorCode: 'runtime_missing' as const },
    { statusCheckErrorCode: 'unavailable' as const },
    { modelCatalogRefreshState: 'error' as const },
    {
      statusCheckOutcome: 'pending' as const,
      statusCheckErrorCode: 'partial_response' as const,
      modelCatalogRefreshState: 'error' as const,
    },
  ])('blocks mixed secondary provider failure even with discovery loading: %j', (override) => {
    const { source, statuses, checks } = refreshingAnthropicSelection();
    statuses.set('codex', { ...provider('codex'), ...override });
    expect(
      canSkipProviderPreflight(
        'loading',
        [...statuses.keys()],
        statuses,
        new Map([['codex', true]]),
        checks,
        NOW,
        [source]
      )
    ).toBe(false);
  });
  it.each(['pending', 'ready'] as const)(
    'blocks settled stale secondary authority despite a %s check during Anthropic refresh',
    (checkStatus) => {
      const { source, statuses, checks } = refreshingAnthropicSelection();
      statuses.get('codex')!.modelCatalog!.staleAt = new Date(NOW - 1).toISOString();
      checks[1].status = checkStatus;
      expect(
        canSkipProviderPreflight(
          'loading',
          [...statuses.keys()],
          statuses,
          new Map(),
          checks,
          NOW,
          [source]
        )
      ).toBe(false);
    }
  );
  it('blocks a failed secondary model check even when its provider discovery is pending', () => {
    const { source, statuses, checks } = refreshingAnthropicSelection();
    statuses.get('codex')!.statusCheckOutcome = 'pending';
    checks[1].status = 'failed';
    expect(
      canSkipProviderPreflight('loading', [...statuses.keys()], statuses, new Map(), checks, NOW, [
        source,
      ])
    ).toBe(false);
  });
  it.each(['failed-model', 'other-expired', 'missing-source', 'failed-state'] as const)(
    'does not bypass %s during Anthropic refresh',
    (failure) => {
      const { source, statuses, checks } = refreshingAnthropicSelection();
      if (failure === 'failed-model') checks[0].status = 'failed';
      if (failure === 'other-expired')
        statuses.get('codex')!.modelCatalog!.staleAt = new Date(NOW - 1).toISOString();
      expect(
        canSkipProviderPreflight(
          failure === 'failed-state' ? 'failed' : 'ready',
          [...statuses.keys()],
          statuses,
          new Map(),
          checks,
          NOW,
          failure === 'missing-source' ? [] : [source]
        )
      ).toBe(false);
    }
  );
  it('keeps only the unfinished provider badge checking in a mixed preflight', () => {
    expect(
      getPendingProviderPreflightIds(
        'loading',
        ['anthropic', 'codex', 'opencode'],
        [check('anthropic', 'ready'), check('codex', 'pending'), check('opencode', 'ready')]
      )
    ).toEqual(['codex']);
  });
  it('keeps shallow compatibility checking until its remaining deep work finishes', () => {
    expect(
      getPendingProviderPreflightIds(
        'loading',
        ['anthropic', 'codex', 'opencode'],
        [
          {
            ...check('anthropic', 'checking'),
            details: ['Selected model is available for launch.'],
          },
          check('opencode', 'failed'),
        ]
      )
    ).toEqual(['anthropic', 'codex']);
  });
  it.each(['idle', 'loading'] as const)(
    'allows skipping %s optional checks with a pending partial Codex discovery response',
    (state) => {
      const statuses = new Map<TeamProviderId, CliProviderStatus>([
        ['anthropic', provider('anthropic')],
        [
          'codex',
          {
            ...provider('codex'),
            authenticated: false,
            verificationState: 'unknown',
            statusCheckOutcome: 'pending',
            statusCheckErrorCode: 'partial_response',
            modelCatalog: null,
          },
        ],
        ['opencode', provider('opencode')],
      ]);
      expect(
        canSkipProviderPreflight(
          state,
          [...statuses.keys()],
          statuses,
          new Map(),
          [check('anthropic', 'ready'), check('codex', 'pending'), check('opencode', 'ready')],
          NOW
        )
      ).toBe(true);
    }
  );
  it.each([
    { authenticated: false },
    { supported: false },
    { verificationState: 'error' as const },
    { statusCheckErrorCode: 'runtime_missing' as const },
    { statusCheckErrorCode: 'unavailable' as const },
  ])('never skips a known failure during background loading: %j', (override) => {
    const statuses = new Map([['codex' as const, { ...provider('codex'), ...override }]]);
    const loading = new Map([['codex' as const, true]]);
    expect(canSkipPendingProviderDiscovery(['codex'], statuses, loading, NOW)).toBe(false);
    expect(
      canSkipOptionalProviderPreflight(
        ['codex'],
        statuses,
        loading,
        [check('codex', 'checking')],
        NOW
      )
    ).toBe(false);
  });
  it('allows initial skip when one selected provider is still loading', () => {
    expect(
      canSkipPendingProviderDiscovery(
        ['anthropic', 'opencode'],
        new Map([
          ['anthropic', provider('anthropic')],
          ['opencode', provider('opencode')],
        ]),
        new Map([['opencode', true]]),
        NOW
      )
    ).toBe(true);
  });
  it('does not bypass settled passive model-only discovery', () => {
    expect(
      canSkipPendingProviderDiscovery(
        ['opencode'],
        new Map([
          [
            'opencode',
            {
              ...provider('opencode'),
              statusCheckOutcome: 'model_only' as const,
              modelCatalog: null,
            },
          ],
        ]),
        new Map(),
        NOW
      )
    ).toBe(false);
  });
  it('allows initial skip after a bounded provider discovery timeout', () => {
    expect(
      canSkipPendingProviderDiscovery(
        ['opencode'],
        new Map([
          [
            'opencode',
            {
              ...provider('opencode'),
              authenticated: false,
              statusCheckOutcome: 'transient_error' as const,
              statusCheckErrorCode: 'timeout',
              modelCatalog: null,
            },
          ],
        ]),
        new Map(),
        NOW
      )
    ).toBe(true);
  });
  it('does not label an already ready selection as skippable', () => {
    expect(
      canSkipPendingProviderDiscovery(
        ['anthropic', 'codex'],
        new Map([
          ['anthropic', provider('anthropic')],
          ['codex', provider('codex')],
        ]),
        new Map(),
        NOW
      )
    ).toBe(false);
  });
  it('does not bypass a settled provider failure', () => {
    expect(
      canSkipPendingProviderDiscovery(
        ['codex'],
        new Map([
          [
            'codex',
            {
              ...provider('codex'),
              authenticated: false,
              statusCheckOutcome: 'transient_error' as const,
            },
          ],
        ]),
        new Map(),
        NOW
      )
    ).toBe(false);
  });
  it.each(['pending', 'completed'] as const)(
    'rejoins %s skipped diagnostics without another paid prepare',
    async (state) => {
      const fence = createProviderSubmissionFence();
      let finish!: (value: TeamProvisioningPrepareResult) => void;
      const prepareProvisioning = vi
        .fn<Parameters<typeof fence.runPreflight>[1]['prepareProvisioning']>()
        .mockResolvedValueOnce({
          ready: true,
          message: 'ready',
          details: ['Selected model opus is available for launch.'],
        })
        .mockImplementation(
          () =>
            new Promise<TeamProvisioningPrepareResult>((resolve) => {
              finish = resolve;
            })
        );
      const input = {
        cwd: '/tmp/test-preflight',
        providerId: 'anthropic' as const,
        selectedModelIds: ['opus'],
        prepareProvisioning,
      };
      const identity = { cacheKey: 'fresh-proof', requestSignature: 'same-account-model-cwd' };
      const original = fence.runPreflight(identity, input);
      await Promise.resolve();
      fence.acquire({ current: 0 });
      if (state === 'completed') {
        finish({
          ready: true,
          message: 'ready',
          details: ['Selected model opus is available for launch.'],
        });
        expect((await original).status).toBe('ready');
      }
      fence.release();
      const retry = fence.runPreflight(identity, input);
      expect(retry).toBe(original);
      if (state === 'pending')
        finish({
          ready: true,
          message: 'ready',
          details: ['Selected model opus is available for launch.'],
        });
      expect((await retry).status).toBe('ready');
      expect(prepareProvisioning).toHaveBeenCalledTimes(2);
      expect(prepareProvisioning.mock.calls.filter((call) => call[5] === 'deep')).toHaveLength(1);
    }
  );
  it.each(['cacheKey', 'requestSignature', 'expired'] as const)(
    'does not reuse skipped results across %s',
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const fence = createProviderSubmissionFence();
      const prepareProvisioning = vi.fn(async () => ({ ready: true, message: 'ready' }));
      const input = {
        cwd: '/tmp/test-preflight',
        providerId: 'anthropic' as const,
        selectedModelIds: [],
        prepareProvisioning,
      };
      const identity = { cacheKey: 'proof', requestSignature: 'account-model-cwd' };
      const original = fence.runPreflight(identity, input);
      fence.acquire({ current: 0 });
      await original;
      fence.release();
      if (change === 'expired') vi.setSystemTime(NOW + 45_000);
      const nextIdentity =
        change === 'cacheKey' || change === 'requestSignature'
          ? { ...identity, [change]: 'changed' }
          : identity;
      await fence.runPreflight(nextIdentity, input);
      expect(prepareProvisioning).toHaveBeenCalledTimes(2);
    }
  );
  it('rejoins skipped OpenCode diagnostics with the same exact proof identity', async () => {
    const fence = createProviderSubmissionFence();
    const prepareProvisioning = vi.fn(async () => ({ ready: true, message: 'ready' }));
    const input = {
      cwd: '/tmp/test-preflight',
      providerId: 'opencode' as const,
      selectedModelIds: [],
      prepareProvisioning,
    };
    const identity = { cacheKey: 'proof', requestSignature: 'account-model-cwd' };
    const original = fence.runPreflight(identity, input);
    fence.acquire({ current: 0 });
    await original;
    fence.release();
    expect(fence.runPreflight(identity, input)).toBe(original);
    expect(prepareProvisioning).toHaveBeenCalledOnce();
  });
  it.each(['anthropic', 'codex', 'opencode'] as const)(
    'allows optional %s checking only with strict current authority',
    (id) => {
      expect(
        canSkipOptionalProviderPreflight(
          [id],
          new Map([[id, provider(id)]]),
          new Map(),
          [check(id, 'checking')],
          NOW
        )
      ).toBe(true);
    }
  );
  it.each([
    { authenticated: false },
    { statusCheckOutcome: 'transient_error' as const },
    { modelCatalog: null },
    { capabilities: { ...provider('codex').capabilities, teamLaunch: false } },
  ])('rejects incomplete runtime authority %j', (override) => {
    expect(
      canSkipOptionalProviderPreflight(
        ['codex'],
        new Map([['codex', { ...provider('codex'), ...override }]]),
        new Map(),
        [check('codex', 'checking')],
        NOW
      )
    ).toBe(false);
  });
  it('allows the user to skip while passive runtime authority is still refreshing', () => {
    expect(
      canSkipOptionalProviderPreflight(
        ['codex'],
        new Map([['codex', provider('codex')]]),
        new Map([['codex', true]]),
        [check('codex', 'checking')],
        NOW
      )
    ).toBe(true);
  });
  it('rejects failed plus pending even when aggregate state is loading', () => {
    expect(
      canSkipOptionalProviderPreflight(
        ['anthropic', 'codex'],
        new Map([
          ['anthropic', provider('anthropic')],
          ['codex', provider('codex')],
        ]),
        new Map(),
        [check('anthropic', 'failed'), check('codex', 'checking')],
        NOW
      )
    ).toBe(false);
  });
  it('allows in-flight OpenCode proof only while all providers retain launch authority', () => {
    const statuses = new Map<TeamProviderId, CliProviderStatus>([
      ['codex', provider('codex')],
      ['opencode', provider('opencode')],
    ]);
    expect(
      canSkipOptionalProviderPreflight(
        ['codex', 'opencode'],
        statuses,
        new Map(),
        [check('codex', 'checking'), check('opencode', 'checking')],
        NOW
      )
    ).toBe(true);
    expect(
      canSkipOptionalProviderPreflight(
        ['codex', 'opencode'],
        statuses,
        new Map(),
        [check('codex', 'checking'), check('opencode', 'ready')],
        NOW
      )
    ).toBe(true);
    statuses.get('opencode')!.statusCheckOutcome = 'model_only';
    expect(
      canSkipOptionalProviderPreflight(
        ['codex', 'opencode'],
        statuses,
        new Map(),
        [check('codex', 'checking'), check('opencode', 'ready')],
        NOW
      )
    ).toBe(true);
  });
  it('allows an in-flight selected-model check over passive model-only authority', () => {
    const passive = {
      ...provider('opencode'),
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'model_only' as const,
      modelCatalog: null,
      modelCatalogRefreshState: 'loading' as const,
    };

    expect(
      canSkipOptionalProviderPreflight(
        ['opencode'],
        new Map([['opencode', passive]]),
        new Map(),
        [check('opencode', 'checking')],
        NOW
      )
    ).toBe(true);
  });
  it('re-evaluates TTL at click time without requiring a rerender', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const statuses = new Map([['codex' as const, provider('codex')]]);
    const allowed = () =>
      canSkipOptionalProviderPreflight(['codex'], statuses, new Map(), [
        check('codex', 'checking'),
      ]);
    expect(allowed()).toBe(true);
    vi.setSystemTime(NOW + 1000);
    expect(allowed()).toBe(false);
  });
  it('deduplicates immediate clicks and fences late callbacks, resuming only interrupted checks after rejection', () => {
    const fence = createProviderSubmissionFence();
    const generation = { current: 7 };
    const callbackGeneration = generation.current;
    expect(fence.acquire(generation)).toBe(true);
    expect(fence.acquire(generation)).toBe(false);
    expect(generation.current).toBe(8);
    const attempts = new Map<TeamProviderId, string>([
      ['codex', 'pending'],
      ['opencode', 'settled'],
      ['anthropic', 'failed'],
    ]);
    resumeInterruptedProviderPreflight(
      [check('codex', 'checking'), check('opencode', 'ready'), check('anthropic', 'failed')],
      attempts
    );
    fence.release();
    expect(attempts.has('codex')).toBe(false);
    expect(attempts.get('opencode')).toBe('settled');
    expect(attempts.get('anthropic')).toBe('failed');
    expect(callbackGeneration === generation.current).toBe(false);
    expect(fence.acquire(generation)).toBe(true);
  });
});
