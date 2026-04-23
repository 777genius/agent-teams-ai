import { useEffect, useMemo, useState } from 'react';

import {
  mergeCodexCliStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { isElectronMode } from '@renderer/api';
import { formatProviderStatusText } from '@renderer/components/runtime/providerConnectionUi';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ProviderBrandLogo } from './ProviderBrandLogo';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

interface ProviderActivityState {
  provider: CliProviderStatus;
  loading: boolean;
  error: boolean;
}

function isProviderCardLoading(provider: CliProviderStatus, providerLoading: boolean): boolean {
  return (
    providerLoading ||
    (!provider.authenticated &&
      provider.statusMessage === 'Checking...' &&
      provider.models.length === 0 &&
      provider.backend == null)
  );
}

function shouldMaskCodexNegativeBootstrapState(
  sourceProvider: CliProviderStatus | null,
  mergedProvider: CliProviderStatus
): boolean {
  return (
    sourceProvider?.providerId === 'codex' &&
    sourceProvider.statusMessage === 'Checking...' &&
    mergedProvider.providerId === 'codex' &&
    mergedProvider.connection?.codex?.launchReadinessState === 'missing_auth' &&
    mergedProvider.connection.codex.login.status === 'idle'
  );
}

function getActivityToneStyles(tone: 'loading' | 'checked' | 'error'): {
  borderColor: string;
  backgroundColor: string;
  textColor: string;
  statusColor: string;
} {
  switch (tone) {
    case 'checked':
      return {
        borderColor: 'rgba(34, 197, 94, 0.22)',
        backgroundColor: 'rgba(34, 197, 94, 0.08)',
        textColor: '#dcfce7',
        statusColor: '#86efac',
      };
    case 'error':
      return {
        borderColor: 'rgba(239, 68, 68, 0.28)',
        backgroundColor: 'rgba(239, 68, 68, 0.08)',
        textColor: '#fee2e2',
        statusColor: '#fca5a5',
      };
    case 'loading':
    default:
      return {
        borderColor: 'var(--color-border-emphasis)',
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        textColor: 'var(--color-text-secondary)',
        statusColor: 'var(--color-text-muted)',
      };
  }
}

function areProviderIdListsEqual(nextIds: CliProviderId[], prevIds: CliProviderId[]): boolean {
  return nextIds.length === prevIds.length && nextIds.every((id, index) => prevIds[index] === id);
}

export const GlobalProviderStatusHeader = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const {
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    multimodelEnabled,
    isDashboardFocused,
  } = useStore(
    useShallow((state) => {
      const focusedPane = state.paneLayout.panes.find(
        (pane) => pane.id === state.paneLayout.focusedPaneId
      );
      const activeTab = focusedPane?.tabs.find((tab) => tab.id === focusedPane.activeTabId) ?? null;

      return {
        cliStatus: state.cliStatus,
        cliStatusLoading: state.cliStatusLoading,
        cliProviderStatusLoading: state.cliProviderStatusLoading,
        multimodelEnabled: state.appConfig?.general?.multimodelEnabled ?? true,
        isDashboardFocused:
          !focusedPane || focusedPane.tabs.length === 0 || activeTab?.type === 'dashboard',
      };
    })
  );
  const [cycleProviderIds, setCycleProviderIds] = useState<CliProviderId[]>([]);

  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );

  const codexAccount = useCodexAccountSnapshot({
    enabled:
      isElectron &&
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
    includeRateLimits: false,
  });

  const effectiveCliStatus = useMemo(
    () => mergeCodexCliStatusWithSnapshot(loadingCliStatus, codexAccount.snapshot),
    [codexAccount.snapshot, loadingCliStatus]
  );
  const codexSnapshotPending =
    codexAccount.loading &&
    Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')) &&
    !codexAccount.snapshot;

  const sourceProviderMap = useMemo(
    () =>
      new Map(
        (loadingCliStatus?.providers ?? []).map((provider) => [provider.providerId, provider])
      ),
    [loadingCliStatus?.providers]
  );

  const providerStates = useMemo<ProviderActivityState[]>(() => {
    const visibleProviders = filterMainScreenCliProviders(effectiveCliStatus?.providers ?? []);

    return visibleProviders.map((provider) => {
      const sourceProvider = sourceProviderMap.get(provider.providerId) ?? null;
      const loading =
        isProviderCardLoading(provider, cliProviderStatusLoading[provider.providerId] === true) ||
        (provider.providerId === 'codex' && codexSnapshotPending) ||
        shouldMaskCodexNegativeBootstrapState(sourceProvider, provider);

      return {
        provider,
        loading,
        error: !loading && provider.verificationState === 'error',
      };
    });
  }, [
    cliProviderStatusLoading,
    codexSnapshotPending,
    effectiveCliStatus?.providers,
    sourceProviderMap,
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
  }, [cycleProviderIds, errorProviderIds, loadingProviderIds, providerStateMap]);

  if (
    !isElectron ||
    isDashboardFocused ||
    !multimodelEnabled ||
    !effectiveCliStatus ||
    effectiveCliStatus.flavor !== 'agent_teams_orchestrator' ||
    !effectiveCliStatus.installed ||
    displayProviderIds.length === 0
  ) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
      style={{
        backgroundColor: 'var(--color-surface-sidebar)',
        borderColor: 'var(--color-border)',
      }}
    >
      <span
        className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Provider Activity
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
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
          const styles = getActivityToneStyles(tone);
          const statusText =
            tone === 'loading'
              ? 'Checking...'
              : tone === 'error'
                ? formatProviderStatusText(providerState.provider)
                : 'Checked';

          return (
            <div
              key={providerId}
              data-testid={`global-provider-status-${providerId}`}
              className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
              style={{
                borderColor: styles.borderColor,
                backgroundColor: styles.backgroundColor,
                color: styles.textColor,
              }}
            >
              {tone === 'loading' ? (
                <Loader2
                  className="size-3 shrink-0 animate-spin"
                  style={{ color: styles.statusColor }}
                />
              ) : tone === 'error' ? (
                <AlertTriangle className="size-3 shrink-0" style={{ color: styles.statusColor }} />
              ) : (
                <CheckCircle2 className="size-3 shrink-0" style={{ color: styles.statusColor }} />
              )}
              <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium" style={{ color: styles.textColor }}>
                {providerState.provider.displayName}
              </span>
              <span
                className="max-w-[280px] truncate"
                style={{ color: styles.statusColor }}
                title={statusText}
              >
                {statusText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
