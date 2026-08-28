import {
  getCliProviderCatalogAuthorityFingerprint,
  getCliProviderProfileAuthorityFingerprint,
  normalizeCliProviderAuthorityProjectPath,
} from '@shared/utils/cliProviderAuthority';
import { hasFreshAuthoritativeScopedProviderStatus } from '@shared/utils/cliProviderStatus';

import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusAuthorityScope,
} from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export interface ScopedCliProviderLaunchProof {
  providerStatus: CliProviderStatus;
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
  /** Missing legacy entries are display-only and must not authorize launch. */
  authorityScope?: CliProviderStatusAuthorityScope;
}

export function setBoundedScopedProviderLaunchProof(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  scopeKey: string,
  proof: ScopedCliProviderLaunchProof
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, proof]);
  if (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.splice(0, entries.length - CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  }
  return Object.fromEntries(entries);
}

function isSemanticAuthorityObservation(status: CliProviderStatus): boolean {
  return !['pending', 'transient_error', 'model_only'].includes(status.statusCheckOutcome ?? '');
}

function deleteScope(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  scopeKey: string
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  if (!(scopeKey in current)) return current;
  const next = { ...current };
  delete next[scopeKey];
  return next;
}

function deleteProvider(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  providerId: CliProviderId
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => !key.startsWith(`${providerId}\0`));
  return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
}

export function reconcileGlobalProviderLaunchProofs(
  currentProofs: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  currentStatus: CliInstallationStatus | null,
  incomingStatus: CliInstallationStatus
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  let nextProofs = currentProofs;
  for (const incoming of incomingStatus.providers) {
    if (!isSemanticAuthorityObservation(incoming)) continue;
    const current = currentStatus?.providers.find(
      ({ providerId }) => providerId === incoming.providerId
    );
    if (
      (current &&
        isSemanticAuthorityObservation(current) &&
        getCliProviderProfileAuthorityFingerprint(current) !==
          getCliProviderProfileAuthorityFingerprint(incoming)) ||
      (incoming.statusCheckOutcome === 'authoritative' && !incoming.authenticated)
    )
      nextProofs = deleteProvider(nextProofs, incoming.providerId);
  }
  return nextProofs;
}

export function reconcileScopedProviderLaunchProofs(input: {
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  scopeKey: string;
  providerId: CliProviderId;
  projectPath: string;
  providerStatus: CliProviderStatus;
  responseMatchesProvider: boolean;
  metadataMatchesRequest: boolean;
  authorityScope: CliProviderStatusAuthorityScope | null;
  requestIntent: 'passive' | 'launch-proof';
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
}): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const previous = input.current[input.scopeKey];
  const profileChange =
    input.responseMatchesProvider &&
    isSemanticAuthorityObservation(input.providerStatus) &&
    previous !== undefined &&
    getCliProviderProfileAuthorityFingerprint(previous.providerStatus) !==
      getCliProviderProfileAuthorityFingerprint(input.providerStatus);
  const catalogChange =
    input.responseMatchesProvider &&
    isSemanticAuthorityObservation(input.providerStatus) &&
    previous !== undefined &&
    getCliProviderCatalogAuthorityFingerprint(previous.providerStatus) !==
      getCliProviderCatalogAuthorityFingerprint(input.providerStatus);
  const globalLogout =
    input.responseMatchesProvider &&
    input.providerStatus.statusCheckOutcome === 'authoritative' &&
    !input.providerStatus.authenticated;
  const retained =
    profileChange || globalLogout
      ? deleteProvider(input.current, input.providerId)
      : catalogChange
        ? deleteScope(input.current, input.scopeKey)
        : input.current;
  const scope = input.authorityScope;
  const canAuthorize =
    input.requestIntent === 'launch-proof' &&
    input.metadataMatchesRequest &&
    input.responseMatchesProvider &&
    hasFreshAuthoritativeScopedProviderStatus(input.providerStatus) &&
    scope?.schemaVersion === 1 &&
    scope.providerId === input.providerId &&
    scope.projectPath === normalizeCliProviderAuthorityProjectPath(input.projectPath);
  return canAuthorize
    ? setBoundedScopedProviderLaunchProof(retained, input.scopeKey, {
        providerStatus: input.providerStatus,
        requestId: input.requestId,
        epoch: input.epoch,
        fetchedAtMs: input.fetchedAtMs,
        authorityScope: scope,
      })
    : retained;
}
