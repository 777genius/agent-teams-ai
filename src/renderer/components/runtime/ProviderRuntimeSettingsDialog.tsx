import { useEffect, useMemo, useState } from 'react';

import {
  formatCodexCreditsValue,
  formatCodexRemainingPercent,
  formatCodexResetWindowLabel,
  formatCodexUsageExplanation,
  formatCodexUsagePercent,
  formatCodexUsageWindowLabel,
  formatCodexWindowDurationLong,
  mergeCodexProviderStatusWithSnapshot,
  normalizeCodexResetTimestamp,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Button } from '@renderer/components/ui/button';
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
import { AlertTriangle, Key, Link2, Loader2, Trash2 } from 'lucide-react';

import {
  formatProviderAuthMethodLabelForProvider,
  formatProviderAuthModeLabelForProvider,
  getProviderConnectLabel,
  getProviderCurrentRuntimeSummary,
  isConnectionManagedRuntimeProvider,
} from './providerConnectionUi';
import {
  getProviderRuntimeBackendSummary,
  getVisibleProviderRuntimeBackendOptions,
  ProviderRuntimeBackendSelector,
} from './ProviderRuntimeBackendSelector';

import type { CliProviderAuthMode, CliProviderId, CliProviderStatus } from '@shared/types';
import type { ApiKeyEntry } from '@shared/types/extensions';

type ApiKeyProviderId = 'anthropic' | 'codex' | 'gemini';
type PendingConnectionAction = 'auto' | 'oauth' | 'chatgpt' | 'api_key' | null;

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
  readonly providerStatusLoading?: Partial<Record<CliProviderId, boolean>>;
  readonly disabled?: boolean;
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

function isApiKeyProviderId(providerId: CliProviderId): providerId is ApiKeyProviderId {
  return providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini';
}

function findPreferredApiKeyEntry(apiKeys: ApiKeyEntry[], envVarName: string): ApiKeyEntry | null {
  const matches = apiKeys.filter((entry) => entry.envVarName === envVarName);
  return matches.find((entry) => entry.scope === 'user') ?? null;
}

function getConnectionDescription(provider: CliProviderStatus): string {
  switch (provider.providerId) {
    case 'anthropic':
      return 'Choose how app-launched Anthropic sessions authenticate.';
    case 'codex':
      return 'Choose whether Codex should prefer your ChatGPT subscription or an API key when the native runtime launches.';
    case 'gemini':
      return 'Configure optional API access. CLI SDK and ADC are still discovered automatically.';
  }
}

function getRuntimeDescription(provider: CliProviderStatus): string {
  switch (provider.providerId) {
    case 'anthropic':
      return 'Anthropic currently has no separate runtime backend selector.';
    case 'codex':
      return 'Codex now runs only through the native runtime path.';
    case 'gemini':
      return 'Choose which Gemini runtime backend multimodel should use.';
  }
}

function getAuthModeDescription(providerId: CliProviderId, authMode: CliProviderAuthMode): string {
  if (providerId === 'anthropic') {
    switch (authMode) {
      case 'auto':
        return 'Use the runtime default behavior. Saved API keys in this app are only used after you switch to API key mode.';
      case 'oauth':
        return 'Force app-launched Anthropic sessions to use the local Anthropic subscription session.';
      case 'api_key':
        return 'Force app-launched Anthropic sessions to use an API key credential.';
    }
  }

  if (providerId === 'codex') {
    switch (authMode) {
      case 'auto':
        return 'Prefer your ChatGPT account when it is available. Fall back to API key mode only when needed.';
      case 'chatgpt':
        return 'Force native Codex launches to use your connected ChatGPT account and subscription.';
      case 'api_key':
        return 'Force native Codex launches to use OPENAI_API_KEY / CODEX_API_KEY billing.';
      default:
        return '';
    }
  }

  return '';
}

