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
  runtimeProviderGenerationById,
  cachedModelResultsByCacheKey,
  allowExperimentalLocalModels,
}: {
  cwd: string;
  providerIds: readonly TeamProviderId[];
  selectedModelChecksByProvider: ReadonlyMap<
    TeamProviderId,
    readonly TeamProvisioningModelCheckRequest[]
  >;
  backendSummaryByProvider: ReadonlyMap<TeamProviderId, string | null>;
  limitContext: boolean;
  runtimeProviderStatusById: RuntimeProviderStatusById;
  runtimeProviderGenerationById?: ReadonlyMap<
    TeamProviderId,
    string | number | null | undefined
  >;
  cachedModelResultsByCacheKey: ReadonlyMap<
    string,
    Record<string, ProviderPrepareDiagnosticsModelResult>
  >;
  allowExperimentalLocalModels?: boolean;
}): ProviderPreparePlan[] {
  return providerIds.map((providerId) => {
    const selectedModelChecks = [...(selectedModelChecksByProvider.get(providerId) ?? [])];
    const selectedModelIds = selectedModelChecks.map((check) => check.model);
    const backendSummary = backendSummaryByProvider.get(providerId) ?? null;
    const runtimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      [providerId],
      runtimeProviderStatusById
    );
    const proofBoundRuntimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      [providerId],
      runtimeProviderStatusById,
      undefined,
      runtimeProviderGenerationById
    );
    const modelChecksSignature = buildProviderPrepareModelChecksSignature(
      new Map([[providerId, selectedModelChecks]])
    );
    const requestSignature = buildProviderPrepareRequestSignature({
      cwd,
      selectedProviderId: providerId,
      selectedModel: '',
      selectedMemberProviders: [providerId],
      limitContext,
      runtimeStatusSignature,
      modelChecksSignature,
      allowExperimentalLocalModels,
    });
    const cacheKey = buildProviderPrepareModelCacheKey({
      cwd,
      providerId,
      backendSummary,
      limitContext,
      runtimeStatusSignature: proofBoundRuntimeStatusSignature,
      modelChecksSignature,
      allowExperimentalLocalModels,
    });
    const reusableModelResultsById = {
      ...getShortLivedProviderPrepareModelResults({
        providerId,
        cacheKey,
      }),
      ...(cachedModelResultsByCacheKey.get(cacheKey) ?? {}),
    };
    // Ready display snapshots are not execution authority. Exact-model deep
    // verification must execute again whenever a plan is refreshed.
    const cachedModelResultsById = Object.fromEntries(
      Object.entries(reusableModelResultsById).filter(([, result]) => result.status !== 'ready')
    );

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
