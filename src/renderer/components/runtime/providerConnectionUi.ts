import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';

import type { CliProviderAuthMode, CliProviderStatus } from '@shared/types';

type ProviderConnectionTranslator = object;

function interpolateProviderConnectionFallback(
  value: string,
  options?: Record<string, unknown>
): string {
  if (!options) {
    return value;
  }

  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match: string, optionKey: string) => {
    const optionValue = options[optionKey];
    if (optionValue === undefined || optionValue === null) {
      return match;
    }
    if (
      typeof optionValue === 'string' ||
      typeof optionValue === 'number' ||
      typeof optionValue === 'boolean' ||
      typeof optionValue === 'bigint'
    ) {
      return String(optionValue);
    }
    return match;
  });
}

function translateProviderConnection(
  t: ProviderConnectionTranslator | undefined,
  key: string,
  fallback: string,
  options?: Record<string, unknown>
): string {
  const interpolatedFallback = interpolateProviderConnectionFallback(fallback, options);
  if (!t) {
    return interpolatedFallback;
  }

  const translated = (t as (translationKey: string, options?: Record<string, unknown>) => string)(
    key,
    {
      ...options,
      defaultValue: fallback,
    }
  );

  return interpolateProviderConnectionFallback(translated, options);
}

const CODEX_NATIVE_LABEL = 'Codex native';
const ANTHROPIC_SUBSCRIPTION_LABEL = 'Anthropic subscription';

const AUTH_MODE_LABELS: Record<CliProviderAuthMode, string> = {
  auto: 'Auto',
  oauth: 'Subscription / OAuth',
  chatgpt: 'ChatGPT account',
  api_key: 'API key',
};

const AUTH_MODE_LABEL_KEYS: Record<CliProviderAuthMode, string> = {
  auto: 'providerRuntime.connectionUi.authMode.auto',
  oauth: 'providerRuntime.connectionUi.authMode.oauth',
  chatgpt: 'providerRuntime.connectionUi.authMode.chatgpt',
  api_key: 'providerRuntime.connectionUi.authMode.apiKey',
};

export function formatProviderAuthModeLabel(
  authMode: CliProviderAuthMode | null,
  t?: ProviderConnectionTranslator
): string | null {
  return authMode
    ? translateProviderConnection(t, AUTH_MODE_LABEL_KEYS[authMode], AUTH_MODE_LABELS[authMode])
    : null;
}

export function formatProviderAuthModeLabelForProvider(
  providerId: CliProviderStatus['providerId'],
  authMode: CliProviderAuthMode | null,
  t?: ProviderConnectionTranslator
): string | null {
  if (!authMode) {
    return null;
  }

  if (providerId === 'anthropic' && authMode === 'oauth') {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.authMode.anthropicSubscription',
      ANTHROPIC_SUBSCRIPTION_LABEL
    );
  }

  return formatProviderAuthModeLabel(authMode, t);
}

export function formatProviderAuthMethodLabel(
  authMethod: string | null,
  t?: ProviderConnectionTranslator
): string {
  switch (authMethod) {
    case 'api_key':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.apiKey',
        'API key'
      );
    case 'api_key_helper':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.apiKeyHelper',
        'API key helper'
      );
    case 'oauth_token':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.oauth',
        'OAuth'
      );
    case 'claude.ai':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.claudeSubscription',
        'Claude subscription'
      );
    case 'cli_oauth_personal':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.geminiCli',
        'Gemini CLI'
      );
    case 'gemini_adc_authorized_user':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.googleAccount',
        'Google account'
      );
    case 'gemini_adc_service_account':
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.authMethod.serviceAccount',
        'service account'
      );
    default:
      return authMethod
        ? authMethod.replaceAll('_', ' ')
        : translateProviderConnection(
            t,
            'providerRuntime.connectionUi.status.notConnected',
            'Not connected'
          );
  }
}

export function formatProviderAuthMethodLabelForProvider(
  providerId: CliProviderStatus['providerId'],
  authMethod: string | null,
  t?: ProviderConnectionTranslator
): string {
  if (providerId === 'anthropic' && (authMethod === 'oauth_token' || authMethod === 'claude.ai')) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.authMode.anthropicSubscription',
      ANTHROPIC_SUBSCRIPTION_LABEL
    );
  }

  return formatProviderAuthMethodLabel(authMethod, t);
}

function isCodexNativeLane(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'codex' &&
    (provider.resolvedBackendId === 'codex-native' || provider.selectedBackendId === 'codex-native')
  );
}

