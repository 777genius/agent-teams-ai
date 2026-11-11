import { useAppTranslation } from '@features/localization/renderer';
import { useOpenCodeDashboardConnectedCountProbe } from '@features/runtime-provider-management/renderer';
import { isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import { Gauge, Settings2 } from 'lucide-react';

import { ProviderConnectionCounts } from './ProviderConnectionCounts';
import { useProviderConnectionSummary } from './useProviderConnectionSummary';

interface DashboardProviderSummaryProps {
  readonly isActive?: boolean;
}

export const DashboardProviderSummary = ({
  isActive = true,
}: DashboardProviderSummaryProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const {
    summary,
    cliStatus,
    cliStatusLoading,
    cliStatusError,
    cliProviderStatusLoading,
    multimodelEnabled,
    openCodeIsChecking,
    projectPath,
    openCodeRuntimeStatus,
  } = useProviderConnectionSummary();
  const openSettingsTab = useStore((state) => state.openSettingsTab);
  const openTab = useStore((state) => state.openTab);

  useOpenCodeDashboardConnectedCountProbe({
    enabled:
      isElectronMode() &&
      isActive &&
      multimodelEnabled &&
      cliStatus?.installed === true &&
      cliStatus.flavor === 'agent_teams_orchestrator',
    projectPath,
    runtimeStatus: openCodeRuntimeStatus,
    connectedCount: summary.openCodeConnected,
  });

  if (!isElectronMode()) return null;

  // A saved credential is not permission to run; keep the readiness title honest.
  const hasReadyProvider =
    cliStatus?.installed === true &&
    filterMainScreenCliProviders(cliStatus.providers).some((provider) =>
      hasEffectiveProviderLaunchAuthority(provider)
    );

  return (
    <div
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface-raised)' }}
      data-testid="dashboard-provider-summary"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-text">
            {hasReadyProvider
              ? t('cliStatus.provider.readyToRunAgents')
              : settingsT('runtimeProvider.tabs.providers')}
          </span>
          <ProviderConnectionCounts
            summary={summary}
            cliStatus={cliStatus}
            cliStatusLoading={cliStatusLoading}
            providerStatusLoading={cliProviderStatusLoading}
            multimodelEnabled={multimodelEnabled}
            openCodeIsChecking={openCodeIsChecking}
          />
        </div>
        {cliStatusError && (
          <p className="mt-1 text-xs text-amber-400" role="status">
            {t('cliStatus.errors.checkStatusFailed')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openTab({ type: 'token-usage', label: 'Usage' })}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-white/5"
        >
          <Gauge className="size-3.5" />
          Usage
        </button>
        <button
          type="button"
          onClick={() => openSettingsTab('providers')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-white/5"
          data-testid="dashboard-manage-providers"
        >
          <Settings2 className="size-3.5" />
          {t('cliStatus.actions.manageProviders')}
        </button>
      </div>
    </div>
  );
};
