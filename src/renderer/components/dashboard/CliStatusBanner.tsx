/**
 * CliStatusBanner — CLI installation status banner for the Dashboard.
 *
 * Shown on the main screen before project search.
 * Displays CLI version/path when installed, or a red error with install button when not.
 * Shows live detail text for every phase and a mini log panel during installation.
 * Only rendered in Electron mode.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import {
  CODEX_ACCOUNT_STARTUP_IDLE_MAX_DELAY_MS,
  CODEX_ACCOUNT_STARTUP_IDLE_MIN_DELAY_MS,
  mergeCodexProviderStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { CodexRuntimeUpdateDialog } from '@features/codex-runtime-installer/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import atlasCloudLogo from '@renderer/assets/atlascloud-logo.svg';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import {
  CodexLoginLinkCopyButton,
  CodexLoginUserCodeBadge,
} from '@renderer/components/runtime/CodexLoginLinkCopyButton';
import {
  isCodexProviderRuntimeMissing,
  shouldOfferCodexRuntimeInstall,
  shouldOfferCodexRuntimeUpdate,
} from '@renderer/components/runtime/codexRuntimeInstallAction';
import {
  formatProviderStatusText,
  getProviderConnectionModeSummary,
  getProviderConnectLabel,
  getProviderCredentialSummary,
  getProviderCurrentRuntimeSummary,
  getProviderDisconnectAction,
  isConnectionManagedRuntimeProvider,
  isOpenCodeCatalogHydrating,
  isProviderInventoryOnlyFallback,
  shouldMaskCodexNegativeBootstrapState,
  shouldShowProviderConnectAction,
  shouldShowProviderStatusSkeleton,
} from '@renderer/components/runtime/providerConnectionUi';
import { ProviderModelBadges } from '@renderer/components/runtime/ProviderModelBadges';
import {
  buildProviderRuntimeBackendSummaryText,
  getProviderRuntimeBackendSummary,
} from '@renderer/components/runtime/ProviderRuntimeBackendSelector';
import {
  getProviderTerminalCommand,
  getProviderTerminalLogoutCommand,
} from '@renderer/components/runtime/providerTerminalCommands';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import {
  loadDashboardCliStatusBannerCollapsed,
  saveDashboardCliStatusBannerCollapsed,
} from '@renderer/services/dashboardCliStatusBannerPreference';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { formatBytes } from '@renderer/utils/formatters';
import { filterMainScreenCliProviders } from '@renderer/utils/geminiUiFreeze';
import { isMultimodelRuntimeStatus } from '@renderer/utils/multimodelProviderVisibility';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName as getHumanRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import { getVisibleTeamProviderModels } from '@renderer/utils/teamModelCatalog';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Handshake,
  HelpCircle,
  Loader2,
  LogIn,
  LogOut,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';

import {
  getDashboardRateLimitsForProvider,
  isDashboardRateLimitSubscriptionMode,
  shouldShowDashboardRateLimitSkeleton,
} from './providerDashboardRateLimits';

import type { DashboardRateLimitItem } from './providerDashboardRateLimits';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type {
  CliProviderAuthMode,
  CliProviderId,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types';

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
const INSTALLED_BANNER_BACKGROUND =
  'color-mix(in srgb, var(--color-surface-raised) 30%, transparent)';
const PROVIDER_STATUS_CARD_BACKGROUND = 'var(--color-surface-raised)';
const ANTHROPIC_LIMIT_REFRESH_INTERVAL_MS = 60 * 1000;
const SHOW_ATLAS_CLOUD_OPENCODE_BANNER = false;
const ATLAS_CLOUD_OPENCODE_PROVIDER_ID = 'atlascloud';
const ATLAS_CLOUD_CODING_PLAN_URL = 'https://www.atlascloud.ai/console/coding-plan';
const ProviderRuntimeSettingsDialog = lazy(() =>
  import('@renderer/components/runtime/ProviderRuntimeSettingsDialog').then((module) => ({
    default: module.ProviderRuntimeSettingsDialog,
  }))
);
const TerminalLogPanel = lazy(() =>
  import('@renderer/components/terminal/TerminalLogPanel').then((module) => ({
    default: module.TerminalLogPanel,
  }))
);
const TerminalModal = lazy(() =>
  import('@renderer/components/terminal/TerminalModal').then((module) => ({
    default: module.TerminalModal,
  }))
);

const DashboardRateLimitChips = ({
  providerId,
  items,
}: {
  providerId: CliProviderId;
  items: DashboardRateLimitItem[];
}): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <div
          key={`${providerId}-${item.label}`}
          className="w-fit max-w-full rounded-md border px-2 py-1.5"
          style={{
            borderColor: 'rgba(74, 222, 128, 0.2)',
            backgroundColor: 'rgba(74, 222, 128, 0.06)',
          }}
        >
          <div className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span
              className="text-[10px] uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {item.label}
            </span>
            <span
              className="text-xs font-medium"
              style={{ color: item.isDepleted ? '#f87171' : '#86efac' }}
            >
              {item.remaining}
            </span>
            <span
              className="min-w-0 truncate text-[10px]"
              style={{ color: 'var(--color-text-secondary)' }}
              title={item.resetsAt}
            >
              • {t('cliStatus.labels.resets', { time: item.resetsAt })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

const RATE_LIMIT_SKELETON_LABELS = ['5h left', 'Weekly left'] as const;

const DashboardRateLimitSkeletonChips = (): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label={t('cliStatus.labels.loadingRateLimits')}
    >
      {RATE_LIMIT_SKELETON_LABELS.map((label, index) => (
        <div
          key={label}
          className="w-fit max-w-full rounded-md border px-2 py-1.5"
          style={{
            borderColor: 'rgba(148, 163, 184, 0.16)',
            backgroundColor: 'rgba(148, 163, 184, 0.04)',
          }}
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="text-[10px] uppercase tracking-[0.06em]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {label}
            </span>
            <span
              className="skeleton-shimmer h-3 rounded-sm"
              style={{ width: index === 0 ? '2rem' : '2.25rem' }}
            />
            <span
              className="skeleton-shimmer h-3 rounded-sm"
              style={{ width: index === 0 ? '5.75rem' : '6.5rem' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

function getCodexDashboardHint(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  if (provider.providerId !== 'codex') {
    return null;
  }

  const codex = provider.connection?.codex;
  if (!codex || codex.managedAccount?.type === 'chatgpt') {
    return null;
  }

  if (codex.login.status === 'starting' || codex.login.status === 'pending') {
    return codex.login.authUrl ? t('cliStatus.hints.codexFinishLogin') : null;
  }

  const usageHint = codex.localActiveChatgptAccountPresent
    ? t('cliStatus.hints.codexReconnectNeeded')
    : codex.localAccountArtifactsPresent
      ? t('cliStatus.hints.codexNoActiveManagedSession')
      : t('cliStatus.hints.codexNoActiveLogin');
  if (
    provider.connection?.configuredAuthMode === 'chatgpt' &&
    provider.connection.apiKeyConfigured
  ) {
    return t('cliStatus.hints.codexApiKeyFallback', { hint: usageHint });
  }

  if (provider.connection?.configuredAuthMode === 'auto' && provider.connection.apiKeyConfigured) {
    return t('cliStatus.hints.codexAutoApiKey', { hint: usageHint });
  }

  return provider.connection?.configuredAuthMode === 'chatgpt' ? usageHint : null;
}

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

const InstallCompletedNotice = ({
  version,
  runtimeDisplayName,
}: {
  version: string | null;
  runtimeDisplayName: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <div
      className={`mb-6 flex items-center gap-3 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
      style={{
        borderColor: VARIANT_STYLES.success.border,
        backgroundColor: VARIANT_STYLES.success.bg,
      }}
    >
      <CheckCircle className="size-4 shrink-0" style={{ color: '#4ade80' }} />
      <span className="text-sm" style={{ color: '#4ade80' }}>
        {t('cliStatus.installer.success', {
          runtime: runtimeDisplayName,
          version: version ?? 'latest',
        })}
      </span>
    </div>
  );
};

/** Error display with multi-line support */
const ErrorDisplay = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
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
          {t('cliStatus.actions.retry')}
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
  const { t } = useAppTranslation('dashboard');
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
            {t('cliStatus.hints.firstCheckSlow')}
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
  sourceProviderMap: Map<CliProviderId, CliProviderStatus>;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Partial<Record<CliProviderId, boolean>>;
  codexSnapshotPending: boolean;
  cliStatusError: string | null;
  providersCollapsed: boolean;
  providerConnectionAuthModes: {
    anthropic: CliProviderAuthMode | null;
    codex: CliProviderAuthMode | null;
  };
  codexRateLimitsLoading: boolean;
  anthropicRateLimitsRefreshing: boolean;
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null;
  openCodeRuntimeStatusLoading: boolean;
  codexRuntimeStatus: CodexRuntimeStatus | null;
  codexRuntimeStatusLoading: boolean;
  isBusy: boolean;
  onInstall: () => void;
  onOpenCodeInstall: () => void;
  onCodexInstall: () => void;
  onRefresh: () => void;
  onToggleProvidersCollapsed: () => void;
  onProviderLogin: (providerId: CliProviderId) => void;
  onProviderLogout: (providerId: CliProviderId) => void;
  onProviderManage: (providerId: CliProviderId) => void;
  onOpenCodeProviderConnect: (providerId: string) => void;
  onProviderRefresh: (providerId: CliProviderId) => void;
  onCodexReconnect: () => void;
  onCodexDeviceCodeLogin: () => void;
  codexReconnectBusy: boolean;
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
    case 'opencode':
      return 'OpenCode (200+ models)';
  }
}

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

  const runtimeLabel = getHumanRuntimeDisplayName(cliStatus);
  return cliStatus.showVersionDetails && cliStatus.installedVersion
    ? `${runtimeLabel} v${cliStatus.installedVersion ?? 'unknown'}`
    : runtimeLabel;
}

