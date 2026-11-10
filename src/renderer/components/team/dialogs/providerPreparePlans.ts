import { buildProviderPrepareAttemptRuntimeSignature } from './providerPrepareAttemptIdentity';
import { buildProviderPrepareModelCacheKey } from './providerPrepareCacheKey';
import {
  getProviderPrepareCachedSnapshot,
  type ProviderPrepareDiagnosticsCachedSnapshot,
  type ProviderPrepareDiagnosticsModelResult,
} from './providerPrepareDiagnostics';
import {
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRequestSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from './providerPrepareRequestSignature';
import { getShortLivedProviderPrepareModelResults } from './providerPrepareShortLivedCache';

import type {
  CliProviderStatus,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareContext,
} from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>;

export interface ProviderPreparePlan {
  providerId: TeamProviderId;
  selectedModelChecks: TeamProvisioningModelCheckRequest[];
  selectedModelIds: string[];
  backendSummary: string | null;
  runtimeStatusSignature: string;
  modelChecksSignature: string;
  requestSignature: string;
  cacheKey: string;
  cachedModelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>;
  cachedSnapshot: ProviderPrepareDiagnosticsCachedSnapshot;
}

export function buildProviderPreparePlans({
  cwd,
  providerIds,
  selectedModelChecksByProvider,
  backendSummaryByProvider,
  limitContext,
  runtimeProviderStatusById,
  cachedModelResultsByCacheKey,
  context,
}: {
  cwd: string;
  providerIds: readonly TeamProviderId[];
  selectedModelChecksByProvider: ReadonlyMap<
    TeamProviderId,
    readonly TeamProvisioningModelCheckRequest[]
  >;
  backendSummaryByProvider: ReadonlyMap<TeamProviderId, string | null>;
  limitContext: boolean;
  context?: TeamProvisioningPrepareContext;
  runtimeProviderStatusById: RuntimeProviderStatusById;
  cachedModelResultsByCacheKey: ReadonlyMap<
    string,
    Record<string, ProviderPrepareDiagnosticsModelResult>
  >;
}): ProviderPreparePlan[] {
  return providerIds.map((providerId) => {
    const selectedModelChecks = [...(selectedModelChecksByProvider.get(providerId) ?? [])];
    const selectedModelIds = selectedModelChecks.map((check) => check.model);
    const backendSummary = backendSummaryByProvider.get(providerId) ?? null;
    const runtimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      [providerId],
      runtimeProviderStatusById
    );
    const modelChecksSignature = buildProviderPrepareModelChecksSignature(
      new Map([[providerId, selectedModelChecks]])
    );
    const baseRequestSignature = buildProviderPrepareRequestSignature({
      cwd,
      selectedProviderId: providerId,
      selectedModel: '',
      selectedMemberProviders: [providerId],
      limitContext,
      runtimeStatusSignature: buildProviderPrepareAttemptRuntimeSignature(
        runtimeProviderStatusById.get(providerId)
      ),
      modelChecksSignature,
    });
    const baseCacheKey = buildProviderPrepareModelCacheKey({
      cwd,
      providerId,
      backendSummary,
      limitContext,
      runtimeStatusSignature,
      modelChecksSignature,
    });
    const requestSignature = context
      ? JSON.stringify([context, baseRequestSignature])
      : baseRequestSignature;
    const cacheKey = context ? JSON.stringify([context, baseCacheKey]) : baseCacheKey;
    const cachedModelResultsById = {
      ...getShortLivedProviderPrepareModelResults({
        providerId,
        cacheKey,
      }),
      ...(cachedModelResultsByCacheKey.get(cacheKey) ?? {}),
    };

    return {
      providerId,
      selectedModelChecks,
      selectedModelIds,
      backendSummary,
      runtimeStatusSignature,
      modelChecksSignature,
      requestSignature,
      cacheKey,
      cachedModelResultsById,
      cachedSnapshot: getProviderPrepareCachedSnapshot({
        providerId,
        selectedModelIds,
        cachedModelResultsById,
      }),
    };
  });
}