function getSelectedRuntimeBackendOption(
  provider: CliProviderStatus
): NonNullable<CliProviderStatus['availableBackends']>[number] | null {
  const options = provider.availableBackends ?? [];
  if (options.length === 0) {
    return null;
  }

  const selectedBackendId = provider.selectedBackendId ?? null;
  const resolvedBackendId = provider.resolvedBackendId ?? null;

  return (
    options.find((option) => option.id === selectedBackendId) ??
    options.find((option) => option.id === resolvedBackendId) ??
    null
  );
}

export function isProviderInventoryOnlyFallback(provider: CliProviderStatus): boolean {
  return (
    provider.supported === false &&
    provider.authenticated === false &&
    provider.authMethod === null &&
    provider.verificationState === 'unknown' &&
    provider.models.length > 0 &&
    provider.backend == null &&
    (provider.availableBackends?.length ?? 0) === 0 &&
    provider.capabilities.teamLaunch === false
  );
}

export function isOpenCodeCatalogHydrating(
  provider:
    | Pick<
        CliProviderStatus,
        | 'providerId'
        | 'models'
        | 'modelCatalog'
        | 'modelCatalogRefreshState'
        | 'runtimeCapabilities'
      >
    | null
    | undefined
): boolean {
  if (provider?.providerId !== 'opencode') {
    return false;
  }

  if (provider.modelCatalog?.providerId === 'opencode') {
    return false;
  }

  if (provider.modelCatalogRefreshState === 'error') {
    return false;
  }

  return (
    provider.modelCatalogRefreshState === 'loading' ||
    provider.runtimeCapabilities?.modelCatalog?.dynamic === true
  );
}

function hasKnownProviderStatus(
  provider: Pick<
    CliProviderStatus,
    | 'authenticated'
    | 'supported'
    | 'statusMessage'
    | 'models'
    | 'backend'
    | 'availableBackends'
    | 'connection'
    | 'modelCatalog'
  >
): boolean {
  const statusMessage = provider.statusMessage?.trim() ?? '';
  return (
    provider.authenticated ||
    provider.supported ||
    provider.models.length > 0 ||
    provider.backend != null ||
    (provider.availableBackends?.length ?? 0) > 0 ||
    provider.connection != null ||
    provider.modelCatalog != null ||
    (statusMessage.length > 0 &&
      statusMessage !== 'Checking...' &&
      statusMessage !== CLI_PROVIDER_STATUS_DEFERRED_MESSAGE)
  );
}

export function shouldShowProviderStatusSkeleton(
  provider: CliProviderStatus,
  providerLoading: boolean
): boolean {
  const isPlaceholder =
    !provider.authenticated &&
    (provider.statusMessage === 'Checking...' ||
      provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE) &&
    provider.models.length === 0 &&
    provider.backend == null;

  return isPlaceholder || (providerLoading && !hasKnownProviderStatus(provider));
}

export function isConnectionManagedRuntimeProvider(provider: CliProviderStatus): boolean {
  return provider.providerId === 'codex';
}

function getCodexCurrentRuntimeLabel(t?: ProviderConnectionTranslator): string {
  return translateProviderConnection(
    t,
    'providerRuntime.connectionUi.runtime.codexNative',
    CODEX_NATIVE_LABEL
  );
}

function getCodexApiKeyAvailabilitySummary(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string | null {
  if (provider.providerId !== 'codex' || !provider.connection?.apiKeyConfigured) {
    return null;
  }

  if (provider.connection.apiKeySource === 'stored') {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.credential.savedApiKeyAvailable',
      'Saved API key available in Manage'
    );
  }

  return (
    provider.connection.apiKeySourceLabel ??
    translateProviderConnection(
      t,
      'providerRuntime.connectionUi.credential.apiKeyConfigured',
      'API key is configured'
    )
  );
}

function isAnthropicApiKeyModeReady(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'anthropic' &&
    provider.connection?.configuredAuthMode === 'api_key' &&
    provider.connection.apiKeyConfigured === true &&
    provider.authenticated === true &&
    (provider.authMethod === 'api_key' || provider.authMethod === 'api_key_helper') &&
    provider.verificationState === 'verified'
  );
}

function isAnthropicApiKeyModeMissingCredential(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'anthropic' &&
    provider.connection?.configuredAuthMode === 'api_key' &&
    provider.connection.apiKeyConfigured !== true
  );
}

