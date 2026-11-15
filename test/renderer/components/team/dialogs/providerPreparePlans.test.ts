import { buildProviderPrepareModelCacheKey } from '@renderer/components/team/dialogs/providerPrepareCacheKey';
import { buildProviderPreparePlans } from '@renderer/components/team/dialogs/providerPreparePlans';
import {
  __resetShortLivedProviderPrepareCacheForTests,
  getShortLivedProviderPrepareModelIssueReasons,
  storeShortLivedProviderPrepareModelResults,
} from '@renderer/components/team/dialogs/providerPrepareShortLivedCache';
import { readLaunchPrepareModelIssues } from '@renderer/components/team/dialogs/readLaunchPrepareModelIssues';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CliProviderStatus,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareContext,
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
  afterEach(__resetShortLivedProviderPrepareCacheForTests);

  it('keeps model proof and in-flight request identities on their original Team or create context', () => {
    const input = {
      cwd: '/TEST/project',
      providerIds: ['anthropic' as const],
      selectedModelChecksByProvider: modelChecksMap([
        ['anthropic', [{ providerId: 'anthropic', model: 'opus' }]],
      ]),
      backendSummaryByProvider: new Map(),
      limitContext: false,
      runtimeProviderStatusById: new Map(),
      cachedModelResultsByCacheKey: new Map(),
    };
    const contexts = [
      undefined,
      { kind: 'create' as const },
      { kind: 'team' as const, teamName: 'legacy' },
      { kind: 'team' as const, teamName: 'host-team:TEST' },
    ];
    const plans = contexts.map((context) => buildProviderPreparePlans({ ...input, context })[0]);
    expect(new Set(plans.map((plan) => plan.cacheKey)).size).toBe(4);
    expect(new Set(plans.map((plan) => plan.requestSignature)).size).toBe(4);
    const repeated = buildProviderPreparePlans({
      ...input,
      context: { kind: 'team', teamName: 'host-team:TEST' },
    })[0];
    expect(repeated.cacheKey).toBe(plans[3].cacheKey);
    expect(repeated.requestSignature).toBe(plans[3].requestSignature);
    const proof = { opus: { status: 'ready' as const, line: 'Legacy model response' } };
    const cachedModelResultsByCacheKey = new Map([[plans[2].cacheKey, proof]]);
    expect(
      buildProviderPreparePlans({ ...input, context: contexts[2], cachedModelResultsByCacheKey })[0]
        .cachedModelResultsById
    ).toEqual(proof);
    expect(
      buildProviderPreparePlans({ ...input, context: contexts[3], cachedModelResultsByCacheKey })[0]
        .cachedModelResultsById
    ).toEqual({});
  });

  it('shows model option hints only for the same captured context and settings epoch as their plan', () => {
    const providerId = 'opencode' as const;
    const model = 'opencode/big-pickle';
    const unavailableModel = 'openai/gpt-5.4';
    const advisoryModel = 'opencode/minimax-m2.5-free';
    const input = {
      cwd: '/TEST/project',
      providerIds: [providerId],
      selectedModelChecksByProvider: modelChecksMap([
        [
          providerId,
          [model, unavailableModel, advisoryModel].map((model) => ({ providerId, model })),
        ],
      ]),
      backendSummaryByProvider: new Map([[providerId, 'OpenCode CLI']]),
      limitContext: false,
      runtimeProviderStatusById: new Map(),
      cachedModelResultsByCacheKey: new Map(),
    };
    const contexts: TeamProvisioningPrepareContext[] = [
      { kind: 'create', preparationId: 'TEST-create' },
      { kind: 'create', preparationId: 'TEST-other-create' },
      { kind: 'team', teamName: 'legacy' },
      { kind: 'team', teamName: 'host-team:TEST' },
    ];
    const planAt = (context: TeamProvisioningPrepareContext, epoch = 0) =>
      buildProviderPreparePlans({
        ...input,
        context,
        invalidationEpochByProviderId: { [providerId]: epoch },
      })[0]!;
    const readOptions = (context: TeamProvisioningPrepareContext, epoch = 0) =>
      readLaunchPrepareModelIssues({
        ...input,
        context,
        isLaunchMode: true,
        selectedMemberProviders: input.providerIds,
        runtimeBackendSummaryByProvider: input.backendSummaryByProvider,
        invalidationEpochByProviderId: { [providerId]: epoch },
      });
    const emptyOptions = {
      modelAdvisoryReasonByProvider: {},
      modelIssueReasonByProvider: {},
      modelUnavailableReasonByProvider: {},
    };

    for (const context of contexts) {
      __resetShortLivedProviderPrepareCacheForTests();
      const plan = planAt(context);
      storeShortLivedProviderPrepareModelResults({
        providerId,
        cacheKey: plan.cacheKey,
        modelResultsById: {
          [model]: { status: 'ready', line: 'Verified model' },
          [unavailableModel]: { status: 'failed', line: 'GPT-5.4 - unavailable - Access denied' },
          [advisoryModel]: { status: 'notes', line: 'Minimax - verification deferred - Timed out' },
        },
      });
      expect(readOptions(context)).toEqual({
        modelAdvisoryReasonByProvider: { [providerId]: { [advisoryModel]: 'Timed out' } },
        modelIssueReasonByProvider: {},
        modelUnavailableReasonByProvider: { [providerId]: { [unavailableModel]: 'Access denied' } },
      });
      expect(planAt(context).cachedModelResultsById[model]?.status).toBe('ready');
      for (const otherContext of contexts.filter((candidate) => candidate !== context)) {
        expect(readOptions(otherContext)).toEqual(emptyOptions);
        expect(planAt(otherContext).cachedModelResultsById).toEqual({});
      }

      const invalidated = planAt(context, 1);
      expect(invalidated.requestSignature).not.toBe(plan.requestSignature);
      expect(invalidated.cachedModelResultsById).toEqual({});
      expect(readOptions(context, 1)).toEqual(emptyOptions);
      storeShortLivedProviderPrepareModelResults({
        providerId,
        cacheKey: invalidated.cacheKey,
        modelResultsById: {
          [unavailableModel]: {
            status: 'notes',
            line: 'GPT-5.4 - check failed - Retry after settings change',
          },
        },
      });
      expect(readOptions(context, 1).modelAdvisoryReasonByProvider).toEqual({
        [providerId]: { [unavailableModel]: 'Retry after settings change' },
      });
      // Both dialogs use the same presentation reader and plan cache key owner.
      const displayKey = buildProviderPrepareModelCacheKey({
        cwd: input.cwd,
        providerId,
        backendSummary: input.backendSummaryByProvider.get(providerId),
        limitContext: input.limitContext,
        runtimeStatusSignature: invalidated.runtimeStatusSignature,
        modelChecksSignature: invalidated.modelChecksSignature,
        context,
        invalidationEpoch: 1,
      });
      expect(displayKey).toBe(invalidated.cacheKey);
      expect(
        getShortLivedProviderPrepareModelIssueReasons({ providerId, cacheKey: displayKey })
      ).toEqual({
        modelAdvisoryReasonByValue: { [unavailableModel]: 'Retry after settings change' },
        modelIssueReasonByValue: {},
        modelUnavailableReasonByValue: {},
      });
    }
  });

  it('invalidates auth proof without scheduling another paid attempt or changing other providers', () => {
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

    expect(firstByProvider.get('codex')?.requestSignature).toBe(
      secondByProvider.get('codex')?.requestSignature
    );
    expect(firstByProvider.get('codex')?.cacheKey).not.toBe(
      secondByProvider.get('codex')?.cacheKey
    );
    expect(firstByProvider.get('opencode')?.requestSignature).toBe(
      secondByProvider.get('opencode')?.requestSignature
    );
    expect(firstByProvider.get('opencode')?.cacheKey).toBe(
      secondByProvider.get('opencode')?.cacheKey
    );
  });
});
