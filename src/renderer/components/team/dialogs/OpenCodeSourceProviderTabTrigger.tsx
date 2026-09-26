import React from 'react';

import { ProviderBrandIcon } from '@features/runtime-provider-management/renderer';
import { TabsTrigger } from '@renderer/components/ui/tabs';
import { RefreshCw } from 'lucide-react';

import {
  getOpenCodeSourceTabCountState,
  type OpenCodePassiveCatalogState,
} from './openCodeRuntimeStatusUi';

export interface OpenCodeSourceProviderTabTriggerProps {
  provider: {
    id: string;
    label: string;
    sourceId: string;
    connected: boolean;
    directoryModelCount?: number | null;
  };
  sourceModelCount: number;
  sourceScopedLoading: boolean;
  passiveCatalogState: OpenCodePassiveCatalogState;
  sourceLoadable: boolean;
  sourceDisabled: boolean;
  disabledReason: string | null;
}

export const OpenCodeSourceProviderTabTrigger = ({
  provider,
  sourceModelCount,
  sourceScopedLoading,
  passiveCatalogState,
  sourceLoadable,
  sourceDisabled,
  disabledReason,
}: OpenCodeSourceProviderTabTriggerProps): React.JSX.Element => {
  const sourceCountState = getOpenCodeSourceTabCountState({
    sourceModelCount,
    sourceScopedLoading,
    directoryExpectsModels:
      provider.directoryModelCount === null ||
      (provider.directoryModelCount !== undefined && provider.directoryModelCount > 0),
    passiveCatalogState,
  });

  return (
    <TabsTrigger
      value={provider.id}
      disabled={sourceDisabled}
      aria-disabled={sourceDisabled || undefined}
      aria-description={
        sourceCountState === 'pending'
          ? `${provider.label} is connected. Loading models.`
          : sourceCountState === 'unavailable'
            ? `${provider.label} models are unavailable until the OpenCode check succeeds.`
            : sourceLoadable
              ? (disabledReason ?? undefined)
              : `${provider.label} has no available models.`
      }
      data-connection-status={provider.connected ? 'connected' : undefined}
      data-testid={`team-model-selector-provider-nav-${provider.sourceId}`}
      className="relative h-10 w-full shrink-0 justify-start gap-2 rounded-md border border-transparent px-2.5 text-left text-xs text-[var(--color-text-secondary)] shadow-none transition-colors hover:bg-black/[0.035] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-45 data-[state=active]:border-black/[0.06] data-[state=active]:bg-black/[0.065] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-none data-[state=active]:before:absolute data-[state=active]:before:inset-y-2 data-[state=active]:before:left-0 data-[state=active]:before:w-0.5 data-[state=active]:before:rounded-full data-[state=active]:before:bg-emerald-500 data-[state=active]:before:content-[''] dark:hover:bg-white/[0.035] dark:data-[state=active]:border-white/[0.06] dark:data-[state=active]:bg-white/[0.065] dark:data-[state=active]:before:bg-emerald-300"
    >
      <ProviderBrandIcon
        provider={{ providerId: provider.sourceId, displayName: provider.label }}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{provider.label}</span>
      <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-[var(--color-text-muted)]">
        {provider.connected ? (
          <>
            <span
              data-testid={`team-model-selector-provider-nav-connected-${provider.sourceId}`}
              className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-300"
              aria-hidden="true"
            />
            <span className="sr-only">Connected provider, </span>
          </>
        ) : null}
        {sourceCountState === 'pending' ? (
          <>
            <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
            <span className="sr-only">Loading models</span>
          </>
        ) : sourceCountState === 'unavailable' ? (
          <span
            data-testid={`team-model-selector-provider-nav-count-unavailable-${provider.sourceId}`}
          >
            <span aria-hidden="true">-</span>
            <span className="sr-only">Model count unavailable</span>
          </span>
        ) : (
          sourceModelCount
        )}
      </span>
    </TabsTrigger>
  );
};