function getConnectionAlert(provider: CliProviderStatus): string | null {
  const authMode = provider.connection?.configuredAuthMode;
  const hasAnthropicSubscriptionSession =
    provider.authMethod === 'oauth_token' || provider.authMethod === 'claude.ai';

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'api_key' &&
    !provider.connection?.apiKeyConfigured
  ) {
    return 'API key mode is selected, but no Anthropic API credential is available yet.';
  }

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'oauth' &&
    !hasAnthropicSubscriptionSession
  ) {
    return 'Anthropic subscription mode is selected. Sign in with Anthropic to use this provider.';
  }

  if (
    provider.providerId === 'anthropic' &&
    authMode === 'auto' &&
    provider.connection?.apiKeySource === 'stored'
  ) {
    return 'A saved API key is available, but app-launched Anthropic sessions use it only after you switch to API key mode.';
  }

  if (provider.providerId === 'codex') {
    const codex = provider.connection?.codex;
    if (codex?.login.status === 'starting') {
      return 'Starting ChatGPT login...';
    }

    if (codex?.login.status === 'pending') {
      return 'Waiting for ChatGPT account login to finish...';
    }

    if (codex?.login.status === 'failed' && codex.login.error) {
      return codex.login.error;
    }

    if (provider.connection?.configuredAuthMode === 'api_key') {
      if (!provider.connection?.apiKeyConfigured) {
        return 'API key mode is selected, but no OPENAI_API_KEY or CODEX_API_KEY credential is available yet.';
      }
      return null;
    }

    if (provider.connection?.configuredAuthMode === 'chatgpt' && !codex?.managedAccount) {
      const missingChatgptMessage = codex?.localActiveChatgptAccountPresent
        ? 'Codex has a locally selected ChatGPT account, but the current session needs reconnect.'
        : codex?.localAccountArtifactsPresent
          ? 'Codex CLI currently has no active ChatGPT account. Local Codex account data exists, but no active managed session is selected.'
          : 'Codex CLI currently has no active ChatGPT account. Connect ChatGPT to use your subscription.';
      return provider.connection.apiKeyConfigured
        ? `${missingChatgptMessage} Switch to API key mode to use the detected API key.`
        : missingChatgptMessage;
    }

    if (!codex?.launchAllowed && codex?.launchIssueMessage) {
      return codex.launchIssueMessage;
    }

    if (codex?.appServerState === 'degraded' && codex.appServerStatusMessage) {
      return codex.appServerStatusMessage;
    }

    if (!provider.connection?.apiKeyConfigured && !codex?.managedAccount) {
      return 'No ChatGPT account or API key is available yet.';
    }

    return null;
  }

  if (
    provider.providerId === 'gemini' &&
    provider.availableBackends?.some((option) => option.id === 'api' && !option.available)
  ) {
    return 'Gemini API is currently unavailable. Configure `GEMINI_API_KEY` here or use valid Google ADC credentials.';
  }

  return null;
}

