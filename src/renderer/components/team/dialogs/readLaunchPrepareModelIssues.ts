import { buildProviderPrepareModelCacheKey } from './providerPrepareCacheKey';
import {
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from './providerPrepareRequestSignature';
import { getShortLivedProviderPrepareModelIssueReasons } from './providerPrepareShortLivedCache';

import type {
  CliProviderStatus,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';

/** Presentation cache lookup only; cached model results carry no launch readiness. */
export function readLaunchPrepareModelIssues({
  isLaunchMode,
  selectedMemberProviders,
  runtimeBackendSummaryByProvider,
  runtimeProviderStatusById,
  selectedModelChecksByProvider,
  cwd,
  limitContext,
}: {
  isLaunchMode: boolean;
  selectedMemberProviders: readonly TeamProviderId[];
  runtimeBackendSummaryByProvider: ReadonlyMap<TeamProviderId, string | null>;
  runtimeProviderStatusById: ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>;
  selectedModelChecksByProvider: ReadonlyMap<
    TeamProviderId,
    readonly TeamProvisioningModelCheckRequest[]
  >;
  cwd: string;
  limitContext: boolean;
}) {
  const modelAdvisoryReasonByProvider: Partial<Record<TeamProviderId, Record<string, string>>> = {};
  const modelIssueReasonByProvider: Partial<Record<TeamProviderId, Record<string, string>>> = {};
  const modelUnavailableReasonByProvider: Partial<Record<TeamProviderId, Record<string, string>>> =
    {};

  if (!isLaunchMode) {
    return {
      modelAdvisoryReasonByProvider,
      modelIssueReasonByProvider,
      modelUnavailableReasonByProvider,
    };
  }

  for (const providerId of selectedMemberProviders) {
    const backendSummary = runtimeBackendSummaryByProvider.get(providerId) ?? null;
    const providerRuntimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      [providerId],
      runtimeProviderStatusById
    );
    const providerModelChecksSignature = buildProviderPrepareModelChecksSignature(
      new Map([[providerId, selectedModelChecksByProvider.get(providerId) ?? []]])
    );
    const cacheKey = buildProviderPrepareModelCacheKey({
      cwd: cwd,
      providerId,
      backendSummary,
      limitContext: limitContext,
      runtimeStatusSignature: providerRuntimeStatusSignature,
      modelChecksSignature: providerModelChecksSignature,
    });
    const issueReasons = getShortLivedProviderPrepareModelIssueReasons({
      providerId,
      cacheKey,
    });
    if (Object.keys(issueReasons.modelAdvisoryReasonByValue).length > 0) {
      modelAdvisoryReasonByProvider[providerId] = issueReasons.modelAdvisoryReasonByValue;
    }
    if (Object.keys(issueReasons.modelIssueReasonByValue).length > 0) {
      modelIssueReasonByProvider[providerId] = issueReasons.modelIssueReasonByValue;
    }
    if (Object.keys(issueReasons.modelUnavailableReasonByValue).length > 0) {
      modelUnavailableReasonByProvider[providerId] = issueReasons.modelUnavailableReasonByValue;
    }
  }

  return {
    modelAdvisoryReasonByProvider,
    modelIssueReasonByProvider,
    modelUnavailableReasonByProvider,
  };
}
