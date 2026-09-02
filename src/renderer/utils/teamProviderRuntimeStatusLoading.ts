import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';
import { isProviderModelCatalogExactReady } from '@shared/utils/providerStatusAuthority';

import {
  isTeamProviderModelVerificationPending,
  type TeamModelRuntimeProviderStatus,
} from './teamModelAvailability';

import type { CliProviderId, CliProviderStatus, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export interface OpenCodeScopedPreparationEvidence {
  selectedModels: readonly string[];
  scopedStatusBySourceId: ReadonlyMap<string, CliProviderStatus | null | undefined>;
  localSourceIds?: ReadonlySet<string>;
  localProviderLookupAuthoritative?: boolean;
}

export function getOpenCodeScopedPreparationFailure(
  evidence: OpenCodeScopedPreparationEvidence | undefined
): CliProviderStatus | null {
  if (!evidence) return null;
  for (const model of evidence.selectedModels) {
    const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId?.trim().toLowerCase();
    if (!sourceId || isOpenCodeLocalProviderId(sourceId)) continue;
    const scopedStatus = evidence.scopedStatusBySourceId.get(sourceId);
    if (scopedStatus?.modelCatalogRefreshState === 'error') return scopedStatus;
  }
  return null;
}

export function hasSettledOpenCodeScopedPreparation(
  providerStatus: CliProviderStatus | null | undefined,
  evidence: OpenCodeScopedPreparationEvidence | undefined,
  now = Date.now()
): boolean {
  if (
    providerStatus?.statusCheckOutcome !== 'model_only' ||
    !evidence ||
    evidence.selectedModels.length === 0
  ) {
    return false;
  }

  return evidence.selectedModels.every((model) => {
    const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId?.trim().toLowerCase();
    if (!sourceId) return false;
    if (
      isOpenCodeLocalProviderId(sourceId) ||
      evidence.localSourceIds?.has(sourceId) === true
    ) {
      return true;
    }
    const scopedStatus = evidence.scopedStatusBySourceId.get(sourceId);
    return Boolean(scopedStatus && isProviderModelCatalogExactReady(scopedStatus, now));
  });
}

export function isTeamProviderRuntimeStatusLoading(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null,
  providerLoading = false,
  openCodeEvidence?: OpenCodeScopedPreparationEvidence
): boolean {
  if (!providerId) {
    return false;
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    if (
      providerId === 'opencode' &&
      getOpenCodeScopedPreparationFailure(openCodeEvidence)
    ) {
      return false;
    }
    if (
      providerId !== 'opencode' ||
      !hasSettledOpenCodeScopedPreparation(
        providerStatus as CliProviderStatus | null | undefined,
        openCodeEvidence
      )
    ) {
      return true;
    }
  }

  // Cached model truth must not make an explicit provider/auth check look settled.
  return providerLoading;
}