function getCodexMissingManagedAccountStatus(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string | null {
  if (provider.providerId !== 'codex') {
    return null;
  }

  const codexConnection = provider.connection?.codex;
  if (!codexConnection || codexConnection.managedAccount?.type === 'chatgpt') {
    return null;
  }

  if (provider.connection?.configuredAuthMode !== 'chatgpt') {
    return null;
  }

  if (codexConnection.requiresOpenaiAuth) {
    if (codexConnection.localActiveChatgptAccountPresent) {
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.codexLocalAccountNeedsReconnect',
        'Codex has a locally selected ChatGPT account, but the current session needs reconnect.'
      );
    }

    return codexConnection.localAccountArtifactsPresent
      ? translateProviderConnection(
          t,
          'providerRuntime.connectionUi.status.codexNoActiveManagedSession',
          'Codex CLI reports no active ChatGPT login. Local Codex account data exists, but no active managed session is selected.'
        )
      : translateProviderConnection(
          t,
          'providerRuntime.connectionUi.status.codexNoActiveChatGptLogin',
          'Codex CLI reports no active ChatGPT login'
        );
  }

  return (
    codexConnection.launchIssueMessage ??
    translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.connectChatGptForSubscription',
      'Connect a ChatGPT account to use your Codex subscription.'
    )
  );
}

export function getProviderCurrentRuntimeSummary(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string | null {
  if (provider.providerId !== 'codex' || !isConnectionManagedRuntimeProvider(provider)) {
    return null;
  }

  const prefix = provider.authenticated
    ? translateProviderConnection(
        t,
        'providerRuntime.connectionUi.runtime.currentRuntime',
        'Current runtime'
      )
    : translateProviderConnection(
        t,
        'providerRuntime.connectionUi.runtime.selectedRuntime',
        'Selected runtime'
      );
  return translateProviderConnection(
    t,
    'providerRuntime.connectionUi.runtime.summary',
    '{{prefix}}: {{runtime}}',
    {
      prefix,
      runtime: getCodexCurrentRuntimeLabel(t),
    }
  );
}

export function formatProviderStatusText(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string {
  if (isProviderInventoryOnlyFallback(provider)) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.modelsAvailable',
      'Models available'
    );
  }

  const selectedBackendOption = getSelectedRuntimeBackendOption(provider);

  if (provider.providerId === 'codex') {
    if (provider.connection?.codex?.login.status === 'starting') {
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.startingChatGptLogin',
        'Starting ChatGPT login...'
      );
    }

    if (provider.connection?.codex?.login.status === 'pending') {
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.waitingForChatGptLogin',
        'Waiting for ChatGPT account login...'
      );
    }

    if (
      provider.connection?.codex?.login.status === 'failed' &&
      provider.connection.codex.login.error
    ) {
      return provider.connection.codex.login.error;
    }

    if (
      provider.connection?.codex?.appServerState === 'degraded' &&
      provider.connection.codex.effectiveAuthMode === 'chatgpt' &&
      provider.connection.codex.launchAllowed
    ) {
      return (
        provider.connection.codex.launchIssueMessage ??
        translateProviderConnection(
          t,
          'providerRuntime.connectionUi.status.chatGptVerificationDegraded',
          'ChatGPT account detected - account verification is currently degraded.'
        )
      );
    }

    if (provider.connection?.codex?.launchAllowed) {
      if (provider.connection.codex.effectiveAuthMode === 'chatgpt') {
        return translateProviderConnection(
          t,
          'providerRuntime.connectionUi.status.chatGptAccountReady',
          'ChatGPT account ready'
        );
      }

      if (provider.connection.codex.effectiveAuthMode === 'api_key') {
        return translateProviderConnection(
          t,
          'providerRuntime.connectionUi.status.apiKeyReady',
          'API key ready'
        );
      }
    }

    const missingManagedAccountStatus = getCodexMissingManagedAccountStatus(provider, t);
    if (missingManagedAccountStatus) {
      return missingManagedAccountStatus;
    }

    if (provider.connection?.codex?.launchIssueMessage) {
      return provider.connection.codex.launchIssueMessage;
    }

    if (selectedBackendOption?.statusMessage) {
      return selectedBackendOption.statusMessage;
    }
    return (
      provider.statusMessage ??
      (provider.authenticated
        ? translateProviderConnection(
            t,
            'providerRuntime.connectionUi.status.codexNativeReady',
            'Codex native ready'
          )
        : translateProviderConnection(
            t,
            'providerRuntime.connectionUi.status.notConnected',
            'Not connected'
          ))
    );
  }

  if (
    isCodexNativeLane(provider) &&
    selectedBackendOption?.state &&
    selectedBackendOption.state !== 'ready'
  ) {
    return (
      selectedBackendOption.statusMessage ??
      provider.statusMessage ??
      translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.codexNativeUnavailable',
        'Codex native unavailable'
      )
    );
  }

  if (
    isCodexNativeLane(provider) &&
    selectedBackendOption?.audience === 'internal' &&
    selectedBackendOption.statusMessage
  ) {
    return selectedBackendOption.statusMessage;
  }

  if (!provider.supported) {
    return (
      provider.statusMessage ??
      translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.unavailableInCurrentRuntime',
        'Unavailable in current runtime'
      )
    );
  }

  if (isAnthropicApiKeyModeReady(provider)) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.connectedViaApiKey',
      'Connected via API key'
    );
  }

  if (
    provider.providerId === 'anthropic' &&
    provider.connection?.configuredAuthMode === 'api_key' &&
    provider.connection.apiKeyConfigured === true
  ) {
    const statusMessage = provider.statusMessage?.trim();
    if (statusMessage && !/^connected\b/i.test(statusMessage)) {
      return statusMessage;
    }
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.apiKeyConfiguredNotVerified',
      'API key configured, but not verified yet'
    );
  }

  if (isAnthropicApiKeyModeMissingCredential(provider)) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.apiKeyModeMissingCredential',
      'API key mode selected, but no API key is configured'
    );
  }

  if (provider.authenticated) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.connectedVia',
      'Connected via {{method}}',
      {
        method: formatProviderAuthMethodLabelForProvider(
          provider.providerId,
          provider.authMethod,
          t
        ),
      }
    );
  }

  if (provider.verificationState === 'offline') {
    return (
      provider.statusMessage ??
      translateProviderConnection(
        t,
        'providerRuntime.connectionUi.status.unableToVerify',
        'Unable to verify'
      )
    );
  }

  return (
    provider.statusMessage ??
    translateProviderConnection(
      t,
      'providerRuntime.connectionUi.status.notConnected',
      'Not connected'
    )
  );
}

