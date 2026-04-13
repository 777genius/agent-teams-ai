/**
 * CliStatusBanner — CLI installation status banner for the Dashboard.
 *
 * Shown on the main screen before project search.
 * Displays CLI version/path when installed, or a red error with install button when not.
 * Shows live detail text for every phase and a mini log panel during installation.
 * Only rendered in Electron mode.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import {
  formatProviderStatusText,
  getProviderConnectionModeSummary,
  getProviderConnectLabel,
  getProviderCredentialSummary,
  getProviderCurrentRuntimeSummary,
  getProviderDisconnectAction,
  isConnectionManagedRuntimeProvider,
  shouldShowProviderConnectAction,
} from '@renderer/components/runtime/providerConnectionUi';
import { getProviderRuntimeBackendSummary } from '@renderer/components/runtime/ProviderRuntimeBackendSelector';
import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import { SettingsToggle } from '@renderer/components/settings/components';
import { TerminalLogPanel } from '@renderer/components/terminal/TerminalLogPanel';
import { TerminalModal } from '@renderer/components/terminal/TerminalModal';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { formatBytes } from '@renderer/utils/formatters';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import {
  getTeamModelBadgeLabel,
  getVisibleTeamProviderModels,
} from '@renderer/utils/teamModelCatalog';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Download,
  HelpCircle,
  Loader2,
  LogIn,
  LogOut,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

// =============================================================================
// Border color by state
// =============================================================================

type BannerVariant = 'loading' | 'error' | 'success' | 'info' | 'warning';

const VARIANT_STYLES: Record<BannerVariant, { border: string; bg: string }> = {
  loading: { border: 'var(--color-border)', bg: 'transparent' },
  error: { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)' },
  success: { border: '#22c55e', bg: 'rgba(34, 197, 94, 0.04)' },
  info: { border: 'var(--info-border)', bg: 'var(--info-bg)' },
  warning: { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.06)' },
};

/** Minimum banner height — prevents layout shift between states (loading → installed → checking). */
const BANNER_MIN_H = 'min-h-[4.25rem]';

// =============================================================================
// Sub-components
// =============================================================================

/** Detail text shown under the main status line */
const DetailLine = ({ text }: { text: string | null }): React.JSX.Element | null => {
  if (!text) return null;
  return (
    <p className="mt-1 truncate font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>
      {text}
    </p>
  );
};

