import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { shouldMaskCodexNegativeBootstrapState } from '@renderer/components/runtime/providerConnectionUi';
import { cn } from '@renderer/lib/utils';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import {
  hasSettledOpenCodeScopedPreparation,
  isTeamProviderRuntimeStatusLoading,
  type OpenCodeScopedPreparationEvidence,
} from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { ProviderBrandLogo } from './ProviderBrandLogo';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

interface ProviderActivityState {
  provider: CliProviderStatus;
  loading: boolean;
  error: boolean;
}

interface ProviderActivityStatusStripProps {
  readonly cliStatus: CliInstallationStatus | null | undefined;
  readonly sourceCliStatus?: CliInstallationStatus | null;
  readonly providerStatusOverride?: CliProviderStatus | null;
  readonly cliStatusLoading: boolean;
  readonly cliProviderStatusLoading: Partial<Record<CliProviderId, boolean>>;
  readonly multimodelEnabled: boolean;
  readonly codexSnapshotPending?: boolean;
  readonly openCodePreparationEvidence?: OpenCodeScopedPreparationEvidence;
  readonly forceLoadingProviderIds?: readonly CliProviderId[];
  readonly providerIds?: readonly CliProviderId[];
  readonly className?: string;
  readonly label?: string | null;
  readonly layout?: 'inline' | 'stacked';
  readonly showReadyProviders?: boolean;
  readonly readyStatusText?: string;
  readonly showDetailMessages?: boolean;
}

/** Light-first classes with dark variants, so the chip stays readable in both themes. */
function getActivityToneClasses(tone: 'loading' | 'checked' | 'error'): {
  container: string;
  text: string;
  status: string;
} {
  switch (tone) {
    case 'checked':
      return {
        container:
          'border-green-600/30 bg-green-500/10 dark:border-green-500/[0.22] dark:bg-green-500/[0.08]',
        text: 'text-green-800 dark:text-green-100',
        status: 'text-green-700 dark:text-green-300',
      };
    case 'error':
      return {
        container:
          'border-red-600/30 bg-red-500/10 dark:border-red-500/[0.28] dark:bg-red-500/[0.08]',
        text: 'text-red-800 dark:text-red-100',
        status: 'text-red-700 dark:text-red-300',
      };
    case 'loading':
    default:
      return {
        container: 'border-[var(--color-border-emphasis)] bg-black/[0.03] dark:bg-white/[0.03]',
        text: 'text-[var(--color-text-secondary)]',
        status: 'text-[var(--color-text-muted)]',
      };
  }
}

function areProviderIdListsEqual(nextIds: CliProviderId[], prevIds: CliProviderId[]): boolean {
  return nextIds.length === prevIds.length && nextIds.every((id, index) => prevIds[index] === id);
}

