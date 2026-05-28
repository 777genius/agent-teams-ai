import { hostedIntegrationError, throwHostedIntegrationError } from './hostedIntegrationErrors';

export interface NormalizedControlPlaneBaseUrl {
  readonly href: string;
  readonly origin: string;
  readonly isLocalDevelopment: boolean;
}

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- Blocks the AWS metadata endpoint by exact host.
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal']);
const LOCALHOST_NAMES = new Set(['localhost']);
const ALLOWED_GITHUB_SETUP_HOSTS = new Set(['github.com', 'www.github.com']);

export function normalizeControlPlaneBaseUrl(
  rawUrl: string,
  options: { allowLocalhostHttp?: boolean } = {}
): NormalizedControlPlaneBaseUrl {
  const input = rawUrl.trim();
  if (!input) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_REQUIRED',
        'Control-plane URL is required.',
        'configuration'
      )
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_INVALID',
        'Control-plane URL is invalid.',
        'configuration'
      )
    );
  }

  if (parsed.username || parsed.password) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_HAS_CREDENTIALS',
        'Control-plane URL must not contain credentials.',
        'security'
      )
    );
  }

  if (parsed.hash) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_HAS_FRAGMENT',
        'Control-plane URL must not contain a fragment.',
        'security'
      )
    );
  }

  const isLocalDevelopment = isLocalhost(parsed.hostname);
  const allowLocalhostHttp = options.allowLocalhostHttp === true;
  if (
    parsed.protocol !== 'https:' &&
    !(allowLocalhostHttp && parsed.protocol === 'http:' && isLocalDevelopment)
  ) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_SCHEME_REJECTED',
        'Control-plane URL must use HTTPS outside localhost development.',
        'security'
      )
    );
  }

  if (isBlockedNetworkHost(parsed.hostname) && !isLocalDevelopment) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_BASE_URL_HOST_REJECTED',
        'Control-plane URL host is not allowed.',
        'security'
      )
    );
  }

  parsed.hash = '';
  parsed.search = '';
  const pathname = normalizeBasePath(parsed.pathname);
  parsed.pathname = pathname;
  return {
    href: parsed.href,
    origin: parsed.origin,
    isLocalDevelopment,
  };
}

export function assertTokenBearingRequestUrl(
  baseUrl: NormalizedControlPlaneBaseUrl,
  requestUrl: string
): URL {
  const parsed = new URL(requestUrl, baseUrl.href);
  if (parsed.origin !== baseUrl.origin) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_TOKEN_DESTINATION_REJECTED',
        'Refusing to send hosted integration credentials to a different origin.',
        'security'
      )
    );
  }
  return parsed;
}

export function assertHostedSetupUrlAllowed(
  baseUrl: NormalizedControlPlaneBaseUrl,
  setupUrl: string
): URL {
  let parsed: URL;
  try {
    parsed = new URL(setupUrl);
  } catch {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_SETUP_URL_INVALID',
        'Setup URL is invalid.',
        'security'
      )
    );
  }

  if (
    parsed.protocol !== 'https:' &&
    !(baseUrl.isLocalDevelopment && parsed.protocol === 'http:' && isLocalhost(parsed.hostname))
  ) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_SETUP_URL_SCHEME_REJECTED',
        'Setup URL scheme is not allowed.',
        'security'
      )
    );
  }

  const isControlPlaneUrl = parsed.origin === baseUrl.origin;
  const isGitHubSetupUrl =
    parsed.protocol === 'https:' && ALLOWED_GITHUB_SETUP_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isControlPlaneUrl && !isGitHubSetupUrl) {
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_SETUP_URL_ORIGIN_REJECTED',
        'Setup URL origin is not allowed.',
        'security'
      )
    );
  }
  return parsed;
}

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimSlashes(trimmed)}/`;
}

function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOCALHOST_NAMES.has(host) || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isBlockedNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (isBlockedIpv4(host)) return true;

  const ipv6Host = stripIpv6Brackets(host);
  if (ipv6Host === '::1') return true;
  if (ipv6Host.includes(':') && (ipv6Host.startsWith('fc') || ipv6Host.startsWith('fd'))) {
    return true;
  }
  return false;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

function isBlockedIpv4(hostname: string): boolean {
  const octets = parseIpv4Octets(hostname);
  if (!octets) return false;
  const [first, second] = octets;
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function parseIpv4Octets(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(parseDecimalOctet);
  if (octets.some((octet) => octet === null)) return null;
  return octets as [number, number, number, number];
}

function parseDecimalOctet(value: string): number | null {
  if (!value) return null;
  let parsed = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return null;
    parsed = parsed * 10 + code - 48;
    if (parsed > 255) return null;
  }
  return parsed;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, hostname.length - 1)
    : hostname;
}
