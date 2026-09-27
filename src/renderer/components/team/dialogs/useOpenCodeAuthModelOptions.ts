import { useMemo } from 'react';

import { getOpenCodeAuthFilteredModelOptions } from './teamModelSelectorUi';

import type {
  TeamModelRuntimeProviderStatus,
  TeamRuntimeModelOption,
} from '@renderer/utils/teamModelAvailability';
import type { TeamProviderId } from '@shared/types';

interface OpenCodeAuthModelOptionsInput {
  options: readonly TeamRuntimeModelOption[];
  providerId: TeamProviderId;
  providerStatus: TeamModelRuntimeProviderStatus | null | undefined;
  catalogFresh: boolean;
  selectedModel: string;
  showAuthRequired: boolean;
}

export function useOpenCodeAuthModelOptions({
  options,
  providerId,
  providerStatus,
  catalogFresh,
  selectedModel,
  showAuthRequired,
}: OpenCodeAuthModelOptionsInput): ReturnType<typeof getOpenCodeAuthFilteredModelOptions> {
  return useMemo(
    () =>
      getOpenCodeAuthFilteredModelOptions({
        options,
        providerStatus: providerId === 'opencode' ? providerStatus : null,
        catalogFresh,
        selectedModel,
        showAuthRequired,
      }),
    [options, providerId, providerStatus, catalogFresh, selectedModel, showAuthRequired]
  );
}
