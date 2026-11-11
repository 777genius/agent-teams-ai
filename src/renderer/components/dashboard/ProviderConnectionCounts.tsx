import { useAppTranslation } from '@features/localization/renderer';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { LoaderCircle } from 'lucide-react';

import type { DashboardConnectionSummary } from './providerConnectionSummary';
import type { CliInstallationStatus, CliProviderId } from '@shared/types';

interface ProviderConnectionCountsProps {
  readonly summary: DashboardConnectionSummary;
  readonly cliStatus: Pick<
    CliInstallationStatus,
    'installed' | 'authLoggedIn' | 'authStatusChecking' | 'providers'
  > | null;
  readonly cliStatusLoading: boolean;
  readonly providerStatusLoading: Partial<Record<CliProviderId, boolean>>;
  readonly multimodelEnabled: boolean;
  readonly openCodeIsChecking: boolean;
}

/** Shared compact evidence labels: never initiate checks or infer launch readiness. */
export const ProviderConnectionCounts = ({
  summary,
  cliStatus,
  cliStatusLoading,
  providerStatusLoading,
  multimodelEnabled,
  openCodeIsChecking,
}: ProviderConnectionCountsProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const unknown = settingsT('runtimeProvider.badges.unknown');
  const cliSuffix = summary.cliCountPending ? t('cliStatus.provider.checkingProviders') : unknown;
  const cliText =
    cliStatus?.installed === false && !cliStatusLoading
      ? t('cliStatus.quickConnect.cliNotInstalled')
      : !multimodelEnabled
        ? cliStatusLoading || !cliStatus || cliStatus.authStatusChecking
          ? t('cliStatus.provider.checkingAuthentication')
          : cliStatus.authLoggedIn
            ? t('cliStatus.provider.authenticated')
            : t('cliStatus.provider.connectToGetStarted')
        : summary.cliConnected === null
          ? cliSuffix
          : summary.cliCountComplete
            ? t('cliStatus.provider.connectedCount', { connected: summary.cliConnected })
            : `${t('cliStatus.provider.connectedCount', { connected: summary.cliConnected })} · ${unknown}`;

  const openCodeCount =
    summary.openCodeConnected ??
    (openCodeIsChecking ? summary.openCodePreviousConnected : undefined) ??
    summary.openCodeKnownConnected;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      <span
        data-testid="dashboard-main-provider-count"
        className={multimodelEnabled ? 'contents' : undefined}
      >
        {multimodelEnabled && !(cliStatus?.installed === false && !cliStatusLoading)
          ? (['anthropic', 'codex'] as const).map((id) => {
              const provider = cliStatus?.providers.find((item) => item.providerId === id);
              const checking =
                cliStatusLoading ||
                !cliStatus ||
                providerStatusLoading[id] === true ||
                provider?.statusCheckOutcome === 'pending' ||
                provider?.statusMessage === 'Checking...' ||
                provider?.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE;
              const connected =
                !checking &&
                provider?.authenticated === true &&
                (provider.statusCheckOutcome === 'authoritative' ||
                  provider.statusCheckOutcome === 'model_only' ||
                  (provider.statusCheckOutcome == null &&
                    provider.verificationState === 'verified'));
              return (
                <span
                  key={id}
                  data-testid={`dashboard-${id}-status`}
                  className={connected ? 'text-green-400' : undefined}
                >
                  {id === 'anthropic' ? 'Anthropic' : 'Codex'}
                  {checking ? (
                    <span
                      role="status"
                      aria-label={t('cliStatus.provider.checkingProviders')}
                      className="ml-1 inline-flex items-center align-middle"
                    >
                      <LoaderCircle
                        className="size-3.5 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                    </span>
                  ) : !connected && provider?.verificationState !== 'verified' ? (
                    ` · ${unknown}`
                  ) : null}
                </span>
              );
            })
          : cliText}
      </span>
      {multimodelEnabled && (
        <span
          data-testid="dashboard-opencode-provider-count"
          className={openCodeCount != null && openCodeCount > 0 ? 'text-green-400' : undefined}
        >
          OpenCode ·{' '}
          {openCodeCount != null &&
            t('cliStatus.provider.connectedCount', { connected: openCodeCount })}
          {openCodeIsChecking ? (
            <span
              data-testid="dashboard-opencode-count-loading"
              role="status"
              aria-label={t('cliStatus.provider.checkingProviders')}
              className={`inline-flex items-center align-middle ${openCodeCount != null ? 'ml-1' : ''}`}
            >
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            </span>
          ) : summary.openCodeConnected === null ? (
            <>
              {openCodeCount != null ? ' · ' : null}
              {unknown}
            </>
          ) : null}
        </span>
      )}
    </div>
  );
};
