import { useEffect, useMemo, useState } from 'react';

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
  ProviderRuntimeBackendSelector,
} from './ProviderRuntimeBackendSelector';

import type { CliProviderAuthMode, CliProviderId, CliProviderStatus } from '@shared/types';
import type { ApiKeyEntry } from '@shared/types/extensions';

type ApiKeyProviderId = 'anthropic' | 'codex' | 'gemini';
type PendingConnectionAction =
  | 'auto'
  | 'oauth'
  | 'api_key'
  | 'codex-beta-on'
  | 'codex-beta-off'
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
    name: 'OpenAI API Key',
    title: 'API key',
    description:
      'Use `OPENAI_API_KEY` with the public OpenAI Responses API. Your Codex subscription session stays available when you switch back.',
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
  return matches.find((entry) => entry.scope === 'user') ?? matches[0] ?? null;
}

function getConnectionDescription(provider: CliProviderStatus): string {
  switch (provider.providerId) {
    case 'anthropic':
      return 'Choose how app-launched Anthropic sessions authenticate.';
    case 'codex':
      return provider.connection?.apiKeyBetaEnabled
        ? 'Choose whether app-launched Codex sessions use your Codex subscription or an OpenAI API key. Runtime follows this automatically.'
        : 'Codex uses your subscription session by default. Enable API key mode if you want to switch Codex to OPENAI_API_KEY billing.';
    case 'gemini':
      return 'Configure optional API access. CLI SDK and ADC are still discovered automatically.';
  }
}

function getRuntimeDescription(provider: CliProviderStatus): string {
  switch (provider.providerId) {
    case 'anthropic':
      return 'Anthropic currently has no separate runtime backend selector.';
    case 'codex':
      return 'Codex runtime selection follows the active connection method automatically.';
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
    return authMode === 'api_key'
      ? 'Use OPENAI_API_KEY and the public OpenAI Responses API backend.'
      : 'Use your Codex subscription session and the built-in Codex runtime.';
  }

  return '';
}

function getConnectionAlert(provider: CliProviderStatus): string | null {
  const authMode = provider.connection?.configuredAuthMode;
  const hasAnthropicSubscriptionSession =
    provider.authMethod === 'oauth_token' || provider.authMethod === 'claude.ai';
  const hasCodexSubscriptionSession = provider.authMethod === 'oauth_token';

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

  if (
    provider.providerId === 'codex' &&
    provider.connection?.apiKeyBetaEnabled &&
    authMode === 'api_key' &&
    !provider.connection?.apiKeyConfigured
  ) {
    return 'API key mode is selected, but no OPENAI_API_KEY credential is available yet.';
  }

  if (
    provider.providerId === 'codex' &&
    provider.connection?.apiKeyBetaEnabled &&
    authMode === 'oauth' &&
    !hasCodexSubscriptionSession
  ) {
    return 'Codex subscription mode is selected. Sign in with Codex to use this provider.';
  }

  if (
    provider.providerId === 'codex' &&
    provider.connection?.apiKeyBetaEnabled &&
    authMode === 'oauth' &&
    provider.connection?.apiKeySource === 'stored'
  ) {
    return 'A saved OPENAI_API_KEY is available, but Codex uses it only after you switch to API key mode.';
  }

  if (
    provider.providerId === 'gemini' &&
    provider.availableBackends?.some((option) => option.id === 'api' && !option.available)
  ) {
    return 'Gemini API is currently unavailable. Configure `GEMINI_API_KEY` here or use valid Google ADC credentials.';
  }

  return null;
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
      if (!provider.connection?.apiKeyBetaEnabled) {
        return null;
      }

      return [
        {
          authMode: 'oauth',
          title: 'Codex subscription',
          description: 'Use your Codex sign-in session and subscription access.',
        },
        {
          authMode: 'api_key',
          title: 'OpenAI API key',
          description: 'Use OPENAI_API_KEY and OpenAI API billing.',
        },
      ];
    default:
      return null;
  }
}

