/**
 * CliStatusSection — CLI installation status and install/update controls.
 *
 * Displayed in Settings → Advanced, only in Electron mode.
 * Shows detection status, version info, download progress, and error states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  mergeCodexProviderStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { isCodexProviderRuntimeMissing } from '@renderer/components/runtime/codexRuntimeInstallAction';
import {
  formatProviderStatusText,
  getProviderConnectionModeSummary,
  getProviderConnectLabel,
  getProviderCredentialSummary,
  getProviderCurrentRuntimeSummary,
  getProviderDisconnectAction,
  isConnectionManagedRuntimeProvider,
  isOpenCodeCatalogHydrating,
  shouldMaskCodexNegativeBootstrapState,
  shouldShowProviderConnectAction,
  shouldShowProviderStatusSkeleton,
} from '@renderer/components/runtime/providerConnectionUi';
import { ProviderModelBadges } from '@renderer/components/runtime/ProviderModelBadges';
import {
  buildProviderRuntimeBackendSummaryText,
  getProviderRuntimeBackendSummary,
} from '@renderer/components/runtime/ProviderRuntimeBackendSelector';
import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import {
  getProviderTerminalCommand,
  getProviderTerminalLogoutCommand,
} from '@renderer/components/runtime/providerTerminalCommands';
import { TerminalModal } from '@renderer/components/terminal/TerminalModal';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { formatBytes } from '@renderer/utils/formatters';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import { getVisibleTeamProviderModels } from '@renderer/utils/teamModelCatalog';
import {
  AlertTriangle,
  CheckCircle,
  Download,
  Loader2,
  LogIn,
  LogOut,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';

import { SettingsSectionHeader } from '../components';

import type { AnalyticsProviderCheckReason } from '@renderer/analytics/productAnalytics';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

const ProviderDetailSkeleton = (): React.JSX.Element => {
  return (
    <div className="mt-1 space-y-2">
      <div
        className="skeleton-shimmer h-3 rounded-sm"
        style={{ width: '58%', backgroundColor: 'var(--skeleton-base)' }}
      />
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="skeleton-shimmer h-6 rounded-md border"
            style={{
              width: index === 0 ? 56 : index === 1 ? 84 : index === 2 ? 72 : 96,
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--skeleton-base-dim)',
            }}
          />
        ))}
      </div>
    </div>
  );
};

function isCodexSnapshotPending(
  provider: CliProviderStatus,
  codexSnapshotPending: boolean
): boolean {
  return provider.providerId === 'codex' && codexSnapshotPending;
}

function getProviderStatusColor(statusText: string, authenticated: boolean): string {
  if (statusText === 'Checking...') {
    return 'var(--color-text-secondary)';
  }

  return authenticated ? '#4ade80' : 'var(--color-text-muted)';
}

function getProviderLabel(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (200+ models)';
  }
}

export const CliStatusSection = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  const { t: commonT } = useAppTranslation('common');
  const runtimeBackendSummaryText = useMemo(
    () => buildProviderRuntimeBackendSummaryText(commonT),
    [commonT]
  );
  const isElectron = useMemo(() => isElectronMode(), []);
  const appConfig = useStore((s) => s.appConfig);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const repositoryGroups = useStore((s) => s.repositoryGroups);
  const openExtensionsTab = useStore((s) => s.openExtensionsTab);
  const updateConfig = useStore((s) => s.updateConfig);
  const {
    cliStatus,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    completedVersion,
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    fetchCodexRuntimeStatus,
    installCodexRuntime,
    installCli,
    isBusy,
    cliStatusLoading,
    cliProviderStatusLoading,
    invalidateCliStatus,
  } = useCliInstaller();
  const [providerTerminal, setProviderTerminal] = useState<{
    providerId: CliProviderId;
    action: 'login' | 'logout';
  } | null>(null);
  const [manageProviderId, setManageProviderId] = useState<CliProviderId>('gemini');
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? true;
  const selectedProjectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [projects, repositoryGroups, selectedProjectId]
  );
  const loadingCliStatus =
    !cliStatus && cliStatusLoading && multimodelEnabled
      ? createLoadingMultimodelCliStatus()
      : cliStatus;
  const codexAccount = useCodexAccountSnapshot({
    enabled:
      isElectron &&
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
    includeRateLimits: true,
  });
  const codexSnapshotPending =
    codexAccount.loading &&
    Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')) &&
    !codexAccount.snapshot;
  const effectiveCliStatus = useMemo(
    () =>
      loadingCliStatus
        ? {
            ...loadingCliStatus,
            providers: loadingCliStatus.providers.map((provider) =>
              provider.providerId === 'codex'
                ? mergeCodexProviderStatusWithSnapshot(provider, codexAccount.snapshot)
                : provider
            ),
          }
        : loadingCliStatus,
    [codexAccount.snapshot, loadingCliStatus]
  );
  const visibleEffectiveProviders = useMemo(
    () => filterMainScreenCliProviders(effectiveCliStatus?.providers ?? []),
    [effectiveCliStatus?.providers]
  );
  const loadingCliProviderMap = useMemo(
    () =>
      new Map(
        filterMainScreenCliProviders(loadingCliStatus?.providers ?? []).map((provider) => [
          provider.providerId,
          provider,
        ])
      ),
    [loadingCliStatus?.providers]
  );
  const canOpenExtensions = effectiveCliStatus?.installed === true;
  const showInstalledControls =
    effectiveCliStatus !== null && (installerState === 'idle' || installerState === 'completed');

  useEffect(() => {
    if (isElectron) {
      if (!cliStatus) {
        if (multimodelEnabled) {
          void bootstrapCliStatus({ multimodelEnabled: true });
        } else {
          void fetchCliStatus();
        }
      }
    }
  }, [bootstrapCliStatus, cliStatus, fetchCliStatus, isElectron, multimodelEnabled]);

  useEffect(() => {
    if (!isElectron || codexRuntimeStatus || codexRuntimeStatusLoading) {
      return;
    }

    if (visibleEffectiveProviders.some(isCodexProviderRuntimeMissing)) {
      void fetchCodexRuntimeStatus();
    }
  }, [
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    fetchCodexRuntimeStatus,
    isElectron,
    visibleEffectiveProviders,
  ]);

  const handleInstall = useCallback(() => {
    installCli();
  }, [installCli]);

  const handleRefresh = useCallback(() => {
    void (async () => {
      await invalidateCliStatus();
      await refreshCliStatusForCurrentMode({
        multimodelEnabled,
        bootstrapCliStatus,
        fetchCliStatus,
      });
    })();
  }, [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled]);

  const handleProviderRefresh = useCallback(
    async (
      providerId: CliProviderId,
      checkReason: AnalyticsProviderCheckReason = 'manual_refresh'
    ) => {
      await invalidateCliStatus();
      return fetchCliProviderStatus(providerId, { checkReason });
    },
    [fetchCliProviderStatus, invalidateCliStatus]
  );

  const handleProviderLogout = useCallback(
    async (providerId: CliProviderId) => {
      const provider =
        effectiveCliStatus?.providers.find((entry) => entry.providerId === providerId) ?? null;
      const disconnectAction = provider ? getProviderDisconnectAction(provider, t) : null;
      if (!disconnectAction) {
        return;
      }

      const confirmed = await confirm({
        title: disconnectAction.title,
        message: disconnectAction.message,
        confirmLabel: disconnectAction.confirmLabel,
        cancelLabel: t('providerRuntime.actions.cancel'),
        variant: 'danger',
      });

      if (!confirmed) {
        return;
      }

      setProviderTerminal({
        providerId,
        action: 'logout',
      });
    },
    [effectiveCliStatus?.providers, t]
  );

  const handleProviderManage = useCallback((providerId: CliProviderId) => {
    setManageProviderId(providerId);
    setManageDialogOpen(true);
  }, []);

  const recheckStatus = useCallback(() => {
    void (async () => {
      await invalidateCliStatus();
      await refreshCliStatusForCurrentMode({
        multimodelEnabled,
        bootstrapCliStatus,
        fetchCliStatus,
      });
    })();
  }, [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled]);

  const handleRuntimeBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'codex-native' as const,
      };

      if (providerId !== 'gemini' && providerId !== 'codex') {
        return;
      }

      await updateConfig('runtime', {
        providerBackends: {
          ...currentBackends,
          [providerId]: backendId,
        },
      });

      try {
        const refreshed = await fetchCliProviderStatus(providerId, {
          checkReason: 'manual_refresh',
        });
        if (!refreshed) {
          throw new Error('Provider status refresh failed');
        }
      } catch {
        throw new Error('Runtime updated, but failed to refresh provider status.');
      }
    },
    [appConfig?.runtime?.providerBackends, fetchCliProviderStatus, updateConfig]
  );

  if (!isElectron) return null;

  const runtimeDisplayName = getRuntimeDisplayName(effectiveCliStatus, multimodelEnabled);
  const runtimeLabel =
    effectiveCliStatus?.flavor === 'agent_teams_orchestrator'
      ? null
      : effectiveCliStatus &&
          effectiveCliStatus.showVersionDetails &&
          effectiveCliStatus.installedVersion
        ? `${runtimeDisplayName} v${effectiveCliStatus.installedVersion ?? 'unknown'}`
        : runtimeDisplayName;

  const activeTerminalProvider = providerTerminal
    ? (effectiveCliStatus?.providers.find(
        (provider) => provider.providerId === providerTerminal.providerId
      ) ?? null)
    : null;
  const providerTerminalCommand =
    providerTerminal && activeTerminalProvider
      ? providerTerminal.action === 'login'
        ? getProviderTerminalCommand(activeTerminalProvider)
        : getProviderTerminalLogoutCommand(activeTerminalProvider)
      : null;

  return (
    <div className="mb-2">
      <SettingsSectionHeader title={t('cliRuntime.title')} />
      <div className="space-y-3 py-2">
        {/* Loading status */}
        {!effectiveCliStatus && installerState === 'idle' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {multimodelEnabled
              ? t('cliRuntime.loading.aiProviders')
              : t('cliRuntime.loading.claudeCli')}
          </div>
        )}

        {/* Status display */}
        {showInstalledControls && effectiveCliStatus && (
          <div className="space-y-2">
            {effectiveCliStatus.installed ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <Terminal
                    className="size-4 shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}
                  />
                  {runtimeLabel && (
                    <span style={{ color: 'var(--color-text)' }}>{runtimeLabel}</span>
                  )}
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs font-medium"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('cliRuntime.labels.multimodel')}
                    </span>
                  </div>
                  {/* Inline action buttons */}
                  {effectiveCliStatus.supportsSelfUpdate && effectiveCliStatus.updateAvailable ? (
                    <button
                      onClick={handleInstall}
                      disabled={isBusy}
                      className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium text-white transition-colors disabled:opacity-50"
                      style={{ backgroundColor: '#3b82f6' }}
                    >
                      <Download className="size-3.5" />
                      {t('cliRuntime.actions.update')}
                    </button>
                  ) : effectiveCliStatus.supportsSelfUpdate ? (
                    <button
                      onClick={handleRefresh}
                      disabled={cliStatusLoading}
                      className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                      style={{
                        borderColor: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {cliStatusLoading ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          {t('cliRuntime.actions.checking')}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="size-3.5" />
                          {t('cliRuntime.actions.checkForUpdates')}
                        </>
                      )}
                    </button>
                  ) : null}
                  {/* Extensions button — right-aligned */}
                  {canOpenExtensions && (
                    <button
                      type="button"
                      onClick={openExtensionsTab}
                      className="ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
                      style={{
                        borderColor: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      <Puzzle className="size-3.5" />
                      {t('cliRuntime.actions.extensions')}
                    </button>
                  )}
                </div>
                {effectiveCliStatus.showBinaryPath && effectiveCliStatus.binaryPath && (
                  <p
                    className="ml-6 truncate text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={effectiveCliStatus.binaryPath}
                  >
                    {effectiveCliStatus.binaryPath}
                  </p>
                )}
                {effectiveCliStatus.supportsSelfUpdate &&
                  effectiveCliStatus.updateAvailable &&
                  effectiveCliStatus.latestVersion && (
                    <div className="ml-6 flex items-center gap-2">
                      <span className="text-xs" style={{ color: '#60a5fa' }}>
                        {t('cliStatus.versionUpgrade', {
                          current: effectiveCliStatus.installedVersion,
                          latest: effectiveCliStatus.latestVersion,
                        })}
                      </span>
                    </div>
                  )}
                {visibleEffectiveProviders.length > 0 && (
                  <div className="ml-6 mt-3 space-y-2">
                    {visibleEffectiveProviders.map((provider) => (
                      <div
                        key={provider.providerId}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-md border px-3 py-2"
                        style={{
                          borderColor: 'var(--color-border-subtle)',
                          backgroundColor: 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        {(() => {
                          const providerLoading =
                            cliProviderStatusLoading[provider.providerId] === true;
                          const showSkeleton =
                            shouldShowProviderStatusSkeleton(provider, providerLoading) ||
                            isCodexSnapshotPending(provider, codexSnapshotPending);
                          const runtimeSummary = isConnectionManagedRuntimeProvider(provider)
                            ? getProviderCurrentRuntimeSummary(provider, t)
                            : getProviderRuntimeBackendSummary(provider, runtimeBackendSummaryText);
                          const sourceProvider =
                            loadingCliProviderMap.get(provider.providerId) ?? null;
                          const maskNegativeBootstrapState = shouldMaskCodexNegativeBootstrapState(
                            sourceProvider,
                            provider,
                            { providerLoading }
                          );
                          const effectiveShowSkeleton = showSkeleton || maskNegativeBootstrapState;
                          const statusText = effectiveShowSkeleton
                            ? t('providerRuntime.connectionUi.status.checking')
                            : formatProviderStatusText(provider, t);
                          const modelCatalogLoading =
                            provider.modelCatalogRefreshState === 'loading' ||
                            isOpenCodeCatalogHydrating(provider);
                          const hasProviderModels =
                            provider.providerId === 'opencode'
                              ? getVisibleTeamProviderModels(
                                  provider.providerId,
                                  provider.models,
                                  provider
                                ).length > 0
                              : provider.models.length > 0;
                          const connectionModeSummary = getProviderConnectionModeSummary(
                            provider,
                            t
                          );
                          const credentialSummary = getProviderCredentialSummary(provider, t);
                          const disconnectAction = getProviderDisconnectAction(provider, t);
                          const hasDetailContent = Boolean(
                            (provider.backend?.label && !runtimeSummary) ||
                            runtimeSummary ||
                            connectionModeSummary ||
                            credentialSummary ||
                            !hasProviderModels ||
                            modelCatalogLoading
                          );

                          return (
                            <>
                              <div className="col-span-2 flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                                    <span className="flex min-w-0 items-center gap-2">
                                      <ProviderBrandLogo
                                        providerId={provider.providerId}
                                        className="size-4 shrink-0"
                                      />
                                      <span
                                        className="truncate whitespace-nowrap font-medium"
                                        style={{ color: 'var(--color-text-secondary)' }}
                                      >
                                        {provider.displayName}
                                      </span>
                                    </span>
                                    <span
                                      className="whitespace-nowrap"
                                      style={{
                                        color: getProviderStatusColor(
                                          statusText,
                                          provider.authenticated
                                        ),
                                      }}
                                    >
                                      {statusText}
                                    </span>
                                  </div>
                                  {effectiveShowSkeleton ? (
                                    <ProviderDetailSkeleton />
                                  ) : hasDetailContent ? (
                                    <div
                                      className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]"
                                      style={{ color: 'var(--color-text-muted)' }}
                                    >
                                      {provider.backend?.label && !runtimeSummary && (
                                        <span>
                                          {t('cliRuntime.provider.backend', {
                                            backend: provider.backend.label,
                                          })}
                                        </span>
                                      )}
                                      {runtimeSummary ? (
                                        <span>
                                          {isConnectionManagedRuntimeProvider(provider)
                                            ? runtimeSummary
                                            : t('cliRuntime.provider.runtime', {
                                                runtime: runtimeSummary,
                                              })}
                                        </span>
                                      ) : null}
                                      {connectionModeSummary ? (
                                        <span>{connectionModeSummary}</span>
                                      ) : null}
                                      {credentialSummary ? <span>{credentialSummary}</span> : null}
                                      {modelCatalogLoading ? (
                                        <span>{t('cliRuntime.provider.loadingModels')}</span>
                                      ) : null}
                                      {!hasProviderModels && !modelCatalogLoading && (
                                        <span>{t('cliRuntime.provider.modelsUnavailable')}</span>
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="flex shrink-0 items-start gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleProviderManage(provider.providerId)}
                                    disabled={!effectiveCliStatus.binaryPath}
                                    className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                    style={{
                                      borderColor: 'var(--color-border)',
                                      color: 'var(--color-text-secondary)',
                                    }}
                                  >
                                    <SlidersHorizontal className="size-3" />
                                    {t('cliRuntime.actions.manage')}
                                  </button>
                                  {disconnectAction ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleProviderLogout(provider.providerId)}
                                      disabled={!effectiveCliStatus.binaryPath}
                                      className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                      style={{
                                        borderColor: 'var(--color-border)',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                    >
                                      <LogOut className="size-3" />
                                      {disconnectAction.label}
                                    </button>
                                  ) : !effectiveShowSkeleton &&
                                    shouldShowProviderConnectAction(provider) ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setProviderTerminal({
                                          providerId: provider.providerId,
                                          action: 'login',
                                        })
                                      }
                                      disabled={!effectiveCliStatus.binaryPath}
                                      className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                      style={{
                                        borderColor: 'var(--color-border)',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                    >
                                      <LogIn className="size-3" />
                                      {getProviderConnectLabel(provider, t)}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              {!effectiveShowSkeleton &&
                                !modelCatalogLoading &&
                                hasProviderModels && (
                                  <div className="col-span-2">
                                    <ProviderModelBadges
                                      providerId={provider.providerId}
                                      models={provider.models}
                                      modelAvailability={provider.modelAvailability}
                                      providerStatus={provider}
                                    />
                                  </div>
                                )}
                            </>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
                <ProviderRuntimeSettingsDialog
                  open={manageDialogOpen}
                  onOpenChange={setManageDialogOpen}
                  providers={effectiveCliStatus.providers}
                  projectPath={selectedProjectPath}
                  initialProviderId={manageProviderId}
                  providerStatusLoading={cliProviderStatusLoading}
                  disabled={!effectiveCliStatus.binaryPath || isBusy || cliStatusLoading}
                  codexRuntimeStatus={codexRuntimeStatus}
                  codexRuntimeStatusLoading={codexRuntimeStatusLoading}
                  onInstallCodexRuntime={() => installCodexRuntime()}
                  onSelectBackend={handleRuntimeBackendChange}
                  onRefreshProvider={handleProviderRefresh}
                  onRequestLogin={(providerId) =>
                    setProviderTerminal({ providerId, action: 'login' })
                  }
                />
              </div>
            ) : (
              <div className="space-y-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0" style={{ color: '#fbbf24' }} />
                  {effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
                    ? t('cliRuntime.status.foundButFailed', { runtime: runtimeDisplayName })
                    : t('cliRuntime.status.notInstalled', { runtime: runtimeDisplayName })}
                </div>
                {effectiveCliStatus.showBinaryPath && effectiveCliStatus.binaryPath && (
                  <div className="break-all font-mono text-xs text-text-muted">
                    {effectiveCliStatus.binaryPath}
                  </div>
                )}
                {effectiveCliStatus.launchError && (
                  <div
                    className="rounded border px-2 py-1.5 font-mono text-xs"
                    style={{
                      borderColor: 'rgba(245, 158, 11, 0.25)',
                      backgroundColor: 'rgba(245, 158, 11, 0.06)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {effectiveCliStatus.launchError}
                  </div>
                )}
              </div>
            )}

            {/* Install button (CLI not installed) */}
            {!effectiveCliStatus.installed && effectiveCliStatus.supportsSelfUpdate && (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleRefresh}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
                  style={{
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <RefreshCw className="size-3.5" />
                  {t('cliRuntime.actions.recheck')}
                </button>
                <button
                  onClick={handleInstall}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#3b82f6' }}
                >
                  <Download className="size-3.5" />
                  {effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
                    ? t('cliRuntime.actions.reinstallRuntime', { runtime: runtimeDisplayName })
                    : t('cliRuntime.actions.installRuntime', { runtime: runtimeDisplayName })}
                </button>
              </div>
            )}
            {!effectiveCliStatus.installed && !effectiveCliStatus.supportsSelfUpdate && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
                  ? t('cliRuntime.status.healthCheckFailed', { runtime: runtimeDisplayName })
                  : t('cliRuntime.status.configuredNotFound', { runtime: runtimeDisplayName })}
              </p>
            )}
          </div>
        )}

        {/* Downloading */}
        {installerState === 'downloading' && (
          <div className="space-y-2">
            <div
              className="flex items-center justify-between text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <span>{t('cliRuntime.installer.downloading')}</span>
              <span>
                {downloadTotal > 0
                  ? `${formatBytes(downloadTransferred)} / ${formatBytes(downloadTotal)} (${downloadProgress}%)`
                  : `${formatBytes(downloadTransferred)}`}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              {downloadTotal > 0 ? (
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress}%`,
                    backgroundColor: '#3b82f6',
                  }}
                />
              ) : (
                <div
                  className="h-full w-1/3 animate-pulse rounded-full"
                  style={{ backgroundColor: '#3b82f6' }}
                />
              )}
            </div>
          </div>
        )}

        {/* Checking */}
        {installerState === 'checking' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {t('cliRuntime.installer.checkingLatest')}
          </div>
        )}

        {/* Verifying */}
        {installerState === 'verifying' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {t('cliRuntime.installer.verifying')}
          </div>
        )}

        {/* Installing */}
        {installerState === 'installing' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {t('cliRuntime.installer.installing')}
          </div>
        )}

        {/* Completed */}
        {installerState === 'completed' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: '#4ade80' }}>
            <CheckCircle className="size-4" />
            {t('cliRuntime.installer.installed', {
              version: completedVersion ?? t('cliRuntime.installer.latest'),
            })}
          </div>
        )}

        {/* Error */}
        {installerState === 'error' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: '#f87171' }}>
              <AlertTriangle className="size-4" />
              {installerError ?? t('cliRuntime.installer.failed')}
            </div>
            <button
              onClick={handleInstall}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <RefreshCw className="size-3.5" />
              {t('cliRuntime.actions.retry')}
            </button>
          </div>
        )}
      </div>
      {providerTerminal && cliStatus?.binaryPath && (
        <TerminalModal
          title={`${getRuntimeDisplayName(cliStatus, multimodelEnabled)} ${
            providerTerminal.action === 'login'
              ? t('cliRuntime.providerTerminal.login')
              : t('cliRuntime.providerTerminal.logout')
          }: ${getProviderLabel(providerTerminal.providerId)}`}
          command={cliStatus.binaryPath}
          args={providerTerminalCommand?.args}
          env={providerTerminalCommand?.env}
          onClose={() => {
            setProviderTerminal(null);
            recheckStatus();
          }}
          autoCloseOnSuccessMs={3000}
          successMessage={
            providerTerminal.action === 'login'
              ? t('cliRuntime.providerTerminal.authUpdated')
              : t('cliRuntime.providerTerminal.loggedOut')
          }
          failureMessage={
            providerTerminal.action === 'login'
              ? t('cliRuntime.providerTerminal.authFailed')
              : t('cliRuntime.providerTerminal.logoutFailed')
          }
        />
      )}
    </div>
  );
};
