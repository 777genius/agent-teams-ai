import type { CliProviderAuthMode, CliProviderStatus } from '@shared/types';

const CODEX_NATIVE_LABEL = 'Codex native';
const ANTHROPIC_SUBSCRIPTION_LABEL = 'Anthropic subscription';

const AUTH_MODE_LABELS: Record<CliProviderAuthMode, string> = {
  auto: 'Auto',
  oauth: 'Subscription / OAuth',
  chatgpt: 'ChatGPT account',
  api_key: 'API key',
};

export function formatProviderAuthModeLabel(authMode: CliProviderAuthMode | null): string | null {
  return authMode ? AUTH_MODE_LABELS[authMode] : null;
}

export function formatProviderAuthModeLabelForProvider(
  providerId: CliProviderStatus['providerId'],
  authMode: CliProviderAuthMode | null
): string | null {
  if (!authMode) {
    return null;
  }

  if (providerId === 'anthropic' && authMode === 'oauth') {
    return ANTHROPIC_SUBSCRIPTION_LABEL;
  }

  return formatProviderAuthModeLabel(authMode);
}

export function formatProviderAuthMethodLabel(authMethod: string | null): string {
  switch (authMethod) {
    case 'api_key':
      return 'API key';
    case 'api_key_helper':
      return 'API key helper';
    case 'oauth_token':
      return 'OAuth';
    case 'claude.ai':
      return 'Claude subscription';
    case 'cli_oauth_personal':
      return 'Gemini CLI';
    case 'gemini_adc_authorized_user':
      return 'Google account';
    case 'gemini_adc_service_account':
      return 'service account';
    default:
      return authMethod ? authMethod.replaceAll('_', ' ') : 'Not connected';
  }
}

export function formatProviderAuthMethodLabelForProvider(
  providerId: CliProviderStatus['providerId'],
  authMethod: string | null
): string {
  if (providerId === 'anthropic' && (authMethod === 'oauth_token' || authMethod === 'claude.ai')) {
    return ANTHROPIC_SUBSCRIPTION_LABEL;
  }

  return formatProviderAuthMethodLabel(authMethod);
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

export function isConnectionManagedRuntimeProvider(provider: CliProviderStatus): boolean {
  return provider.providerId === 'codex';
}

function getCodexCurrentRuntimeLabel(provider: CliProviderStatus): string {
  return CODEX_NATIVE_LABEL;
}

function getCodexApiKeyAvailabilitySummary(provider: CliProviderStatus): string | null {
  if (provider.providerId !== 'codex' || !provider.connection?.apiKeyConfigured) {
    return null;
  }

  if (provider.connection.apiKeySource === 'stored') {
    return 'Saved API key available in Manage';
  }

  return provider.connection.apiKeySourceLabel ?? 'API key is configured';
}

function getCodexMissingManagedAccountStatus(provider: CliProviderStatus): string | null {
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
      return 'Codex has a locally selected ChatGPT account, but the current session needs reconnect.';
    }

    return codexConnection.localAccountArtifactsPresent
      ? 'Codex CLI reports no active ChatGPT login. Local Codex account data exists, but no active managed session is selected.'
      : 'Codex CLI reports no active ChatGPT login';
  }

  return (
    codexConnection.launchIssueMessage ??
    'Connect a ChatGPT account to use your Codex subscription.'
  );
}

export function getProviderCurrentRuntimeSummary(provider: CliProviderStatus): string | null {
  if (provider.providerId !== 'codex' || !isConnectionManagedRuntimeProvider(provider)) {
    return null;
  }

  const prefix = provider.authenticated ? 'Current runtime' : 'Selected runtime';
  return `${prefix}: ${getCodexCurrentRuntimeLabel(provider)}`;
}

