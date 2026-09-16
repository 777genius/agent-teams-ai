import type { RuntimeProviderAuthMethodDto } from '../../contracts';

export type OpenCodeCatalogFailureKind =
  | 'auth_reconnect'
  | 'auth_api_key'
  | 'timeout'
  | 'runtime_missing'
  | 'stale'
  | 'directory'
  | 'generic';

export type OpenCodeCatalogUserCopyKey =
  | 'catalogSignInExpired'
  | 'catalogCheckCredential'
  | 'catalogLoadFailed'
  | 'catalogDirectoryFailed'
  | 'catalogTimedOut'
  | 'catalogStale';

export interface OpenCodeCatalogFailureClassificationInput {
  readonly operation: 'provider_directory' | 'provider_models';
  readonly sourceProviderId: string | null;
  readonly origin: 'main' | 'client_validation' | 'transport' | 'stale';
  readonly message: string;
  readonly errorCode?: string | null;
  readonly timedOut?: boolean | null;
  readonly displayName?: string | null;
  readonly authMethods?: readonly RuntimeProviderAuthMethodDto[] | null;
  readonly connectedAuthHint?: string | null;
}

export interface OpenCodeCatalogUserCopy {
  readonly kind: OpenCodeCatalogFailureKind;
  readonly key: OpenCodeCatalogUserCopyKey;
  readonly provider: string;
}

const GENERIC_CATALOG_FAILURE_MESSAGES = new Set([
  'opencode catalog request failed.',
  'catalog request failed.',
  'the provider-model catalog request failed.',
  'catalog failed',
]);

const OAUTH_PROVIDER_IDS = new Set([
  'xai',
  'github-copilot',
  'github-copilot-enterprise',
  'kiro',
  'cursor',
  'cursor-acp',
]);

export function catalogProviderDisplayName(
  providerId: string | null,
  directoryName?: string | null,
  connectedAuthHint?: string | null
): string {
  if (providerId === 'xai' && connectedAuthHint !== 'api') {
    return 'SuperGrok';
  }
  const name = directoryName?.trim();
  if (name) {
    return name;
  }
  if (providerId === 'xai') {
    return 'xAI';
  }
  return providerId?.trim() || 'OpenCode';
}

function isGenericOpenCodeCatalogFailureMessage(message: string): boolean {
  return GENERIC_CATALOG_FAILURE_MESSAGES.has(message.trim().toLowerCase());
}

function looksLikeOAuthProvider(input: OpenCodeCatalogFailureClassificationInput): boolean {
  const providerId = input.sourceProviderId?.trim().toLowerCase() ?? '';
  // The saved credential wins over advertised methods: xAI advertises both
  // SuperGrok OAuth and an API key, but only one is actually connected.
  if (input.connectedAuthHint === 'api') {
    return false;
  }
  if (input.connectedAuthHint === 'oauth') {
    return true;
  }
  if (input.authMethods?.includes('oauth') && !input.authMethods.includes('api')) {
    return true;
  }
  return OAUTH_PROVIDER_IDS.has(providerId);
}

function looksLikeApiKeyProvider(input: OpenCodeCatalogFailureClassificationInput): boolean {
  if (input.connectedAuthHint === 'oauth') {
    return false;
  }
  if (input.connectedAuthHint === 'api') {
    return true;
  }
  return Boolean(input.authMethods?.includes('api') && !input.authMethods.includes('oauth'));
}

function looksLikeAuthFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('token refresh failed') ||
    lower.includes('invalid_grant') ||
    lower.includes('invalid grant') ||
    lower.includes('invalid or unknown refresh token') ||
    lower.includes('authentication failed') ||
    lower.includes('authentication required') ||
    lower.includes('not logged in') ||
    lower.includes('unauthorized') ||
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower)
  );
}

function looksLikeApiKeyFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('rejected this api key') ||
    /\binvalid[\s_-]+api[\s_-]*key\b/.test(lower) ||
    /\bapi[\s_-]*key\s+(?:is\s+)?(?:invalid|not\s+valid|expired|revoked)\b/.test(lower)
  );
}

export function describeOpenCodeCatalogFailure(
  input: OpenCodeCatalogFailureClassificationInput
): OpenCodeCatalogUserCopy {
  const provider = catalogProviderDisplayName(
    input.sourceProviderId,
    input.displayName,
    input.connectedAuthHint
  );
  if (input.origin === 'stale') {
    return { kind: 'stale', key: 'catalogStale', provider };
  }
  if (input.operation === 'provider_directory') {
    return { kind: 'directory', key: 'catalogDirectoryFailed', provider };
  }
  if (input.timedOut === true || /\btimed out\b/i.test(input.message)) {
    return { kind: 'timeout', key: 'catalogTimedOut', provider };
  }
  if (input.errorCode === 'runtime-missing') {
    return { kind: 'runtime_missing', key: 'catalogLoadFailed', provider };
  }
  if (looksLikeApiKeyFailureMessage(input.message)) {
    return { kind: 'auth_api_key', key: 'catalogCheckCredential', provider };
  }
  if (
    input.errorCode === 'auth-failed' ||
    input.errorCode === 'auth-required' ||
    looksLikeAuthFailureMessage(input.message)
  ) {
    return { kind: 'auth_reconnect', key: 'catalogSignInExpired', provider };
  }
  if (isGenericOpenCodeCatalogFailureMessage(input.message)) {
    if (looksLikeOAuthProvider(input)) {
      return { kind: 'auth_reconnect', key: 'catalogSignInExpired', provider };
    }
    if (looksLikeApiKeyProvider(input)) {
      return { kind: 'auth_api_key', key: 'catalogCheckCredential', provider };
    }
  }
  return { kind: 'generic', key: 'catalogLoadFailed', provider };
}

export function formatOpenCodeCatalogAlertMessage(
  failures: readonly OpenCodeCatalogFailureClassificationInput[],
  translate: (key: OpenCodeCatalogUserCopyKey, provider: string) => string
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    const copy = describeOpenCodeCatalogFailure(failure);
    const line = translate(copy.key, copy.provider);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  if (lines.length === 0) {
    return translate('catalogDirectoryFailed', 'OpenCode');
  }
  if (lines.length === 1) {
    return lines[0]!;
  }
  return `${lines[0]} (+${failures.length - 1})`;
}
