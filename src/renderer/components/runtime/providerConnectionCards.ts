import { useAppTranslation } from '@features/localization/renderer';
import { ANTHROPIC_EXTERNAL_BACKEND_IDS } from '@shared/constants/anthropicConnectionMode';

import type { ConnectionMethodCardOption } from './ConnectionMethodCards';
import type { ProviderRuntimeBackendSummaryText } from './ProviderRuntimeBackendSelector';
import type { CliProviderStatus } from '@shared/types';

const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com']);

export function validateAnthropicCompatibleBaseUrl(
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

export function getConnectionMethodCardOptions(
  provider: CliProviderStatus,
  t: ReturnType<typeof useAppTranslation>['t'],
  runtimeBackendSummaryText: ProviderRuntimeBackendSummaryText,
  configuredAnthropicCompatibleBaseUrl = ''
): ConnectionMethodCardOption[] | null {
  switch (provider.providerId) {
    case 'anthropic': {
      const resolvedBackendId = provider.resolvedBackendId?.trim() ?? '';
      const resolvedExternalBackendLabel =
        provider.connection?.compatibleEndpoint?.enabled !== true &&
        ANTHROPIC_EXTERNAL_BACKEND_IDS.some((backendId) => backendId === resolvedBackendId)
          ? provider.backend?.label.trim() || resolvedBackendId
          : null;
      const bedrockEndpointLabelCandidate =
        resolvedBackendId === 'bedrock' && resolvedExternalBackendLabel
          ? provider.backend?.endpointLabel?.trim() || null
          : null;
      const bedrockEndpointLabel =
        bedrockEndpointLabelCandidate === resolvedExternalBackendLabel
          ? null
          : bedrockEndpointLabelCandidate;
      const autoTitle = resolvedExternalBackendLabel
        ? provider.connection?.configuredAuthMode === 'auto'
          ? runtimeBackendSummaryText.autoCurrently(resolvedExternalBackendLabel)
          : `${t('providerRuntime.connectionCards.auto.title')} (${resolvedExternalBackendLabel})`
        : t('providerRuntime.connectionCards.auto.title');
      const autoDescription = [
        t('providerRuntime.connectionCards.anthropic.autoDescription'),
        bedrockEndpointLabel,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      const savedCompatibleBaseUrl =
        provider.connection?.compatibleEndpoint?.baseUrl.trim() ||
        configuredAnthropicCompatibleBaseUrl.trim();
      const savedValidBaseUrl =
        savedCompatibleBaseUrl && !validateAnthropicCompatibleBaseUrl(savedCompatibleBaseUrl, t)
          ? savedCompatibleBaseUrl
          : null;
      const compatibleDescription = [
        t('providerRuntime.compatibleEndpoint.description'),
        savedValidBaseUrl,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');

      return [
        {
          id: 'auto',
          title: autoTitle,
          description: autoDescription,
        },
        {
          id: 'oauth',
          title: t('providerRuntime.connectionCards.anthropic.subscriptionTitle'),
          description: t('providerRuntime.connectionCards.anthropic.subscriptionDescription'),
        },
        {
          id: 'api_key',
          title: t('providerRuntime.connectionCards.apiKey.title'),
          description: t('providerRuntime.connectionCards.anthropic.apiKeyDescription'),
        },
        {
          id: 'compatible',
          title: t('providerRuntime.compatibleEndpoint.title'),
          description: compatibleDescription,
        },
      ];
    }
    case 'codex':
      return [
        {
          id: 'auto',
          title: t('providerRuntime.connectionCards.auto.title'),
          description: t('providerRuntime.connectionCards.codex.autoDescription'),
        },
        {
          id: 'chatgpt',
          title: t('providerRuntime.connectionCards.codex.chatgptTitle'),
          description: t('providerRuntime.connectionCards.codex.chatgptDescription'),
        },
        {
          id: 'api_key',
          title: t('providerRuntime.connectionCards.apiKey.title'),
          description: t('providerRuntime.connectionCards.codex.apiKeyDescription'),
        },
      ];
    default:
      return null;
  }
}

export function getConnectionMethodCardsHint(
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
