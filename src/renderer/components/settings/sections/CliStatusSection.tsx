/**
 * CliStatusSection — CLI installation status and install/update controls.
 *
 * Displayed in Settings → Advanced, only in Electron mode.
 * Shows detection status, version info, download progress, and error states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import { getProviderRuntimeBackendSummary } from '@renderer/components/runtime/ProviderRuntimeBackendSelector';
import { SettingsToggle } from '@renderer/components/settings/components';
import { TerminalModal } from '@renderer/components/terminal/TerminalModal';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { formatBytes } from '@renderer/utils/formatters';
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

import type { CliProviderId, CliProviderStatus } from '@shared/types';

function formatModelBadgeLabel(providerId: CliProviderId, model: string): string {
  if (providerId === 'anthropic') {
    return model.replace(/^claude-/, '');
  }
  if (providerId === 'codex') {
    return model.replace(/^gpt-/, '');
  }
  if (providerId === 'gemini') {
    return model.replace(/^gemini-/, '');
  }
  return model;
}

function ModelBadges({
  providerId,
  models,
}: {
  providerId: CliProviderId;
  models: string[];
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((model) => (
        <span
          key={model}
          className="rounded-md border px-1.5 py-px font-mono text-[10px] leading-4"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {formatModelBadgeLabel(providerId, model)}
        </span>
      ))}
    </div>
  );
}

function ProviderDetailSkeleton(): React.JSX.Element {
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

function getProviderLabel(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
  }
}

function getProviderTerminalCommand(provider: CliProviderStatus): {
  args: string[];
  env?: Record<string, string>;
} {
  if (provider.providerId === 'gemini') {
    return {
      args: ['login'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  return {
    args: ['auth', 'login', '--provider', provider.providerId],
  };
}

function getProviderTerminalLogoutCommand(provider: CliProviderStatus): {
  args: string[];
  env?: Record<string, string>;
} {
  if (provider.providerId === 'gemini') {
    return {
      args: ['logout'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  return {
    args: ['auth', 'logout', '--provider', provider.providerId],
  };
}

export const CliStatusSection = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const appConfig = useStore((s) => s.appConfig);
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
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
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
  const [isSwitchingFlavor, setIsSwitchingFlavor] = useState(false);
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? true;
  const effectiveCliStatus =
    !cliStatus && cliStatusLoading && multimodelEnabled
      ? createLoadingMultimodelCliStatus()
      : cliStatus;
  const showInstalledControls =
    effectiveCliStatus !== null &&
    (installerState === 'idle' ||
      (installerState === 'completed' && effectiveCliStatus.installed === true));

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

  const handleInstall = useCallback(() => {
    installCli();
  }, [installCli]);

  const handleRefresh = useCallback(() => {
    void fetchCliStatus();
  }, [fetchCliStatus]);

  const handleProviderLogout = useCallback(async (providerId: CliProviderId) => {
    const confirmed = await confirm({
      title: `Logout from ${getProviderLabel(providerId)}?`,
      message: 'This will remove the current provider session from the local Claude CLI runtime.',
      confirmLabel: 'Logout',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });

    if (!confirmed) {
      return;
    }

    setProviderTerminal({
      providerId,
      action: 'logout',
    });
  }, []);

  const handleProviderManage = useCallback((providerId: CliProviderId) => {
    setManageProviderId(providerId);
    setManageDialogOpen(true);
  }, []);

  const recheckStatus = useCallback(() => {
    void (async () => {
      await invalidateCliStatus();
      await fetchCliStatus();
    })();
  }, [fetchCliStatus, invalidateCliStatus]);

  const handleMultimodelToggle = useCallback(
    async (enabled: boolean) => {
      setIsSwitchingFlavor(true);
      try {
        useStore.setState({
          cliStatus: enabled ? createLoadingMultimodelCliStatus() : null,
          cliStatusLoading: true,
          cliStatusError: null,
        });
        await updateConfig('general', { multimodelEnabled: enabled });
        await invalidateCliStatus();
        if (enabled) {
          await bootstrapCliStatus({ multimodelEnabled: true });
        } else {
          await fetchCliStatus();
        }
      } finally {
        setIsSwitchingFlavor(false);
      }
    },
    [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, updateConfig]
  );

  if (!isElectron) return null;

  const runtimeLabel =
    effectiveCliStatus?.flavor === 'free-code'
      ? null
      : effectiveCliStatus &&
          effectiveCliStatus.showVersionDetails &&
          effectiveCliStatus.installedVersion
        ? `${effectiveCliStatus.displayName} v${effectiveCliStatus.installedVersion ?? 'unknown'}`
        : (effectiveCliStatus?.displayName ?? 'Claude CLI');

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

  const handleRuntimeBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'auto' as const,
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
      await fetchCliProviderStatus(providerId);
    },
    [appConfig?.runtime?.providerBackends, fetchCliProviderStatus, updateConfig]
  );

  return (
    <div className="mb-2">
      <SettingsSectionHeader title="CLI Runtime" />
      <div className="space-y-3 py-2">
        {/* Loading status */}
        {!effectiveCliStatus && installerState === 'idle' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {multimodelEnabled ? 'Checking AI Providers...' : 'Checking Claude CLI...'}
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
                      Multimodel
                    </span>
                    {multimodelEnabled && (
                      <span
                        className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                        style={{
                          borderColor: 'rgba(245, 158, 11, 0.35)',
                          backgroundColor: 'rgba(245, 158, 11, 0.1)',
                          color: '#fbbf24',
                        }}
                      >
                        Beta
                      </span>
                    )}
                    <SettingsToggle
                      enabled={multimodelEnabled}
                      onChange={(value) => void handleMultimodelToggle(value)}
                      disabled={isBusy || cliStatusLoading || isSwitchingFlavor}
                    />
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
                      Update
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
                          Checking...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="size-3.5" />
                          Check for Updates
                        </>
                      )}
                    </button>
                  ) : null}
                  {/* Extensions button — right-aligned */}
                  {effectiveCliStatus.authLoggedIn && (
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
                      Extensions
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
                        v{effectiveCliStatus.installedVersion} &rarr; v
                        {effectiveCliStatus.latestVersion}
                      </span>
                    </div>
                  )}
                {effectiveCliStatus.providers.length > 0 && (
                  <div className="ml-6 mt-3 space-y-2">
                    {effectiveCliStatus.providers.map((provider) => (
                      <div
                        key={provider.providerId}
                        className="grid min-h-[132px] grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-md border px-3 py-2"
                        style={{
                          borderColor: 'var(--color-border-subtle)',
                          backgroundColor: 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        {(() => {
                          const providerLoading =
                            cliProviderStatusLoading[provider.providerId] === true;
                          const showSkeleton = isProviderCardLoading(provider, providerLoading);
                          const runtimeSummary = getProviderRuntimeBackendSummary(provider);

                          return (
                            <>
                              <div className="col-span-2 flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span
                                      className="font-medium"
                                      style={{ color: 'var(--color-text-secondary)' }}
                                    >
                                      {provider.displayName}
                                    </span>
                                    <span
                                      style={{
                                        color: provider.authenticated
                                          ? '#4ade80'
                                          : 'var(--color-text-muted)',
                                      }}
                                    >
                                      {provider.authenticated
                                        ? provider.authMethod
                                          ? `Authenticated via ${provider.authMethod}`
                                          : 'Authenticated'
                                        : provider.statusMessage || 'Not connected'}
                                    </span>
                                  </div>
                                  {showSkeleton ? (
                                    <ProviderDetailSkeleton />
                                  ) : (
                                    <div
                                      className="mt-1 flex min-h-[2.75rem] flex-wrap gap-x-3 gap-y-1 text-[11px]"
                                      style={{ color: 'var(--color-text-muted)' }}
                                    >
                                      {provider.backend?.label && (
                                        <span>Backend: {provider.backend.label}</span>
                                      )}
                                      {runtimeSummary ? (
                                        <span>Runtime: {runtimeSummary}</span>
                                      ) : null}
                                      {provider.models.length === 0 && (
                                        <span>Models unavailable for this runtime build</span>
                                      )}
                                    </div>
                                  )}
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
                                    Manage
                                  </button>
                                  {provider.authenticated && provider.canLoginFromUi ? (
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
                                      Logout
                                    </button>
                                  ) : provider.canLoginFromUi ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setProviderTerminal({
                                          providerId: provider.providerId,
                                          action: 'login',
                                        })
                                      }
                                      disabled={
                                        !effectiveCliStatus.binaryPath || !provider.canLoginFromUi
                                      }
                                      className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                      style={{
                                        borderColor: 'var(--color-border)',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                    >
                                      <LogIn className="size-3" />
                                      Login
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              {!showSkeleton && provider.models.length > 0 && (
                                <div className="col-span-2">
                                  <ModelBadges
                                    providerId={provider.providerId}
                                    models={provider.models}
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
                  initialProviderId={manageProviderId}
                  providerStatusLoading={cliProviderStatusLoading}
                  disabled={!effectiveCliStatus.binaryPath || isBusy || cliStatusLoading}
                  onSelectBackend={(providerId, backendId) => {
                    void handleRuntimeBackendChange(providerId, backendId);
                  }}
                  onRefreshProvider={(providerId) => fetchCliProviderStatus(providerId)}
                />
              </div>
            ) : (
              <div
                className="flex items-center gap-2 text-sm"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <AlertTriangle className="size-4 shrink-0" style={{ color: '#fbbf24' }} />
                Claude CLI not installed
              </div>
            )}

            {/* Install button (CLI not installed) */}
            {!effectiveCliStatus.installed && effectiveCliStatus.supportsSelfUpdate && (
              <button
                onClick={handleInstall}
                disabled={isBusy}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                style={{ backgroundColor: '#3b82f6' }}
              >
                <Download className="size-3.5" />
                Install Claude CLI
              </button>
            )}
            {!effectiveCliStatus.installed && !effectiveCliStatus.supportsSelfUpdate && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                The configured free-code runtime was not found.
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
              <span>Downloading...</span>
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
            Checking latest version...
          </div>
        )}

        {/* Verifying */}
        {installerState === 'verifying' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Verifying checksum...
          </div>
        )}

        {/* Installing */}
        {installerState === 'installing' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Installing...
          </div>
        )}

        {/* Completed */}
        {installerState === 'completed' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: '#4ade80' }}>
            <CheckCircle className="size-4" />
            Installed v{completedVersion ?? 'latest'}
          </div>
        )}

        {/* Error */}
        {installerState === 'error' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: '#f87171' }}>
              <AlertTriangle className="size-4" />
              {installerError ?? 'Installation failed'}
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
              Retry
            </button>
          </div>
        )}
      </div>
      {providerTerminal && cliStatus?.binaryPath && (
        <TerminalModal
          title={`${cliStatus.displayName} ${providerTerminal.action === 'login' ? 'Login' : 'Logout'}: ${getProviderLabel(
            providerTerminal.providerId
          )}`}
          command={cliStatus.binaryPath}
          args={providerTerminalCommand?.args}
          env={providerTerminalCommand?.env}
          onClose={() => {
            setProviderTerminal(null);
            recheckStatus();
          }}
          onExit={() => {
            recheckStatus();
          }}
          autoCloseOnSuccessMs={3000}
          successMessage={
            providerTerminal.action === 'login' ? 'Authentication updated' : 'Provider logged out'
          }
          failureMessage={
            providerTerminal.action === 'login' ? 'Authentication failed' : 'Logout failed'
          }
        />
      )}
    </div>
  );
};
