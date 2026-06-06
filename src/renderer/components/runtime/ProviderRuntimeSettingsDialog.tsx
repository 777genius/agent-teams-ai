import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatCodexCreditsValue,
  formatCodexRemainingPercent,
  formatCodexResetWindowLabel,
  formatCodexUsagePercent,
  formatCodexUsageWindowLabel,
  formatCodexWindowDurationLong,
  mergeCodexProviderStatusWithSnapshot,
  normalizeCodexResetTimestamp,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import {
  CODEX_FAST_CREDIT_COST_MULTIPLIER,
  CODEX_FAST_MODEL_ID,
  CODEX_FAST_SPEED_MULTIPLIER,
  resolveCodexFastMode,
  resolveCodexRuntimeSelection,
} from '@features/codex-runtime-profile/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { RuntimeProviderManagementPanel } from '@features/runtime-provider-management/renderer';
import { api } from '@renderer/api';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import {
  CodexLoginLinkCopyButton,
  CodexLoginUserCodeBadge,
} from '@renderer/components/runtime/CodexLoginLinkCopyButton';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useStore } from '@renderer/store';
import { AlertTriangle, Download, Key, Link2, Loader2, Save, Trash2 } from 'lucide-react';

import {
  isCodexProviderRuntimeMissing,
  shouldOfferCodexRuntimeInstall,
} from './codexRuntimeInstallAction';
import {
  formatProviderAuthMethodLabelForProvider,
  formatProviderAuthModeLabelForProvider,
  formatProviderStatusText,
  getProviderConnectLabel,
  getProviderCurrentRuntimeSummary,
  isConnectionManagedRuntimeProvider,
} from './providerConnectionUi';
import {
  getProviderRuntimeBackendSummary,
  getVisibleProviderRuntimeBackendOptions,
  ProviderRuntimeBackendSelector,
} from './ProviderRuntimeBackendSelector';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderAuthMode, CliProviderId, CliProviderStatus } from '@shared/types';
import type { ApiKeyEntry } from '@shared/types/extensions';

type ApiKeyProviderId = 'anthropic' | 'codex' | 'gemini';
type PendingConnectionAction =
  | 'auto'
  | 'oauth'
  | 'chatgpt'
  | 'api_key'
  | 'compatible'
  | 'codex-custom-provider'
  | null;

interface ConnectionMethodCardOption {
  readonly authMode: CliProviderAuthMode;
  readonly title: string;
  readonly description: string;
}

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: CliProviderStatus[];
  readonly initialProviderId: CliProviderId;
  readonly initialRuntimeProviderId?: string | null;
  readonly initialRuntimeProviderAction?: 'connect' | 'select' | null;
  readonly projectPath?: string | null;
  readonly providerStatusLoading?: Partial<Record<CliProviderId, boolean>>;
  readonly disabled?: boolean;
  readonly codexRuntimeStatus?: CodexRuntimeStatus | null;
  readonly codexRuntimeStatusLoading?: boolean;
  readonly onInstallCodexRuntime?: () => Promise<void> | void;
  readonly onSelectBackend: (providerId: CliProviderId, backendId: string) => Promise<void> | void;
  readonly onRefreshProvider?: (providerId: CliProviderId) => Promise<void> | void;
  readonly onRequestLogin?: (providerId: CliProviderId) => void;
}

const API_KEY_PROVIDER_CONFIG: Record<
  ApiKeyProviderId,
  {
    envVarName: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
    name: string;
    title: string;
    description: string;
    placeholder: string;
  }
> = {
  anthropic: {
    envVarName: 'ANTHROPIC_API_KEY',
    name: 'Anthropic API Key',
    title: 'API key',
    description:
      'Use a direct Anthropic API key for API-billed access. Your Anthropic subscription session stays available when you switch back.',
    placeholder: 'sk-ant-...',
  },
  codex: {
    envVarName: 'OPENAI_API_KEY',
    name: 'Codex API Key',
    title: 'API key',
    description:
      'Use an OpenAI API key as a secondary Codex auth path. If you switch Codex to API key mode, the app will mirror OPENAI_API_KEY into CODEX_API_KEY for native launches.',
    placeholder: 'sk-proj-...',
  },
  gemini: {
    envVarName: 'GEMINI_API_KEY',
    name: 'Gemini API Key',
    title: 'API access',
    description:
      'Use `GEMINI_API_KEY` for the Gemini API backend. CLI SDK and ADC do not require it.',
    placeholder: 'AIza...',
  },
};

const API_KEY_PROVIDER_TRANSLATION_KEYS = {
  anthropic: {
    name: 'providerRuntime.apiKey.providers.anthropic.name',
    title: 'providerRuntime.apiKey.providers.anthropic.title',
    description: 'providerRuntime.apiKey.providers.anthropic.description',
    placeholder: 'providerRuntime.apiKey.providers.anthropic.placeholder',
  },
  codex: {
    name: 'providerRuntime.apiKey.providers.codex.name',
    title: 'providerRuntime.apiKey.providers.codex.title',
    description: 'providerRuntime.apiKey.providers.codex.description',
    placeholder: 'providerRuntime.apiKey.providers.codex.placeholder',
  },
  gemini: {
    name: 'providerRuntime.apiKey.providers.gemini.name',
    title: 'providerRuntime.apiKey.providers.gemini.title',
    description: 'providerRuntime.apiKey.providers.gemini.description',
    placeholder: 'providerRuntime.apiKey.providers.gemini.placeholder',
  },
} as const satisfies Record<
  ApiKeyProviderId,
  {
    name: string;
    title: string;
    description: string;
    placeholder: string;
  }
>;

const ANTHROPIC_COMPATIBLE_AUTH_TOKEN_ENV_VAR = 'ANTHROPIC_AUTH_TOKEN';
const ANTHROPIC_COMPATIBLE_AUTH_TOKEN_NAME = 'Anthropic-compatible Auth Token';
const CODEX_CUSTOM_PROVIDER_MODEL_MAX_LENGTH = 200;
const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com']);

function isApiKeyProviderId(providerId: CliProviderId): providerId is ApiKeyProviderId {
  return providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini';
}

function isCodexRuntimeInstalling(
  status: CodexRuntimeStatus | null | undefined,
  loading: boolean
): boolean {
  return (
    loading ||
    status?.state === 'checking' ||
    status?.state === 'downloading' ||
    status?.state === 'installing'
  );
}

function getCodexRuntimeInstallLabel(
  status: CodexRuntimeStatus | null | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (status?.state) {
    case 'checking':
      return t('providerRuntime.codex.install.checking');
    case 'downloading':
      return t('providerRuntime.codex.install.downloading');
    case 'installing':
      return t('providerRuntime.codex.install.installing');
    case 'failed':
      return t('providerRuntime.codex.install.retryInstall');
    default:
      return t('providerRuntime.codex.install.installCli');
  }
}

function findPreferredApiKeyEntry(apiKeys: ApiKeyEntry[], envVarName: string): ApiKeyEntry | null {
  const matches = apiKeys.filter((entry) => entry.envVarName === envVarName);
  return matches.find((entry) => entry.scope === 'user') ?? null;
}

function validateAnthropicCompatibleBaseUrl(
  value: string,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return t('providerRuntime.compatibleEndpoint.validation.baseUrlRequired');
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return t('providerRuntime.compatibleEndpoint.validation.httpRequired');
    }
    if (url.username || url.password) {
      return t('providerRuntime.compatibleEndpoint.validation.noCredentials');
    }
    if (FIRST_PARTY_ANTHROPIC_HOSTS.has(url.hostname)) {
      return t('providerRuntime.compatibleEndpoint.validation.firstPartyAnthropic');
    }
  } catch {
    return t('providerRuntime.compatibleEndpoint.validation.invalidUrl');
  }

  return null;
}

function validateCodexCustomProviderBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Base URL is required when custom endpoint is enabled.';
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must use http:// or https://.';
    }
    if (url.username || url.password) {
      return 'Base URL must not include username or password.';
    }
    if (url.search || url.hash) {
      return 'Base URL must not include query string or fragment.';
    }
  } catch {
    return 'Base URL must be a valid URL.';
  }

  return null;
}

function validateCodexCustomProviderModel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Model id is required when custom endpoint is enabled.';
  }

  if (trimmed.length > CODEX_CUSTOM_PROVIDER_MODEL_MAX_LENGTH) {
    return `Model id must be ${CODEX_CUSTOM_PROVIDER_MODEL_MAX_LENGTH} characters or fewer.`;
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return 'Model id must not include newlines or control characters.';
    }
  }

  return null;
}

function getConnectionDescription(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (provider.providerId) {
    case 'anthropic':
      return t('providerRuntime.connection.descriptions.anthropic');
    case 'codex':
      return t('providerRuntime.connection.descriptions.codex');
    case 'gemini':
      return t('providerRuntime.connection.descriptions.gemini');
    case 'opencode':
      return t('providerRuntime.connection.descriptions.opencode');
  }
}

function getRuntimeDescription(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  switch (provider.providerId) {
    case 'anthropic':
      return t('providerRuntime.runtime.descriptions.anthropic');
    case 'codex':
      return t('providerRuntime.runtime.descriptions.codex');
    case 'gemini':
      return t('providerRuntime.runtime.descriptions.gemini');
    case 'opencode':
      return t('providerRuntime.runtime.descriptions.opencode');
  }
}

function getAuthModeDescription(
  providerId: CliProviderId,
  authMode: CliProviderAuthMode,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  if (providerId === 'anthropic') {
    switch (authMode) {
      case 'auto':
        return t('providerRuntime.authModeDescriptions.anthropic.auto');
      case 'oauth':
        return t('providerRuntime.authModeDescriptions.anthropic.oauth');
      case 'api_key':
        return t('providerRuntime.authModeDescriptions.anthropic.apiKey');
    }
  }

  if (providerId === 'codex') {
    switch (authMode) {
      case 'auto':
        return t('providerRuntime.authModeDescriptions.codex.auto');
      case 'chatgpt':
        return t('providerRuntime.authModeDescriptions.codex.chatgpt');
      case 'api_key':
        return t('providerRuntime.authModeDescriptions.codex.apiKey');
      default:
        return '';
    }
  }

  return '';
}

function getConnectionAlert(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  const authMode = provider.connection?.configuredAuthMode;
  const hasAnthropicSubscriptionSession =
    provider.authMethod === 'oauth_token' || provider.authMethod === 'claude.ai';

  if (provider.providerId === 'anthropic' && provider.connection?.compatibleEndpoint?.enabled) {
    return provider.connection.compatibleEndpoint.tokenConfigured
      ? null
      : t('providerRuntime.alerts.authTokenMissing');
  }

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'api_key' &&
    !provider.connection?.apiKeyConfigured
  ) {
    return t('providerRuntime.alerts.anthropicApiKeyMissing');
  }

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'oauth' &&
    !hasAnthropicSubscriptionSession
  ) {
    return t('providerRuntime.alerts.anthropicSubscriptionMissing');
  }

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'auto' &&
    provider.connection?.apiKeySource === 'stored'
  ) {
    return t('providerRuntime.alerts.anthropicStoredKeyAvailable');
  }

  if (provider.providerId === 'codex') {
    const codex = provider.connection?.codex;
    if (codex?.login.status === 'starting') {
      return t('providerRuntime.alerts.chatgptLoginStarting');
    }

    if (codex?.login.status === 'pending') {
      return t('providerRuntime.alerts.chatgptLoginPending');
    }

    if (codex?.login.status === 'failed' && codex.login.error) {
      return codex.login.error;
    }

    if (provider.connection?.configuredAuthMode === 'api_key') {
      if (!provider.connection?.apiKeyConfigured) {
        return t('providerRuntime.alerts.codexApiKeyMissing');
      }
      return null;
    }

    if (provider.connection?.configuredAuthMode === 'chatgpt' && !codex?.managedAccount) {
      const missingChatgptMessage = codex?.localActiveChatgptAccountPresent
        ? t('providerRuntime.alerts.codexNeedsReconnect')
        : codex?.localAccountArtifactsPresent
          ? t('providerRuntime.alerts.codexLocalArtifactsNoSession')
          : t('providerRuntime.alerts.codexNoChatgptAccount');
      return provider.connection.apiKeyConfigured
        ? t('providerRuntime.alerts.withApiKeyFallback', { message: missingChatgptMessage })
        : missingChatgptMessage;
    }

    if (!codex?.launchAllowed && codex?.launchIssueMessage) {
      return codex.launchIssueMessage;
    }

    if (codex?.appServerState === 'degraded' && codex.appServerStatusMessage) {
      return codex.appServerStatusMessage;
    }

    if (!provider.connection?.apiKeyConfigured && !codex?.managedAccount) {
      return t('providerRuntime.alerts.codexNoCredential');
    }

    return null;
  }

  if (
    provider.providerId === 'gemini' &&
    provider.availableBackends?.some((option) => option.id === 'api' && !option.available)
  ) {
    return t('providerRuntime.alerts.geminiApiUnavailable');
  }

  return null;
}