const InstallCompletedNotice = ({ version }: { version: string | null }): React.JSX.Element => (
  <div
    className={`mb-6 flex items-center gap-3 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
    style={{
      borderColor: VARIANT_STYLES.success.border,
      backgroundColor: VARIANT_STYLES.success.bg,
    }}
  >
    <CheckCircle className="size-4 shrink-0" style={{ color: '#4ade80' }} />
    <span className="text-sm" style={{ color: '#4ade80' }}>
      Successfully installed Claude CLI v{version ?? 'latest'}
    </span>
  </div>
);

/** Error display with multi-line support */
const ErrorDisplay = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): React.JSX.Element => {
  const lines = error.split('\n');
  const title = lines[0];
  const details = lines.slice(1).filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: '#f87171' }} />
          <div className="min-w-0">
            <p className="text-sm font-medium" style={{ color: '#f87171' }}>
              {title}
            </p>
            {details.length > 0 && (
              <div
                className="mt-1.5 rounded border px-2 py-1.5 font-mono text-xs leading-relaxed"
                style={{
                  borderColor: 'rgba(239, 68, 68, 0.2)',
                  backgroundColor: 'rgba(239, 68, 68, 0.04)',
                  color: 'var(--color-text-muted)',
                }}
              >
                {details.map((line, i) => (
                  <div key={i} className="break-all">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    </div>
  );
};

// =============================================================================
// CLI checking spinner with delayed hint
// =============================================================================

const SLOW_CHECK_DELAY_MS = 5_000;

const CliCheckingSpinner = ({
  styles,
  label,
}: {
  styles: { border: string; bg: string };
  label: string;
}): React.JSX.Element => {
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), SLOW_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`mb-6 flex items-center gap-3 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
      style={{ borderColor: styles.border, backgroundColor: styles.bg }}
    >
      <Loader2
        className="size-4 shrink-0 animate-spin"
        style={{ color: 'var(--color-text-muted)' }}
      />
      <div>
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {label}
        </span>
        {showHint && (
          <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
            First check may take up to 30 seconds
          </p>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Installed banner (extracted sub-component)
// =============================================================================

interface InstalledBannerProps {
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Partial<Record<CliProviderId, boolean>>;
  cliStatusError: string | null;
  isBusy: boolean;
  multimodelEnabled: boolean;
  multimodelBusy: boolean;
  onInstall: () => void;
  onRefresh: () => void;
  onMultimodelToggle: (enabled: boolean) => void;
  onProviderLogin: (providerId: CliProviderId) => void;
  onProviderLogout: (providerId: CliProviderId) => void;
  onProviderManage: (providerId: CliProviderId) => void;
  onProviderRefresh: (providerId: CliProviderId) => void;
  variant: BannerVariant;
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

function formatModelBadgeLabel(providerId: CliProviderId, model: string): string {
  return getTeamModelBadgeLabel(providerId, model) ?? model;
}

const ModelBadges = ({
  providerId,
  models,
}: {
  readonly providerId: CliProviderId;
  readonly models: string[];
}): React.JSX.Element => {
  const visibleModels = getVisibleTeamProviderModels(providerId, models);
  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleModels.map((model) => (
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
};

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

function isProviderCardLoading(provider: CliProviderStatus, providerLoading: boolean): boolean {
  return (
    providerLoading ||
    (!provider.authenticated &&
      provider.statusMessage === 'Checking...' &&
      provider.models.length === 0 &&
      provider.backend == null)
  );
}

function getApiKeyActionRequiredProviders(
  providers: readonly CliProviderStatus[]
): CliProviderStatus[] {
  return providers.filter(
    (provider) => !provider.authenticated && provider.connection?.configuredAuthMode === 'api_key'
  );
}

function formatRuntimeLabel(
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>
): string | null {
  if (cliStatus.flavor === 'agent_teams_orchestrator') {
    return null;
  }

  return cliStatus.showVersionDetails && cliStatus.installedVersion
    ? `${cliStatus.displayName} v${cliStatus.installedVersion ?? 'unknown'}`
    : cliStatus.displayName;
}

function formatRuntimeAuthSummary(
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>,
  visibleProviders: readonly CliProviderStatus[]
): string | null {
  if (cliStatus.flavor === 'agent_teams_orchestrator' && visibleProviders.length > 0) {
    if (
      visibleProviders.every(
        (provider) => provider.statusMessage === 'Checking...' && !provider.authenticated
      )
    ) {
      return 'Checking providers...';
    }
    const denominator = visibleProviders.length;
    const connected = visibleProviders.filter((provider) => provider.authenticated).length;

    return `Providers: ${connected}/${denominator} connected`;
  }

  if (cliStatus.authStatusChecking) {
    return 'Checking authentication...';
  }

  if (cliStatus.authLoggedIn) {
    return 'Authenticated';
  }

  return null;
}

function isCheckingMultimodelStatus(
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>,
  visibleProviders: readonly CliProviderStatus[]
): boolean {
  return (
    cliStatus.flavor === 'agent_teams_orchestrator' &&
    visibleProviders.length > 0 &&
    visibleProviders.every(
      (provider) => provider.statusMessage === 'Checking...' && !provider.authenticated
    )
  );
}

const InstalledBanner = ({
  cliStatus,
  cliStatusLoading,
  cliProviderStatusLoading,
  cliStatusError,
  isBusy,
  multimodelEnabled,
  multimodelBusy,
  onInstall,
  onRefresh,
  onMultimodelToggle,
  onProviderLogin,
  onProviderLogout,
  onProviderManage,
  onProviderRefresh,
  variant,
}: InstalledBannerProps): React.JSX.Element => {
  const openExtensionsTab = useStore((s) => s.openExtensionsTab);
  const styles = VARIANT_STYLES[variant];
  const visibleProviders = useMemo(
    () => filterMainScreenCliProviders(cliStatus.providers),
    [cliStatus.providers]
  );
  const runtimeLabel = formatRuntimeLabel(cliStatus);
  const runtimeAuthSummary = formatRuntimeAuthSummary(cliStatus, visibleProviders);

  return (
    <div
      className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
      style={{ borderColor: styles.border, backgroundColor: styles.bg }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Terminal className="size-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {runtimeLabel && (
                <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                  {runtimeLabel}
                </span>
              )}

              {/* Update / Check for Updates — inline next to version */}
              {cliStatus.supportsSelfUpdate && cliStatus.updateAvailable ? (
                <button
                  onClick={onInstall}
                  disabled={isBusy}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#3b82f6' }}
                >
                  <Download className="size-3" />
                  Update to v{cliStatus.latestVersion}
                </button>
              ) : cliStatus.supportsSelfUpdate ? (
                <button
                  onClick={onRefresh}
                  disabled={cliStatusLoading}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-white/5 disabled:opacity-50"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <RefreshCw className={cliStatusLoading ? 'size-3 animate-spin' : 'size-3'} />
                  {cliStatusLoading ? 'Checking...' : 'Check for Updates'}
                </button>
              ) : null}

              {runtimeAuthSummary && (
                <span className="text-xs" style={{ color: '#4ade80' }}>
                  {runtimeAuthSummary}
                </span>
              )}
            </div>
            {cliStatus.showBinaryPath && cliStatus.binaryPath && (
              <button
                className="truncate font-mono text-xs hover:underline"
                style={{ color: 'var(--color-text-muted)' }}
                title={`Reveal in file manager: ${cliStatus.binaryPath}`}
                onClick={() => void api.showInFolder(cliStatus.binaryPath!)}
              >
                {cliStatus.binaryPath}
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-8">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
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
              onChange={onMultimodelToggle}
              disabled={isBusy || cliStatusLoading || multimodelBusy}
            />
          </div>
          {/* Extensions button — only when installed + authenticated */}
          {cliStatus.authLoggedIn && (
            <button
              onClick={openExtensionsTab}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <Puzzle className="size-3.5" />
              Extensions
            </button>
          )}
        </div>
      </div>
      {cliStatusError && !cliStatusLoading && (
        <p className="mt-2 text-xs" style={{ color: '#f87171' }}>
          Failed to check for updates. Check your network connection and try again.
        </p>
      )}
      {visibleProviders.length > 0 && (
        <div
          className="mt-3 space-y-2 border-t pt-3"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {visibleProviders.map((provider) => {
            const statusText = formatProviderStatusText(provider);
            const actionDisabled = isBusy || !cliStatus.binaryPath;
            const runtimeSummary = isConnectionManagedRuntimeProvider(provider)
              ? getProviderCurrentRuntimeSummary(provider)
              : getProviderRuntimeBackendSummary(provider);
            const connectionModeSummary = getProviderConnectionModeSummary(provider);
            const credentialSummary = getProviderCredentialSummary(provider);
            const disconnectAction = getProviderDisconnectAction(provider);
            const providerLoading = cliProviderStatusLoading[provider.providerId] === true;
            const showSkeleton = isProviderCardLoading(provider, providerLoading);
            const hasDetailContent = Boolean(
              (provider.backend?.label && !runtimeSummary) ||
              runtimeSummary ||
              connectionModeSummary ||
              credentialSummary ||
              provider.models.length === 0
            );

            return (
              <div
                key={provider.providerId}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-md p-2"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)' }}
              >
                <div className="col-span-2 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-2">
                        <ProviderBrandLogo
                          providerId={provider.providerId}
                          className="size-4 shrink-0"
                        />
                        <span
                          className="text-xs font-medium"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {provider.displayName}
                        </span>
                      </span>
                      <span
                        className="text-xs"
                        style={{
                          color: provider.authenticated ? '#4ade80' : 'var(--color-text-muted)',
                        }}
                      >
                        {statusText}
                      </span>
                    </div>
                    {showSkeleton ? (
                      <ProviderDetailSkeleton />
                    ) : hasDetailContent ? (
                      <div
                        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {provider.backend?.label && !runtimeSummary && (
                          <span>Backend: {provider.backend.label}</span>
                        )}
                        {runtimeSummary ? (
                          <span>
                            {isConnectionManagedRuntimeProvider(provider)
                              ? runtimeSummary
                              : `Runtime: ${runtimeSummary}`}
                          </span>
                        ) : null}
                        {connectionModeSummary ? <span>{connectionModeSummary}</span> : null}
                        {credentialSummary ? <span>{credentialSummary}</span> : null}
                        {provider.models.length === 0 && (
                          <span>Models unavailable for this runtime build</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-start gap-2">
                    <button
                      onClick={() => onProviderManage(provider.providerId)}
                      disabled={actionDisabled}
                      className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                      style={{
                        borderColor: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      <SlidersHorizontal className="size-3" />
                      Manage
                    </button>
                    {disconnectAction ? (
                      <button
                        onClick={() => onProviderLogout(provider.providerId)}
                        disabled={actionDisabled}
                        className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{
                          borderColor: 'var(--color-border)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        <LogOut className="size-3" />
                        {disconnectAction.label}
                      </button>
                    ) : shouldShowProviderConnectAction(provider) ? (
                      <button
                        onClick={() => onProviderLogin(provider.providerId)}
                        disabled={actionDisabled}
                        className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{
                          borderColor: 'var(--color-border)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        <LogIn className="size-3" />
                        {getProviderConnectLabel(provider)}
                      </button>
                    ) : null}
                    <button
                      onClick={() => onProviderRefresh(provider.providerId)}
                      disabled={cliStatusLoading || providerLoading}
                      className="flex items-center gap-1 rounded-md border px-1.5 py-[3px] text-[10px] transition-colors hover:bg-white/5 disabled:opacity-50"
                      style={{
                        borderColor: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                      title={`Re-check ${provider.displayName}`}
                    >
                      <RefreshCw
                        className={
                          cliStatusLoading || providerLoading
                            ? 'size-[11px] animate-spin'
                            : 'size-[11px]'
                        }
                      />
                    </button>
                  </div>
                </div>
                {!showSkeleton && provider.models.length > 0 && (
                  <div className="col-span-2">
                    <ModelBadges providerId={provider.providerId} models={provider.models} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const CliStatusBanner = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const appConfig = useStore((s) => s.appConfig);
  const updateConfig = useStore((s) => s.updateConfig);
  const {
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    cliStatusError,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    installerDetail,
    installerRawChunks,
    completedVersion,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    invalidateCliStatus,
    installCli,
    isBusy,
  } = useCliInstaller();

  const [showLoginTerminal, setShowLoginTerminal] = useState(false);
  const [providerTerminal, setProviderTerminal] = useState<{
    providerId: CliProviderId;
    action: 'login' | 'logout';
  } | null>(null);
  const [manageProviderId, setManageProviderId] = useState<CliProviderId>('anthropic');
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);
  const [isSwitchingFlavor, setIsSwitchingFlavor] = useState(false);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? true;
  const visibleCliProviders = useMemo(
    () => filterMainScreenCliProviders(cliStatus?.providers ?? []),
    [cliStatus?.providers]
  );

  useEffect(() => {
    if (!isElectron) return;
    // IMPORTANT: do NOT auto-fetch on mount.
    // Store initialization already schedules a deferred CLI status check to avoid
    // competing with initial teams/tasks/project scans.
    // Keep a low-frequency refresh, but only after we've successfully loaded a status.
    if (!cliStatus) {
      return;
    }

    const interval = setInterval(
      () => {
        void fetchCliStatus();
      },
      10 * 60 * 1000
    );

    return () => clearInterval(interval);
  }, [isElectron, cliStatus, fetchCliStatus]);

  const handleInstall = useCallback(() => {
    installCli();
  }, [installCli]);

  const handleRefresh = useCallback(() => {
    if (multimodelEnabled) {
      void bootstrapCliStatus({ multimodelEnabled: true });
      return;
    }
    void fetchCliStatus();
  }, [bootstrapCliStatus, fetchCliStatus, multimodelEnabled]);

  const handleMultimodelToggle = useCallback(
    async (enabled: boolean) => {
      setIsSwitchingFlavor(true);
      let nextMultimodelEnabled = multimodelEnabled;
      try {
        useStore.setState({
          cliStatus: enabled ? createLoadingMultimodelCliStatus() : null,
          cliStatusLoading: true,
          cliStatusError: null,
        });
        await updateConfig('general', { multimodelEnabled: enabled });
        nextMultimodelEnabled = enabled;
        await invalidateCliStatus();
        if (enabled) {
          await bootstrapCliStatus({ multimodelEnabled: true });
        } else {
          await fetchCliStatus();
        }
      } catch {
        if (nextMultimodelEnabled) {
          await bootstrapCliStatus({ multimodelEnabled: true });
        } else {
          await fetchCliStatus();
        }
      } finally {
        setIsSwitchingFlavor(false);
      }
    },
    [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled, updateConfig]
  );

  const recheckAuthState = useCallback(() => {
    setIsVerifyingAuth(true);
    void (async () => {
      try {
        await invalidateCliStatus();
        await fetchCliStatus();
      } finally {
        setIsVerifyingAuth(false);
      }
    })();
  }, [fetchCliStatus, invalidateCliStatus]);

  const handleProviderLogin = useCallback((providerId: CliProviderId) => {
    setProviderTerminal({ providerId, action: 'login' });
  }, []);

  const handleProviderLogout = useCallback(
    (providerId: CliProviderId) => {
      void (async () => {
        const provider =
          cliStatus?.providers.find((entry) => entry.providerId === providerId) ?? null;
        const disconnectAction = provider ? getProviderDisconnectAction(provider) : null;
        if (!disconnectAction) {
          return;
        }

        const confirmed = await confirm({
          title: disconnectAction.title,
          message: disconnectAction.message,
          confirmLabel: disconnectAction.confirmLabel,
          cancelLabel: 'Cancel',
          variant: 'danger',
        });

        if (!confirmed) {
          return;
        }

        setProviderTerminal({ providerId, action: 'logout' });
      })();
    },
    [cliStatus?.providers]
  );

  const handleProviderManage = useCallback((providerId: CliProviderId) => {
    setManageProviderId(providerId);
    setManageDialogOpen(true);
  }, []);

  const handleProviderRefresh = useCallback(
    (providerId: CliProviderId) => {
      void fetchCliProviderStatus(providerId);
    },
    [fetchCliProviderStatus]
  );

  const handleProviderBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      if (providerId !== 'gemini' && providerId !== 'codex') {
        return;
      }

      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'auto' as const,
      };

      await updateConfig('runtime', {
        providerBackends: {
          ...currentBackends,
          [providerId]: backendId,
        },
      });

      try {
        await fetchCliProviderStatus(providerId);
      } catch {
        throw new Error('Runtime updated, but failed to refresh provider status.');
      }
    },
    [appConfig?.runtime?.providerBackends, fetchCliProviderStatus, updateConfig]
  );

  if (!isElectron) return null;

  // Determine variant for styling
  const getVariant = (): BannerVariant => {
    if (installerState === 'error') return 'error';
    if (installerState === 'completed') return 'success';
    if (installerState !== 'idle') return 'info';
    if (!cliStatus) return 'loading';
    if (isCheckingMultimodelStatus(cliStatus, visibleCliProviders)) return 'info';
    if (cliStatus.authStatusChecking) return 'info';
    if (!cliStatus.installed) return 'error';
    if (cliStatus.installed && !cliStatus.authLoggedIn) return 'warning';
    if (cliStatus.updateAvailable) return 'info';
    return 'success';
  };

  const variant = getVariant();
  const styles = VARIANT_STYLES[variant];
  const activeTerminalProvider = providerTerminal
    ? (cliStatus?.providers.find(
        (provider) => provider.providerId === providerTerminal.providerId
      ) ?? null)
    : null;
  const providerTerminalCommand =
    providerTerminal && activeTerminalProvider
      ? providerTerminal.action === 'login'
        ? getProviderTerminalCommand(activeTerminalProvider)
        : getProviderTerminalLogoutCommand(activeTerminalProvider)
      : null;
  const installedAuxiliaryUi =
    cliStatus !== null ? (
      <>
        <ProviderRuntimeSettingsDialog
          open={manageDialogOpen}
          onOpenChange={setManageDialogOpen}
          providers={visibleCliProviders}
          initialProviderId={
            visibleCliProviders.some((provider) => provider.providerId === manageProviderId)
              ? manageProviderId
              : (visibleCliProviders[0]?.providerId ?? 'anthropic')
          }
          providerStatusLoading={cliProviderStatusLoading}
          disabled={isBusy || cliStatusLoading || !cliStatus.binaryPath}
          onSelectBackend={handleProviderBackendChange}
          onRefreshProvider={(providerId) => fetchCliProviderStatus(providerId)}
          onRequestLogin={(providerId) => setProviderTerminal({ providerId, action: 'login' })}
        />
        {providerTerminal && cliStatus.binaryPath && (
          <TerminalModal
            title={`${cliStatus.displayName} ${providerTerminal.action === 'login' ? 'Login' : 'Logout'}: ${getProviderLabel(
              providerTerminal.providerId
            )}`}
            command={cliStatus.binaryPath}
            args={providerTerminalCommand?.args}
            env={providerTerminalCommand?.env}
            onClose={() => {
              setProviderTerminal(null);
              recheckAuthState();
            }}
            onExit={() => {
              recheckAuthState();
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
      </>
    ) : null;

  // ── Loading / fetch error state ────────────────────────────────────────
  if (!cliStatus && installerState === 'idle') {
    // Fetch failed — show error with retry
    if (cliStatusError && !cliStatusLoading) {
      return (
        <div
          className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
          style={{
            borderColor: VARIANT_STYLES.error.border,
            backgroundColor: VARIANT_STYLES.error.bg,
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" style={{ color: '#f87171' }} />
              <span className="text-sm" style={{ color: '#f87171' }}>
                Failed to check CLI status
              </span>
            </div>
            <button
              onClick={handleRefresh}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <RefreshCw className="size-3.5" />
              Retry
            </button>
          </div>
        </div>
      );
    }

    // If we aren't currently loading, avoid showing a "stuck" spinner.
    // The initial CLI status check is deferred; allow user to trigger manually.
    if (!cliStatusLoading) {
      return (
        <div
          className={`mb-6 flex items-center justify-between gap-3 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
          style={{ borderColor: styles.border, backgroundColor: styles.bg }}
        >
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Claude CLI status will be checked in the background.
          </span>
          <button
            onClick={handleRefresh}
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <RefreshCw className="size-3.5" />
            Check now
          </button>
        </div>
      );
    }

    // Multimodel: render provider cards immediately instead of a generic intermediate block.
    if (multimodelEnabled) {
      return (
        <InstalledBanner
          cliStatus={createLoadingMultimodelCliStatus()}
          cliStatusLoading={cliStatusLoading}
          cliProviderStatusLoading={cliProviderStatusLoading}
          cliStatusError={cliStatusError ?? null}
          isBusy={isBusy}
          multimodelEnabled={multimodelEnabled}
          multimodelBusy={isSwitchingFlavor}
          onInstall={handleInstall}
          onRefresh={handleRefresh}
          onMultimodelToggle={(enabled) => void handleMultimodelToggle(enabled)}
          onProviderLogin={handleProviderLogin}
          onProviderLogout={handleProviderLogout}
          onProviderManage={handleProviderManage}
          onProviderRefresh={handleProviderRefresh}
          variant="info"
        />
      );
    }

    // Claude-only mode: keep the generic loading spinner.
    return (
      <CliCheckingSpinner
        styles={styles}
        label={multimodelEnabled ? 'Checking AI Providers...' : 'Checking Claude CLI...'}
      />
    );
  }

  // ── Downloading ────────────────────────────────────────────────────────
  if (installerState === 'downloading') {
    return (
      <div
        className={`mb-6 space-y-2 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Downloading Claude CLI...
            </span>
          </div>
          <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {downloadTotal > 0
              ? `${formatBytes(downloadTransferred)} / ${formatBytes(downloadTotal)} (${downloadProgress}%)`
              : formatBytes(downloadTransferred)}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
        >
          {downloadTotal > 0 ? (
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${downloadProgress}%`, backgroundColor: '#3b82f6' }}
            />
          ) : (
            <div
              className="h-full w-1/3 animate-pulse rounded-full"
              style={{ backgroundColor: '#3b82f6' }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Checking / Verifying ───────────────────────────────────────────────
  if (installerState === 'checking' || installerState === 'verifying') {
    const label =
      installerState === 'checking' ? 'Checking latest version...' : 'Verifying checksum...';
    return (
      <div
        className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {label}
          </span>
        </div>
        <DetailLine text={installerDetail} />
      </div>
    );
  }

  // ── Installing (with log panel) ────────────────────────────────────────
  if (installerState === 'installing') {
    return (
      <div
        className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Installing Claude CLI...
          </span>
        </div>
        <TerminalLogPanel chunks={installerRawChunks} />
      </div>
    );
  }

  // ── Completed ──────────────────────────────────────────────────────────
  if (
    installerState === 'completed' &&
    !cliStatus?.installed &&
    !(cliStatus?.binaryPath && cliStatus?.launchError)
  ) {
    return <InstallCompletedNotice version={completedVersion} />;
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (installerState === 'error') {
    return (
      <div
        className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <ErrorDisplay error={installerError ?? 'Installation failed'} onRetry={handleInstall} />
      </div>
    );
  }

  // ── Idle state with status ─────────────────────────────────────────────
  if (!cliStatus) return null;
  const cliLaunchIssue =
    !cliStatus.installed && Boolean(cliStatus.binaryPath && cliStatus.launchError);

  // Not installed — red error banner
  if (!cliStatus.installed) {
    return (
      <div
        className="mb-6 rounded-lg border-l-4 p-4"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" style={{ color: '#ef4444' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: '#f87171' }}>
                {cliLaunchIssue
                  ? 'Claude CLI was found but failed to start'
                  : 'Claude CLI is required'}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {cliLaunchIssue
                  ? 'The app found a Claude CLI binary, but its startup health check failed. Repair or reinstall it, then retry.'
                  : 'Claude CLI is required for team provisioning and session management. Install it to get started.'}
              </p>
              {cliStatus.showBinaryPath && cliStatus.binaryPath && (
                <p
                  className="mt-2 break-all font-mono text-[11px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {cliStatus.binaryPath}
                </p>
              )}
              {cliLaunchIssue && cliStatus.launchError && (
                <div
                  className="mt-2 rounded border px-2 py-1.5 font-mono text-[11px]"
                  style={{
                    borderColor: 'rgba(239, 68, 68, 0.2)',
                    backgroundColor: 'rgba(239, 68, 68, 0.04)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {cliStatus.launchError}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <button
              onClick={handleRefresh}
              className="flex items-center justify-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <RefreshCw className="size-4" />
              Re-check
            </button>
            {cliStatus.supportsSelfUpdate ? (
              <button
                onClick={handleInstall}
                disabled={isBusy}
                className="flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
                style={{ backgroundColor: '#3b82f6' }}
              >
                <Download className="size-4" />
                {cliLaunchIssue ? 'Reinstall Claude CLI' : 'Install Claude CLI'}
              </button>
            ) : (
              <p className="max-w-40 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {cliLaunchIssue
                  ? `The configured ${cliStatus.displayName} runtime failed its startup health check.`
                  : `The configured ${cliStatus.displayName} runtime was not found.`}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Installed but not logged in — yellow warning banner
  if (
    cliStatus.installed &&
    cliStatus.flavor !== 'agent_teams_orchestrator' &&
    (cliStatus.authStatusChecking || isVerifyingAuth)
  ) {
    if (cliStatus.authStatusChecking || isVerifyingAuth) {
      return (
        <>
          <InstalledBanner
            cliStatus={cliStatus}
            cliStatusLoading={cliStatusLoading}
            cliProviderStatusLoading={cliProviderStatusLoading}
            cliStatusError={cliStatusError ?? null}
            isBusy={isBusy}
            multimodelEnabled={multimodelEnabled}
            multimodelBusy={isSwitchingFlavor}
            onInstall={handleInstall}
            onRefresh={handleRefresh}
            onMultimodelToggle={(enabled) => void handleMultimodelToggle(enabled)}
            onProviderLogin={handleProviderLogin}
            onProviderLogout={handleProviderLogout}
            onProviderManage={handleProviderManage}
            onProviderRefresh={handleProviderRefresh}
            variant={variant}
          />
          {installedAuxiliaryUi}
        </>
      );
    }
  }

  if (
    cliStatus.installed &&
    cliStatus.flavor !== 'agent_teams_orchestrator' &&
    !cliStatus.authStatusChecking &&
    !cliStatus.authLoggedIn
  ) {
    const apiKeyActionRequiredProviders = getApiKeyActionRequiredProviders(cliStatus.providers);
    const hasApiKeyModeIssue = apiKeyActionRequiredProviders.length > 0;
    const primaryApiKeyProvider = apiKeyActionRequiredProviders[0] ?? null;
    const apiKeyMissingProviders = apiKeyActionRequiredProviders.filter(
      (provider) => provider.connection?.apiKeyConfigured !== true
    );
    const allApiKeyIssuesAreMissingKeys =
      hasApiKeyModeIssue && apiKeyMissingProviders.length === apiKeyActionRequiredProviders.length;
    const warningTitle = hasApiKeyModeIssue
      ? allApiKeyIssuesAreMissingKeys
        ? 'API key required'
        : 'Provider action required'
      : 'Not logged in';
    const warningMessage = hasApiKeyModeIssue
      ? allApiKeyIssuesAreMissingKeys
        ? apiKeyActionRequiredProviders.length === 1 && primaryApiKeyProvider
          ? `${primaryApiKeyProvider.displayName} is set to API key mode, but no API key is configured. Open Manage Providers to add a key or switch the connection mode.`
          : 'One or more providers are set to API key mode, but no API key is configured. Open Manage Providers to add keys or switch the connection mode.'
        : apiKeyActionRequiredProviders.length === 1 && primaryApiKeyProvider
          ? `${primaryApiKeyProvider.displayName} is set to API key mode, but it is not connected. Open Manage Providers to review the saved key or switch the connection mode.`
          : 'One or more providers are set to API key mode and need attention. Open Manage Providers to review saved keys or switch the connection mode.'
      : `${cliStatus.displayName} is installed but you are not authenticated. Login is required for team provisioning and AI features.`;

    return (
      <>
        <InstalledBanner
          cliStatus={cliStatus}
          cliStatusLoading={cliStatusLoading}
          cliProviderStatusLoading={cliProviderStatusLoading}
          cliStatusError={cliStatusError ?? null}
          isBusy={isBusy}
          multimodelEnabled={multimodelEnabled}
          multimodelBusy={isSwitchingFlavor}
          onInstall={handleInstall}
          onRefresh={handleRefresh}
          onMultimodelToggle={(enabled) => void handleMultimodelToggle(enabled)}
          onProviderLogin={handleProviderLogin}
          onProviderLogout={handleProviderLogout}
          onProviderManage={handleProviderManage}
          onProviderRefresh={handleProviderRefresh}
          variant={variant}
        />
        <div
          className="mb-6 rounded-lg border-l-4 p-4"
          style={{
            borderColor: VARIANT_STYLES.warning.border,
            backgroundColor: VARIANT_STYLES.warning.bg,
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" style={{ color: '#f59e0b' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: '#fbbf24' }}>
                  {warningTitle}
                </p>
                <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {warningMessage}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasApiKeyModeIssue ? (
                <button
                  onClick={() =>
                    handleProviderManage(primaryApiKeyProvider?.providerId ?? 'anthropic')
                  }
                  className="flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors"
                  style={{ backgroundColor: '#f59e0b' }}
                >
                  <SlidersHorizontal className="size-4" />
                  Manage Providers
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setShowTroubleshoot((v) => !v)}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-white/5"
                    style={{
                      borderColor: 'var(--color-border-emphasis)',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    <HelpCircle className="size-3.5" />
                    Already logged in?
                    {showTroubleshoot ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </button>
                  <button
                    onClick={() => setShowLoginTerminal(true)}
                    className="flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors"
                    style={{ backgroundColor: '#f59e0b' }}
                  >
                    <LogIn className="size-4" />
                    Login
                  </button>
                </>
              )}
            </div>
          </div>

          {!hasApiKeyModeIssue && showTroubleshoot && (
            <div
              className="mt-3 rounded-md border p-3"
              style={{
                borderColor: 'var(--color-border)',
                backgroundColor: 'var(--color-surface)',
              }}
            >
              <p
                className="mb-2 text-xs font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                If you&apos;re sure you&apos;re logged in, try these steps:
              </p>
              <ol
                className="ml-4 list-decimal space-y-1.5 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <li>
                  Click{' '}
                  <button
                    onClick={async () => {
                      setIsVerifyingAuth(true);
                      try {
                        await invalidateCliStatus();
                        if (multimodelEnabled) {
                          await bootstrapCliStatus({ multimodelEnabled: true });
                        } else {
                          await fetchCliStatus();
                        }
                      } finally {
                        setIsVerifyingAuth(false);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-white/10"
                    style={{
                      color: '#fbbf24',
                      backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    }}
                  >
                    <RefreshCw className="size-3" />
                    Re-check
                  </button>{' '}
                  — sometimes the status is cached for a few seconds
                </li>
                <li>
                  Open your terminal and run:{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {cliStatus.showBinaryPath && cliStatus.binaryPath
                      ? `"${cliStatus.binaryPath}" auth status`
                      : 'your configured CLI auth status command'}
                  </code>{' '}
                  — check if it shows &quot;Logged in&quot;
                </li>
                <li>
                  If it says logged in but the app doesn&apos;t see it, try:{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {cliStatus.showBinaryPath && cliStatus.binaryPath
                      ? `"${cliStatus.binaryPath}" auth logout`
                      : 'the runtime logout command'}
                  </code>{' '}
                  then{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {cliStatus.showBinaryPath && cliStatus.binaryPath
                      ? `"${cliStatus.binaryPath}" auth login`
                      : 'the runtime login command'}
                  </code>{' '}
                  again
                </li>
                <li>
                  Make sure the CLI in your terminal is the same runtime the app uses
                  {cliStatus.showBinaryPath && cliStatus.binaryPath && (
                    <span>
                      :{' '}
                      <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                        {cliStatus.binaryPath}
                      </code>
                    </span>
                  )}
                </li>
              </ol>
              <p className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Browsing sessions and projects works without login. Login is only needed to run
                agent teams.
              </p>
            </div>
          )}
        </div>
        {installedAuxiliaryUi}
        {showLoginTerminal && cliStatus.binaryPath && (
          <TerminalModal
            title={`${cliStatus.displayName} Login`}
            command={cliStatus.binaryPath}
            args={['auth', 'login']}
            onClose={() => {
              setShowLoginTerminal(false);
              setIsVerifyingAuth(true);
              void (async () => {
                try {
                  await invalidateCliStatus();
                  if (multimodelEnabled) {
                    await bootstrapCliStatus({ multimodelEnabled: true });
                  } else {
                    await fetchCliStatus();
                  }
                } finally {
                  setIsVerifyingAuth(false);
                }
              })();
            }}
            onExit={() => {
              setIsVerifyingAuth(true);
              void (async () => {
                try {
                  await invalidateCliStatus();
                  if (multimodelEnabled) {
                    await bootstrapCliStatus({ multimodelEnabled: true });
                  } else {
                    await fetchCliStatus();
                  }
                } finally {
                  setIsVerifyingAuth(false);
                }
              })();
            }}
            autoCloseOnSuccessMs={4000}
            successMessage="Login complete"
            failureMessage="Login failed"
          />
        )}
      </>
    );
  }

  // Installed — show version, path, update info
  return (
    <>
      <InstalledBanner
        cliStatus={cliStatus}
        cliStatusLoading={cliStatusLoading}
        cliProviderStatusLoading={cliProviderStatusLoading}
        cliStatusError={cliStatusError ?? null}
        isBusy={isBusy}
        multimodelEnabled={multimodelEnabled}
        multimodelBusy={isSwitchingFlavor}
        onInstall={handleInstall}
        onRefresh={handleRefresh}
        onMultimodelToggle={(enabled) => void handleMultimodelToggle(enabled)}
        onProviderLogin={handleProviderLogin}
        onProviderLogout={handleProviderLogout}
        onProviderManage={handleProviderManage}
        onProviderRefresh={handleProviderRefresh}
        variant={variant}
      />
      {installedAuxiliaryUi}
    </>
  );
};