export function getProviderConnectionModeSummary(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string | null {
  if (provider.providerId !== 'anthropic' && provider.providerId !== 'codex') {
    return null;
  }

  if (provider.providerId === 'anthropic') {
    if (provider.authenticated) {
      return null;
    }

    if (provider.connection?.configuredAuthMode === 'auto') {
      return null;
    }
  }

  if (provider.providerId === 'codex' && provider.connection?.configuredAuthMode === 'auto') {
    return null;
  }

  const authModeLabel = formatProviderAuthModeLabelForProvider(
    provider.providerId,
    provider.connection?.configuredAuthMode ?? null,
    t
  );
  if (!authModeLabel) {
    return null;
  }

  return provider.providerId === 'codex'
    ? translateProviderConnection(
        t,
        'providerRuntime.connectionUi.mode.selectedAuth',
        'Selected auth: {{authMode}}',
        { authMode: authModeLabel }
      )
    : translateProviderConnection(
        t,
        'providerRuntime.connectionUi.mode.preferredAuth',
        'Preferred auth: {{authMode}}',
        { authMode: authModeLabel }
      );
}

export function getProviderCredentialSummary(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string | null {
  if (!provider.connection?.apiKeyConfigured) {
    return null;
  }

  if (isAnthropicApiKeyModeReady(provider)) {
    return (
      provider.connection?.apiKeySourceLabel ??
      translateProviderConnection(
        t,
        'providerRuntime.connectionUi.credential.apiKeyConfigured',
        'API key is configured'
      )
    );
  }

  if (
    provider.providerId === 'anthropic' &&
    provider.connection.apiKeySource === 'stored' &&
    provider.connection.configuredAuthMode === 'auto'
  ) {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.credential.savedApiKeyAvailable',
      'Saved API key available in Manage'
    );
  }

  if (
    provider.providerId === 'anthropic' &&
    provider.authMethod !== 'api_key' &&
    provider.authMethod !== 'api_key_helper'
  ) {
    return provider.connection.apiKeySource === 'stored'
      ? translateProviderConnection(
          t,
          'providerRuntime.connectionUi.credential.apiKeyAlsoConfigured',
          'API key also configured in Manage'
        )
      : (provider.connection.apiKeySourceLabel ??
          translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.apiKeyConfigured',
            'API key is configured'
          ));
  }

  if (provider.authMethod !== 'api_key' && provider.providerId === 'gemini') {
    return provider.connection.apiKeySource === 'stored'
      ? translateProviderConnection(
          t,
          'providerRuntime.connectionUi.credential.apiKeyConfiguredInManage',
          'API key is configured in Manage'
        )
      : (provider.connection.apiKeySourceLabel ??
          translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.apiKeyConfigured',
            'API key is configured'
          ));
  }

  if (provider.providerId === 'codex') {
    const apiKeyAvailabilitySummary = getCodexApiKeyAvailabilitySummary(provider, t);
    if (!apiKeyAvailabilitySummary) {
      return null;
    }

    if (
      provider.connection.codex?.managedAccount?.type === 'chatgpt' ||
      provider.connection.codex?.effectiveAuthMode === 'chatgpt'
    ) {
      return provider.connection.apiKeySource === 'stored'
        ? translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.apiKeyFallbackInManage',
            'API key also available in Manage as fallback'
          )
        : translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.availableAsFallback',
            '{{summary}} - available as fallback',
            { summary: apiKeyAvailabilitySummary }
          );
    }

    if (provider.connection.configuredAuthMode === 'chatgpt') {
      return provider.connection.apiKeySource === 'stored'
        ? translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.savedApiKeyAvailableIfSwitch',
            'Saved API key available in Manage if you switch to API key mode'
          )
        : translateProviderConnection(
            t,
            'providerRuntime.connectionUi.credential.availableIfSwitch',
            '{{summary}} - available if you switch to API key mode',
            { summary: apiKeyAvailabilitySummary }
          );
    }

    if (provider.connection.configuredAuthMode === 'auto') {
      return translateProviderConnection(
        t,
        'providerRuntime.connectionUi.credential.autoWillUseUntilChatGpt',
        '{{summary}} - Auto will use this until ChatGPT is connected',
        { summary: apiKeyAvailabilitySummary }
      );
    }

    return apiKeyAvailabilitySummary;
  }

  return provider.connection.apiKeySourceLabel ?? null;
}

