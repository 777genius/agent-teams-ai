import { resolveAnthropicRuntimeSelection } from '@features/anthropic-runtime-profile/renderer';
import { getAnthropicRuntimeDefaultLaunchModel } from '@shared/utils/providerDefaultModel';

import type { CliProviderStatus } from '@shared/types';

/** Keeps launch, effort and Fast-mode controls on the same provider default. */
export function resolveAnthropicProviderRuntimeSelection(
  providerStatus: CliProviderStatus | null | undefined,
  selectedModel: string | null | undefined,
  limitContext: boolean
): ReturnType<typeof resolveAnthropicRuntimeSelection> {
  return resolveAnthropicRuntimeSelection({
    source: {
      modelCatalog: providerStatus?.modelCatalog,
      runtimeCapabilities: providerStatus?.runtimeCapabilities,
    },
    selectedModel,
    limitContext,
    defaultLaunchModel: getAnthropicRuntimeDefaultLaunchModel(providerStatus),
  });
}
