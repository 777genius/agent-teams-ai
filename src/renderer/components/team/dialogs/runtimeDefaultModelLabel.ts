import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export interface TeamDefaultModelLabel {
  label: string;
  modelLabel: string;
}

/** Presents runtime-confirmed defaults only; catalog recommendations are not launch evidence. */
export function resolveRuntimeDefaultModelLabel(
  providerId: TeamProviderId,
  status: CliProviderStatus | null | undefined,
  limitContext = false,
  now = Date.now()
): TeamDefaultModelLabel | null {
  if (
    (providerId !== 'anthropic' && providerId !== 'codex') ||
    status?.providerId !== providerId ||
    !status.supported ||
    status.verificationState !== 'verified' ||
    status.statusCheckOutcome !== 'authoritative' ||
    status.statusCheckErrorCode != null ||
    status.modelCatalogRefreshState === 'loading' ||
    status.modelCatalogRefreshState === 'error'
  ) {
    return null;
  }
  const catalog = status.modelCatalog;
  if (
    catalog &&
    (catalog.providerId !== providerId ||
      catalog.status !== 'ready' ||
      !Number.isFinite(Date.parse(catalog.staleAt)) ||
      Date.parse(catalog.staleAt) <= now)
  ) {
    return null;
  }
  const confirmedModel = status.effectiveDefaultModel?.trim();
  if (!confirmedModel || isDefaultProviderModelSelection(confirmedModel)) return null;
  // An unresolved Claude family alias does not identify the actual model.
  if (
    providerId === 'anthropic' &&
    /^(?:fable|opus|sonnet|haiku)(?:\[1m\])?$/i.test(confirmedModel)
  ) {
    return null;
  }
  const model =
    providerId === 'anthropic'
      ? resolveAnthropicLaunchModel({ defaultLaunchModel: confirmedModel, limitContext })
      : confirmedModel;
  return model ? { label: model, modelLabel: model } : null;
}