export function formatProviderStatusText(provider: CliProviderStatus): string {
  const selectedBackendOption = getSelectedRuntimeBackendOption(provider);

  if (provider.providerId === 'codex') {
    if (provider.connection?.codex?.login.status === 'starting') {
      return 'Starting ChatGPT login...';
    }

    if (provider.connection?.codex?.login.status === 'pending') {
      return 'Waiting for ChatGPT account login...';
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
        'ChatGPT account detected - account verification is currently degraded.'
      );
    }

    if (provider.connection?.codex?.launchAllowed) {
      if (provider.connection.codex.effectiveAuthMode === 'chatgpt') {
        return 'ChatGPT account ready';
      }

      if (provider.connection.codex.effectiveAuthMode === 'api_key') {
        return 'API key ready';
      }
    }

    const missingManagedAccountStatus = getCodexMissingManagedAccountStatus(provider);
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
      provider.statusMessage ?? (provider.authenticated ? 'Codex native ready' : 'Not connected')
    );
  }

  if (
    isCodexNativeLane(provider) &&
    selectedBackendOption &&
    selectedBackendOption.state &&
    selectedBackendOption.state !== 'ready'
  ) {
    return (
      selectedBackendOption.statusMessage ?? provider.statusMessage ?? 'Codex native unavailable'
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
    return provider.statusMessage ?? 'Unavailable in current runtime';
  }

  if (provider.authenticated) {
    return `Connected via ${formatProviderAuthMethodLabelForProvider(
      provider.providerId,
      provider.authMethod
    )}`;
  }

  if (provider.verificationState === 'offline') {
    return provider.statusMessage ?? 'Unable to verify';
  }

  return provider.statusMessage ?? 'Not connected';
}

export function getProviderConnectionModeSummary(provider: CliProviderStatus): string | null {
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
    provider.connection?.configuredAuthMode ?? null
  );
  if (!authModeLabel) {
    return null;
  }

  return provider.providerId === 'codex'
    ? `Selected auth: ${authModeLabel}`
    : `Preferred auth: ${authModeLabel}`;
}

export function getProviderCredentialSummary(provider: CliProviderStatus): string | null {
  if (!provider.connection?.apiKeyConfigured) {
    return null;
  }

  if (
    provider.providerId === 'anthropic' &&
    provider.connection.apiKeySource === 'stored' &&
    provider.connection.configuredAuthMode === 'auto'
  ) {
    return 'Saved API key available in Manage';
  }

  if (provider.authMethod !== 'api_key' && provider.providerId === 'anthropic') {
    return provider.connection.apiKeySource === 'stored'
      ? 'API key also configured in Manage'
      : (provider.connection.apiKeySourceLabel ?? 'API key is configured');
  }

  if (provider.authMethod !== 'api_key' && provider.providerId === 'gemini') {
    return provider.connection.apiKeySource === 'stored'
      ? 'API key is configured in Manage'
      : (provider.connection.apiKeySourceLabel ?? 'API key is configured');
  }

  if (provider.providerId === 'codex') {
    const apiKeyAvailabilitySummary = getCodexApiKeyAvailabilitySummary(provider);
    if (!apiKeyAvailabilitySummary) {
      return null;
    }

    if (
      provider.connection.codex?.managedAccount?.type === 'chatgpt' ||
      provider.connection.codex?.effectiveAuthMode === 'chatgpt'
    ) {
      return provider.connection.apiKeySource === 'stored'
        ? 'API key also available in Manage as fallback'
        : `${apiKeyAvailabilitySummary} - available as fallback`;
    }

    if (provider.connection.configuredAuthMode === 'chatgpt') {
      return provider.connection.apiKeySource === 'stored'
        ? 'Saved API key available in Manage if you switch to API key mode'
        : `${apiKeyAvailabilitySummary} - available if you switch to API key mode`;
    }

    if (provider.connection.configuredAuthMode === 'auto') {
      return `${apiKeyAvailabilitySummary} - Auto will use this until ChatGPT is connected`;
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
} | null {
  if (!provider.authenticated) {
    return null;
  }

  if (provider.providerId === 'anthropic') {
    if (provider.authMethod !== 'oauth_token' && provider.authMethod !== 'claude.ai') {
      return null;
    }

    return {
      label: 'Disconnect',
      confirmLabel: 'Disconnect',
      title: 'Disconnect Anthropic subscription?',
      message: provider.connection?.apiKeyConfigured
        ? 'This removes the local Anthropic subscription session from the Claude CLI runtime. Saved API keys in Manage stay available.'
        : 'This removes the local Anthropic subscription session from the Claude CLI runtime.',
    };
  }

  if (provider.providerId === 'gemini' && provider.authMethod === 'cli_oauth_personal') {
    return {
      label: 'Disconnect',
      confirmLabel: 'Disconnect',
      title: 'Disconnect Gemini CLI?',
      message:
        'This clears the local Gemini CLI session metadata. External ADC credentials and saved API keys are not removed.',
    };
  }

  return null;
}

export function getProviderConnectLabel(provider: CliProviderStatus): string {
  if (provider.providerId === 'anthropic') {
    return 'Connect Anthropic';
  }

  if (provider.providerId === 'codex') {
    return 'Connect ChatGPT';
  }

  if (provider.providerId === 'gemini') {
    return 'Open Login';
  }

  return 'Connect';
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
