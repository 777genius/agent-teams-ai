import type { CliProviderAuthMode, CliProviderStatus } from '@shared/types';

const ANTHROPIC_AUTH_MODES: CliProviderAuthMode[] = ['auto', 'oauth', 'api_key'];

export function resolveProviderAuthModeUiState(
  provider: CliProviderStatus | null,
  configuredAnthropicAuthMode?: CliProviderAuthMode,
  configuredCompatibleEndpointEnabled = false
): {
  configurableAuthModes: CliProviderAuthMode[];
  configuredAuthMode: CliProviderAuthMode | undefined;
  anthropicCompatibleEndpointEnabled: boolean;
} {
  const configurableAuthModes =
    provider?.connection?.configurableAuthModes ??
    (provider?.providerId === 'anthropic' ? ANTHROPIC_AUTH_MODES : []);
  const configuredAuthMode =
    provider?.connection?.configuredAuthMode ??
    (provider?.providerId === 'anthropic'
      ? configuredAnthropicAuthMode
      : configurableAuthModes[0]) ??
    configurableAuthModes[0];
  const anthropicCompatibleEndpointEnabled =
    provider?.providerId === 'anthropic' &&
    (provider.connection?.compatibleEndpoint?.enabled ?? configuredCompatibleEndpointEnabled);

  return { configurableAuthModes, configuredAuthMode, anthropicCompatibleEndpointEnabled };
}