function getProviderUsageLabel(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  if (provider.providerId === 'anthropic' && provider.connection?.compatibleEndpoint?.enabled) {
    return t('providerRuntime.usage.compatibleEndpoint');
  }

  if (
    provider.providerId === 'anthropic' &&
    provider.connection?.configuredAuthMode === 'api_key'
  ) {
    return provider.connection.apiKeyConfigured
      ? t('providerRuntime.usage.apiKey')
      : t('providerRuntime.usage.apiKeyRequired');
  }

  return provider.authenticated
    ? t('providerRuntime.usage.usingMethod', {
        method: formatProviderAuthMethodLabelForProvider(
          provider.providerId,
          provider.authMethod,
          t
        ),
      })
    : formatProviderStatusText(provider, t);
}

function getCompactOpenCodeProviderDetailMessage(detailMessage?: string | null): string | null {
  const trimmed = detailMessage?.trim();
  if (!trimmed) {
    return null;
  }

  const firstInternalDetailIndex = [' - auth ', ' - behavior ', ' - managed ']
    .map((marker) => trimmed.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  const compact =
    typeof firstInternalDetailIndex === 'number'
      ? trimmed.slice(0, firstInternalDetailIndex).trim()
      : trimmed;
  return compact || null;
}

function getCodexAccountPanelHint(
  provider: CliProviderStatus | null,
  configuredAuthMode: CliProviderAuthMode | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  if (provider?.providerId !== 'codex') {
    return null;
  }

  const codex = provider.connection?.codex;
  if (!codex || codex.login.status === 'starting' || codex.login.status === 'pending') {
    return null;
  }

  const hasActiveChatgptSession =
    codex.effectiveAuthMode === 'chatgpt' && codex.launchAllowed === true;

  if (hasActiveChatgptSession) {
    if (!codex.rateLimits) {
      return t('providerRuntime.codex.account.hints.usageLimitsAfterReport');
    }

    return null;
  }

  const usageSentence = codex.localActiveChatgptAccountPresent
    ? t('providerRuntime.codex.account.hints.reconnectBeforeUsage')
    : codex.localAccountArtifactsPresent
      ? t('providerRuntime.codex.account.hints.localArtifactsNoSession')
      : t('providerRuntime.codex.account.hints.noActiveAccount');
  if (configuredAuthMode === 'chatgpt' && provider.connection?.apiKeyConfigured) {
    return t('providerRuntime.codex.account.hints.detectedApiKeyNeedsApiMode', {
      message: usageSentence,
    });
  }

  if (configuredAuthMode === 'auto' && provider.connection?.apiKeyConfigured) {
    return t('providerRuntime.codex.account.hints.autoUsesApiKeyUntilChatgpt', {
      message: usageSentence,
    });
  }

  return usageSentence;
}

function getCheckingStatusColor(): string {
  return 'var(--color-text-secondary)';
}

function getProviderStatusColor(statusText: string | null, authenticated: boolean): string {
  if (statusText === 'Checking...') {
    return getCheckingStatusColor();
  }

  return authenticated ? '#4ade80' : 'var(--color-text-muted)';
}

function formatCodexResetDateTime(
  timestampSeconds: number | null | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const normalized = normalizeCodexResetTimestamp(timestampSeconds);
  return normalized ? new Date(normalized).toLocaleString() : t('providerRuntime.status.unknown');
}

function formatLocalizedCodexUsageWindowLabel(
  title: 'Primary used' | 'Secondary used' | 'Weekly used',
  windowDurationMins: number | null | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const titleByKey = {
    'Primary used': t('providerRuntime.codex.rateLimits.primaryUsed'),
    'Secondary used': t('providerRuntime.codex.rateLimits.secondaryUsed'),
    'Weekly used': t('providerRuntime.codex.rateLimits.weeklyUsed'),
  };
  return formatCodexUsageWindowLabel(title, windowDurationMins).replace(title, titleByKey[title]);
}

function formatLocalizedCodexResetWindowLabel(
  title: 'Primary reset' | 'Secondary reset' | 'Weekly reset',
  windowDurationMins: number | null | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const titleByKey = {
    'Primary reset': t('providerRuntime.codex.rateLimits.primaryReset'),
    'Secondary reset': t('providerRuntime.codex.rateLimits.secondaryReset'),
    'Weekly reset': t('providerRuntime.codex.rateLimits.weeklyReset'),
  };
  return formatCodexResetWindowLabel(title, windowDurationMins).replace(title, titleByKey[title]);
}

function formatLocalizedCodexUsageExplanation(
  usedPercent: number | null | undefined,
  windowDurationMins: number | null | undefined,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const windowLabel = formatCodexWindowDurationLong(windowDurationMins);
  const remaining = formatCodexRemainingPercent(usedPercent);

  if (windowLabel && remaining) {
    return t('providerRuntime.codex.rateLimits.usageExplanationWithRemaining', {
      used: formatCodexUsagePercent(usedPercent),
      remaining,
      window: windowLabel,
    });
  }

  if (windowLabel) {
    return t('providerRuntime.codex.rateLimits.usageExplanationWindowOnly', {
      window: windowLabel,
    });
  }

  return t('providerRuntime.codex.rateLimits.usageExplanationGeneric');
}

const CodexRateLimitWindowCard = ({
  title,
  usedLabel,
  usedValue,
  remainingValue,
  resetLabel,
  resetValue,
  accent,
}: Readonly<{
  title: string;
  usedLabel: string;
  usedValue: string;
  remainingValue: string;
  resetLabel: string;
  resetValue: string;
  accent: 'primary' | 'secondary';
}>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const accentStyles =
    accent === 'primary'
      ? {
          borderColor: 'rgba(74, 222, 128, 0.24)',
          backgroundColor: 'rgba(74, 222, 128, 0.05)',
          badgeColor: '#86efac',
          badgeBackground: 'rgba(74, 222, 128, 0.14)',
        }
      : {
          borderColor: 'rgba(125, 211, 252, 0.22)',
          backgroundColor: 'rgba(125, 211, 252, 0.04)',
          badgeColor: '#bae6fd',
          badgeBackground: 'rgba(125, 211, 252, 0.14)',
        };

  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{
        borderColor: accentStyles.borderColor,
        backgroundColor: accentStyles.backgroundColor,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          {title}
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            color: accentStyles.badgeColor,
            backgroundColor: accentStyles.badgeBackground,
          }}
        >
          {remainingValue}
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="space-y-1">
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {usedLabel}
          </div>
          <div
            className="text-3xl font-semibold leading-none"
            style={{ color: 'var(--color-text)' }}
          >
            {usedValue}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
            {t('providerRuntime.codex.rateLimits.remainingLeft', { value: remainingValue })}
          </div>
        </div>

        <div
          className="rounded-md border px-3 py-2"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {resetLabel}
          </div>
          <div className="mt-1 text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {resetValue}
          </div>
        </div>
      </div>
    </div>
  );
};

function getConnectionMethodCardOptions(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): ConnectionMethodCardOption[] | null {
  switch (provider.providerId) {
    case 'anthropic':
      return [
        {
          authMode: 'auto',
          title: t('providerRuntime.connectionCards.auto.title'),
          description: t('providerRuntime.connectionCards.anthropic.autoDescription'),
        },
        {
          authMode: 'oauth',
          title: t('providerRuntime.connectionCards.anthropic.subscriptionTitle'),
          description: t('providerRuntime.connectionCards.anthropic.subscriptionDescription'),
        },
        {
          authMode: 'api_key',
          title: t('providerRuntime.connectionCards.apiKey.title'),
          description: t('providerRuntime.connectionCards.anthropic.apiKeyDescription'),
        },
      ];
    case 'codex':
      return [
        {
          authMode: 'auto',
          title: t('providerRuntime.connectionCards.auto.title'),
          description: t('providerRuntime.connectionCards.codex.autoDescription'),
        },
        {
          authMode: 'chatgpt',
          title: t('providerRuntime.connectionCards.codex.chatgptTitle'),
          description: t('providerRuntime.connectionCards.codex.chatgptDescription'),
        },
        {
          authMode: 'api_key',
          title: t('providerRuntime.connectionCards.apiKey.title'),
          description: t('providerRuntime.connectionCards.codex.apiKeyDescription'),
        },
      ];
    default:
      return null;
  }
}

function getConnectionMethodCardsHint(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  if (provider.providerId === 'codex') {
    return t('providerRuntime.connectionCards.codex.hint');
  }

  if (provider.providerId === 'anthropic') {
    return t('providerRuntime.connectionCards.anthropic.hint');
  }

  return null;
}