function isPendingMultimodelProviderStatus(provider: CliProviderStatus): boolean {
  return (
    !provider.authenticated &&
    (provider.statusMessage === 'Checking...' ||
      provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE)
  );
}

function isProviderCountedAsConnected(provider: CliProviderStatus): boolean {
  return provider.authenticated || isProviderInventoryOnlyFallback(provider);
}

function formatRuntimeAuthSummary(
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>,
  visibleProviders: readonly CliProviderStatus[],
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  if (isMultimodelRuntimeStatus(cliStatus)) {
    if (visibleProviders.length === 0) {
      return null;
    }

    if (visibleProviders.every(isPendingMultimodelProviderStatus)) {
      return t('cliStatus.provider.checkingProviders');
    }
    const denominator = visibleProviders.length;
    const connected = visibleProviders.filter(isProviderCountedAsConnected).length;

    return t('cliStatus.provider.connectedCount', { connected, denominator });
  }

  if (cliStatus.authStatusChecking) {
    return t('cliStatus.provider.checkingAuthentication');
  }

  if (cliStatus.authLoggedIn) {
    return t('cliStatus.provider.authenticated');
  }

  return null;
}

function isCheckingMultimodelStatus(
  cliStatus: NonNullable<ReturnType<typeof useCliInstaller>['cliStatus']>,
  visibleProviders: readonly CliProviderStatus[]
): boolean {
  return (
    isMultimodelRuntimeStatus(cliStatus) &&
    visibleProviders.length > 0 &&
    visibleProviders.every(isPendingMultimodelProviderStatus)
  );
}

function hasVisibleAuthenticatedMultimodelProvider(
  visibleProviders: readonly CliProviderStatus[]
): boolean {
  return visibleProviders.some(isProviderCountedAsConnected);
}

function isOpenCodeProviderEffectivelyReady(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'opencode' &&
    provider.supported === true &&
    provider.authenticated === true &&
    provider.verificationState === 'verified' &&
    provider.capabilities.teamLaunch === true
  );
}

function isOpenCodeRuntimeReady(openCodeRuntimeStatus: OpenCodeRuntimeStatus | null): boolean {
  return (
    openCodeRuntimeStatus?.installed === true &&
    (openCodeRuntimeStatus.source === 'path' ||
      (openCodeRuntimeStatus.source === 'app-managed' && openCodeRuntimeStatus.state !== 'failed'))
  );
}

function shouldShowOpenCodeInstallAction(
  provider: CliProviderStatus,
  showSkeleton: boolean,
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null
): boolean {
  return (
    provider.providerId === 'opencode' &&
    !showSkeleton &&
    !isOpenCodeProviderEffectivelyReady(provider) &&
    !isOpenCodeRuntimeReady(openCodeRuntimeStatus)
  );
}

function shouldShowCodexInstallAction(
  provider: CliProviderStatus,
  showSkeleton: boolean,
  codexRuntimeStatus: CodexRuntimeStatus | null
): boolean {
  return (
    provider.providerId === 'codex' &&
    !showSkeleton &&
    (shouldOfferCodexRuntimeUpdate(codexRuntimeStatus) ||
      (!provider.authenticated &&
        isCodexProviderRuntimeMissing(provider) &&
        shouldOfferCodexRuntimeInstall(codexRuntimeStatus)))
  );
}

function isRuntimeInstalling(
  status: OpenCodeRuntimeStatus | CodexRuntimeStatus | null,
  loading: boolean
): boolean {
  return (
    loading ||
    status?.state === 'checking' ||
    status?.state === 'downloading' ||
    status?.state === 'installing'
  );
}

function getRuntimeInstallLabel(
  status: OpenCodeRuntimeStatus | CodexRuntimeStatus | null,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  if (status?.state === 'downloading') {
    const percent = status.progress?.percent;
    return typeof percent === 'number'
      ? t('cliStatus.runtimeInstall.downloadingPercent', { percent })
      : t('cliStatus.runtimeInstall.downloading');
  }
  if (status?.state === 'installing') {
    return t('cliStatus.runtimeInstall.installing');
  }
  if (status?.state === 'checking') {
    return t('cliStatus.runtimeInstall.checking');
  }
  if (status?.state === 'failed') {
    return t('cliStatus.runtimeInstall.retryInstall');
  }
  if (status && 'updateAvailable' in status && status.updateAvailable && status.latestVersion) {
    return t('cliStatus.actions.updateTo', { version: status.latestVersion });
  }
  return t('cliStatus.runtimeInstall.install');
}

function shouldShowOpenCodeProviderFreeBadge(provider: CliProviderStatus): boolean {
  return provider.providerId === 'opencode';
}

function getOpenCodeDashboardChips(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): { label: string; title?: string }[] {
  if (!shouldShowOpenCodeProviderFreeBadge(provider)) {
    return [];
  }

  const catalogModels = provider.modelCatalog?.models ?? [];
  const configuredLocalCount = new Set(
    catalogModels
      .filter((model) => model.metadata?.opencode?.routeKind === 'configured_local')
      .map((model) => model.launchModel)
  ).size;
  const verifiedCount = new Set(
    catalogModels
      .filter((model) => model.metadata?.opencode?.proofState === 'verified')
      .map((model) => model.launchModel)
  ).size;

  return [
    {
      label: t('cliStatus.provider.freeModels'),
      title: t('cliStatus.provider.freeModelsTitle'),
    },
    ...(configuredLocalCount > 0
      ? [
          {
            label: t('cliStatus.provider.configuredLocalCount', {
              count: configuredLocalCount,
            }),
            title: t('cliStatus.provider.configuredLocalTitle'),
          },
        ]
      : []),
    ...(verifiedCount > 0
      ? [
          {
            label: t('cliStatus.provider.verifiedCount', { count: verifiedCount }),
            title: t('cliStatus.provider.verifiedTitle'),
          },
        ]
      : []),
  ];
}

