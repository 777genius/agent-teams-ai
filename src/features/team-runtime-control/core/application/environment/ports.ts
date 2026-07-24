import type {
  HostedChildEnvironmentIdentity,
  HostedChildEnvironmentNonSecretVariable,
  HostedChildEnvironmentSecretVariable,
} from '../../../contracts/hostedChildEnvironment';

export interface ResolveHostedChildNonSecretValueRequest {
  readonly identity: HostedChildEnvironmentIdentity;
  readonly variable: HostedChildEnvironmentNonSecretVariable;
}

export interface ResolveHostedChildProviderSecretRequest {
  readonly identity: HostedChildEnvironmentIdentity;
  readonly variable: HostedChildEnvironmentSecretVariable;
}

export type HostedChildEnvironmentValueResolution =
  | { readonly status: 'resolved'; readonly value: string }
  | { readonly status: 'rejected'; readonly reason: 'unavailable' | 'not_authorized' | 'invalid' };

/**
 * Implemented by the provider-owned output adapter. It resolves one declared key at the application
 * boundary and cannot supply an ambient process or shell environment.
 */
export interface HostedChildEnvironmentValueResolverPort {
  resolveNonSecret(
    request: ResolveHostedChildNonSecretValueRequest
  ): Promise<HostedChildEnvironmentValueResolution>;
  resolveProviderSecret(
    request: ResolveHostedChildProviderSecretRequest
  ): Promise<HostedChildEnvironmentValueResolution>;
}