const ConnectionMethodCards = ({
  options,
  selectedAuthMode,
  disabled,
  connectionSaving,
  pendingConnectionAction,
  onSelect,
}: Readonly<{
  options: ConnectionMethodCardOption[];
  selectedAuthMode: CliProviderAuthMode;
  disabled: boolean;
  connectionSaving: boolean;
  pendingConnectionAction: PendingConnectionAction;
  onSelect: (authMode: CliProviderAuthMode) => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const gridClassName =
    options.length === 3 ? 'grid gap-2 md:grid-cols-3' : 'grid gap-2 sm:grid-cols-2';

  return (
    <div className={gridClassName}>
      {options.map((option) => {
        const selected = selectedAuthMode === option.authMode;
        return (
          <button
            key={option.authMode}
            type="button"
            onClick={() => onSelect(option.authMode)}
            disabled={disabled}
            className="rounded-md border p-3 text-left transition-colors disabled:opacity-60"
            style={{
              borderColor: selected ? 'rgba(74, 222, 128, 0.32)' : 'var(--color-border-subtle)',
              backgroundColor: selected ? 'rgba(74, 222, 128, 0.08)' : 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <div
              className="flex items-center justify-between gap-2 text-sm font-medium"
              style={{ color: 'var(--color-text)' }}
            >
              <span>{option.title}</span>
              {connectionSaving && pendingConnectionAction === option.authMode ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    color: 'var(--color-text-secondary)',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <Loader2 className="size-3 animate-spin" />
                  {t('providerRuntime.connection.switching')}
                </span>
              ) : selected ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    color: '#86efac',
                    backgroundColor: 'rgba(74, 222, 128, 0.14)',
                  }}
                >
                  {t('providerRuntime.connection.selected')}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {option.description}
            </div>
          </button>
        );
      })}
    </div>
  );
};

export const ProviderRuntimeSettingsDialog = ({
  open,
  onOpenChange,
  providers,
  initialProviderId,
  initialRuntimeProviderId = null,
  initialRuntimeProviderAction = null,
  projectPath = null,
  providerStatusLoading = {},
  disabled = false,
  codexRuntimeStatus = null,
  codexRuntimeStatusLoading = false,
  onInstallCodexRuntime,
  onSelectBackend,
  onRefreshProvider,
  onRequestLogin,
}: Props): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [selectedProviderId, setSelectedProviderId] = useState<CliProviderId>(initialProviderId);
  const [activeApiKeyFormProviderId, setActiveApiKeyFormProviderId] =
    useState<ApiKeyProviderId | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [apiKeyScope, setApiKeyScope] = useState<'user' | 'project'>('user');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [pendingConnectionAction, setPendingConnectionAction] =
    useState<PendingConnectionAction>(null);
  const [compatibleBaseUrl, setCompatibleBaseUrl] = useState('');
  const [compatibleTokenValue, setCompatibleTokenValue] = useState('');
  const [compatibleEndpointError, setCompatibleEndpointError] = useState<string | null>(null);
  const [compatibleEndpointStatus, setCompatibleEndpointStatus] = useState<string | null>(null);
  const [codexCustomProviderEnabled, setCodexCustomProviderEnabled] = useState(false);
  const [codexCustomProviderBaseUrl, setCodexCustomProviderBaseUrl] = useState('');
  const [codexCustomProviderModel, setCodexCustomProviderModel] = useState('');
  const [codexCustomProviderApiKeyValue, setCodexCustomProviderApiKeyValue] = useState('');
  const [codexCustomProviderError, setCodexCustomProviderError] = useState<string | null>(null);
  const [codexCustomProviderStatus, setCodexCustomProviderStatus] = useState<string | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);

  const apiKeys = useStore((s) => s.apiKeys);
  const apiKeysLoading = useStore((s) => s.apiKeysLoading);
  const apiKeysError = useStore((s) => s.apiKeysError);
  const apiKeySaving = useStore((s) => s.apiKeySaving);
  const apiKeyStorageStatus = useStore((s) => s.apiKeyStorageStatus);
  const fetchApiKeys = useStore((s) => s.fetchApiKeys);
  const fetchApiKeyStorageStatus = useStore((s) => s.fetchApiKeyStorageStatus);
  const saveApiKey = useStore((s) => s.saveApiKey);
  const deleteApiKey = useStore((s) => s.deleteApiKey);
  const updateConfig = useStore((s) => s.updateConfig);
  const appConfig = useStore((s) => s.appConfig);
  const codexAccount = useCodexAccountSnapshot({
    enabled: open && selectedProviderId === 'codex',
    includeRateLimits: true,
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedProviderId(initialProviderId);
    void fetchApiKeys();
    void fetchApiKeyStorageStatus();
  }, [fetchApiKeyStorageStatus, fetchApiKeys, initialProviderId, open]);

  useEffect(() => {
    if (open) {
      return;
    }

    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');
    setApiKeyScope('user');
    setApiKeyError(null);
    setConnectionError(null);
    setRuntimeError(null);
    setConnectionSaving(false);
    setRuntimeSaving(false);
    setPendingConnectionAction(null);
    setCompatibleBaseUrl('');
    setCompatibleTokenValue('');
    setCompatibleEndpointError(null);
    setCompatibleEndpointStatus(null);
    setCodexCustomProviderEnabled(false);
    setCodexCustomProviderBaseUrl('');
    setCodexCustomProviderModel('');
    setCodexCustomProviderApiKeyValue('');
    setCodexCustomProviderError(null);
    setCodexCustomProviderStatus(null);
  }, [open]);

  useEffect(() => {
    setConnectionError(null);
    setRuntimeError(null);
    setCompatibleEndpointError(null);
    setCompatibleEndpointStatus(null);
    setCodexCustomProviderError(null);
    setCodexCustomProviderStatus(null);
  }, [selectedProviderId]);

  useEffect(() => {
    if (selectedProviderId === 'codex' && codexAccount.error) {
      setConnectionError(codexAccount.error);
    }
  }, [codexAccount.error, selectedProviderId]);

  const statusSelectedProvider = useMemo(() => {
    return (
      providers.find((provider) => provider.providerId === selectedProviderId) ??
      providers.find(
        (provider) => provider.availableBackends && provider.availableBackends.length > 0
      ) ??
      providers[0] ??
      null
    );
  }, [providers, selectedProviderId]);

  const statusApiKeyConfig =
    statusSelectedProvider && isApiKeyProviderId(statusSelectedProvider.providerId)
      ? API_KEY_PROVIDER_CONFIG[statusSelectedProvider.providerId]
      : null;
  const selectedApiKey = statusApiKeyConfig
    ? findPreferredApiKeyEntry(apiKeys, statusApiKeyConfig.envVarName)
    : null;
  const anthropicCompatibleConfig = appConfig?.providerConnections?.anthropic
    .compatibleEndpoint ?? {
    enabled: false,
    baseUrl: '',
  };
  const codexCustomProviderConfig = appConfig?.providerConnections?.codex.customProvider ?? {
    enabled: false,
    baseUrl: '',
    model: '',
  };
  const selectedCompatibleToken = findPreferredApiKeyEntry(
    apiKeys,
    ANTHROPIC_COMPATIBLE_AUTH_TOKEN_ENV_VAR
  );

  const selectedProvider = useMemo(() => {
    const mergedStatusProvider =
      statusSelectedProvider?.providerId === 'codex'
        ? mergeCodexProviderStatusWithSnapshot(statusSelectedProvider, codexAccount.snapshot)
        : statusSelectedProvider;

    if (!mergedStatusProvider?.connection) {
      return mergedStatusProvider;
    }

    const nextConnection = {
      ...mergedStatusProvider.connection,
    };

    if (mergedStatusProvider.providerId === 'anthropic') {
      nextConnection.configuredAuthMode =
        appConfig?.providerConnections?.anthropic.authMode ??
        mergedStatusProvider.connection.configuredAuthMode;
      nextConnection.compatibleEndpoint = {
        ...(mergedStatusProvider.connection.compatibleEndpoint ?? {
          enabled: false,
          baseUrl: '',
          tokenConfigured: false,
          tokenSource: null,
          tokenSourceLabel: null,
        }),
        enabled: anthropicCompatibleConfig.enabled,
        baseUrl: anthropicCompatibleConfig.baseUrl,
      };
      if (selectedCompatibleToken) {
        nextConnection.compatibleEndpoint.tokenConfigured = true;
        nextConnection.compatibleEndpoint.tokenSource = 'stored';
        nextConnection.compatibleEndpoint.tokenSourceLabel = t(
          'providerRuntime.apiKey.storedInApp'
        );
      }
    }

    if (mergedStatusProvider.providerId === 'codex') {
      nextConnection.configuredAuthMode =
        appConfig?.providerConnections?.codex.preferredAuthMode ??
        mergedStatusProvider.connection.configuredAuthMode;
      if (nextConnection.codex) {
        nextConnection.codex = {
          ...nextConnection.codex,
          preferredAuthMode:
            appConfig?.providerConnections?.codex.preferredAuthMode ??
            nextConnection.codex.preferredAuthMode,
          customProvider: {
            ...(nextConnection.codex.customProvider ?? {
              enabled: false,
              active: false,
              baseUrl: '',
              model: '',
              issueMessage: null,
            }),
            enabled: codexCustomProviderConfig.enabled,
            active:
              codexCustomProviderConfig.enabled &&
              (appConfig?.providerConnections?.codex.preferredAuthMode ??
                mergedStatusProvider.connection.configuredAuthMode) === 'api_key' &&
              validateCodexCustomProviderBaseUrl(codexCustomProviderConfig.baseUrl) === null &&
              validateCodexCustomProviderModel(codexCustomProviderConfig.model) === null,
            baseUrl: codexCustomProviderConfig.baseUrl,
            model: codexCustomProviderConfig.model,
          },
        };
      }
    }

    if (statusApiKeyConfig) {
      if (nextConnection.apiKeySource === 'stored') {
        nextConnection.apiKeyConfigured = Boolean(selectedApiKey);
        nextConnection.apiKeySource = selectedApiKey ? 'stored' : null;
        nextConnection.apiKeySourceLabel = selectedApiKey
          ? t('providerRuntime.apiKey.storedInApp')
          : null;
      } else if (!nextConnection.apiKeyConfigured && selectedApiKey) {
        nextConnection.apiKeyConfigured = true;
        nextConnection.apiKeySource = 'stored';
        nextConnection.apiKeySourceLabel = t('providerRuntime.apiKey.storedInApp');
      }
    }

    return {
      ...mergedStatusProvider,
      connection: nextConnection,
    };
  }, [
    anthropicCompatibleConfig.baseUrl,
    anthropicCompatibleConfig.enabled,
    appConfig?.providerConnections?.anthropic.authMode,
    appConfig?.providerConnections?.codex.preferredAuthMode,
    codexAccount.snapshot,
    codexCustomProviderConfig.baseUrl,
    codexCustomProviderConfig.enabled,
    codexCustomProviderConfig.model,
    selectedCompatibleToken,
    selectedApiKey,
    statusApiKeyConfig,
    statusSelectedProvider,
    t,
  ]);

  useEffect(() => {
    if (!open || selectedProviderId !== 'anthropic') {
      return;
    }

    setCompatibleBaseUrl(anthropicCompatibleConfig.baseUrl);
    setCompatibleTokenValue('');
    setCompatibleEndpointError(null);
    setCompatibleEndpointStatus(null);
  }, [anthropicCompatibleConfig.baseUrl, open, selectedProviderId]);

  useEffect(() => {
    if (!open || selectedProviderId !== 'codex') {
      return;
    }

    setCodexCustomProviderEnabled(codexCustomProviderConfig.enabled);
    setCodexCustomProviderBaseUrl(codexCustomProviderConfig.baseUrl);
    setCodexCustomProviderModel(codexCustomProviderConfig.model);
    setCodexCustomProviderApiKeyValue('');
    setCodexCustomProviderError(null);
    setCodexCustomProviderStatus(null);
  }, [
    codexCustomProviderConfig.baseUrl,
    codexCustomProviderConfig.enabled,
    codexCustomProviderConfig.model,
    open,
    selectedProviderId,
  ]);

  const selectedProviderLoading = selectedProvider
    ? providerStatusLoading[selectedProvider.providerId] === true
    : false;
  const runtimeSummary = selectedProvider
    ? getProviderRuntimeBackendSummary(selectedProvider)
    : null;
  const codexConnection =
    selectedProvider?.providerId === 'codex' ? (selectedProvider.connection?.codex ?? null) : null;
  const codexHasActiveChatgptSession =
    codexConnection?.effectiveAuthMode === 'chatgpt' && codexConnection.launchAllowed === true;
  const codexNeedsReconnect =
    Boolean(codexConnection?.localActiveChatgptAccountPresent) && !codexHasActiveChatgptSession;
  const codexLoginPending =
    codexConnection?.login.status === 'starting' || codexConnection?.login.status === 'pending';
  const codexLoginAuthUrl = codexConnection?.login.authUrl ?? null;
  const codexLoginUserCode = codexConnection?.login.userCode ?? null;
  const configurableAuthModes = selectedProvider?.connection?.configurableAuthModes ?? [];
  const configuredAuthMode: CliProviderAuthMode | undefined =
    selectedProvider?.connection?.configuredAuthMode ?? configurableAuthModes[0] ?? undefined;
  const connectionMethodCardOptions = selectedProvider
    ? getConnectionMethodCardOptions(selectedProvider, t)
    : null;
  const showConnectionMethodCards =
    connectionMethodCardOptions !== null && typeof configuredAuthMode !== 'undefined';
  const managedRuntimeSummary = selectedProvider
    ? getProviderCurrentRuntimeSummary(selectedProvider, t)
    : null;
  const connectionManagedRuntime = selectedProvider
    ? isConnectionManagedRuntimeProvider(selectedProvider)
    : false;
  const showRuntimeProviderManagement = selectedProvider?.providerId === 'opencode';
  const hideConnectionMethodMeta = showConnectionMethodCards;
  const canConfigureRuntime =
    !showRuntimeProviderManagement &&
    !connectionManagedRuntime &&
    (selectedProvider
      ? getVisibleProviderRuntimeBackendOptions(selectedProvider).length > 1
      : false);

  const apiKeyProviderId =
    selectedProvider && isApiKeyProviderId(selectedProvider.providerId)
      ? selectedProvider.providerId
      : null;
  const apiKeyConfig = apiKeyProviderId ? API_KEY_PROVIDER_CONFIG[apiKeyProviderId] : null;
  const apiKeyTranslationKeys = apiKeyProviderId
    ? API_KEY_PROVIDER_TRANSLATION_KEYS[apiKeyProviderId]
    : null;
  const apiKeyDisplayConfig = apiKeyTranslationKeys
    ? {
        title: t(apiKeyTranslationKeys.title),
        description: t(apiKeyTranslationKeys.description),
        name: t(apiKeyTranslationKeys.name),
        placeholder: t(apiKeyTranslationKeys.placeholder),
      }
    : null;
  const showApiKeyForm =
    selectedProvider &&
    isApiKeyProviderId(selectedProvider.providerId) &&
    activeApiKeyFormProviderId === selectedProvider.providerId;
  const showApiKeySection = Boolean(
    apiKeyConfig &&
    (selectedProvider?.providerId !== 'codex' || !selectedProvider.connection?.supportsOAuth)
  );
  const connectionAlert = selectedProvider ? getConnectionAlert(selectedProvider, t) : null;
  const connectionLoading =
    selectedProviderLoading ||
    connectionSaving ||
    Boolean(selectedProvider?.providerId === 'codex' && codexAccount.loading && !codexConnection);
  const connectionBusy = disabled || connectionLoading;
  const codexActionBusy =
    disabled || selectedProviderLoading || connectionSaving || codexAccount.loading;
  const codexRuntimeInstallBusy = isCodexRuntimeInstalling(
    codexRuntimeStatus,
    codexRuntimeStatusLoading
  );
  const showCodexRuntimeInstallAction =
    selectedProvider?.providerId === 'codex' &&
    typeof onInstallCodexRuntime === 'function' &&
    isCodexProviderRuntimeMissing(selectedProvider) &&
    shouldOfferCodexRuntimeInstall(codexRuntimeStatus);
  const runtimeBusy = disabled || selectedProviderLoading || runtimeSaving;
  const anthropicFastModeCapability =
    selectedProvider?.providerId === 'anthropic'
      ? (selectedProvider.runtimeCapabilities?.fastMode ?? null)
      : null;
  const anthropicFastModeEnabled =
    appConfig?.providerConnections?.anthropic.fastModeDefault === true;
  const anthropicFastModeSupported = anthropicFastModeCapability?.supported === true;
  const anthropicFastModeAvailable = anthropicFastModeCapability?.available === true;
  const anthropicFastModeDisabledReason =
    anthropicFastModeCapability?.reason ??
    (anthropicFastModeSupported
      ? t('providerRuntime.fastMode.unavailableForRuntime')
      : t('providerRuntime.fastMode.notExposed'));
  const connectionMethodCardsHint = selectedProvider
    ? getConnectionMethodCardsHint(selectedProvider, t)
    : null;
  const codexAccountPanelHint = getCodexAccountPanelHint(
    selectedProvider ?? null,
    configuredAuthMode,
    t
  );
  const codexFastCapability = useMemo(() => {
    if (selectedProvider?.providerId !== 'codex') {
      return null;
    }
    const fastProbeModel =
      selectedProvider.modelCatalog?.models.find((model) => model.supportsFastMode === true)
        ?.launchModel ?? CODEX_FAST_MODEL_ID;
    const selection = resolveCodexRuntimeSelection({
      source: {
        providerStatus: selectedProvider,
        accountSnapshot: codexAccount.snapshot,
      },
      selectedModel: fastProbeModel,
    });
    return resolveCodexFastMode({
      selection,
      selectedFastMode: 'on',
    });
  }, [codexAccount.snapshot, selectedProvider]);
  const codexFastCapabilityHint =
    selectedProvider?.providerId === 'codex' && codexFastCapability
      ? codexFastCapability.selectable
        ? `Fast mode can be enabled per team or schedule for Fast-capable Codex models with your ChatGPT account. It is about ${CODEX_FAST_SPEED_MULTIPLIER}x faster and costs ${CODEX_FAST_CREDIT_COST_MULTIPLIER}x credits.`
        : (codexFastCapability.disabledReason ??
          'Codex Fast mode is currently unavailable for this account or runtime.')
      : null;
  const hasSubscriptionSession =
    selectedProvider?.providerId === 'anthropic'
      ? selectedProvider.authMethod === 'oauth_token' || selectedProvider.authMethod === 'claude.ai'
      : false;
  const canRequestSubscriptionLogin =
    selectedProvider?.providerId === 'anthropic' &&
    Boolean(selectedProvider.connection?.supportsOAuth && onRequestLogin) &&
    selectedProvider.connection?.compatibleEndpoint?.enabled !== true &&
    configuredAuthMode !== 'api_key' &&
    selectedProvider.statusMessage !== 'Checking...' &&
    (!selectedProvider?.authenticated || hasSubscriptionSession || configuredAuthMode === 'oauth');
  const anthropicCompatibleEndpoint =
    selectedProvider?.providerId === 'anthropic'
      ? (selectedProvider.connection?.compatibleEndpoint ?? null)
      : null;
  const anthropicCompatibleEndpointEnabled = anthropicCompatibleEndpoint?.enabled === true;
  const anthropicCompatibleTokenConfigured = Boolean(
    selectedCompatibleToken || anthropicCompatibleEndpoint?.tokenConfigured
  );
  const anthropicCompatibleTokenStatus =
    selectedCompatibleToken?.maskedValue ??
    anthropicCompatibleEndpoint?.tokenSourceLabel ??
    (anthropicCompatibleTokenConfigured ? t('providerRuntime.status.configured') : null);
  const anthropicCompatibleMissingToken =
    anthropicCompatibleEndpointEnabled && !anthropicCompatibleTokenConfigured;
  const codexCustomProvider =
    selectedProvider?.providerId === 'codex'
      ? (selectedProvider.connection?.codex?.customProvider ?? null)
      : null;
  const codexCustomProviderPersistedEnabled =
    codexCustomProvider?.enabled ?? codexCustomProviderConfig.enabled;
  const codexCustomProviderActive = codexCustomProvider?.active === true;
  const codexCustomProviderIssueMessage = codexCustomProvider?.issueMessage ?? null;
  const codexCustomProviderApiKeyConfigured = Boolean(
    selectedProvider?.providerId === 'codex' &&
    (selectedApiKey || selectedProvider.connection?.apiKeyConfigured)
  );
  const codexCustomProviderApiKeyStatus =
    selectedApiKey?.maskedValue ??
    (selectedProvider?.providerId === 'codex'
      ? selectedProvider.connection?.apiKeySourceLabel
      : null) ??
    (codexCustomProviderApiKeyConfigured ? t('providerRuntime.status.configured') : null);
  const codexCustomProviderInactiveMessage =
    codexCustomProviderPersistedEnabled && configuredAuthMode !== 'api_key'
      ? 'Custom endpoint is saved but inactive because Codex is not in API key mode.'
      : null;

  useEffect(() => {
    if (!showApiKeyForm) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [selectedProvider?.providerId, showApiKeyForm]);

  let connectionStatusLabel: string | null = null;
  if (selectedProvider) {
    if (!hideConnectionMethodMeta) {
      connectionStatusLabel = getProviderUsageLabel(selectedProvider, t);
    }
  }
  const showSelectedProviderSummary = Boolean(selectedProvider) && !connectionManagedRuntime;
  const selectedProviderDetailMessage =
    selectedProvider?.providerId === 'opencode'
      ? getCompactOpenCodeProviderDetailMessage(selectedProvider.detailMessage)
      : (selectedProvider?.detailMessage ?? null);
  const selectedProviderDiagnostics =
    selectedProvider?.providerId === 'opencode'
      ? []
      : (selectedProvider?.externalRuntimeDiagnostics ?? []);

  const connectionProgressMessage = useMemo(() => {
    if (!connectionLoading || !selectedProvider) {
      return null;
    }

    if (connectionSaving) {
      if (selectedProvider.providerId === 'anthropic') {
        switch (pendingConnectionAction) {
          case 'api_key':
            return t('providerRuntime.progress.switchingApiKey');
          case 'oauth':
            return t('providerRuntime.progress.switchingAnthropicSubscription');
          case 'auto':
            return t('providerRuntime.progress.switchingAuto');
          case 'compatible':
            return t('providerRuntime.progress.savingCompatibleEndpoint');
          default:
            return t('providerRuntime.progress.applyingConnectionChanges');
        }
      }

      if (selectedProvider.providerId === 'codex') {
        switch (pendingConnectionAction) {
          case 'chatgpt':
            return t('providerRuntime.progress.switchingChatgpt');
          case 'api_key':
            return t('providerRuntime.progress.switchingApiKeyMode');
          case 'auto':
            return t('providerRuntime.progress.switchingAuto');
          case 'codex-custom-provider':
            return 'Saving Codex custom endpoint';
          default:
            return t('providerRuntime.progress.applyingConnectionChanges');
        }
      }

      return t('providerRuntime.progress.applyingConnectionChanges');
    }

    return t('providerRuntime.progress.refreshingProviderStatus');
  }, [connectionLoading, connectionSaving, pendingConnectionAction, selectedProvider, t]);

  const handleStartApiKeyEdit = (): void => {
    if (!selectedProvider || !isApiKeyProviderId(selectedProvider.providerId) || !apiKeyConfig) {
      return;
    }

    setConnectionError(null);
    setActiveApiKeyFormProviderId(selectedProvider.providerId);
    setApiKeyScope(selectedApiKey?.scope ?? 'user');
    setApiKeyValue('');
    setApiKeyError(null);
  };

  const handleCancelApiKeyEdit = (): void => {
    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');
    setApiKeyError(null);
  };

  const handleSaveApiKey = async (): Promise<void> => {
    if (!selectedProvider || !isApiKeyProviderId(selectedProvider.providerId) || !apiKeyConfig) {
      return;
    }

    if (!apiKeyValue.trim()) {
      setApiKeyError(t('providerRuntime.errors.apiKeyRequired'));
      return;
    }

    setApiKeyError(null);
    setConnectionError(null);
    try {
      await saveApiKey({
        id: selectedApiKey?.id,
        name: apiKeyConfig.name,
        envVarName: apiKeyConfig.envVarName,
        value: apiKeyValue.trim(),
        scope: apiKeyScope,
      });
    } catch (error) {
      setApiKeyError(
        error instanceof Error ? error.message : t('providerRuntime.errors.saveApiKey')
      );
      return;
    }

    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');

    try {
      await onRefreshProvider?.(selectedProvider.providerId);
    } catch {
      setConnectionError(t('providerRuntime.errors.apiKeySavedRefreshFailed'));
    }
  };

  const handleDeleteApiKey = async (): Promise<void> => {
    if (!selectedProvider || !selectedApiKey) {
      return;
    }

    setApiKeyError(null);
    setConnectionError(null);
    try {
      await deleteApiKey(selectedApiKey.id);
    } catch (error) {
      setApiKeyError(
        error instanceof Error ? error.message : t('providerRuntime.errors.deleteApiKey')
      );
      return;
    }

    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');

    try {
      await onRefreshProvider?.(selectedProvider.providerId);
    } catch {
      setConnectionError(t('providerRuntime.errors.apiKeyDeletedRefreshFailed'));
    }
  };

  const handleAuthModeChange = async (authMode: string): Promise<void> => {
    if (selectedProvider?.providerId !== 'anthropic' && selectedProvider?.providerId !== 'codex') {
      return;
    }

    const nextAuthMode = authMode as CliProviderAuthMode;
    if (nextAuthMode === configuredAuthMode) {
      return;
    }

    setConnectionSaving(true);
    setPendingConnectionAction(nextAuthMode);
    setConnectionError(null);
    let updateSucceeded = false;
    try {
      if (selectedProvider.providerId === 'anthropic') {
        await updateConfig('providerConnections', {
          anthropic: {
            authMode: nextAuthMode,
          },
        });
      } else if (nextAuthMode !== 'oauth') {
        await updateConfig('providerConnections', {
          codex: {
            preferredAuthMode: nextAuthMode,
          },
        });
        await codexAccount.refresh({ includeRateLimits: true, forceRefreshToken: true });
      }

      updateSucceeded = true;
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : t('providerRuntime.errors.updateConnection')
      );
    } finally {
      if (updateSucceeded) {
        try {
          await onRefreshProvider?.(selectedProvider.providerId);
        } catch {
          setConnectionError(t('providerRuntime.errors.connectionUpdatedRefreshFailed'));
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
    }
  };

  const handleSaveAnthropicCompatibleEndpoint = async (): Promise<void> => {
    if (selectedProvider?.providerId !== 'anthropic') {
      return;
    }

    const baseUrl = compatibleBaseUrl.trim();
    const validationError = validateAnthropicCompatibleBaseUrl(baseUrl, t);
    if (validationError) {
      setCompatibleEndpointError(validationError);
      setCompatibleEndpointStatus(null);
      return;
    }

    setConnectionSaving(true);
    setPendingConnectionAction('compatible');
    setConnectionError(null);
    setCompatibleEndpointError(null);
    setCompatibleEndpointStatus(null);
    let updateSucceeded = false;

    try {
      if (compatibleTokenValue.trim()) {
        await saveApiKey({
          id: selectedCompatibleToken?.id,
          name: ANTHROPIC_COMPATIBLE_AUTH_TOKEN_NAME,
          envVarName: ANTHROPIC_COMPATIBLE_AUTH_TOKEN_ENV_VAR,
          value: compatibleTokenValue.trim(),
          scope: 'user',
        });
      }

      await updateConfig('providerConnections', {
        anthropic: {
          compatibleEndpoint: {
            enabled: true,
            baseUrl,
          },
        },
      });
      updateSucceeded = true;
      setCompatibleTokenValue('');
      setCompatibleEndpointStatus(
        compatibleTokenValue.trim() || anthropicCompatibleTokenConfigured
          ? t('providerRuntime.compatibleEndpoint.status.endpointSaved')
          : t('providerRuntime.compatibleEndpoint.status.endpointSavedTokenMissing')
      );
    } catch (error) {
      setCompatibleEndpointError(
        error instanceof Error ? error.message : t('providerRuntime.errors.saveEndpoint')
      );
    } finally {
      if (updateSucceeded) {
        try {
          await onRefreshProvider?.('anthropic');
        } catch {
          setConnectionError(t('providerRuntime.errors.endpointSavedRefreshFailed'));
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
    }
  };

  const handleDisableAnthropicCompatibleEndpoint = async (): Promise<void> => {
    if (selectedProvider?.providerId !== 'anthropic') {
      return;
    }

    setConnectionSaving(true);
    setPendingConnectionAction('compatible');
    setConnectionError(null);
    setCompatibleEndpointError(null);
    setCompatibleEndpointStatus(null);
    let updateSucceeded = false;

    try {
      await updateConfig('providerConnections', {
        anthropic: {
          compatibleEndpoint: {
            enabled: false,
            baseUrl: compatibleBaseUrl.trim(),
          },
        },
      });
      updateSucceeded = true;
      setCompatibleTokenValue('');
      setCompatibleEndpointStatus(
        t('providerRuntime.compatibleEndpoint.status.endpointDisabledTokenKept')
      );
    } catch (error) {
      setCompatibleEndpointError(
        error instanceof Error ? error.message : t('providerRuntime.errors.disableEndpoint')
      );
    } finally {
      if (updateSucceeded) {
        try {
          await onRefreshProvider?.('anthropic');
        } catch {
          setConnectionError(t('providerRuntime.errors.endpointDisabledRefreshFailed'));
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
    }
  };

  const handleSaveCodexCustomProvider = async (): Promise<void> => {
    if (selectedProvider?.providerId !== 'codex' || !apiKeyConfig) {
      return;
    }

    const baseUrl = codexCustomProviderBaseUrl.trim();
    const model = codexCustomProviderModel.trim();
    const shouldEnable = codexCustomProviderEnabled;
    if (shouldEnable) {
      const baseUrlError = validateCodexCustomProviderBaseUrl(baseUrl);
      if (baseUrlError) {
        setCodexCustomProviderError(baseUrlError);
        setCodexCustomProviderStatus(null);
        return;
      }

      const modelError = validateCodexCustomProviderModel(model);
      if (modelError) {
        setCodexCustomProviderError(modelError);
        setCodexCustomProviderStatus(null);
        return;
      }
    } else if (baseUrl) {
      const baseUrlError = validateCodexCustomProviderBaseUrl(baseUrl);
      if (baseUrlError) {
        setCodexCustomProviderError(baseUrlError);
        setCodexCustomProviderStatus(null);
        return;
      }
    }

    if (!shouldEnable && model) {
      const modelError = validateCodexCustomProviderModel(model);
      if (modelError) {
        setCodexCustomProviderError(modelError);
        setCodexCustomProviderStatus(null);
        return;
      }
    }

    setConnectionSaving(true);
    setPendingConnectionAction('codex-custom-provider');
    setConnectionError(null);
    setCodexCustomProviderError(null);
    setCodexCustomProviderStatus(null);
    let updateSucceeded = false;

    try {
      if (codexCustomProviderApiKeyValue.trim()) {
        await saveApiKey({
          id: selectedApiKey?.id,
          name: apiKeyConfig.name,
          envVarName: apiKeyConfig.envVarName,
          value: codexCustomProviderApiKeyValue.trim(),
          scope: selectedApiKey?.scope ?? 'user',
        });
      }

      await updateConfig('providerConnections', {
        codex: {
          ...(shouldEnable ? { preferredAuthMode: 'api_key' as const } : {}),
          customProvider: {
            enabled: shouldEnable,
            baseUrl,
            model,
          },
        },
      });
      updateSucceeded = true;
      setCodexCustomProviderApiKeyValue('');
      setCodexCustomProviderStatus(
        shouldEnable
          ? 'Custom endpoint saved. Codex API key mode is selected.'
          : 'Custom endpoint disabled. Saved endpoint, model, and key were kept.'
      );
    } catch (error) {
      setCodexCustomProviderError(
        error instanceof Error ? error.message : 'Failed to save Codex custom endpoint.'
      );
    } finally {
      if (updateSucceeded) {
        try {
          await codexAccount.refresh({ includeRateLimits: true, forceRefreshToken: true });
          await onRefreshProvider?.('codex');
        } catch {
          setConnectionError('Codex custom endpoint saved, but provider status refresh failed.');
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
    }
  };

  const handleDisableCodexCustomProvider = async (): Promise<void> => {
    if (selectedProvider?.providerId !== 'codex') {
      return;
    }

    setConnectionSaving(true);
    setPendingConnectionAction('codex-custom-provider');
    setConnectionError(null);
    setCodexCustomProviderError(null);
    setCodexCustomProviderStatus(null);
    let updateSucceeded = false;

    try {
      await updateConfig('providerConnections', {
        codex: {
          customProvider: {
            enabled: false,
            baseUrl: codexCustomProviderConfig.baseUrl,
            model: codexCustomProviderConfig.model,
          },
        },
      });
      updateSucceeded = true;
      setCodexCustomProviderEnabled(false);
      setCodexCustomProviderStatus(
        'Custom endpoint disabled. Saved endpoint, model, and key were kept.'
      );
    } catch (error) {
      setCodexCustomProviderError(
        error instanceof Error ? error.message : 'Failed to disable Codex custom endpoint.'
      );
    } finally {
      if (updateSucceeded) {
        try {
          await codexAccount.refresh({ includeRateLimits: true, forceRefreshToken: true });
          await onRefreshProvider?.('codex');
        } catch {
          setConnectionError('Codex custom endpoint disabled, but provider status refresh failed.');
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
    }
  };

  const handleCodexAccountRefresh = async (): Promise<void> => {
    setConnectionError(null);
    try {
      await codexAccount.refresh({ includeRateLimits: true, forceRefreshToken: true });
      await onRefreshProvider?.('codex');
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : t('providerRuntime.errors.refreshCodexAccount')
      );
    }
  };

  const handleCodexStartLogin = async (
    mode: 'browser' | 'device_code' = 'browser'
  ): Promise<void> => {
    setConnectionError(null);
    const success = await codexAccount.startChatgptLogin(mode);
    if (!success && codexAccount.error) {
      setConnectionError(codexAccount.error);
    }
  };

  const handleCodexCancelLogin = async (): Promise<void> => {
    setConnectionError(null);
    const success = await codexAccount.cancelChatgptLogin();
    if (success) {
      await onRefreshProvider?.('codex');
    } else if (codexAccount.error) {
      setConnectionError(codexAccount.error);
    }
  };

  const handleCodexLogout = async (): Promise<void> => {
    setConnectionError(null);
    const success = await codexAccount.logout();
    if (success) {
      await onRefreshProvider?.('codex');
    } else if (codexAccount.error) {
      setConnectionError(codexAccount.error);
    }
  };

  const handleRuntimeBackendSelect = async (
    providerId: CliProviderId,
    backendId: string
  ): Promise<void> => {
    setRuntimeSaving(true);
    setRuntimeError(null);
    try {
      await onSelectBackend(providerId, backendId);
    } catch (error) {
      setRuntimeError(
        error instanceof Error ? error.message : t('providerRuntime.errors.updateRuntimeBackend')
      );
    } finally {
      setRuntimeSaving(false);
    }
  };

  const handleAnthropicFastModeDefaultChange = async (enabled: boolean): Promise<void> => {
    if (selectedProvider?.providerId !== 'anthropic' || anthropicFastModeEnabled === enabled) {
      return;
    }

    setConnectionSaving(true);
    setConnectionError(null);
    try {
      await updateConfig('providerConnections', {
        anthropic: {
          fastModeDefault: enabled,
        },
      });
      await onRefreshProvider?.('anthropic');
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : t('providerRuntime.errors.updateAnthropicFastMode')
      );
    } finally {
      setConnectionSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,980px)] max-w-[min(96vw,980px)]">
        <DialogHeader>
          <DialogTitle>{t('providerRuntime.title')}</DialogTitle>
          <DialogDescription>{t('providerRuntime.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
              {t('providerRuntime.provider')}
            </div>
            <Tabs
              value={selectedProvider?.providerId ?? selectedProviderId}
              onValueChange={(value) => setSelectedProviderId(value as CliProviderId)}
            >
              <div
                className="-mx-1 border-b px-1"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                <TabsList className="gap-1 rounded-b-none">
                  {providers.map((provider) => (
                    <TabsTrigger
                      key={provider.providerId}
                      value={provider.providerId}
                      className="relative rounded-b-none data-[state=active]:z-10 data-[state=active]:-mb-px data-[state=active]:bg-[var(--color-surface)] data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-1 data-[state=active]:after:bg-[var(--color-surface)] data-[state=active]:after:content-['']"
                    >
                      <span className="inline-flex items-center gap-2">
                        <ProviderBrandLogo
                          providerId={provider.providerId}
                          className="size-4 shrink-0"
                        />
                        <span>{provider.displayName}</span>
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </Tabs>
          </div>

          {showSelectedProviderSummary && selectedProvider ? (
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'rgba(255, 255, 255, 0.025)',
              }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {selectedProvider.displayName}
                </span>
                <span
                  className="text-xs"
                  style={{
                    color: getProviderStatusColor(
                      getProviderUsageLabel(selectedProvider, t),
                      selectedProvider.authenticated
                    ),
                  }}
                >
                  {getProviderUsageLabel(selectedProvider, t)}
                </span>
                {managedRuntimeSummary && !hideConnectionMethodMeta ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {managedRuntimeSummary}
                  </span>
                ) : runtimeSummary ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('providerRuntime.runtimeSummary', { runtime: runtimeSummary })}
                  </span>
                ) : null}
              </div>
              {selectedProviderDetailMessage ? (
                <div className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  {selectedProviderDetailMessage}
                </div>
              ) : null}
              {selectedProviderDiagnostics.length > 0 ? (
                <div
                  className="mt-2 space-y-1 text-[11px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {selectedProviderDiagnostics.slice(0, 3).map((diagnostic) => (
                    <div key={diagnostic.id}>
                      {diagnostic.label}:{' '}
                      {diagnostic.statusMessage ?? (diagnostic.detected ? 'detected' : 'missing')}
                      {diagnostic.detailMessage ? ` - ${diagnostic.detailMessage}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {selectedProvider ? (
            showRuntimeProviderManagement ? (
              <RuntimeProviderManagementPanel
                runtimeId="opencode"
                open={open}
                projectPath={projectPath}
                initialProviderId={initialRuntimeProviderId}
                initialProviderAction={initialRuntimeProviderAction}
                disabled={disabled || selectedProviderLoading}
                onProviderChanged={() => onRefreshProvider?.('opencode')}
              />
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                      {t('providerRuntime.connection.title')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {getConnectionDescription(selectedProvider, t)}
                    </div>
                    {connectionProgressMessage ? (
                      <div
                        className="mt-2 inline-flex items-center gap-1.5 text-[11px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        <Loader2 className="size-3 animate-spin" />
                        <span>{connectionProgressMessage}</span>
                      </div>
                    ) : null}
                  </div>
                  {canRequestSubscriptionLogin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={connectionBusy}
                      onClick={() => onRequestLogin?.(selectedProvider.providerId)}
                    >
                      <Link2 className="mr-1 size-3.5" />
                      {selectedProvider.authenticated &&
                      (selectedProvider.authMethod === 'oauth_token' ||
                        selectedProvider.authMethod === 'claude.ai')
                        ? t('providerRuntime.actions.reconnectAnthropic')
                        : getProviderConnectLabel(selectedProvider, t)}
                    </Button>
                  ) : null}
                </div>

                {showConnectionMethodCards ? (
                  <div className="space-y-2">
                    <Label className="text-xs">{t('providerRuntime.connection.method')}</Label>
                    <ConnectionMethodCards
                      options={connectionMethodCardOptions}
                      selectedAuthMode={configuredAuthMode}
                      disabled={connectionBusy}
                      connectionSaving={connectionSaving}
                      pendingConnectionAction={pendingConnectionAction}
                      onSelect={(authMode) => void handleAuthModeChange(authMode)}
                    />
                    {connectionMethodCardsHint ? (
                      <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                        {connectionMethodCardsHint}
                      </div>
                    ) : null}
                  </div>
                ) : configurableAuthModes.length > 0 && configuredAuthMode ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {selectedProvider.providerId === 'codex'
                        ? t('providerRuntime.connection.method')
                        : t('providerRuntime.connection.authenticationMethod')}
                    </Label>
                    <Select
                      value={configuredAuthMode}
                      disabled={connectionBusy}
                      onValueChange={(value) => void handleAuthModeChange(value)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {configurableAuthModes.map((authMode) => (
                          <SelectItem key={authMode} value={authMode}>
                            {formatProviderAuthModeLabelForProvider(
                              selectedProvider.providerId,
                              authMode,
                              t
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {getAuthModeDescription(selectedProvider.providerId, configuredAuthMode, t)}
                    </div>
                  </div>
                ) : null}

                {selectedProvider.providerId === 'anthropic' ? (
                  <div
                    className="space-y-3 rounded-md border p-3"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                          {t('providerRuntime.compatibleEndpoint.title')}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {t('providerRuntime.compatibleEndpoint.description')}
                        </div>
                      </div>
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px]"
                        style={{
                          color: anthropicCompatibleEndpointEnabled
                            ? '#86efac'
                            : 'var(--color-text-muted)',
                          backgroundColor: anthropicCompatibleEndpointEnabled
                            ? 'rgba(74, 222, 128, 0.14)'
                            : 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        {anthropicCompatibleEndpointEnabled
                          ? t('providerRuntime.status.enabled')
                          : t('providerRuntime.status.off')}
                      </span>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="space-y-1.5">
                        <Label htmlFor="anthropic-compatible-base-url" className="text-xs">
                          {t('providerRuntime.compatibleEndpoint.baseUrl')}
                        </Label>
                        <Input
                          id="anthropic-compatible-base-url"
                          value={compatibleBaseUrl}
                          onChange={(event) => {
                            setCompatibleBaseUrl(event.currentTarget.value);
                            setCompatibleEndpointError(null);
                            setCompatibleEndpointStatus(null);
                          }}
                          placeholder={t('runtimeProvider.compatibleEndpoint.baseUrlPlaceholder')}
                          className="h-9 text-sm"
                          disabled={connectionBusy}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="anthropic-compatible-auth-token" className="text-xs">
                          {t('providerRuntime.compatibleEndpoint.authToken')}
                        </Label>
                        <Input
                          id="anthropic-compatible-auth-token"
                          type="password"
                          value={compatibleTokenValue}
                          onChange={(event) => {
                            setCompatibleTokenValue(event.currentTarget.value);
                            setCompatibleEndpointError(null);
                            setCompatibleEndpointStatus(null);
                          }}
                          placeholder={
                            anthropicCompatibleTokenConfigured
                              ? t('providerRuntime.compatibleEndpoint.keepSavedToken')
                              : 'lmstudio'
                          }
                          className="h-9 text-sm"
                          disabled={connectionBusy || apiKeySaving}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className="rounded-full px-2 py-0.5"
                        style={{
                          color: anthropicCompatibleTokenConfigured
                            ? '#86efac'
                            : 'var(--color-text-muted)',
                          backgroundColor: anthropicCompatibleTokenConfigured
                            ? 'rgba(74, 222, 128, 0.14)'
                            : 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        {t('providerRuntime.compatibleEndpoint.tokenStatus', {
                          status: anthropicCompatibleTokenConfigured
                            ? t('providerRuntime.status.configured')
                            : t('providerRuntime.status.notSet'),
                        })}
                      </span>
                      {anthropicCompatibleTokenStatus ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {anthropicCompatibleTokenStatus}
                        </span>
                      ) : null}
                      {anthropicCompatibleEndpointEnabled &&
                      anthropicCompatibleEndpoint?.baseUrl ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {anthropicCompatibleEndpoint.baseUrl}
                        </span>
                      ) : null}
                    </div>

                    {compatibleEndpointError ? (
                      <div
                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(248, 113, 113, 0.25)',
                          backgroundColor: 'rgba(248, 113, 113, 0.06)',
                          color: '#fca5a5',
                        }}
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{compatibleEndpointError}</span>
                      </div>
                    ) : compatibleEndpointStatus ? (
                      <div
                        className="rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(74, 222, 128, 0.22)',
                          backgroundColor: 'rgba(74, 222, 128, 0.06)',
                          color: '#86efac',
                        }}
                      >
                        {compatibleEndpointStatus}
                      </div>
                    ) : anthropicCompatibleMissingToken ? (
                      <div
                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(245, 158, 11, 0.25)',
                          backgroundColor: 'rgba(245, 158, 11, 0.06)',
                          color: '#fbbf24',
                        }}
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{t('providerRuntime.compatibleEndpoint.authTokenMissing')}</span>
                      </div>
                    ) : null}

                    <div className="flex justify-end gap-2">
                      {anthropicCompatibleEndpointEnabled ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={connectionBusy}
                          onClick={() => void handleDisableAnthropicCompatibleEndpoint()}
                        >
                          {t('providerRuntime.actions.disable')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        disabled={connectionBusy || apiKeySaving || !compatibleBaseUrl.trim()}
                        onClick={() => void handleSaveAnthropicCompatibleEndpoint()}
                      >
                        {connectionSaving && pendingConnectionAction === 'compatible' ? (
                          <Loader2 className="mr-1 size-3.5 animate-spin" />
                        ) : (
                          <Save className="mr-1 size-3.5" />
                        )}
                        {t('providerRuntime.actions.saveEndpoint')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selectedProvider.providerId === 'codex' ? (
                  <div
                    data-testid="codex-custom-provider-panel"
                    className="space-y-3 rounded-md border p-3"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                          Custom API endpoint
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          Route Codex API-key launches through an app-managed custom provider.
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span
                          className="rounded-full px-2 py-0.5"
                          style={{
                            color: codexCustomProviderPersistedEnabled
                              ? '#86efac'
                              : 'var(--color-text-muted)',
                            backgroundColor: codexCustomProviderPersistedEnabled
                              ? 'rgba(74, 222, 128, 0.14)'
                              : 'rgba(255, 255, 255, 0.05)',
                          }}
                        >
                          {codexCustomProviderPersistedEnabled ? 'enabled' : 'off'}
                        </span>
                        {codexCustomProviderPersistedEnabled ? (
                          <span
                            className="rounded-full px-2 py-0.5"
                            style={{
                              color: codexCustomProviderActive
                                ? '#86efac'
                                : 'var(--color-text-muted)',
                              backgroundColor: codexCustomProviderActive
                                ? 'rgba(74, 222, 128, 0.14)'
                                : 'rgba(255, 255, 255, 0.05)',
                            }}
                          >
                            {codexCustomProviderActive ? 'active' : 'inactive'}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-start gap-2 text-xs">
                      <Checkbox
                        checked={codexCustomProviderEnabled}
                        disabled={connectionBusy}
                        onCheckedChange={(checked) => {
                          setCodexCustomProviderEnabled(checked === true);
                          setCodexCustomProviderError(null);
                          setCodexCustomProviderStatus(null);
                        }}
                      />
                      <span style={{ color: 'var(--color-text-secondary)' }}>
                        Enable custom endpoint for Codex API-key launches
                      </span>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="space-y-1.5">
                        <Label htmlFor="codex-custom-provider-base-url" className="text-xs">
                          Base URL
                        </Label>
                        <Input
                          id="codex-custom-provider-base-url"
                          data-testid="codex-custom-provider-base-url"
                          value={codexCustomProviderBaseUrl}
                          onChange={(event) => {
                            setCodexCustomProviderBaseUrl(event.currentTarget.value);
                            setCodexCustomProviderError(null);
                            setCodexCustomProviderStatus(null);
                          }}
                          placeholder="https://gateway.example.com/v1"
                          className="h-9 text-sm"
                          disabled={connectionBusy}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="codex-custom-provider-model" className="text-xs">
                          Model id
                        </Label>
                        <Input
                          id="codex-custom-provider-model"
                          data-testid="codex-custom-provider-model"
                          value={codexCustomProviderModel}
                          onChange={(event) => {
                            setCodexCustomProviderModel(event.currentTarget.value);
                            setCodexCustomProviderError(null);
                            setCodexCustomProviderStatus(null);
                          }}
                          placeholder="gateway-model-id"
                          className="h-9 text-sm"
                          disabled={connectionBusy}
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="codex-custom-provider-api-key" className="text-xs">
                        API key
                      </Label>
                      <Input
                        id="codex-custom-provider-api-key"
                        data-testid="codex-custom-provider-api-key"
                        type="password"
                        value={codexCustomProviderApiKeyValue}
                        onChange={(event) => {
                          setCodexCustomProviderApiKeyValue(event.currentTarget.value);
                          setCodexCustomProviderError(null);
                          setCodexCustomProviderStatus(null);
                        }}
                        placeholder={
                          codexCustomProviderApiKeyConfigured
                            ? 'Keep saved OPENAI_API_KEY'
                            : apiKeyConfig?.placeholder
                        }
                        className="h-9 text-sm"
                        disabled={connectionBusy || apiKeySaving}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className="rounded-full px-2 py-0.5"
                        style={{
                          color: codexCustomProviderApiKeyConfigured
                            ? '#86efac'
                            : 'var(--color-text-muted)',
                          backgroundColor: codexCustomProviderApiKeyConfigured
                            ? 'rgba(74, 222, 128, 0.14)'
                            : 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        API key:{' '}
                        {codexCustomProviderApiKeyConfigured
                          ? t('providerRuntime.status.configured')
                          : t('providerRuntime.status.notSet')}
                      </span>
                      {codexCustomProviderApiKeyStatus ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {codexCustomProviderApiKeyStatus}
                        </span>
                      ) : null}
                      {codexCustomProviderPersistedEnabled && codexCustomProvider?.baseUrl ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {codexCustomProvider.baseUrl}
                        </span>
                      ) : null}
                    </div>

                    <div
                      className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                      style={{
                        borderColor: 'rgba(245, 158, 11, 0.25)',
                        backgroundColor: 'rgba(245, 158, 11, 0.06)',
                        color: '#fbbf24',
                      }}
                    >
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Endpoint must support the Codex Responses API. Chat Completions-only
                        gateways may fail at launch or model probe time.
                      </span>
                    </div>

                    {codexCustomProviderError ? (
                      <div
                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(248, 113, 113, 0.25)',
                          backgroundColor: 'rgba(248, 113, 113, 0.06)',
                          color: '#fca5a5',
                        }}
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{codexCustomProviderError}</span>
                      </div>
                    ) : codexCustomProviderStatus ? (
                      <div
                        className="rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(74, 222, 128, 0.22)',
                          backgroundColor: 'rgba(74, 222, 128, 0.06)',
                          color: '#86efac',
                        }}
                      >
                        {codexCustomProviderStatus}
                      </div>
                    ) : codexCustomProviderIssueMessage ||
                      codexCustomProviderInactiveMessage ||
                      (codexCustomProviderPersistedEnabled &&
                        !codexCustomProviderApiKeyConfigured) ? (
                      <div
                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'rgba(245, 158, 11, 0.25)',
                          backgroundColor: 'rgba(245, 158, 11, 0.06)',
                          color: '#fbbf24',
                        }}
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          {codexCustomProviderIssueMessage ??
                            codexCustomProviderInactiveMessage ??
                            'Custom endpoint is enabled, but no OPENAI_API_KEY is configured.'}
                        </span>
                      </div>
                    ) : null}

                    <div className="flex justify-end gap-2">
                      {codexCustomProviderPersistedEnabled ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={connectionBusy}
                          onClick={() => void handleDisableCodexCustomProvider()}
                        >
                          {t('providerRuntime.actions.disable')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          connectionBusy ||
                          apiKeySaving ||
                          (codexCustomProviderEnabled &&
                            (!codexCustomProviderBaseUrl.trim() ||
                              !codexCustomProviderModel.trim()))
                        }
                        onClick={() => void handleSaveCodexCustomProvider()}
                      >
                        {connectionSaving && pendingConnectionAction === 'codex-custom-provider' ? (
                          <Loader2 className="mr-1 size-3.5 animate-spin" />
                        ) : (
                          <Save className="mr-1 size-3.5" />
                        )}
                        Save endpoint
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {configuredAuthMode && !hideConnectionMethodMeta ? (
                    <span
                      className="rounded-full px-2 py-0.5"
                      style={{
                        color: 'var(--color-text-secondary)',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                      }}
                    >
                      {t('providerRuntime.connection.mode', {
                        mode: formatProviderAuthModeLabelForProvider(
                          selectedProvider.providerId,
                          configuredAuthMode,
                          t
                        ),
                      })}
                    </span>
                  ) : null}
                  {connectionStatusLabel ? (
                    <span
                      className="rounded-full px-2 py-0.5"
                      style={{
                        color: selectedProvider.authenticated
                          ? '#86efac'
                          : 'var(--color-text-muted)',
                        backgroundColor: selectedProvider.authenticated
                          ? 'rgba(74, 222, 128, 0.14)'
                          : 'rgba(255, 255, 255, 0.05)',
                      }}
                    >
                      {connectionStatusLabel}
                    </span>
                  ) : null}
                  {selectedProvider.connection?.apiKeyConfigured && !showApiKeySection ? (
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {selectedProvider.connection.apiKeySourceLabel}
                    </span>
                  ) : null}
                </div>

                {selectedProvider.providerId === 'anthropic' ? (
                  <div
                    className="space-y-2 rounded-md border p-3"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                      {t('providerRuntime.fastMode.title')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {t('providerRuntime.fastMode.description')}
                    </div>
                    {anthropicFastModeSupported ? (
                      <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
                        {[
                          { enabled: false, label: t('providerRuntime.fastMode.defaultOff') },
                          { enabled: true, label: t('providerRuntime.fastMode.preferFast') },
                        ].map((option) => (
                          <button
                            key={option.label}
                            type="button"
                            className={`rounded-[3px] px-3 py-1 text-xs font-medium transition-colors ${
                              anthropicFastModeEnabled === option.enabled
                                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                            }`}
                            disabled={connectionBusy || !anthropicFastModeAvailable}
                            onClick={() =>
                              void handleAnthropicFastModeDefaultChange(option.enabled)
                            }
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {anthropicFastModeSupported && anthropicFastModeAvailable
                        ? anthropicFastModeEnabled
                          ? t('providerRuntime.fastMode.enabledHint')
                          : t('providerRuntime.fastMode.disabledHint')
                        : anthropicFastModeDisabledReason}
                    </div>
                  </div>
                ) : null}

                {selectedProvider.providerId === 'codex' ? (
                  <div
                    className="space-y-3 rounded-md border p-3"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                          {t('providerRuntime.codex.account.title')}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {t('providerRuntime.codex.account.description')}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={codexActionBusy}
                          onClick={() => void handleCodexAccountRefresh()}
                        >
                          {t('providerRuntime.actions.refresh')}
                        </Button>
                        {showCodexRuntimeInstallAction ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={codexActionBusy || codexRuntimeInstallBusy}
                            title={
                              codexRuntimeStatus?.error ??
                              codexRuntimeStatus?.progress?.detail ??
                              t('providerRuntime.codex.install.title')
                            }
                            onClick={() => void onInstallCodexRuntime?.()}
                          >
                            {codexRuntimeInstallBusy ? (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            ) : (
                              <Download className="mr-1 size-3.5" />
                            )}
                            {getCodexRuntimeInstallLabel(codexRuntimeStatus, t)}
                          </Button>
                        ) : null}
                        {codexLoginPending ? (
                          <>
                            <CodexLoginLinkCopyButton
                              authUrl={codexLoginAuthUrl}
                              userCode={codexLoginUserCode}
                              disabled={codexActionBusy}
                            />
                            <CodexLoginUserCodeBadge userCode={codexLoginUserCode} />
                            {codexLoginAuthUrl ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={codexActionBusy}
                                onClick={() => void api.openExternal(codexLoginAuthUrl)}
                              >
                                <Link2 className="mr-1 size-3.5" />
                                {t('providerRuntime.actions.openLogin')}
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={codexActionBusy}
                              onClick={() => void handleCodexCancelLogin()}
                            >
                              {t('providerRuntime.actions.cancelLogin')}
                            </Button>
                          </>
                        ) : codexHasActiveChatgptSession ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={codexActionBusy}
                            onClick={() => void handleCodexLogout()}
                          >
                            {t('providerRuntime.actions.disconnectAccount')}
                          </Button>
                        ) : (
                          <>
                            <CodexLoginLinkCopyButton
                              authUrl={codexLoginAuthUrl}
                              userCode={codexLoginUserCode}
                              disabled={codexActionBusy}
                            />
                            <CodexLoginUserCodeBadge userCode={codexLoginUserCode} />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={codexActionBusy}
                              onClick={() => void handleCodexStartLogin('device_code')}
                            >
                              <Link2 className="mr-1 size-3.5" />
                              {t('providerRuntime.actions.useCode')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={codexActionBusy}
                              onClick={() => void handleCodexStartLogin('browser')}
                            >
                              <Link2 className="mr-1 size-3.5" />
                              {codexNeedsReconnect
                                ? t('providerRuntime.actions.generateLink')
                                : t('providerRuntime.actions.connectChatGpt')}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className="rounded-full px-2 py-0.5"
                        style={{
                          color: codexHasActiveChatgptSession
                            ? '#86efac'
                            : codexNeedsReconnect
                              ? '#fbbf24'
                              : 'var(--color-text-muted)',
                          backgroundColor: codexHasActiveChatgptSession
                            ? 'rgba(74, 222, 128, 0.14)'
                            : codexNeedsReconnect
                              ? 'rgba(245, 158, 11, 0.14)'
                              : 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        {codexHasActiveChatgptSession
                          ? t('providerRuntime.codex.account.connected')
                          : codexNeedsReconnect
                            ? t('providerRuntime.codex.account.reconnectRequired')
                            : codexLoginPending
                              ? t('providerRuntime.codex.account.loginInProgress')
                              : t('providerRuntime.usage.notConnected')}
                      </span>
                      {codexConnection ? (
                        <span
                          className="rounded-full px-2 py-0.5"
                          style={{
                            color:
                              codexConnection.appServerState === 'healthy'
                                ? '#86efac'
                                : codexConnection.appServerState === 'degraded'
                                  ? '#fbbf24'
                                  : '#fca5a5',
                            backgroundColor:
                              codexConnection.appServerState === 'healthy'
                                ? 'rgba(74, 222, 128, 0.14)'
                                : codexConnection.appServerState === 'degraded'
                                  ? 'rgba(245, 158, 11, 0.12)'
                                  : 'rgba(248, 113, 113, 0.08)',
                          }}
                        >
                          {t('providerRuntime.codex.account.appServer', {
                            state: codexConnection.appServerState,
                          })}
                        </span>
                      ) : null}
                      {codexConnection?.managedAccount?.planType ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {t('providerRuntime.codex.account.plan', {
                            plan: codexConnection.managedAccount.planType,
                          })}
                        </span>
                      ) : null}
                      {codexConnection?.managedAccount?.email ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {codexConnection.managedAccount.email}
                        </span>
                      ) : null}
                    </div>

                    {codexAccountPanelHint ? (
                      <div
                        className="rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'var(--color-border-subtle)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        {codexAccountPanelHint}
                      </div>
                    ) : null}

                    {codexFastCapabilityHint ? (
                      <div
                        className="rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: codexFastCapability?.selectable
                            ? 'rgba(34, 197, 94, 0.28)'
                            : 'var(--color-border-subtle)',
                          color: codexFastCapability?.selectable
                            ? '#86efac'
                            : 'var(--color-text-secondary)',
                          backgroundColor: codexFastCapability?.selectable
                            ? 'rgba(34, 197, 94, 0.08)'
                            : 'transparent',
                        }}
                      >
                        {codexFastCapabilityHint}
                      </div>
                    ) : null}

                    {codexConnection?.rateLimits ? (
                      <div className="space-y-2">
                        <div
                          className="rounded-md border px-3 py-2 text-xs"
                          style={{
                            borderColor: 'var(--color-border-subtle)',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {t('providerRuntime.codex.rateLimits.usedQuotaNote')}{' '}
                          {formatLocalizedCodexUsageExplanation(
                            codexConnection.rateLimits.primary?.usedPercent,
                            codexConnection.rateLimits.primary?.windowDurationMins,
                            t
                          )}
                          {codexConnection.rateLimits.secondary
                            ? t('providerRuntime.codex.rateLimits.secondaryWindowNote', {
                                window:
                                  formatCodexWindowDurationLong(
                                    codexConnection.rateLimits.secondary.windowDurationMins
                                  ) ?? t('providerRuntime.codex.rateLimits.secondaryFallback'),
                              })
                            : ''}
                        </div>

                        <div className="space-y-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <CodexRateLimitWindowCard
                              title={t('providerRuntime.codex.rateLimits.primaryWindow')}
                              usedLabel={formatLocalizedCodexUsageWindowLabel(
                                'Primary used',
                                codexConnection.rateLimits.primary?.windowDurationMins,
                                t
                              )}
                              usedValue={formatCodexUsagePercent(
                                codexConnection.rateLimits.primary?.usedPercent
                              )}
                              remainingValue={
                                formatCodexRemainingPercent(
                                  codexConnection.rateLimits.primary?.usedPercent
                                ) ?? t('providerRuntime.codex.rateLimits.remainingUnknown')
                              }
                              resetLabel={formatLocalizedCodexResetWindowLabel(
                                'Primary reset',
                                codexConnection.rateLimits.primary?.windowDurationMins,
                                t
                              )}
                              resetValue={formatCodexResetDateTime(
                                codexConnection.rateLimits.primary?.resetsAt,
                                t
                              )}
                              accent="primary"
                            />

                            {codexConnection.rateLimits.secondary ? (
                              <CodexRateLimitWindowCard
                                title={
                                  codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                    ? t('providerRuntime.codex.rateLimits.weeklyWindow')
                                    : t('providerRuntime.codex.rateLimits.secondaryWindow')
                                }
                                usedLabel={formatLocalizedCodexUsageWindowLabel(
                                  codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                    ? 'Weekly used'
                                    : 'Secondary used',
                                  codexConnection.rateLimits.secondary.windowDurationMins,
                                  t
                                )}
                                usedValue={formatCodexUsagePercent(
                                  codexConnection.rateLimits.secondary.usedPercent
                                )}
                                remainingValue={
                                  formatCodexRemainingPercent(
                                    codexConnection.rateLimits.secondary.usedPercent
                                  ) ?? t('providerRuntime.codex.rateLimits.remainingUnknown')
                                }
                                resetLabel={formatLocalizedCodexResetWindowLabel(
                                  codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                    ? 'Weekly reset'
                                    : 'Secondary reset',
                                  codexConnection.rateLimits.secondary.windowDurationMins,
                                  t
                                )}
                                resetValue={formatCodexResetDateTime(
                                  codexConnection.rateLimits.secondary.resetsAt,
                                  t
                                )}
                                accent="secondary"
                              />
                            ) : (
                              <div
                                className="rounded-lg border px-4 py-3"
                                style={{
                                  borderColor: 'var(--color-border-subtle)',
                                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                                }}
                              >
                                <div
                                  className="text-sm font-medium"
                                  style={{ color: 'var(--color-text)' }}
                                >
                                  {t('providerRuntime.codex.rateLimits.weeklyWindow')}
                                </div>
                                <div
                                  className="mt-3 text-[11px]"
                                  style={{ color: 'var(--color-text-muted)' }}
                                >
                                  {t('providerRuntime.codex.rateLimits.weeklyUsedOneWeek')}
                                </div>
                                <div
                                  className="mt-1 text-sm font-medium"
                                  style={{ color: 'var(--color-text)' }}
                                >
                                  {t('providerRuntime.codex.rateLimits.notReported')}
                                </div>
                                <div
                                  className="mt-1 text-[11px]"
                                  style={{ color: 'var(--color-text-secondary)' }}
                                >
                                  {t('providerRuntime.codex.rateLimits.noSecondaryWindow')}
                                </div>
                              </div>
                            )}
                          </div>

                          <div
                            className="rounded-lg border px-4 py-3"
                            style={{
                              borderColor: 'var(--color-border-subtle)',
                              backgroundColor: 'rgba(255, 255, 255, 0.02)',
                            }}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div
                                  className="text-[11px]"
                                  style={{ color: 'var(--color-text-muted)' }}
                                >
                                  {t('providerRuntime.codex.rateLimits.credits')}
                                </div>
                                <div
                                  className="mt-1 text-sm font-medium"
                                  style={{ color: 'var(--color-text)' }}
                                >
                                  {formatCodexCreditsValue(codexConnection.rateLimits.credits)}
                                </div>
                              </div>
                              <div
                                className="max-w-md text-[11px]"
                                style={{ color: 'var(--color-text-secondary)' }}
                              >
                                {t('providerRuntime.codex.rateLimits.creditsDescription')}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {showApiKeySection && apiKeyConfig ? (
                  <div
                    className="space-y-3 rounded-md border p-3"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div
                            data-testid="provider-api-key-icon"
                            className="flex size-8 shrink-0 items-center justify-center rounded-md border"
                            style={{
                              borderColor: 'var(--color-border-subtle)',
                              backgroundColor: 'rgba(255,255,255,0.03)',
                            }}
                          >
                            <Key
                              className="size-3.5"
                              style={{ color: 'var(--color-text-muted)' }}
                            />
                          </div>
                          <div>
                            <div
                              className="text-sm font-medium"
                              style={{ color: 'var(--color-text)' }}
                            >
                              {apiKeyDisplayConfig?.title ?? apiKeyConfig.title}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                              {apiKeyDisplayConfig?.description ?? apiKeyConfig.description}
                            </div>
                          </div>
                        </div>
                      </div>
                      {!showApiKeyForm ? (
                        <Button size="sm" variant="outline" onClick={handleStartApiKeyEdit}>
                          {selectedApiKey
                            ? t('providerRuntime.actions.replaceKey')
                            : t('providerRuntime.actions.setApiKey')}
                        </Button>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className="rounded-full px-2 py-0.5"
                        style={{
                          color:
                            selectedProvider.connection?.apiKeyConfigured || selectedApiKey
                              ? '#86efac'
                              : 'var(--color-text-muted)',
                          backgroundColor:
                            selectedProvider.connection?.apiKeyConfigured || selectedApiKey
                              ? 'rgba(74, 222, 128, 0.14)'
                              : 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        {selectedProvider.connection?.apiKeyConfigured || selectedApiKey
                          ? t('providerRuntime.status.configured')
                          : t('providerRuntime.status.notConfigured')}
                      </span>
                      {selectedApiKey ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {selectedApiKey.maskedValue} · {selectedApiKey.scope}
                        </span>
                      ) : selectedProvider.connection?.apiKeySource === 'environment' ? (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {selectedProvider.connection.apiKeySourceLabel}
                        </span>
                      ) : null}
                      {apiKeyStorageStatus && selectedApiKey ? (
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          {t('providerRuntime.apiKey.storedIn', {
                            backend: apiKeyStorageStatus.backend,
                          })}
                        </span>
                      ) : null}
                    </div>

                    {showApiKeyForm ? (
                      <div
                        className="space-y-3 rounded-md border p-3"
                        style={{ borderColor: 'var(--color-border-subtle)' }}
                      >
                        <div className="space-y-1.5">
                          <Label
                            htmlFor={`${selectedProvider.providerId}-api-key`}
                            className="text-xs"
                          >
                            {apiKeyDisplayConfig?.name ?? apiKeyConfig.name}
                          </Label>
                          <Input
                            ref={apiKeyInputRef}
                            id={`${selectedProvider.providerId}-api-key`}
                            type="password"
                            value={apiKeyValue}
                            onChange={(e) => setApiKeyValue(e.target.value)}
                            placeholder={
                              apiKeyDisplayConfig?.placeholder ?? apiKeyConfig.placeholder
                            }
                            className="h-9 text-sm"
                            autoFocus
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs">{t('providerRuntime.apiKey.scope')}</Label>
                          <Select
                            value={apiKeyScope}
                            onValueChange={(value) => setApiKeyScope(value as 'user' | 'project')}
                          >
                            <SelectTrigger className="h-9 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="user">
                                {t('providerRuntime.apiKey.userScope')}
                              </SelectItem>
                              <SelectItem value="project">
                                {t('providerRuntime.apiKey.projectScope')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {(apiKeyError || apiKeysError) && (
                          <div
                            className="rounded-md border px-3 py-2 text-xs"
                            style={{
                              borderColor: 'rgba(248, 113, 113, 0.25)',
                              backgroundColor: 'rgba(248, 113, 113, 0.06)',
                              color: '#fca5a5',
                            }}
                          >
                            {apiKeyError ?? apiKeysError}
                          </div>
                        )}

                        <div className="flex justify-between gap-2">
                          {selectedApiKey ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleDeleteApiKey()}
                              disabled={apiKeySaving}
                            >
                              <Trash2 className="mr-1 size-3.5" />
                              {t('providerRuntime.actions.delete')}
                            </Button>
                          ) : (
                            <span />
                          )}
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={handleCancelApiKeyEdit}
                            >
                              {t('providerRuntime.actions.cancel')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void handleSaveApiKey()}
                              disabled={apiKeySaving || !apiKeyValue.trim()}
                            >
                              {apiKeySaving
                                ? t('providerRuntime.actions.saving')
                                : selectedApiKey
                                  ? t('providerRuntime.actions.updateKey')
                                  : t('providerRuntime.actions.saveKey')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {connectionError ? (
                  <div
                    className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                    style={{
                      borderColor: 'rgba(248, 113, 113, 0.25)',
                      backgroundColor: 'rgba(248, 113, 113, 0.06)',
                      color: '#fca5a5',
                    }}
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{connectionError}</span>
                  </div>
                ) : null}

                {connectionAlert ? (
                  <div
                    className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                    style={{
                      borderColor: 'rgba(245, 158, 11, 0.25)',
                      backgroundColor: 'rgba(245, 158, 11, 0.06)',
                      color: '#fbbf24',
                    }}
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{connectionAlert}</span>
                  </div>
                ) : null}

                {apiKeysLoading && !selectedApiKey ? (
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {t('providerRuntime.apiKey.loadingStoredCredentials')}
                  </div>
                ) : null}
              </div>
            )
          ) : null}

          {selectedProvider && canConfigureRuntime ? (
            <div
              className="space-y-3 rounded-lg border p-3"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'rgba(255, 255, 255, 0.025)',
              }}
            >
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {t('providerRuntime.runtime.title')}
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {getRuntimeDescription(selectedProvider, t)}
                </div>
              </div>

              <ProviderRuntimeBackendSelector
                provider={selectedProvider}
                disabled={runtimeBusy}
                onSelect={(providerId, backendId) =>
                  void handleRuntimeBackendSelect(providerId, backendId)
                }
              />

              {runtimeSaving ? (
                <div
                  className="inline-flex items-center gap-1.5 text-[11px]"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <Loader2 className="size-3 animate-spin" />
                  <span>{t('providerRuntime.runtime.updating')}</span>
                </div>
              ) : null}

              {runtimeError ? (
                <div
                  className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                  style={{
                    borderColor: 'rgba(248, 113, 113, 0.25)',
                    backgroundColor: 'rgba(248, 113, 113, 0.06)',
                    color: '#fca5a5',
                  }}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{runtimeError}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
