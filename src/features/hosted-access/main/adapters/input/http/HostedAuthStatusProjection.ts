import type { HostedAuthMode, HostedAuthStatus, HostedPrincipal } from '../../../../contracts';

export function projectHostedAuthStatus(options: {
  readonly mode: HostedAuthMode;
  readonly principal: HostedPrincipal | null;
  readonly csrfToken: string | null;
  readonly oidcProviderName: string | null;
  readonly runtimeIdentity?: { readonly deploymentId: string; readonly bootId: string } | null;
}): HostedAuthStatus {
  return Object.freeze({
    mode: options.mode,
    authenticated: options.principal !== null,
    principal: options.principal,
    csrfToken: options.csrfToken,
    oidcProviderName: options.oidcProviderName,
    deploymentId: (options.principal && options.runtimeIdentity?.deploymentId) ?? null,
    bootId: (options.principal && options.runtimeIdentity?.bootId) ?? null,
  });
}
