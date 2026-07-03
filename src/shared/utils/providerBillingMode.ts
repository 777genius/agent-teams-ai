import type { ProviderBillingMode, TeamProviderBackendId, TeamProviderId } from '@shared/types';

export interface ProviderBillingModeCatalogModel {
  badgeLabel?: string | null;
  metadata?: {
    free?: boolean;
    opencode?: {
      accessKind?: string | null;
      routeKind?: string | null;
    } | null;
  } | null;
}

export interface ProviderBillingModeInferenceInput {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | string | null;
  explicitBillingMode?: ProviderBillingMode | string | null;
  authMethod?: string | null;
  authMethodDetail?: string | null;
  backendKind?: string | null;
  selectedBackendId?: string | null;
  resolvedBackendId?: string | null;
  authenticated?: boolean | null;
  model?: string | null;
  catalogModel?: ProviderBillingModeCatalogModel | null;
}

export function normalizeProviderBillingMode(value: unknown): ProviderBillingMode | undefined {
  return value === 'api' || value === 'subscription' || value === 'free' || value === 'unknown'
    ? value
    : undefined;
}

export function inferProviderBillingMode(
  input: ProviderBillingModeInferenceInput
): ProviderBillingMode {
  const explicitBillingMode = normalizeProviderBillingMode(input.explicitBillingMode);
  if (explicitBillingMode) {
    return explicitBillingMode;
  }

  const normalizedModel = input.model?.trim().toLowerCase() ?? '';
  const badgeLabel = input.catalogModel?.badgeLabel?.trim().toLowerCase();
  const openCodeRoute = input.catalogModel?.metadata?.opencode;
  if (
    input.catalogModel?.metadata?.free === true ||
    badgeLabel === 'free' ||
    openCodeRoute?.accessKind === 'builtin_free' ||
    openCodeRoute?.routeKind === 'builtin_free' ||
    normalizedModel.includes(':free') ||
    normalizedModel.endsWith('-free') ||
    normalizedModel.endsWith('/free')
  ) {
    return 'free';
  }

  if (input.providerBackendId === 'api') {
    return 'api';
  }

  const authHints = [
    input.authMethod,
    input.authMethodDetail,
    input.backendKind,
    input.selectedBackendId,
    input.resolvedBackendId,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (/(api[_ -]?key|bearer|gateway|provider|openrouter|anthropic_auth_token)/i.test(authHints)) {
    return 'api';
  }

  if (/(chatgpt|oauth|claude\.ai|subscription|account)/i.test(authHints)) {
    return 'subscription';
  }

  if (input.providerId === 'opencode' && input.authenticated === true) {
    return 'api';
  }

  return 'unknown';
}
