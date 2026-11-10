import type { AnthropicCompatibleEndpointConfig } from '../infrastructure/ConfigManager';

const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com']);

export function isAnthropicCompatibleBaseUrl(baseUrl?: string | null): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !FIRST_PARTY_ANTHROPIC_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isUsableAnthropicCompatibleEndpoint(
  endpoint: AnthropicCompatibleEndpointConfig | undefined
): endpoint is AnthropicCompatibleEndpointConfig {
  return endpoint?.enabled === true && isAnthropicCompatibleBaseUrl(endpoint.baseUrl);
}

export function getAnthropicCompatibleEndpointIssue(
  endpoint: AnthropicCompatibleEndpointConfig | undefined
): string | null {
  if (endpoint?.enabled !== true) return null;
  const baseUrl = endpoint.baseUrl.trim();
  if (!baseUrl) return 'Anthropic-compatible endpoint is enabled, but no base URL is configured.';

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Anthropic-compatible endpoint base URL must use http:// or https://.';
    }
    if (url.username || url.password) {
      return 'Anthropic-compatible endpoint base URL must not include credentials.';
    }
    if (!isAnthropicCompatibleBaseUrl(baseUrl)) {
      return 'Anthropic-compatible endpoint cannot use the first-party Anthropic API host.';
    }
  } catch {
    return 'Anthropic-compatible endpoint base URL is invalid.';
  }

  return null;
}