function useProviderActivityDisplay({
  cliStatus,
  sourceCliStatus,
  providerStatusOverride,
  cliStatusLoading,
  cliProviderStatusLoading,
  multimodelEnabled,
  codexSnapshotPending = false,
  openCodePreparationEvidence,
  forceLoadingProviderIds,
  providerIds,
  showReadyProviders,
}: Pick<
  ProviderActivityStatusStripProps,
  | 'cliStatus'
  | 'sourceCliStatus'
  | 'providerStatusOverride'
  | 'cliStatusLoading'
  | 'cliProviderStatusLoading'
  | 'multimodelEnabled'
  | 'codexSnapshotPending'
  | 'openCodePreparationEvidence'
  | 'forceLoadingProviderIds'
  | 'providerIds'
  | 'showReadyProviders'
>): {
  displayProviderIds: CliProviderId[];
  providerStateMap: Map<CliProviderId, ProviderActivityState>;
  shouldRender: boolean;
} {
  const [cycleProviderIds, setCycleProviderIds] = useState<CliProviderId[]>([]);
  const renderCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : (cliStatus ?? null),
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );
  const sourceStatus = sourceCliStatus ?? renderCliStatus;
  const providerIdSet = useMemo(
    () => (providerIds ? new Set<CliProviderId>(providerIds) : null),
    [providerIds]
  );
  const forcedLoadingProviderIdSet = useMemo(
    () => new Set<CliProviderId>(forceLoadingProviderIds ?? []),
    [forceLoadingProviderIds]
  );
  const sourceProviderMap = useMemo(
    () =>
      new Map((sourceStatus?.providers ?? []).map((provider) => [provider.providerId, provider])),
    [sourceStatus?.providers]
  );

  const providerStates = useMemo<ProviderActivityState[]>(() => {
    const visibleProviders = filterMainScreenCliProviders(renderCliStatus?.providers ?? []).filter(
      (provider) => !providerIdSet || providerIdSet.has(provider.providerId)
    );

    return visibleProviders.map((globalProvider) => {
      const overridden = providerStatusOverride?.providerId === globalProvider.providerId;
      const provider = overridden ? providerStatusOverride : globalProvider;
      const sourceProvider = sourceProviderMap.get(provider.providerId) ?? null;
      const loading =
        forcedLoadingProviderIdSet.has(provider.providerId) ||
        isTeamProviderRuntimeStatusLoading(
          provider.providerId,
          provider,
          !overridden && cliProviderStatusLoading[provider.providerId] === true,
          openCodePreparationEvidence
        ) ||
        (provider.providerId === 'codex' && codexSnapshotPending) ||
        shouldMaskCodexNegativeBootstrapState(sourceProvider, provider, {
          providerLoading: cliProviderStatusLoading[provider.providerId] === true,
        });
      const scopedOpenCodeReady =
        provider.providerId === 'opencode' &&
        hasSettledOpenCodeScopedPreparation(provider, openCodePreparationEvidence);

      return {
        provider,
        loading,
        error: !loading && !scopedOpenCodeReady && !hasEffectiveProviderLaunchAuthority(provider),
      };
    });
  }, [
    cliProviderStatusLoading,
    codexSnapshotPending,
    forcedLoadingProviderIdSet,
    openCodePreparationEvidence,
    providerIdSet,
    renderCliStatus?.providers,
    sourceProviderMap,
    providerStatusOverride,
  ]);

  const visibleProviderIds = useMemo(
    () => providerStates.map((state) => state.provider.providerId),
    [providerStates]
  );
  const loadingProviderIds = useMemo(
    () => providerStates.filter((state) => state.loading).map((state) => state.provider.providerId),
    [providerStates]
  );
  const errorProviderIds = useMemo(
    () => providerStates.filter((state) => state.error).map((state) => state.provider.providerId),
    [providerStates]
  );
  const providerStateMap = useMemo(
    () => new Map(providerStates.map((state) => [state.provider.providerId, state])),
    [providerStates]
  );

  useEffect(() => {
    setCycleProviderIds((previousIds) => {
      const visiblePreviousIds = previousIds.filter((providerId) =>
        visibleProviderIds.includes(providerId)
      );

      if (loadingProviderIds.length > 0) {
        const nextIds = [...visiblePreviousIds];
        for (const providerId of loadingProviderIds) {
          if (!nextIds.includes(providerId)) {
            nextIds.push(providerId);
          }
        }

        return areProviderIdListsEqual(nextIds, previousIds) ? previousIds : nextIds;
      }

      if (errorProviderIds.length > 0) {
        return areProviderIdListsEqual(errorProviderIds, previousIds)
          ? previousIds
          : errorProviderIds;
      }

      return previousIds.length === 0 ? previousIds : [];
    });
  }, [errorProviderIds, loadingProviderIds, visibleProviderIds]);

  const displayProviderIds = useMemo(() => {
    if (showReadyProviders) {
      return visibleProviderIds;
    }

    if (loadingProviderIds.length > 0) {
      const activeCycleIds = (
        cycleProviderIds.length > 0 ? cycleProviderIds : loadingProviderIds
      ).filter((providerId) => providerStateMap.has(providerId));
      return Array.from(new Set([...activeCycleIds, ...errorProviderIds]));
    }

    if (errorProviderIds.length > 0) {
      return errorProviderIds;
    }

    return [];
  }, [
    cycleProviderIds,
    errorProviderIds,
    loadingProviderIds,
    providerStateMap,
    showReadyProviders,
    visibleProviderIds,
  ]);

  return {
    displayProviderIds,
    providerStateMap,
    shouldRender:
      isElectronMode() &&
      multimodelEnabled &&
      renderCliStatus?.flavor === 'agent_teams_orchestrator' &&
      renderCliStatus.installed &&
      displayProviderIds.length > 0,
  };
}

