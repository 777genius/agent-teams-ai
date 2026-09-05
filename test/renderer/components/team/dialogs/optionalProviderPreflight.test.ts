import {
  canSkipOptionalProviderPreflight,
  canSkipPendingProviderDiscovery,
  createProviderSubmissionFence,
  resumeInterruptedProviderPreflight,
} from '@renderer/components/team/dialogs/optionalProviderPreflight';
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
