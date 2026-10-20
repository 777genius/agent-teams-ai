import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { getAnthropicRuntimeDefaultLaunchModel } from '@shared/utils/providerDefaultModel';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

/** Reads a provider-scoped runtime default without promoting a mismatched status. */
export function resolveRuntimeStatusDefaultModel(
  status: Partial<CliProviderStatus> | null,
  providerId: TeamProviderId,
  limitContext: boolean
): string | null {
  if (status?.providerId && status.providerId !== providerId) return null;
  const catalog = status?.modelCatalog?.providerId === providerId ? status.modelCatalog : null;
  const resolved =
    getAnthropicRuntimeDefaultLaunchModel(
      status ? { ...status, providerId: status.providerId ?? providerId } : null
    ) ||
    (typeof status?.defaultModel === 'string' ? status.defaultModel.trim() : '') ||
    catalog?.defaultLaunchModel?.trim() ||
    null;
  return providerId === 'anthropic'
    ? resolveAnthropicLaunchModel({
        limitContext,
        availableLaunchModels: catalog?.models.map((model) => model.launchModel) ?? [],
        defaultLaunchModel: resolved,
      })
    : resolved;
}