function getConnectionMethodCardsHint(provider: CliProviderStatus): string | null {
  if (provider.providerId === 'codex') {
    return 'Runtime follows your connection method automatically.';
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
    if (!statusSelectedProvider?.connection) {
      return statusSelectedProvider;
    }

    const nextConnection = {
      ...statusSelectedProvider.connection,
    };

    if (statusSelectedProvider.providerId === 'anthropic') {
      nextConnection.configuredAuthMode =
        appConfig?.providerConnections?.anthropic.authMode ??
        statusSelectedProvider.connection.configuredAuthMode;
    }

    if (statusSelectedProvider.providerId === 'codex') {
      nextConnection.configuredAuthMode =
        appConfig?.providerConnections?.codex.authMode ??
        statusSelectedProvider.connection.configuredAuthMode;
      nextConnection.apiKeyBetaEnabled =
        appConfig?.providerConnections?.codex.apiKeyBetaEnabled ??
        statusSelectedProvider.connection.apiKeyBetaEnabled;
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
      ...statusSelectedProvider,
      connection: nextConnection,
    };
  }, [
    appConfig?.providerConnections?.anthropic.authMode,
    appConfig?.providerConnections?.codex.apiKeyBetaEnabled,
    appConfig?.providerConnections?.codex.authMode,
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
    !connectionManagedRuntime && (selectedProvider?.availableBackends?.length ?? 0) > 0;

  const apiKeyConfig =
    selectedProvider && isApiKeyProviderId(selectedProvider.providerId)
      ? API_KEY_PROVIDER_CONFIG[selectedProvider.providerId]
      : null;
  const showApiKeyForm =
    selectedProvider &&
    isApiKeyProviderId(selectedProvider.providerId) &&
    activeApiKeyFormProviderId === selectedProvider.providerId;
  const codexApiKeyBetaEnabled = selectedProvider?.connection?.apiKeyBetaEnabled === true;
  const showApiKeySection = Boolean(
    apiKeyConfig && (selectedProvider?.providerId !== 'codex' || codexApiKeyBetaEnabled)
  );
  const connectionAlert = selectedProvider ? getConnectionAlert(selectedProvider) : null;
  const connectionLoading = selectedProviderLoading || connectionSaving;
  const connectionBusy = disabled || connectionLoading;
  const runtimeBusy = disabled || selectedProviderLoading || runtimeSaving;
  const connectionMethodCardsHint = selectedProvider
    ? getConnectionMethodCardsHint(selectedProvider)
    : null;
  const hasSubscriptionSession =
    selectedProvider?.providerId === 'anthropic'
      ? selectedProvider.authMethod === 'oauth_token' || selectedProvider.authMethod === 'claude.ai'
      : selectedProvider?.providerId === 'codex'
        ? selectedProvider.authMethod === 'oauth_token'
        : false;
  const canRequestSubscriptionLogin =
    Boolean(selectedProvider?.connection?.supportsOAuth && onRequestLogin) &&
    configuredAuthMode !== 'api_key' &&
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
      if (selectedProvider.providerId === 'codex') {
        switch (pendingConnectionAction) {
          case 'codex-beta-on':
            return 'Enabling API key mode...';
          case 'codex-beta-off':
            return 'Disabling API key mode...';
          case 'api_key':
            return 'Switching to OpenAI API key...';
          case 'oauth':
            return 'Switching to Codex subscription...';
          default:
            return 'Applying connection changes...';
        }
      }

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
      } else {
        await updateConfig('providerConnections', {
          codex: {
            authMode: nextAuthMode === 'api_key' ? 'api_key' : 'oauth',
          },
        });
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

  const handleCodexBetaToggle = async (enabled: boolean): Promise<void> => {
    const fallbackApiKeyScope = selectedApiKey?.scope ?? 'user';
    const shouldOpenApiKeyForm =
      enabled &&
      selectedProvider?.providerId === 'codex' &&
      !selectedProvider.connection?.apiKeyConfigured &&
      !selectedApiKey;

    setConnectionSaving(true);
    setPendingConnectionAction(enabled ? 'codex-beta-on' : 'codex-beta-off');
    setConnectionError(null);
    let updateSucceeded = false;
    try {
      await updateConfig('providerConnections', {
        codex: {
          apiKeyBetaEnabled: enabled,
          authMode: enabled ? 'api_key' : 'oauth',
        },
      });
      updateSucceeded = true;
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Failed to update connection');
    } finally {
      if (updateSucceeded) {
        if (shouldOpenApiKeyForm) {
          setActiveApiKeyFormProviderId('codex');
          setApiKeyScope(fallbackApiKeyScope);
          setApiKeyValue('');
          setApiKeyError(null);
        }

        try {
          await onRefreshProvider?.('codex');
        } catch {
          setConnectionError('Connection updated, but failed to refresh provider status.');
        }
      }

      setConnectionSaving(false);
      setPendingConnectionAction(null);
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
                    color: selectedProvider.authenticated ? '#4ade80' : 'var(--color-text-muted)',
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
                      ? selectedProvider.providerId === 'codex'
                        ? 'Reconnect Codex'
                        : 'Reconnect Anthropic'
                      : getProviderConnectLabel(selectedProvider)}
                  </Button>
                ) : null}
              </div>

              {selectedProvider.providerId === 'codex' &&
              selectedProvider.connection?.apiKeyBetaAvailable &&
              !selectedProvider.connection.apiKeyBetaEnabled ? (
                <div
                  className="space-y-3 rounded-md border p-3"
                  style={{ borderColor: 'var(--color-border-subtle)' }}
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div
                      className="rounded-md border p-3"
                      style={{
                        borderColor: 'rgba(74, 222, 128, 0.3)',
                        backgroundColor: 'rgba(74, 222, 128, 0.08)',
                      }}
                    >
                      <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                        Codex subscription
                      </div>
                      <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Use your Codex sign-in session and subscription access.
                      </div>
                      <div
                        className="mt-3 inline-flex rounded-full px-2 py-0.5 text-[11px]"
                        style={{
                          color: '#86efac',
                          backgroundColor: 'rgba(74, 222, 128, 0.14)',
                        }}
                      >
                        Current
                      </div>
                    </div>
                    <div
                      className="rounded-md border p-3"
                      style={{ borderColor: 'var(--color-border-subtle)' }}
                    >
                      <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                        OpenAI API key (Beta)
                      </div>
                      <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Use OPENAI_API_KEY and OpenAI API billing for Codex.
                      </div>
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={connectionBusy}
                          onClick={() => void handleCodexBetaToggle(true)}
                        >
                          {pendingConnectionAction === 'codex-beta-on' ? (
                            <>
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                              Enabling...
                            </>
                          ) : (
                            'Enable API key mode'
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

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
                {selectedProvider.providerId === 'codex' &&
                selectedProvider.connection?.apiKeyBetaEnabled ? (
                  <button
                    type="button"
                    onClick={() => void handleCodexBetaToggle(false)}
                    className="text-xs underline-offset-2 hover:underline"
                    style={{ color: 'var(--color-text-muted)' }}
                    disabled={connectionBusy}
                  >
                    {pendingConnectionAction === 'codex-beta-off'
                      ? 'Disabling...'
                      : 'Disable API key mode'}
                  </button>
                ) : null}
              </div>

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
