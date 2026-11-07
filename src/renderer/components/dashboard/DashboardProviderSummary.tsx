import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useRuntimeProviderDirectoryCache } from '@features/runtime-provider-management/renderer';
import { isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { Settings2 } from 'lucide-react';

import {
  DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS,
  getDashboardConnectionSummary,
} from './providerConnectionSummary';

export const DashboardProviderSummary = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const cliStatus = useStore((state) => state.cliStatus);
  const cliStatusLoading = useStore((state) => state.cliStatusLoading);
  const cliStatusError = useStore((state) => state.cliStatusError);
  const cliProviderStatusLoading = useStore((state) => state.cliProviderStatusLoading);
  const openCodeRuntimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const openSettingsTab = useStore((state) => state.openSettingsTab);
  const selectedProjectId = useStore((state) => state.selectedProjectId);
  const projects = useStore((state) => state.projects);
  const repositoryGroups = useStore((state) => state.repositoryGroups);
  const multimodelEnabled = useStore((state) => state.appConfig?.general?.multimodelEnabled ?? true);
  const projectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [selectedProjectId, projects, repositoryGroups]
  );
  // Existing in-memory snapshots only; these hooks never start an IPC read.
  const globalDirectory = useRuntimeProviderDirectoryCache(null);
  const projectDirectory = useRuntimeProviderDirectoryCache(projectPath);
  const [, setExpiredRevision] = useState(0);
  useEffect(() => {
    const expiries = [globalDirectory, ...(projectPath ? [projectDirectory] : [])]
      .map((snapshot) => Date.parse(snapshot?.fetchedAt ?? '') + DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS)
      .filter((expiry) => Number.isFinite(expiry) && expiry > Date.now());
    if (expiries.length === 0) return;
    const nextExpiry = Math.min(...expiries);
    // A one-shot display expiry timer is not provider polling or an IPC read.
    const timer = window.setTimeout(
      () => setExpiredRevision((revision) => revision + 1),
      Math.max(1, nextExpiry - Date.now() + 10)
    );
    return () => window.clearTimeout(timer);
  }, [globalDirectory, projectDirectory, projectPath]);
  const summary = getDashboardConnectionSummary({
    cliStatus,
    cliStatusLoading,
    providerStatusLoading: cliProviderStatusLoading,
    projectPath,
    globalDirectory,
    projectDirectory,
    runtimeStatus: openCodeRuntimeStatus,
  });

  if (!isElectronMode()) return null;

  const unknown = settingsT('runtimeProvider.badges.unknown');
  const mainText =
    !multimodelEnabled
      ? cliStatus?.authLoggedIn
        ? t('cliStatus.provider.authenticated')
        : cliStatusLoading || !cliStatus
          ? t('cliStatus.provider.checkingAuthentication')
          : t('cliStatus.provider.connectToGetStarted')
      : summary.cliConnected === null
        ? t('cliStatus.provider.checkingProviders')
        : summary.cliCountComplete
          ? t('cliStatus.provider.connectedCount', { connected: summary.cliConnected })
          : `${t('cliStatus.provider.connectedCount', {
              connected: summary.cliConnected,
            })} · ${t('cliStatus.provider.checkingProviders')}`;
  const openCodeText =
    multimodelEnabled &&
    (summary.openCodeConnected === null
      ? `${t('cliStatus.quickConnect.checkingOpenCode')}: ${unknown}`
      : `OpenCode · ${t('cliStatus.provider.connectedCount', {
          connected: summary.openCodeConnected,
        })}`);

  return (
    <div
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface-raised)' }}
      data-testid="dashboard-provider-summary"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">
          {settingsT('runtimeProvider.tabs.providers')}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          <span data-testid="dashboard-main-provider-count">{mainText}</span>
          {openCodeText && <span data-testid="dashboard-opencode-provider-count">{openCodeText}</span>}
        </div>
        {cliStatusError && (
          <p className="mt-1 text-xs text-amber-400" role="status">
            {t('cliStatus.errors.checkStatusFailed')}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => openSettingsTab('providers')}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-white/5"
        data-testid="dashboard-manage-providers"
      >
        <Settings2 className="size-3.5" />
        {t('cliStatus.actions.manageProviders')}
      </button>
    </div>
  );
};