function getCodexAccountPanelHint(
  provider: CliProviderStatus | null,
  configuredAuthMode: CliProviderAuthMode | undefined
): string | null {
  if (provider?.providerId !== 'codex') {
    return null;
  }

  const codex = provider.connection?.codex;
  if (!codex || codex.login.status === 'starting' || codex.login.status === 'pending') {
    return null;
  }

  if (codex.managedAccount?.type === 'chatgpt') {
    if (!codex.rateLimits) {
      return 'Usage limits appear here after Codex reports them for the connected ChatGPT account.';
    }

    return null;
  }

  const usageSentence = codex.localActiveChatgptAccountPresent
    ? 'Codex has a locally selected ChatGPT account, but the current session needs reconnect before usage limits can load here.'
    : codex.localAccountArtifactsPresent
      ? 'Codex CLI currently reports no active ChatGPT account. Local Codex account data exists, but no active managed session is selected. Usage limits appear here only after Codex CLI sees one.'
      : 'Codex CLI currently reports no active ChatGPT account. Usage limits appear here only after Codex CLI sees one.';
  if (configuredAuthMode === 'chatgpt' && provider.connection?.apiKeyConfigured) {
    return `${usageSentence} The detected API key is only used after you switch Codex to API key mode.`;
  }

  if (configuredAuthMode === 'auto' && provider.connection?.apiKeyConfigured) {
    return `${usageSentence} Auto will keep using the detected API key until ChatGPT is connected.`;
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

function formatCodexResetDateTime(timestampSeconds: number | null | undefined): string {
  const normalized = normalizeCodexResetTimestamp(timestampSeconds);
  return normalized ? new Date(normalized).toLocaleString() : 'Unknown';
}

function CodexRateLimitWindowCard({
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
}>): React.JSX.Element {
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
            {remainingValue} left
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
}

function getConnectionMethodCardOptions(
  provider: CliProviderStatus
): ConnectionMethodCardOption[] | null {
  switch (provider.providerId) {
    case 'anthropic':
      return [
        {
          authMode: 'auto',
          title: 'Auto',
          description: 'Use Anthropic runtime defaults and the best local credential available.',
        },
        {
          authMode: 'oauth',
          title: 'Anthropic subscription',
          description: 'Use your local Anthropic sign-in session and subscription access.',
        },
        {
          authMode: 'api_key',
          title: 'API key',
          description: 'Use ANTHROPIC_API_KEY and Anthropic API billing.',
        },
      ];
    case 'codex':
      return [
        {
          authMode: 'auto',
          title: 'Auto',
          description:
            'Prefer your ChatGPT account and subscription. Use API key mode only if needed.',
        },
        {
          authMode: 'chatgpt',
          title: 'ChatGPT account',
          description: 'Use your connected ChatGPT account and Codex subscription.',
        },
        {
          authMode: 'api_key',
          title: 'API key',
          description: 'Use OPENAI_API_KEY and CODEX_API_KEY billing for native Codex launches.',
        },
      ];
    default:
      return null;
  }
}

function getConnectionMethodCardsHint(provider: CliProviderStatus): string | null {
  if (provider.providerId === 'codex') {
    return 'Codex always runs through the native runtime. Auto prefers your ChatGPT account before falling back to API-key credentials.';
  }

  if (provider.providerId === 'anthropic') {
    return 'Auto keeps Anthropic on its default local credential resolution.';
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
                  Switching...
                </span>
              ) : selected ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    color: '#86efac',
                    backgroundColor: 'rgba(74, 222, 128, 0.14)',
                  }}
                >
                  Selected
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
  providerStatusLoading = {},
  disabled = false,
  onSelectBackend,
  onRefreshProvider,
  onRequestLogin,
}: Props): React.JSX.Element => {
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
  }, [open]);

  useEffect(() => {
    setConnectionError(null);
    setRuntimeError(null);
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
    }

    if (mergedStatusProvider.providerId === 'codex') {
      nextConnection.configuredAuthMode =
        appConfig?.providerConnections?.codex.preferredAuthMode ??
        mergedStatusProvider.connection.configuredAuthMode;
    }

    if (statusApiKeyConfig) {
      if (nextConnection.apiKeySource === 'stored') {
        nextConnection.apiKeyConfigured = Boolean(selectedApiKey);
        nextConnection.apiKeySource = selectedApiKey ? 'stored' : null;
        nextConnection.apiKeySourceLabel = selectedApiKey ? 'Stored in app' : null;
      } else if (!nextConnection.apiKeyConfigured && selectedApiKey) {
        nextConnection.apiKeyConfigured = true;
        nextConnection.apiKeySource = 'stored';
        nextConnection.apiKeySourceLabel = 'Stored in app';
      }
    }

    return {
      ...mergedStatusProvider,
      connection: nextConnection,
    };
  }, [
    appConfig?.providerConnections?.anthropic.authMode,
    appConfig?.providerConnections?.codex.preferredAuthMode,
    codexAccount.snapshot,
    selectedApiKey,
    statusApiKeyConfig,
    statusSelectedProvider,
  ]);

  const selectedProviderLoading = selectedProvider
    ? providerStatusLoading[selectedProvider.providerId] === true
    : false;
  const runtimeSummary = selectedProvider
    ? getProviderRuntimeBackendSummary(selectedProvider)
    : null;
  const codexConnection =
    selectedProvider?.providerId === 'codex' ? (selectedProvider.connection?.codex ?? null) : null;
  const codexLoginPending =
    codexConnection?.login.status === 'starting' || codexConnection?.login.status === 'pending';
  const configurableAuthModes = selectedProvider?.connection?.configurableAuthModes ?? [];
  const configuredAuthMode: CliProviderAuthMode | undefined =
    selectedProvider?.connection?.configuredAuthMode ?? configurableAuthModes[0] ?? undefined;
  const connectionMethodCardOptions = selectedProvider
    ? getConnectionMethodCardOptions(selectedProvider)
    : null;
  const showConnectionMethodCards =
    connectionMethodCardOptions !== null && typeof configuredAuthMode !== 'undefined';
  const managedRuntimeSummary = selectedProvider
    ? getProviderCurrentRuntimeSummary(selectedProvider)
    : null;
  const connectionManagedRuntime = selectedProvider
    ? isConnectionManagedRuntimeProvider(selectedProvider)
    : false;
  const hideConnectionMethodMeta = showConnectionMethodCards;
  const canConfigureRuntime =
    !connectionManagedRuntime &&
    (selectedProvider
      ? getVisibleProviderRuntimeBackendOptions(selectedProvider).length > 1
      : false);

  const apiKeyConfig =
    selectedProvider && isApiKeyProviderId(selectedProvider.providerId)
      ? API_KEY_PROVIDER_CONFIG[selectedProvider.providerId]
      : null;
  const showApiKeyForm =
    selectedProvider &&
    isApiKeyProviderId(selectedProvider.providerId) &&
    activeApiKeyFormProviderId === selectedProvider.providerId;
  const showApiKeySection = Boolean(
    apiKeyConfig &&
    (selectedProvider?.providerId !== 'codex' || !selectedProvider.connection?.supportsOAuth)
  );
  const connectionAlert = selectedProvider ? getConnectionAlert(selectedProvider) : null;
  const connectionLoading =
    selectedProviderLoading ||
    connectionSaving ||
    Boolean(selectedProvider?.providerId === 'codex' && codexAccount.loading && !codexConnection);
  const connectionBusy = disabled || connectionLoading;
  const codexActionBusy =
    disabled || selectedProviderLoading || connectionSaving || codexAccount.loading;
  const runtimeBusy = disabled || selectedProviderLoading || runtimeSaving;
  const connectionMethodCardsHint = selectedProvider
    ? getConnectionMethodCardsHint(selectedProvider)
    : null;
  const codexAccountPanelHint = getCodexAccountPanelHint(
    selectedProvider ?? null,
    configuredAuthMode
  );
  const hasSubscriptionSession =
    selectedProvider?.providerId === 'anthropic'
      ? selectedProvider.authMethod === 'oauth_token' || selectedProvider.authMethod === 'claude.ai'
      : false;
  const canRequestSubscriptionLogin =
    selectedProvider?.providerId === 'anthropic' &&
    Boolean(selectedProvider.connection?.supportsOAuth && onRequestLogin) &&
    configuredAuthMode !== 'api_key' &&
    selectedProvider.statusMessage !== 'Checking...' &&
    (!selectedProvider?.authenticated || hasSubscriptionSession || configuredAuthMode === 'oauth');
  let connectionStatusLabel: string | null = null;
  if (selectedProvider) {
    if (!hideConnectionMethodMeta && selectedProvider.authenticated) {
      connectionStatusLabel = `Using ${formatProviderAuthMethodLabelForProvider(
        selectedProvider.providerId,
        selectedProvider.authMethod
      )}`;
    } else if (!hideConnectionMethodMeta) {
      connectionStatusLabel = 'Not connected';
    }
  }
  const showSelectedProviderSummary = Boolean(selectedProvider) && !connectionManagedRuntime;

  const connectionProgressMessage = useMemo(() => {
    if (!connectionLoading || !selectedProvider) {
      return null;
    }

    if (connectionSaving) {
      if (selectedProvider.providerId === 'anthropic') {
        switch (pendingConnectionAction) {
          case 'api_key':
            return 'Switching to API key...';
          case 'oauth':
            return 'Switching to Anthropic subscription...';
          case 'auto':
            return 'Switching to Auto...';
          default:
            return 'Applying connection changes...';
        }
      }

      if (selectedProvider.providerId === 'codex') {
        switch (pendingConnectionAction) {
          case 'chatgpt':
            return 'Switching to ChatGPT account mode...';
          case 'api_key':
            return 'Switching to API key mode...';
          case 'auto':
            return 'Switching to Auto...';
          default:
            return 'Applying connection changes...';
        }
      }

      return 'Applying connection changes...';
    }

    return 'Refreshing provider status...';
  }, [connectionLoading, connectionSaving, pendingConnectionAction, selectedProvider]);

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
      setApiKeyError('API key is required');
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
      setApiKeyError(error instanceof Error ? error.message : 'Failed to save API key');
      return;
    }

    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');

    try {
      await onRefreshProvider?.(selectedProvider.providerId);
    } catch {
      setConnectionError('API key saved, but failed to refresh provider status.');
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
      setApiKeyError(error instanceof Error ? error.message : 'Failed to delete API key');
      return;
    }

    setActiveApiKeyFormProviderId(null);
    setApiKeyValue('');

    try {
      await onRefreshProvider?.(selectedProvider.providerId);
    } catch {
      setConnectionError('API key deleted, but failed to refresh provider status.');
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
      setConnectionError(error instanceof Error ? error.message : 'Failed to update connection');
    } finally {
      if (updateSucceeded) {
        try {
          await onRefreshProvider?.(selectedProvider.providerId);
        } catch {
          setConnectionError('Connection updated, but failed to refresh provider status.');
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
        error instanceof Error ? error.message : 'Failed to refresh Codex account'
      );
    }
  };

  const handleCodexStartLogin = async (): Promise<void> => {
    setConnectionError(null);
    const success = await codexAccount.startChatgptLogin();
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
      setRuntimeError(error instanceof Error ? error.message : 'Failed to update runtime backend');
    } finally {
      setRuntimeSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Provider Settings</DialogTitle>
          <DialogDescription>
            Manage how each provider connects and, when supported, which backend the multimodel
            runtime should use.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Provider
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
                      selectedProvider.authenticated
                        ? `Using ${formatProviderAuthMethodLabelForProvider(
                            selectedProvider.providerId,
                            selectedProvider.authMethod
                          )}`
                        : selectedProvider.statusMessage || 'Not connected',
                      selectedProvider.authenticated
                    ),
                  }}
                >
                  {selectedProvider.authenticated
                    ? `Using ${formatProviderAuthMethodLabelForProvider(
                        selectedProvider.providerId,
                        selectedProvider.authMethod
                      )}`
                    : selectedProvider.statusMessage || 'Not connected'}
                </span>
                {managedRuntimeSummary && !hideConnectionMethodMeta ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {managedRuntimeSummary}
                  </span>
                ) : runtimeSummary ? (
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    Runtime: {runtimeSummary}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {selectedProvider ? (
            <div
              className="space-y-3 rounded-lg border p-3"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'rgba(255, 255, 255, 0.025)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                    Connection
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {getConnectionDescription(selectedProvider)}
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
                      ? 'Reconnect Anthropic'
                      : getProviderConnectLabel(selectedProvider)}
                  </Button>
                ) : null}
              </div>

              {showConnectionMethodCards ? (
                <div className="space-y-2">
                  <Label className="text-xs">Connection method</Label>
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
                      ? 'Connection method'
                      : 'Authentication method'}
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
                            authMode
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {getAuthModeDescription(selectedProvider.providerId, configuredAuthMode)}
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
                    Mode:{' '}
                    {formatProviderAuthModeLabelForProvider(
                      selectedProvider.providerId,
                      configuredAuthMode
                    )}
                  </span>
                ) : null}
                {connectionStatusLabel ? (
                  <span
                    className="rounded-full px-2 py-0.5"
                    style={{
                      color: selectedProvider.authenticated ? '#86efac' : 'var(--color-text-muted)',
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

              {selectedProvider.providerId === 'codex' ? (
                <div
                  className="space-y-3 rounded-md border p-3"
                  style={{ borderColor: 'var(--color-border-subtle)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                        ChatGPT account
                      </div>
                      <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Manage the local Codex app-server account session that powers
                        subscription-backed native launches.
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={codexActionBusy}
                        onClick={() => void handleCodexAccountRefresh()}
                      >
                        Refresh
                      </Button>
                      {codexLoginPending ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={codexActionBusy}
                          onClick={() => void handleCodexCancelLogin()}
                        >
                          Cancel login
                        </Button>
                      ) : codexConnection?.managedAccount?.type === 'chatgpt' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={codexActionBusy}
                          onClick={() => void handleCodexLogout()}
                        >
                          Disconnect account
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={codexActionBusy}
                          onClick={() => void handleCodexStartLogin()}
                        >
                          <Link2 className="mr-1 size-3.5" />
                          Connect ChatGPT
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="rounded-full px-2 py-0.5"
                      style={{
                        color:
                          codexConnection?.managedAccount?.type === 'chatgpt'
                            ? '#86efac'
                            : 'var(--color-text-muted)',
                        backgroundColor:
                          codexConnection?.managedAccount?.type === 'chatgpt'
                            ? 'rgba(74, 222, 128, 0.14)'
                            : 'rgba(255, 255, 255, 0.05)',
                      }}
                    >
                      {codexConnection?.managedAccount?.type === 'chatgpt'
                        ? 'Connected'
                        : codexLoginPending
                          ? 'Login in progress'
                          : 'Not connected'}
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
                        App-server: {codexConnection.appServerState}
                      </span>
                    ) : null}
                    {codexConnection?.managedAccount?.planType ? (
                      <span style={{ color: 'var(--color-text-secondary)' }}>
                        Plan: {codexConnection.managedAccount.planType}
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

                  {codexConnection?.rateLimits ? (
                    <div className="space-y-2">
                      <div
                        className="rounded-md border px-3 py-2 text-xs"
                        style={{
                          borderColor: 'var(--color-border-subtle)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        These percentages show used quota, not remaining quota.{' '}
                        {formatCodexUsageExplanation(
                          codexConnection.rateLimits.primary?.usedPercent,
                          codexConnection.rateLimits.primary?.windowDurationMins
                        )}
                        {codexConnection.rateLimits.secondary
                          ? ` Weekly limits are shown separately in the ${
                              formatCodexWindowDurationLong(
                                codexConnection.rateLimits.secondary.windowDurationMins
                              ) ?? 'secondary'
                            } window.`
                          : ''}
                      </div>

                      <div className="space-y-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <CodexRateLimitWindowCard
                            title="Primary window"
                            usedLabel={formatCodexUsageWindowLabel(
                              'Primary used',
                              codexConnection.rateLimits.primary?.windowDurationMins
                            )}
                            usedValue={formatCodexUsagePercent(
                              codexConnection.rateLimits.primary?.usedPercent
                            )}
                            remainingValue={
                              formatCodexRemainingPercent(
                                codexConnection.rateLimits.primary?.usedPercent
                              ) ?? 'Remaining unknown'
                            }
                            resetLabel={formatCodexResetWindowLabel(
                              'Primary reset',
                              codexConnection.rateLimits.primary?.windowDurationMins
                            )}
                            resetValue={formatCodexResetDateTime(
                              codexConnection.rateLimits.primary?.resetsAt
                            )}
                            accent="primary"
                          />

                          {codexConnection.rateLimits.secondary ? (
                            <CodexRateLimitWindowCard
                              title={
                                codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                  ? 'Weekly window'
                                  : 'Secondary window'
                              }
                              usedLabel={formatCodexUsageWindowLabel(
                                codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                  ? 'Weekly used'
                                  : 'Secondary used',
                                codexConnection.rateLimits.secondary.windowDurationMins
                              )}
                              usedValue={formatCodexUsagePercent(
                                codexConnection.rateLimits.secondary.usedPercent
                              )}
                              remainingValue={
                                formatCodexRemainingPercent(
                                  codexConnection.rateLimits.secondary.usedPercent
                                ) ?? 'Remaining unknown'
                              }
                              resetLabel={formatCodexResetWindowLabel(
                                codexConnection.rateLimits.secondary.windowDurationMins === 10_080
                                  ? 'Weekly reset'
                                  : 'Secondary reset',
                                codexConnection.rateLimits.secondary.windowDurationMins
                              )}
                              resetValue={formatCodexResetDateTime(
                                codexConnection.rateLimits.secondary.resetsAt
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
                                Weekly window
                              </div>
                              <div
                                className="mt-3 text-[11px]"
                                style={{ color: 'var(--color-text-muted)' }}
                              >
                                Weekly used (1w)
                              </div>
                              <div
                                className="mt-1 text-sm font-medium"
                                style={{ color: 'var(--color-text)' }}
                              >
                                Not reported
                              </div>
                              <div
                                className="mt-1 text-[11px]"
                                style={{ color: 'var(--color-text-secondary)' }}
                              >
                                Codex did not return a secondary window for this account snapshot.
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
                                Credits
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
                              Credits are shown separately from window-based subscription usage and
                              may be unavailable for plan-backed ChatGPT sessions.
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
                          <Key className="size-3.5" style={{ color: 'var(--color-text-muted)' }} />
                        </div>
                        <div>
                          <div
                            className="text-sm font-medium"
                            style={{ color: 'var(--color-text)' }}
                          >
                            {apiKeyConfig.title}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            {apiKeyConfig.description}
                          </div>
                        </div>
                      </div>
                    </div>
                    {!showApiKeyForm ? (
                      <Button size="sm" variant="outline" onClick={handleStartApiKeyEdit}>
                        {selectedApiKey ? 'Replace key' : 'Set API key'}
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
                        ? 'Configured'
                        : 'Not configured'}
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
                        Stored in {apiKeyStorageStatus.backend}
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
                          {apiKeyConfig.name}
                        </Label>
                        <Input
                          id={`${selectedProvider.providerId}-api-key`}
                          type="password"
                          value={apiKeyValue}
                          onChange={(e) => setApiKeyValue(e.target.value)}
                          placeholder={apiKeyConfig.placeholder}
                          className="h-9 text-sm"
                          autoFocus
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs">Scope</Label>
                        <Select
                          value={apiKeyScope}
                          onValueChange={(value) => setApiKeyScope(value as 'user' | 'project')}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">User</SelectItem>
                            <SelectItem value="project">Project</SelectItem>
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
                            Delete
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
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void handleSaveApiKey()}
                            disabled={apiKeySaving || !apiKeyValue.trim()}
                          >
                            {apiKeySaving
                              ? 'Saving...'
                              : selectedApiKey
                                ? 'Update key'
                                : 'Save key'}
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
                  Loading stored credentials...
                </div>
              ) : null}
            </div>
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
                  Runtime
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {getRuntimeDescription(selectedProvider)}
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
                  <span>Updating runtime...</span>
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