const OpenCodeAtlasCloudBanner = ({
  disabled,
  onConnect,
}: {
  disabled: boolean;
  onConnect: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <div
      className="col-span-2 rounded-md border px-2.5 py-2"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255, 255, 255, 0.018)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <img
            src={atlasCloudLogo}
            alt={t('cliStatus.atlas.alt')}
            className="h-4 w-auto shrink-0 rounded-[3px] opacity-75"
            draggable={false}
          />
          <span
            className="min-w-0 truncate text-[11px] font-medium"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {t('cliStatus.atlas.plan')}
          </span>
          <span
            className="rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text-muted)',
            }}
          >
            {t('cliStatus.atlas.sponsor')}
          </span>
          <span
            className="rounded border px-1.5 py-0.5 text-[9px] font-medium"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text-muted)',
            }}
          >
            {t('cliStatus.atlas.openCodeProvider')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onConnect}
            disabled={disabled}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
            style={{
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <LogIn className="size-3" />
            {t('cliStatus.actions.connect')}
          </button>
          <button
            type="button"
            onClick={() => void api.openExternal(ATLAS_CLOUD_CODING_PLAN_URL)}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5"
            style={{
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-muted)',
            }}
          >
            <ExternalLink className="size-3" />
            {t('cliStatus.actions.plan')}
          </button>
          <button
            type="button"
            disabled
            className="flex cursor-not-allowed items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium disabled:opacity-50"
            style={{
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-muted)',
            }}
            title={t('cliStatus.labels.comingSoon')}
          >
            <Handshake className="size-3" />
            {t('cliStatus.actions.becomeSponsor')}
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-4" style={{ color: 'var(--color-text-muted)' }}>
        {t('cliStatus.atlas.description')}
      </p>
    </div>
  );
};

