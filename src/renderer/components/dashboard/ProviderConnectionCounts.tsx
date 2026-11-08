import { useAppTranslation } from '@features/localization/renderer';

import type { DashboardConnectionSummary } from './providerConnectionSummary';
import type { CliInstallationStatus } from '@shared/types';

interface ProviderConnectionCountsProps {
  readonly summary: DashboardConnectionSummary;
  readonly cliStatus: Pick<CliInstallationStatus, 'installed' | 'authLoggedIn'> | null;
  readonly cliStatusLoading: boolean;
  readonly multimodelEnabled: boolean;
}

/** Shared compact evidence labels: never initiate checks or infer launch readiness. */
export const ProviderConnectionCounts = ({
  summary,
  cliStatus,
  cliStatusLoading,
  multimodelEnabled,
}: ProviderConnectionCountsProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const unknown = settingsT('runtimeProvider.badges.unknown');
  const cliSuffix = summary.cliCountPending ? t('cliStatus.provider.checkingProviders') : unknown;
  const cliText =
    cliStatus?.installed === false && !cliStatusLoading
      ? t('cliStatus.quickConnect.cliNotInstalled')
      : !multimodelEnabled
        ? cliStatus?.authLoggedIn
          ? t('cliStatus.provider.authenticated')
          : cliStatusLoading || !cliStatus
            ? t('cliStatus.provider.checkingAuthentication')
            : t('cliStatus.provider.connectToGetStarted')
        : summary.cliConnected === null
          ? cliSuffix
          : summary.cliCountComplete
            ? t('cliStatus.provider.connectedCount', { connected: summary.cliConnected })
            : `${t('cliStatus.provider.connectedCount', { connected: summary.cliConnected })} · ${unknown}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      <span data-testid="dashboard-main-provider-count" className={summary.cliCountComplete && (summary.cliConnected ?? 0) > 0 ? 'text-green-400' : undefined}>
        {multimodelEnabled ? 'Anthropic / Codex · ' : null}{cliText}
      </span>
      {multimodelEnabled && (
        <span data-testid="dashboard-opencode-provider-count" className={summary.openCodeConnected != null && summary.openCodeConnected > 0 ? 'text-green-400' : undefined}>
          OpenCode · {summary.openCodeConnected === null
            ? unknown
            : t('cliStatus.provider.connectedCount', { connected: summary.openCodeConnected })}
        </span>
      )}
    </div>
  );};
