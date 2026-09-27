import { useLayoutEffect, useMemo, useReducer } from 'react';

import { getOpenCodeAuthFilteredModelOptions } from './teamModelSelectorUi';

import type {
  TeamModelRuntimeProviderStatus,
  TeamRuntimeModelOption,
} from '@renderer/utils/teamModelAvailability';
import type { TeamProviderId } from '@shared/types';

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

interface CatalogClockSnapshot {
  staleAt: string | null;
  now: number;
}

/** Refreshes passive catalog authority at its expiry without reading the clock during render. */
export function usePassiveOpenCodeAuthCatalogFreshness(
  providerStatus: TeamModelRuntimeProviderStatus | null | undefined
): boolean {
  const staleAt =
    providerStatus?.modelCatalog?.status === 'ready' ? providerStatus.modelCatalog.staleAt : null;
  const [snapshot, publishSnapshot] = useReducer(
    (_current: CatalogClockSnapshot, next: CatalogClockSnapshot) => next,
    { staleAt: null, now: Number.POSITIVE_INFINITY }
  );

  useLayoutEffect(() => {
    if (!staleAt) return;
    const expiresAt = Date.parse(staleAt);
    if (!Number.isFinite(expiresAt)) return;

    let timeoutId: number | undefined;
    const refresh = (): void => {
      const now = Date.now();
      publishSnapshot({ staleAt, now });
      if (now < expiresAt) {
        timeoutId = window.setTimeout(refresh, Math.min(expiresAt - now, MAX_BROWSER_TIMEOUT_MS));
      }
    };
    refresh();
    return () => window.clearTimeout(timeoutId);
  }, [staleAt]);

  return staleAt !== null && snapshot.staleAt === staleAt && Date.parse(staleAt) > snapshot.now;
}

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