export const ProviderActivityStatusStrip = ({
  cliStatus,
  sourceCliStatus,
  providerStatusOverride,
  cliStatusLoading,
  cliProviderStatusLoading,
  multimodelEnabled,
  codexSnapshotPending = false,
  openCodePreparationEvidence,
  forceLoadingProviderIds,
  providerIds,
  className = '',
  label,
  layout = 'inline',
  showReadyProviders = false,
  readyStatusText,
  showDetailMessages = false,
}: ProviderActivityStatusStripProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  const { t: teamT } = useAppTranslation('team');
  const effectiveLabel = label ?? t('providerRuntime.connectionUi.status.providerActivity');
  const { displayProviderIds, providerStateMap, shouldRender } = useProviderActivityDisplay({
    cliStatus,
    sourceCliStatus,
    providerStatusOverride,
    cliStatusLoading,
    cliProviderStatusLoading,
    multimodelEnabled,
    codexSnapshotPending,
    openCodePreparationEvidence,
    forceLoadingProviderIds,
    providerIds,
    showReadyProviders,
  });

  if (!shouldRender) {
    return null;
  }

  const rootClassName =
    layout === 'stacked'
      ? `flex min-w-0 flex-col items-start gap-1.5 ${className}`.trim()
      : `flex min-w-0 flex-wrap items-center gap-2 ${className}`.trim();
  const itemsClassName =
    layout === 'stacked'
      ? 'flex min-w-0 w-full flex-wrap items-center gap-1.5'
      : 'flex min-w-0 flex-1 flex-wrap items-center gap-2';
  const detailMessages = showDetailMessages
    ? displayProviderIds.flatMap((providerId) => {
        const provider = providerStateMap.get(providerId)?.provider;
        const message = provider?.statusMessage?.trim() || provider?.detailMessage?.trim();
        return provider && message ? [{ providerId, provider, message }] : [];
      })
    : [];

  return (
    <div className={rootClassName}>
      {effectiveLabel ? (
        <span
          className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {effectiveLabel}
        </span>
      ) : null}
      <div className={itemsClassName}>
        {displayProviderIds.map((providerId) => {
          const providerState = providerStateMap.get(providerId);
          if (!providerState) {
            return null;
          }

          const tone = providerState.loading
            ? 'loading'
            : providerState.error
              ? 'error'
              : 'checked';
          const toneClasses = getActivityToneClasses(tone);
          const statusText =
            tone === 'loading'
              ? t('providerRuntime.connectionUi.status.checking')
              : tone === 'error'
                ? teamT('provisioning.providerStatus.detailSummary.needsAttention')
                : t('providerRuntime.connectionUi.status.checked');
          const displayStatusText =
            tone === 'checked' && readyStatusText ? readyStatusText : statusText;

          return (
            <div
              key={providerId}
              data-testid={`provider-activity-status-${providerId}`}
              data-tone={tone}
              className={cn(
                'flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                toneClasses.container,
                toneClasses.text
              )}
            >
              {tone === 'loading' ? (
                <Loader2 className={cn('size-3 shrink-0 animate-spin', toneClasses.status)} />
              ) : tone === 'error' ? (
                <AlertTriangle className={cn('size-3 shrink-0', toneClasses.status)} />
              ) : (
                <CheckCircle2 className={cn('size-3 shrink-0', toneClasses.status)} />
              )}
              <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />
              <span className={cn('shrink-0 font-medium', toneClasses.text)}>
                {providerState.provider.displayName}
              </span>
              <span className={cn('max-w-[280px] truncate', toneClasses.status)}>
                {displayStatusText}
              </span>
            </div>
          );
        })}
      </div>
      {detailMessages.length > 0 ? (
        <div className="space-y-0.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
          {detailMessages.map(({ providerId, provider, message }) => (
            <p key={providerId} data-testid={`provider-activity-detail-${providerId}`}>
              {detailMessages.length > 1 ? `${provider.displayName}: ` : ''}
              {message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};