const InstalledBanner = ({
  cliStatus,
  sourceProviderMap,
  cliStatusLoading,
  cliProviderStatusLoading,
  codexSnapshotPending,
  cliStatusError,
  providersCollapsed,
  providerConnectionAuthModes,
  codexRateLimitsLoading,
  anthropicRateLimitsRefreshing,
  openCodeRuntimeStatus,
  openCodeRuntimeStatusLoading,
  codexRuntimeStatus,
  codexRuntimeStatusLoading,
  isBusy,
  onInstall,
  onOpenCodeInstall,
  onCodexInstall,
  onRefresh,
  onToggleProvidersCollapsed,
  onProviderLogin,
  onProviderLogout,
  onProviderManage,
  onOpenCodeProviderConnect,
  onProviderRefresh,
  onCodexReconnect,
  onCodexDeviceCodeLogin,
  codexReconnectBusy,
  variant,
}: InstalledBannerProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const { t: commonT } = useAppTranslation('common');
  const runtimeBackendSummaryText = useMemo(
    () => buildProviderRuntimeBackendSummaryText(commonT),
    [commonT]
  );
  const openExtensionsTab = useStore((s) => s.openExtensionsTab);
  const styles = VARIANT_STYLES[variant];
  const visibleProviders = useMemo(
    () => filterMainScreenCliProviders(cliStatus.providers),
    [cliStatus.providers]
  );
  const canOpenExtensions = cliStatus.installed;
  const runtimeLabel = formatRuntimeLabel(cliStatus);
  const runtimeAuthSummary = formatRuntimeAuthSummary(cliStatus, visibleProviders, t);
  const showCollapseControl = visibleProviders.length > 0;
  const showExpandedContent = !providersCollapsed;

  return (
    <div
      className={`mb-6 rounded-lg border-l-4 px-4 ${
        showExpandedContent ? `py-3 ${BANNER_MIN_H}` : 'py-2.5'
      }`}
      style={{ borderColor: styles.border, backgroundColor: INSTALLED_BANNER_BACKGROUND }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {showCollapseControl && (
            <button
              type="button"
              onClick={onToggleProvidersCollapsed}
              className="flex items-center justify-center rounded-md p-1 transition-colors hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
              aria-label={
                providersCollapsed
                  ? t('cliStatus.labels.expandProviderDetails')
                  : t('cliStatus.labels.collapseProviderDetails')
              }
              aria-expanded={!providersCollapsed}
              title={
                providersCollapsed
                  ? t('cliStatus.labels.expandProviderDetails')
                  : t('cliStatus.labels.collapseProviderDetails')
              }
            >
              {providersCollapsed ? (
                <ChevronRight className="size-4 shrink-0" />
              ) : (
                <ChevronDown className="size-4 shrink-0" />
              )}
            </button>
          )}
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
                  {t('cliStatus.actions.updateTo', { version: cliStatus.latestVersion })}
                </button>
              ) : cliStatus.supportsSelfUpdate ? (
                <button
                  onClick={onRefresh}
                  disabled={cliStatusLoading}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-white/5 disabled:opacity-50"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <RefreshCw className={cliStatusLoading ? 'size-3 animate-spin' : 'size-3'} />
                  {cliStatusLoading
                    ? t('cliStatus.actions.checking')
                    : t('cliStatus.actions.checkUpdates')}
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
          {/* Extensions button — available whenever the runtime is installed */}
          {canOpenExtensions && (
            <button
              onClick={openExtensionsTab}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <Puzzle className="size-3.5" />
              {t('cliStatus.actions.extensions')}
            </button>
          )}
        </div>
      </div>
      {showExpandedContent && cliStatusError && !cliStatusLoading && (
        <p className="mt-2 text-xs" style={{ color: '#f87171' }}>
          {t('cliStatus.errors.refreshFailed')}
        </p>
      )}
      {showExpandedContent && visibleProviders.length > 0 && (
        <div
          className="mt-3 space-y-2 border-t pt-3"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {visibleProviders.map((provider) => {
            const actionDisabled = isBusy || !cliStatus.binaryPath;
            const runtimeSummary = isConnectionManagedRuntimeProvider(provider)
              ? getProviderCurrentRuntimeSummary(provider, settingsT)
              : getProviderRuntimeBackendSummary(provider, runtimeBackendSummaryText);
            const connectionModeSummary = getProviderConnectionModeSummary(provider, settingsT);
            const credentialSummary = getProviderCredentialSummary(provider, settingsT);
            const dashboardRateLimits = getDashboardRateLimitsForProvider(provider);
            const hasDashboardRateLimits = Boolean(dashboardRateLimits?.length);
            const isSubscriptionRateLimitMode = isDashboardRateLimitSubscriptionMode({
              provider,
              sourceProvider: sourceProviderMap.get(provider.providerId) ?? null,
              configuredAuthModes: providerConnectionAuthModes,
            });
            const codexDashboardHint = getCodexDashboardHint(provider, t);
            const codexNeedsReconnect =
              provider.providerId === 'codex' &&
              Boolean(provider.connection?.codex?.localActiveChatgptAccountPresent) &&
              provider.connection?.codex?.launchAllowed !== true &&
              provider.connection?.codex?.login.status !== 'starting' &&
              provider.connection?.codex?.login.status !== 'pending';
            const codexLoginAuthUrl = provider.connection?.codex?.login.authUrl ?? null;
            const codexLoginUserCode = provider.connection?.codex?.login.userCode ?? null;
            const showCodexLoginActions = codexNeedsReconnect || Boolean(codexLoginAuthUrl);
            const disconnectAction = getProviderDisconnectAction(provider, settingsT);
            const providerLoading = cliProviderStatusLoading[provider.providerId] === true;
            const sourceProvider = sourceProviderMap.get(provider.providerId) ?? null;
            const maskNegativeBootstrapState = shouldMaskCodexNegativeBootstrapState(
              sourceProvider,
              provider,
              { providerLoading }
            );
            const showSkeleton =
              shouldShowProviderStatusSkeleton(provider, providerLoading) ||
              isCodexSnapshotPending(provider, codexSnapshotPending) ||
              maskNegativeBootstrapState;
            const anthropicRateLimitsLoading =
              provider.providerId === 'anthropic' &&
              (anthropicRateLimitsRefreshing || provider.modelCatalogRefreshState === 'loading');
            const rateLimitsLoading =
              showSkeleton ||
              (provider.providerId === 'codex' && codexRateLimitsLoading) ||
              anthropicRateLimitsLoading ||
              isSubscriptionRateLimitMode;
            const showRateLimitSkeleton = shouldShowDashboardRateLimitSkeleton({
              provider,
              sourceProvider,
              configuredAuthModes: providerConnectionAuthModes,
              hasRateLimits: hasDashboardRateLimits,
              loading: rateLimitsLoading,
            });
            const statusText = showSkeleton
              ? t('cliStatus.actions.checking')
              : formatProviderStatusText(provider, settingsT);
            const modelCatalogLoading =
              provider.modelCatalogRefreshState === 'loading' ||
              isOpenCodeCatalogHydrating(provider);
            const hasProviderModels =
              provider.providerId === 'opencode'
                ? getVisibleTeamProviderModels(provider.providerId, provider.models, provider)
                    .length > 0
                : provider.models.length > 0;
            const openCodeDashboardChips = getOpenCodeDashboardChips(provider, t);
            const hasDetailContent = Boolean(
              (provider.backend?.label && !runtimeSummary) ||
              runtimeSummary ||
              connectionModeSummary ||
              credentialSummary ||
              !hasProviderModels ||
              modelCatalogLoading
            );

            return (
              <div
                key={provider.providerId}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-md p-2"
                style={{ backgroundColor: PROVIDER_STATUS_CARD_BACKGROUND }}
              >
                <div className="col-span-2 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderBrandLogo
                          providerId={provider.providerId}
                          className="size-4 shrink-0"
                        />
                        <span
                          className="truncate whitespace-nowrap text-xs font-medium"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {provider.providerId === 'opencode'
                            ? getProviderLabel(provider.providerId)
                            : provider.displayName}
                        </span>
                        {openCodeDashboardChips.map((chip) => (
                          <span
                            key={chip.label}
                            className="shrink-0 whitespace-nowrap rounded bg-[rgba(34,197,94,0.14)] px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.06em] text-[rgb(74,222,128)]"
                            title={chip.title}
                          >
                            {chip.label}
                          </span>
                        ))}
                      </span>
                      <span
                        className="whitespace-nowrap text-xs"
                        style={{
                          color: getProviderStatusColor(statusText, provider.authenticated),
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
                          <span>
                            {t('cliStatus.provider.backend', { backend: provider.backend.label })}
                          </span>
                        )}
                        {runtimeSummary ? (
                          <span>
                            {isConnectionManagedRuntimeProvider(provider)
                              ? runtimeSummary
                              : t('cliStatus.provider.runtime', { runtime: runtimeSummary })}
                          </span>
                        ) : null}
                        {connectionModeSummary ? <span>{connectionModeSummary}</span> : null}
                        {credentialSummary ? <span>{credentialSummary}</span> : null}
                        {modelCatalogLoading ? (
                          <span>{t('cliStatus.provider.loadingModels')}</span>
                        ) : null}
                        {!hasProviderModels && !modelCatalogLoading && (
                          <span>{t('cliStatus.provider.modelsUnavailable')}</span>
                        )}
                      </div>
                    ) : null}
                    {!showSkeleton && codexDashboardHint ? (
                      <div
                        className="mt-2 rounded-md border px-2.5 py-2 text-[11px]"
                        style={{
                          borderColor: 'rgba(255, 255, 255, 0.08)',
                          backgroundColor: 'rgba(255, 255, 255, 0.025)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">{codexDashboardHint}</span>
                          {showCodexLoginActions ? (
                            <>
                              <CodexLoginLinkCopyButton
                                authUrl={codexLoginAuthUrl}
                                userCode={codexLoginUserCode}
                                disabled={codexReconnectBusy || actionDisabled}
                                size="xs"
                              />
                              <CodexLoginUserCodeBadge userCode={codexLoginUserCode} />
                              {!codexLoginAuthUrl ? (
                                <button
                                  type="button"
                                  onClick={onCodexDeviceCodeLogin}
                                  disabled={codexReconnectBusy || actionDisabled}
                                  className="shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                  style={{
                                    borderColor: 'rgba(245, 158, 11, 0.22)',
                                    backgroundColor: 'rgba(245, 158, 11, 0.05)',
                                    color: '#fbbf24',
                                  }}
                                >
                                  {t('cliStatus.actions.useCode')}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  if (codexLoginAuthUrl) {
                                    void api.openExternal(codexLoginAuthUrl);
                                    return;
                                  }
                                  onCodexReconnect();
                                }}
                                disabled={codexReconnectBusy || actionDisabled}
                                className="shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                                style={{
                                  borderColor: 'rgba(245, 158, 11, 0.28)',
                                  backgroundColor: 'rgba(245, 158, 11, 0.08)',
                                  color: '#fbbf24',
                                }}
                              >
                                {codexLoginAuthUrl
                                  ? t('cliStatus.labels.openLogin')
                                  : t('cliStatus.labels.generateLink')}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-start gap-2">
                    {shouldShowCodexInstallAction(provider, showSkeleton, codexRuntimeStatus) ? (
                      <button
                        type="button"
                        onClick={onCodexInstall}
                        disabled={isRuntimeInstalling(
                          codexRuntimeStatus,
                          codexRuntimeStatusLoading
                        )}
                        className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{
                          borderColor: 'rgba(34, 197, 94, 0.34)',
                          color: '#86efac',
                        }}
                        title={
                          codexRuntimeStatus?.error ??
                          codexRuntimeStatus?.progress?.detail ??
                          t('cliStatus.runtimeInstall.codexTitle')
                        }
                      >
                        {isRuntimeInstalling(codexRuntimeStatus, codexRuntimeStatusLoading) ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        {getRuntimeInstallLabel(codexRuntimeStatus, t)}
                      </button>
                    ) : null}
                    {shouldShowOpenCodeInstallAction(
                      provider,
                      showSkeleton,
                      openCodeRuntimeStatus
                    ) ? (
                      <button
                        type="button"
                        onClick={onOpenCodeInstall}
                        disabled={isRuntimeInstalling(
                          openCodeRuntimeStatus,
                          openCodeRuntimeStatusLoading
                        )}
                        className="flex items-center gap-1 rounded-md border px-2 py-[3px] text-[10px] font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{
                          borderColor: 'rgba(14, 165, 233, 0.36)',
                          color: '#7dd3fc',
                        }}
                        title={
                          openCodeRuntimeStatus?.error ??
                          openCodeRuntimeStatus?.progress?.detail ??
                          t('cliStatus.runtimeInstall.openCodeTitle')
                        }
                      >
                        {isRuntimeInstalling(
                          openCodeRuntimeStatus,
                          openCodeRuntimeStatusLoading
                        ) ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        {getRuntimeInstallLabel(openCodeRuntimeStatus, t)}
                      </button>
                    ) : null}
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
                      {t('cliStatus.actions.manage')}
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
                    ) : !showSkeleton && shouldShowProviderConnectAction(provider) ? (
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
                        {getProviderConnectLabel(provider, settingsT)}
                      </button>
                    ) : null}
                    <button
                      onClick={() => onProviderRefresh(provider.providerId)}
                      disabled={providerLoading}
                      className="flex items-center gap-1 rounded-md border px-1.5 py-[3px] text-[10px] transition-colors hover:bg-white/5 disabled:opacity-50"
                      style={{
                        borderColor: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                      title={t('cliStatus.actions.recheckProvider', {
                        provider: provider.displayName,
                      })}
                    >
                      <RefreshCw
                        className={providerLoading ? 'size-[11px] animate-spin' : 'size-[11px]'}
                      />
                    </button>
                  </div>
                </div>
                {!showSkeleton && !modelCatalogLoading && hasProviderModels && (
                  <div className="col-span-2">
                    <ProviderModelBadges
                      providerId={provider.providerId}
                      models={provider.models}
                      modelAvailability={provider.modelAvailability}
                      providerStatus={provider}
                      collapseAfter={15}
                      maxCollapsedRows={provider.providerId === 'opencode' ? 2 : undefined}
                    />
                  </div>
                )}
                {!showSkeleton &&
                SHOW_ATLAS_CLOUD_OPENCODE_BANNER &&
                provider.providerId === 'opencode' ? (
                  <OpenCodeAtlasCloudBanner
                    disabled={actionDisabled}
                    onConnect={() => onOpenCodeProviderConnect(ATLAS_CLOUD_OPENCODE_PROVIDER_ID)}
                  />
                ) : null}
                {!showSkeleton && dashboardRateLimits && dashboardRateLimits.length > 0 && (
                  <div className="col-span-2">
                    <DashboardRateLimitChips
                      providerId={provider.providerId}
                      items={dashboardRateLimits}
                    />
                  </div>
                )}
                {showRateLimitSkeleton && (
                  <div className="col-span-2">
                    <DashboardRateLimitSkeletonChips />
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
  const { t } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const isElectron = useMemo(() => isElectronMode(), []);
  const appConfig = useStore((s) => s.appConfig);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const repositoryGroups = useStore((s) => s.repositoryGroups);
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
    openCodeRuntimeStatus,
    openCodeRuntimeStatusLoading,
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    fetchCodexRuntimeStatus,
    invalidateCliStatus,
    installCli,
    installOpenCodeRuntime,
    installCodexRuntime,
    isBusy,
  } = useCliInstaller();

  const [showLoginTerminal, setShowLoginTerminal] = useState(false);
  const [codexRuntimeDialogOpen, setCodexRuntimeDialogOpen] = useState(false);
  const [providerTerminal, setProviderTerminal] = useState<{
    providerId: CliProviderId;
    action: 'login' | 'logout';
  } | null>(null);
  const [manageProviderId, setManageProviderId] = useState<CliProviderId>('anthropic');
  const [manageRuntimeProviderId, setManageRuntimeProviderId] = useState<string | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);
  const [providersCollapsed, setProvidersCollapsed] = useState(() =>
    loadDashboardCliStatusBannerCollapsed()
  );
  const [anthropicRateLimitsRefreshing, setAnthropicRateLimitsRefreshing] = useState(false);
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? true;
  const selectedProjectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [projects, repositoryGroups, selectedProjectId]
  );
  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );
  const providerConnectionAuthModes = useMemo(
    () => ({
      anthropic: appConfig?.providerConnections?.anthropic.authMode ?? null,
      codex: appConfig?.providerConnections?.codex.preferredAuthMode ?? null,
    }),
    [
      appConfig?.providerConnections?.anthropic.authMode,
      appConfig?.providerConnections?.codex.preferredAuthMode,
    ]
  );
  const codexAccount = useCodexAccountSnapshot({
    enabled:
      isElectron &&
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
    includeRateLimits: true,
    initialRefreshDelayMs: CODEX_ACCOUNT_STARTUP_IDLE_MIN_DELAY_MS,
    initialRefreshMaxDelayMs: CODEX_ACCOUNT_STARTUP_IDLE_MAX_DELAY_MS,
  });
  const visibleCliProviders = useMemo(
    () =>
      filterMainScreenCliProviders(loadingCliStatus?.providers ?? []).map((provider) =>
        provider.providerId === 'codex'
          ? mergeCodexProviderStatusWithSnapshot(provider, codexAccount.snapshot)
          : provider
      ),
    [loadingCliStatus?.providers, codexAccount.snapshot]
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
  const codexSnapshotPending =
    codexAccount.loading &&
    Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')) &&
    !codexAccount.snapshot;
  const effectiveCliStatus = useMemo(
    () =>
      loadingCliStatus
        ? {
            ...loadingCliStatus,
            providers: visibleCliProviders,
          }
        : loadingCliStatus,
    [loadingCliStatus, visibleCliProviders]
  );
  const renderCliStatus = effectiveCliStatus;

  useEffect(() => {
    if (!isElectron || codexRuntimeStatus || codexRuntimeStatusLoading) {
      return;
    }

    if (visibleCliProviders.some((provider) => provider.providerId === 'codex')) {
      void fetchCodexRuntimeStatus();
    }
  }, [
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    fetchCodexRuntimeStatus,
    isElectron,
    visibleCliProviders,
  ]);

  const shouldPollAnthropicSubscriptionLimits = useMemo(() => {
    if (
      !renderCliStatus?.installed ||
      renderCliStatus.flavor !== 'agent_teams_orchestrator' ||
      !multimodelEnabled
    ) {
      return false;
    }

    const provider =
      renderCliStatus.providers.find((candidate) => candidate.providerId === 'anthropic') ?? null;
    if (!provider) {
      return false;
    }

    return isDashboardRateLimitSubscriptionMode({
      provider,
      sourceProvider: loadingCliProviderMap.get('anthropic') ?? null,
      configuredAuthModes: providerConnectionAuthModes,
    });
  }, [loadingCliProviderMap, multimodelEnabled, providerConnectionAuthModes, renderCliStatus]);
  const runtimeDisplayName = getHumanRuntimeDisplayName(renderCliStatus, multimodelEnabled);

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
        void refreshCliStatusForCurrentMode({
          multimodelEnabled,
          bootstrapCliStatus,
          fetchCliStatus,
        });
      },
      10 * 60 * 1000
    );

    return () => clearInterval(interval);
  }, [bootstrapCliStatus, cliStatus, fetchCliStatus, isElectron, multimodelEnabled]);

  useEffect(() => {
    if (!isElectron || !shouldPollAnthropicSubscriptionLimits) {
      setAnthropicRateLimitsRefreshing(false);
      return;
    }

    let active = true;
    const refreshAnthropicLimits = async (): Promise<void> => {
      if (!active) {
        return;
      }

      setAnthropicRateLimitsRefreshing(true);
      try {
        await fetchCliProviderStatus('anthropic', { silent: true });
      } finally {
        if (active) {
          setAnthropicRateLimitsRefreshing(false);
        }
      }
    };

    const interval = setInterval(() => {
      void refreshAnthropicLimits();
    }, ANTHROPIC_LIMIT_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [fetchCliProviderStatus, isElectron, shouldPollAnthropicSubscriptionLimits]);

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

  const handleToggleProvidersCollapsed = useCallback(() => {
    setProvidersCollapsed((current) => {
      const next = !current;
      saveDashboardCliStatusBannerCollapsed(next);
      return next;
    });
  }, []);

  const handleCodexDashboardLogin = useCallback(() => {
    void (async () => {
      await codexAccount.startChatgptLogin('browser');
    })();
  }, [codexAccount]);

  const handleCodexDashboardDeviceCodeLogin = useCallback(() => {
    void (async () => {
      await codexAccount.startChatgptLogin('device_code');
    })();
  }, [codexAccount]);

  const recheckAuthState = useCallback(() => {
    setIsVerifyingAuth(true);
    void (async () => {
      try {
        await invalidateCliStatus();
        await refreshCliStatusForCurrentMode({
          multimodelEnabled,
          bootstrapCliStatus,
          fetchCliStatus,
        });
      } finally {
        setIsVerifyingAuth(false);
      }
    })();
  }, [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled]);

  const handleProviderLogin = useCallback((providerId: CliProviderId) => {
    setProviderTerminal({ providerId, action: 'login' });
  }, []);

  const handleProviderLogout = useCallback(
    (providerId: CliProviderId) => {
      void (async () => {
        const provider =
          effectiveCliStatus?.providers.find((entry) => entry.providerId === providerId) ?? null;
        const disconnectAction = provider ? getProviderDisconnectAction(provider, settingsT) : null;
        if (!disconnectAction) {
          return;
        }

        const confirmed = await confirm({
          title: disconnectAction.title,
          message: disconnectAction.message,
          confirmLabel: disconnectAction.confirmLabel,
          cancelLabel: t('cliStatus.actions.cancel'),
          variant: 'danger',
        });

        if (!confirmed) {
          return;
        }

        setProviderTerminal({ providerId, action: 'logout' });
      })();
    },
    [effectiveCliStatus?.providers, settingsT, t]
  );

  const handleProviderManage = useCallback((providerId: CliProviderId) => {
    setManageProviderId(providerId);
    setManageRuntimeProviderId(null);
    setManageDialogOpen(true);
  }, []);

  const handleOpenCodeProviderConnect = useCallback((providerId: string) => {
    setManageProviderId('opencode');
    setManageRuntimeProviderId(providerId);
    setManageDialogOpen(true);
  }, []);

  const handleManageDialogOpenChange = useCallback((open: boolean) => {
    setManageDialogOpen(open);
    if (!open) {
      setManageRuntimeProviderId(null);
    }
  }, []);

  const handleProviderRefresh = useCallback(
    (providerId: CliProviderId) => {
      void (async () => {
        await invalidateCliStatus();
        await fetchCliProviderStatus(providerId);
      })();
    },
    [fetchCliProviderStatus, invalidateCliStatus]
  );

  const handleProviderBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      if (providerId !== 'gemini' && providerId !== 'codex') {
        return;
      }

      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'codex-native' as const,
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
        throw new Error(t('cliStatus.errors.runtimeUpdatedRefreshFailed'));
      }
    },
    [appConfig?.runtime?.providerBackends, fetchCliProviderStatus, t, updateConfig]
  );

  if (!isElectron) return null;

  // Determine variant for styling
  const getVariant = (): BannerVariant => {
    if (installerState === 'error') return 'error';
    if (installerState === 'completed') return 'success';
    if (installerState !== 'idle') return 'info';
    if (!renderCliStatus) return 'loading';
    if (isCheckingMultimodelStatus(renderCliStatus, visibleCliProviders)) return 'info';
    if (renderCliStatus.authStatusChecking) return 'info';
    if (!renderCliStatus.installed) return 'error';
    if (isMultimodelRuntimeStatus(renderCliStatus) && visibleCliProviders.length === 0) {
      return 'warning';
    }
    if (
      isMultimodelRuntimeStatus(renderCliStatus) &&
      visibleCliProviders.length > 0 &&
      !hasVisibleAuthenticatedMultimodelProvider(visibleCliProviders)
    ) {
      return 'warning';
    }
    if (renderCliStatus.installed && !renderCliStatus.authLoggedIn) return 'warning';
    if (renderCliStatus.updateAvailable) return 'info';
    return 'success';
  };

  const variant = getVariant();
  const styles = VARIANT_STYLES[variant];
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
  const installedAuxiliaryUi =
    renderCliStatus !== null ? (
      <>
        <CodexRuntimeUpdateDialog
          open={codexRuntimeDialogOpen}
          onOpenChange={setCodexRuntimeDialogOpen}
          status={codexRuntimeStatus}
          loading={codexRuntimeStatusLoading}
          error={codexRuntimeStatus?.error ?? null}
          onInstall={() => void installCodexRuntime()}
        />
        {manageDialogOpen && (
          <Suspense fallback={null}>
            <ProviderRuntimeSettingsDialog
              open={manageDialogOpen}
              onOpenChange={handleManageDialogOpenChange}
              providers={visibleCliProviders}
              projectPath={selectedProjectPath}
              initialProviderId={
                visibleCliProviders.some((provider) => provider.providerId === manageProviderId)
                  ? manageProviderId
                  : (visibleCliProviders[0]?.providerId ?? 'anthropic')
              }
              initialRuntimeProviderId={manageRuntimeProviderId}
              initialRuntimeProviderAction={manageRuntimeProviderId ? 'connect' : null}
              providerStatusLoading={cliProviderStatusLoading}
              disabled={isBusy || cliStatusLoading || !renderCliStatus.binaryPath}
              codexRuntimeStatus={codexRuntimeStatus}
              codexRuntimeStatusLoading={codexRuntimeStatusLoading}
              onInstallCodexRuntime={() => installCodexRuntime()}
              onSelectBackend={handleProviderBackendChange}
              onRefreshProvider={handleProviderRefresh}
              onRequestLogin={(providerId) => setProviderTerminal({ providerId, action: 'login' })}
            />
          </Suspense>
        )}
        {providerTerminal && renderCliStatus.binaryPath && (
          <Suspense fallback={null}>
            <TerminalModal
              title={`${getHumanRuntimeDisplayName(renderCliStatus, multimodelEnabled)} ${
                providerTerminal.action === 'login'
                  ? t('cliStatus.labels.loginTitle')
                  : t('cliStatus.labels.logoutTitle')
              }: ${getProviderLabel(providerTerminal.providerId)}`}
              command={renderCliStatus.binaryPath}
              args={providerTerminalCommand?.args}
              env={providerTerminalCommand?.env}
              onClose={() => {
                setProviderTerminal(null);
                recheckAuthState();
              }}
              autoCloseOnSuccessMs={3000}
              successMessage={
                providerTerminal.action === 'login'
                  ? t('cliStatus.labels.loginAuthUpdated')
                  : t('cliStatus.labels.loggedOut')
              }
              failureMessage={
                providerTerminal.action === 'login'
                  ? t('cliStatus.labels.loginAuthFailed')
                  : t('cliStatus.labels.logoutFailed')
              }
            />
          </Suspense>
        )}
      </>
    ) : null;

  // ── Loading / fetch error state ────────────────────────────────────────
  if (!renderCliStatus && installerState === 'idle') {
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
                {t('cliStatus.errors.checkStatusFailed')}
              </span>
            </div>
            <button
              onClick={handleRefresh}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <RefreshCw className="size-3.5" />
              {t('cliStatus.actions.retry')}
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
            {t('cliStatus.hints.backgroundStatus', { runtime: runtimeDisplayName })}
          </span>
          <button
            onClick={handleRefresh}
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <RefreshCw className="size-3.5" />
            {t('cliStatus.actions.checkNow')}
          </button>
        </div>
      );
    }

    // Multimodel: render provider cards immediately instead of a generic intermediate block.
    if (multimodelEnabled) {
      return (
        <InstalledBanner
          cliStatus={renderCliStatus ?? createLoadingMultimodelCliStatus()}
          sourceProviderMap={loadingCliProviderMap}
          cliStatusLoading={cliStatusLoading}
          cliProviderStatusLoading={cliProviderStatusLoading}
          codexSnapshotPending={codexSnapshotPending}
          cliStatusError={cliStatusError ?? null}
          providersCollapsed={providersCollapsed}
          providerConnectionAuthModes={providerConnectionAuthModes}
          codexRateLimitsLoading={codexAccount.rateLimitsLoading}
          anthropicRateLimitsRefreshing={anthropicRateLimitsRefreshing}
          openCodeRuntimeStatus={openCodeRuntimeStatus}
          openCodeRuntimeStatusLoading={openCodeRuntimeStatusLoading}
          codexRuntimeStatus={codexRuntimeStatus}
          codexRuntimeStatusLoading={codexRuntimeStatusLoading}
          isBusy={isBusy}
          onInstall={handleInstall}
          onOpenCodeInstall={() => void installOpenCodeRuntime()}
          onCodexInstall={() => setCodexRuntimeDialogOpen(true)}
          onRefresh={handleRefresh}
          onToggleProvidersCollapsed={handleToggleProvidersCollapsed}
          onProviderLogin={handleProviderLogin}
          onProviderLogout={handleProviderLogout}
          onProviderManage={handleProviderManage}
          onOpenCodeProviderConnect={handleOpenCodeProviderConnect}
          onProviderRefresh={handleProviderRefresh}
          onCodexReconnect={handleCodexDashboardLogin}
          onCodexDeviceCodeLogin={handleCodexDashboardDeviceCodeLogin}
          codexReconnectBusy={codexAccount.loading}
          variant="info"
        />
      );
    }

    // Claude-only mode: keep the generic loading spinner.
    return (
      <CliCheckingSpinner
        styles={styles}
        label={
          multimodelEnabled ? t('cliStatus.loading.aiProviders') : t('cliStatus.loading.claudeCli')
        }
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
              {t('cliStatus.installer.downloading', { runtime: runtimeDisplayName })}
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
      installerState === 'checking'
        ? t('cliStatus.installer.checkingLatest')
        : t('cliStatus.installer.verifying');
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
            {t('cliStatus.installer.installing', { runtime: runtimeDisplayName })}
          </span>
        </div>
        <Suspense fallback={null}>
          <TerminalLogPanel chunks={installerRawChunks} />
        </Suspense>
      </div>
    );
  }

  // ── Completed ──────────────────────────────────────────────────────────
  if (
    installerState === 'completed' &&
    !renderCliStatus?.installed &&
    !(renderCliStatus?.binaryPath && renderCliStatus?.launchError)
  ) {
    return (
      <InstallCompletedNotice version={completedVersion} runtimeDisplayName={runtimeDisplayName} />
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (installerState === 'error') {
    return (
      <div
        className={`mb-6 rounded-lg border-l-4 px-4 py-3 ${BANNER_MIN_H}`}
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <ErrorDisplay
          error={installerError ?? t('cliStatus.errors.installationFailed')}
          onRetry={handleInstall}
        />
      </div>
    );
  }

  // ── Idle state with status ─────────────────────────────────────────────
  if (!renderCliStatus) return null;
  const cliLaunchIssue =
    !renderCliStatus.installed &&
    Boolean(renderCliStatus.binaryPath && renderCliStatus.launchError);

  // Not installed — red error banner
  if (!renderCliStatus.installed) {
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
                  ? t('cliStatus.runtime.foundButFailed', { runtime: runtimeDisplayName })
                  : t('cliStatus.runtime.isRequired', { runtime: runtimeDisplayName })}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {cliLaunchIssue
                  ? t('cliStatus.runtime.healthCheckFailedDescription', {
                      runtime: runtimeDisplayName,
                    })
                  : t('cliStatus.runtime.installRequiredDescription', {
                      runtime: runtimeDisplayName,
                    })}
              </p>
              {renderCliStatus.showBinaryPath && renderCliStatus.binaryPath && (
                <p
                  className="mt-2 break-all font-mono text-[11px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {renderCliStatus.binaryPath}
                </p>
              )}
              {cliLaunchIssue && renderCliStatus.launchError && (
                <div
                  className="mt-2 rounded border px-2 py-1.5 font-mono text-[11px]"
                  style={{
                    borderColor: 'rgba(239, 68, 68, 0.2)',
                    backgroundColor: 'rgba(239, 68, 68, 0.04)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {renderCliStatus.launchError}
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
              {t('cliStatus.actions.recheck')}
            </button>
            {renderCliStatus.supportsSelfUpdate ? (
              <button
                onClick={handleInstall}
                disabled={isBusy}
                className="flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
                style={{ backgroundColor: '#3b82f6' }}
              >
                <Download className="size-4" />
                {cliLaunchIssue
                  ? t('cliStatus.runtime.reinstall', { runtime: runtimeDisplayName })
                  : t('cliStatus.runtime.install', { runtime: runtimeDisplayName })}
              </button>
            ) : (
              <p className="max-w-40 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {cliLaunchIssue
                  ? t('cliStatus.runtime.configuredHealthCheckFailed', {
                      runtime: runtimeDisplayName,
                    })
                  : t('cliStatus.runtime.configuredNotFound', { runtime: runtimeDisplayName })}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Installed but not logged in — yellow warning banner
  if (
    renderCliStatus.installed &&
    renderCliStatus.flavor !== 'agent_teams_orchestrator' &&
    (renderCliStatus.authStatusChecking || isVerifyingAuth)
  ) {
    if (renderCliStatus.authStatusChecking || isVerifyingAuth) {
      return (
        <>
          <InstalledBanner
            cliStatus={renderCliStatus}
            sourceProviderMap={loadingCliProviderMap}
            cliStatusLoading={cliStatusLoading}
            cliProviderStatusLoading={cliProviderStatusLoading}
            codexSnapshotPending={codexSnapshotPending}
            cliStatusError={cliStatusError ?? null}
            providersCollapsed={providersCollapsed}
            providerConnectionAuthModes={providerConnectionAuthModes}
            codexRateLimitsLoading={codexAccount.rateLimitsLoading}
            anthropicRateLimitsRefreshing={anthropicRateLimitsRefreshing}
            openCodeRuntimeStatus={openCodeRuntimeStatus}
            openCodeRuntimeStatusLoading={openCodeRuntimeStatusLoading}
            codexRuntimeStatus={codexRuntimeStatus}
            codexRuntimeStatusLoading={codexRuntimeStatusLoading}
            isBusy={isBusy}
            onInstall={handleInstall}
            onOpenCodeInstall={() => void installOpenCodeRuntime()}
            onCodexInstall={() => setCodexRuntimeDialogOpen(true)}
            onRefresh={handleRefresh}
            onToggleProvidersCollapsed={handleToggleProvidersCollapsed}
            onProviderLogin={handleProviderLogin}
            onProviderLogout={handleProviderLogout}
            onProviderManage={handleProviderManage}
            onOpenCodeProviderConnect={handleOpenCodeProviderConnect}
            onProviderRefresh={handleProviderRefresh}
            onCodexReconnect={handleCodexDashboardLogin}
            onCodexDeviceCodeLogin={handleCodexDashboardDeviceCodeLogin}
            codexReconnectBusy={codexAccount.loading}
            variant={variant}
          />
          {installedAuxiliaryUi}
        </>
      );
    }
  }

  if (
    renderCliStatus.installed &&
    renderCliStatus.flavor !== 'agent_teams_orchestrator' &&
    !renderCliStatus.authStatusChecking &&
    !renderCliStatus.authLoggedIn
  ) {
    const apiKeyActionRequiredProviders = getApiKeyActionRequiredProviders(
      renderCliStatus.providers
    );
    const hasApiKeyModeIssue = apiKeyActionRequiredProviders.length > 0;
    const primaryApiKeyProvider = apiKeyActionRequiredProviders[0] ?? null;
    const apiKeyMissingProviders = apiKeyActionRequiredProviders.filter(
      (provider) => provider.connection?.apiKeyConfigured !== true
    );
    const allApiKeyIssuesAreMissingKeys =
      hasApiKeyModeIssue && apiKeyMissingProviders.length === apiKeyActionRequiredProviders.length;
    const warningTitle = hasApiKeyModeIssue
      ? allApiKeyIssuesAreMissingKeys
        ? t('cliStatus.labels.apiKeyRequired')
        : t('cliStatus.labels.providerActionRequired')
      : t('cliStatus.labels.notLoggedIn');
    const warningMessage = hasApiKeyModeIssue
      ? allApiKeyIssuesAreMissingKeys
        ? apiKeyActionRequiredProviders.length === 1 && primaryApiKeyProvider
          ? t('cliStatus.warnings.singleApiKeyMissing', {
              provider: primaryApiKeyProvider.displayName,
            })
          : t('cliStatus.warnings.multipleApiKeysMissing')
        : apiKeyActionRequiredProviders.length === 1 && primaryApiKeyProvider
          ? t('cliStatus.warnings.singleApiKeyNeedsAttention', {
              provider: primaryApiKeyProvider.displayName,
            })
          : t('cliStatus.warnings.multipleApiKeysNeedAttention')
      : t('cliStatus.warnings.notAuthenticated', { runtime: runtimeDisplayName });

    return (
      <>
        <InstalledBanner
          cliStatus={renderCliStatus}
          sourceProviderMap={loadingCliProviderMap}
          cliStatusLoading={cliStatusLoading}
          cliProviderStatusLoading={cliProviderStatusLoading}
          codexSnapshotPending={codexSnapshotPending}
          cliStatusError={cliStatusError ?? null}
          providersCollapsed={providersCollapsed}
          providerConnectionAuthModes={providerConnectionAuthModes}
          codexRateLimitsLoading={codexAccount.rateLimitsLoading}
          anthropicRateLimitsRefreshing={anthropicRateLimitsRefreshing}
          openCodeRuntimeStatus={openCodeRuntimeStatus}
          openCodeRuntimeStatusLoading={openCodeRuntimeStatusLoading}
          codexRuntimeStatus={codexRuntimeStatus}
          codexRuntimeStatusLoading={codexRuntimeStatusLoading}
          isBusy={isBusy}
          onInstall={handleInstall}
          onOpenCodeInstall={() => void installOpenCodeRuntime()}
          onCodexInstall={() => setCodexRuntimeDialogOpen(true)}
          onRefresh={handleRefresh}
          onToggleProvidersCollapsed={handleToggleProvidersCollapsed}
          onProviderLogin={handleProviderLogin}
          onProviderLogout={handleProviderLogout}
          onProviderManage={handleProviderManage}
          onOpenCodeProviderConnect={handleOpenCodeProviderConnect}
          onProviderRefresh={handleProviderRefresh}
          onCodexReconnect={handleCodexDashboardLogin}
          onCodexDeviceCodeLogin={handleCodexDashboardDeviceCodeLogin}
          codexReconnectBusy={codexAccount.loading}
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
                  {t('cliStatus.actions.manageProviders')}
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
                    {t('cliStatus.actions.alreadyLoggedIn')}
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
                    {t('cliStatus.actions.login')}
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
                {t('cliStatus.hints.troubleshootTitle')}
              </p>
              <ol
                className="ml-4 list-decimal space-y-1.5 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <li>
                  {t('cliStatus.troubleshoot.click')}{' '}
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
                    {t('cliStatus.actions.recheck')}
                  </button>{' '}
                  {t('cliStatus.troubleshoot.statusCacheHint')}
                </li>
                <li>
                  {t('cliStatus.troubleshoot.openTerminal')}{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {renderCliStatus.showBinaryPath && renderCliStatus.binaryPath
                      ? `"${renderCliStatus.binaryPath}" auth status`
                      : t('cliStatus.troubleshoot.authStatusCommand')}
                  </code>{' '}
                  {t('cliStatus.troubleshoot.checkLoggedIn')}
                </li>
                <li>
                  {t('cliStatus.troubleshoot.reloginPrefix')}{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {renderCliStatus.showBinaryPath && renderCliStatus.binaryPath
                      ? `"${renderCliStatus.binaryPath}" auth logout`
                      : t('cliStatus.troubleshoot.logoutCommand')}
                  </code>{' '}
                  {t('cliStatus.troubleshoot.then')}{' '}
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                    {renderCliStatus.showBinaryPath && renderCliStatus.binaryPath
                      ? `"${renderCliStatus.binaryPath}" auth login`
                      : t('cliStatus.troubleshoot.loginCommand')}
                  </code>{' '}
                  {t('cliStatus.troubleshoot.again')}
                </li>
                <li>
                  {t('cliStatus.troubleshoot.sameRuntime')}
                  {renderCliStatus.showBinaryPath && renderCliStatus.binaryPath && (
                    <span>
                      :{' '}
                      <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">
                        {renderCliStatus.binaryPath}
                      </code>
                    </span>
                  )}
                </li>
              </ol>
              <p className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t('cliStatus.hints.loginRequiredForTeams')}
              </p>
            </div>
          )}
        </div>
        {installedAuxiliaryUi}
        {showLoginTerminal && renderCliStatus.binaryPath && (
          <Suspense fallback={null}>
            <TerminalModal
              title={t('cliStatus.labels.runtimeLoginTitle', {
                runtime: getHumanRuntimeDisplayName(renderCliStatus, multimodelEnabled),
              })}
              command={renderCliStatus.binaryPath}
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
              autoCloseOnSuccessMs={4000}
              successMessage={t('cliStatus.labels.loginComplete')}
              failureMessage={t('cliStatus.labels.loginFailed')}
            />
          </Suspense>
        )}
      </>
    );
  }

  // Installed — show version, path, update info
  return (
    <>
      <InstalledBanner
        cliStatus={renderCliStatus}
        sourceProviderMap={loadingCliProviderMap}
        cliStatusLoading={cliStatusLoading}
        cliProviderStatusLoading={cliProviderStatusLoading}
        codexSnapshotPending={codexSnapshotPending}
        cliStatusError={cliStatusError ?? null}
        providersCollapsed={providersCollapsed}
        providerConnectionAuthModes={providerConnectionAuthModes}
        codexRateLimitsLoading={codexAccount.rateLimitsLoading}
        anthropicRateLimitsRefreshing={anthropicRateLimitsRefreshing}
        openCodeRuntimeStatus={openCodeRuntimeStatus}
        openCodeRuntimeStatusLoading={openCodeRuntimeStatusLoading}
        codexRuntimeStatus={codexRuntimeStatus}
        codexRuntimeStatusLoading={codexRuntimeStatusLoading}
        isBusy={isBusy}
        onInstall={handleInstall}
        onOpenCodeInstall={() => void installOpenCodeRuntime()}
        onCodexInstall={() => setCodexRuntimeDialogOpen(true)}
        onRefresh={handleRefresh}
        onToggleProvidersCollapsed={handleToggleProvidersCollapsed}
        onProviderLogin={handleProviderLogin}
        onProviderLogout={handleProviderLogout}
        onProviderManage={handleProviderManage}
        onOpenCodeProviderConnect={handleOpenCodeProviderConnect}
        onProviderRefresh={handleProviderRefresh}
        onCodexReconnect={handleCodexDashboardLogin}
        onCodexDeviceCodeLogin={handleCodexDashboardDeviceCodeLogin}
        codexReconnectBusy={codexAccount.loading}
        variant={variant}
      />
      {installedAuxiliaryUi}
    </>
  );
};