export function getProviderDisconnectAction(provider: CliProviderStatus): {
  label: string;
  confirmLabel: string;
  title: string;
  message: string;
} | null;
export function getProviderDisconnectAction(
  provider: CliProviderStatus,
  t: ProviderConnectionTranslator
): {
  label: string;
  confirmLabel: string;
  title: string;
  message: string;
} | null;
export function getProviderDisconnectAction(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): {
  label: string;
  confirmLabel: string;
  title: string;
  message: string;
} | null {
  if (!provider.authenticated) {
    return null;
  }

  if (provider.providerId === 'anthropic') {
    if (provider.authMethod !== 'oauth_token' && provider.authMethod !== 'claude.ai') {
      return null;
    }

    return {
      label: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.actions.disconnect',
        'Disconnect'
      ),
      confirmLabel: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.actions.disconnect',
        'Disconnect'
      ),
      title: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.disconnect.anthropicTitle',
        'Disconnect Anthropic subscription?'
      ),
      message: provider.connection?.apiKeyConfigured
        ? translateProviderConnection(
            t,
            'providerRuntime.connectionUi.disconnect.anthropicWithApiKey',
            'This removes the local Anthropic subscription session from the Claude CLI runtime. Saved API keys in Manage stay available.'
          )
        : translateProviderConnection(
            t,
            'providerRuntime.connectionUi.disconnect.anthropic',
            'This removes the local Anthropic subscription session from the Claude CLI runtime.'
          ),
    };
  }

  if (provider.providerId === 'gemini' && provider.authMethod === 'cli_oauth_personal') {
    return {
      label: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.actions.disconnect',
        'Disconnect'
      ),
      confirmLabel: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.actions.disconnect',
        'Disconnect'
      ),
      title: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.disconnect.geminiTitle',
        'Disconnect Gemini CLI?'
      ),
      message: translateProviderConnection(
        t,
        'providerRuntime.connectionUi.disconnect.gemini',
        'This clears the local Gemini CLI session metadata. External ADC credentials and saved API keys are not removed.'
      ),
    };
  }

  return null;
}

export function getProviderConnectLabel(
  provider: CliProviderStatus,
  t?: ProviderConnectionTranslator
): string {
  if (provider.providerId === 'anthropic') {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.actions.connectAnthropic',
      'Connect Anthropic'
    );
  }

  if (provider.providerId === 'codex') {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.actions.connectChatGpt',
      'Connect ChatGPT'
    );
  }

  if (provider.providerId === 'gemini') {
    return translateProviderConnection(
      t,
      'providerRuntime.connectionUi.actions.openLogin',
      'Open Login'
    );
  }

  return translateProviderConnection(t, 'providerRuntime.connectionUi.actions.connect', 'Connect');
}

export function shouldShowProviderConnectAction(provider: CliProviderStatus): boolean {
  if (provider.providerId === 'codex') {
    return false;
  }

  if (!provider.canLoginFromUi || provider.authenticated) {
    return false;
  }

  if (provider.connection?.configuredAuthMode === 'api_key') {
    return false;
  }

  return true;
}
