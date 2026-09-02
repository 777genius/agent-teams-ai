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

export function hasSettledOpenCodeScopedPreparation(
  providerStatus: CliProviderStatus | null | undefined,
  evidence: OpenCodeScopedPreparationEvidence | undefined,
  now = Date.now()
): boolean {
  if (providerStatus?.statusCheckOutcome !== 'model_only' || !evidence) return false;

  return evidence.selectedModels.every((model) => {
    const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId?.trim().toLowerCase();
    if (!sourceId) return false;
    if (
      isOpenCodeLocalProviderId(sourceId) ||
      (evidence.localProviderLookupAuthoritative === true &&
        evidence.localSourceIds?.has(sourceId) === true)
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
