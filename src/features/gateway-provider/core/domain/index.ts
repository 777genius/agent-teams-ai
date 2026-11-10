import {
  isLoopbackHostname,
  isPrivateNetworkHostname,
  isUnusableNetworkHostname,
} from '@shared/utils/networkHost';

export class GatewayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayValidationError';
  }
}

export interface GatewayProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemberGatewayBinding {
  teamName: string;
  memberName: string;
  profileId: string;
  apiKeyRef: string;
  gatewayUsageRef: string;
  boundAt: string;
  /** Provisional allocation owned by an Electron renderer document. */
  draftOwner?: string;
}

export interface GatewayUsageSource {
  gatewayUsageRef: string;
  canonicalEndpoint: string;
  allowPrivateNetwork: boolean;
  keyFingerprint: string;
  secretStorageRef: string;
  teamName: string;
  memberName: string;
  agentId?: string;
  firstUsageDay: string;
  createdAt: string;
  lastBoundAt: string;
  lastUnboundAt?: string;
  /** No saved roster or launch has consumed this newly allocated source yet. */
  draftOnly?: boolean;
  draftOwner?: string;
  hasActiveBinding: boolean;
  hasRuntimeArtifact: boolean;
  runtimeArtifactRetiredAt?: string;
}

export interface GatewayProviderState {
  schemaVersion: 1;
  profiles: GatewayProfile[];
  bindings: MemberGatewayBinding[];
  sources: GatewayUsageSource[];
}

export interface GatewayConnectionSpec {
  profileId: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  credentialRef: string;
  model?: string;
}

export interface NormalizeGatewayBaseUrlInput {
  baseUrl: string;
  allowPrivateNetwork?: boolean;
}

const MAX_BASE_URL_LENGTH = 2_048;

/** Canonicalizes a gateway root: no credentials/query/hash, no trailing slash and at most one `/v1`. */
export function normalizeGatewayBaseUrl(input: NormalizeGatewayBaseUrlInput): string {
  const raw = input.baseUrl.trim();
  if (!raw) {
    throw new GatewayValidationError('Enter a gateway URL.');
  }
  if (raw.length > MAX_BASE_URL_LENGTH) {
    throw new GatewayValidationError('Gateway URL is too long.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayValidationError('Enter a valid gateway URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayValidationError('Gateway URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new GatewayValidationError('Credentials are not allowed in the gateway URL.');
  }
  if (url.search || url.hash) {
    throw new GatewayValidationError('Gateway URL cannot include query parameters or a fragment.');
  }
  if (isUnusableNetworkHostname(url.hostname)) {
    throw new GatewayValidationError('Gateway URL must use a reachable host.');
  }

  const loopback = isLoopbackHostname(url.hostname);
  const privateNetwork = !loopback && isPrivateNetworkHostname(url.hostname);
  if (privateNetwork && !input.allowPrivateNetwork) {
    throw new GatewayValidationError(
      'This address is on your local network. Enable local network access to use it.'
    );
  }
  if (!loopback && url.protocol !== 'https:') {
    throw new GatewayValidationError(
      'Remote gateway URLs must use HTTPS to protect model requests and API keys.'
    );
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/v1')) {
    pathname = pathname.slice(0, -3).replace(/\/+$/, '');
  }
  if (pathname === '/') {
    pathname = '';
  }
  if (pathname && !pathname.startsWith('/')) {
    throw new GatewayValidationError('Enter a valid gateway URL.');
  }
  return `${url.origin}${pathname}`;
}

export function isGatewayPrivateNetworkUrl(canonicalBaseUrl: string): boolean {
  try {
    const url = new URL(canonicalBaseUrl);
    return !isLoopbackHostname(url.hostname) && isPrivateNetworkHostname(url.hostname);
  } catch {
    return false;
  }
}

export function gatewayBindingKey(teamName: string, memberName: string): string {
  return JSON.stringify([teamName, memberName]);
}

export function gatewayUsageRefInput(canonicalEndpoint: string, keyFingerprint: string): string {
  return `${canonicalEndpoint}\n${keyFingerprint}`;
}

export function utcDayAt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function resolveGatewayConnectionSpec(input: {
  profile: Pick<GatewayProfile, 'id' | 'baseUrl' | 'allowPrivateNetwork'>;
  credentialRef: string;
  model?: string;
}): GatewayConnectionSpec {
  return {
    profileId: input.profile.id,
    baseUrl: input.profile.baseUrl,
    allowPrivateNetwork: input.profile.allowPrivateNetwork,
    credentialRef: input.credentialRef,
    ...(input.model ? { model: input.model } : {}),
  };
}
