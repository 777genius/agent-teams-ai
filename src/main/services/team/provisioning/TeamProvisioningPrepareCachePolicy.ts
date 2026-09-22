import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import { normalizeProvisioningModelCheckRequests } from './TeamProvisioningRuntimeLaunchSelection';

import type { TeamProviderId, TeamProvisioningModelCheckRequest } from '@shared/types';

interface PrepareCacheKeyOptions {
  forceFresh?: boolean;
  providerId?: TeamProviderId;
  providerIds?: readonly TeamProviderId[];
  modelIds?: readonly string[];
  modelChecks?: readonly TeamProvisioningModelCheckRequest[];
  limitContext?: boolean;
  modelVerificationMode?: string | null;
}

export function createPrepareForProvisioningInFlightKey(
  cwd?: string,
  opts?: PrepareCacheKeyOptions
): string {
  const providerIds = normalizePrepareProviderIds(opts);
  if (providerIds.length === 0) {
    providerIds.push('anthropic');
  }
  const modelIds = normalizePrepareModelIds(opts?.modelIds);
  const modelChecks = normalizePrepareModelChecks(opts?.modelChecks).map((check) => ({
    providerId: check.providerId,
    model: check.model,
    effort: check.effort ?? null,
  }));

  return JSON.stringify({
    cwd: cwd?.trim() || process.cwd(),
    forceFresh: opts?.forceFresh === true,
    providerIds,
    modelIds,
    modelChecks,
    limitContext: opts?.limitContext === true,
    modelVerificationMode: opts?.modelVerificationMode ?? null,
  });
}

export function normalizePrepareProviderIds(opts?: PrepareCacheKeyOptions): TeamProviderId[] {
  return Array.from(
    new Set(
      [opts?.providerId, ...(opts?.providerIds ?? [])]
        .map((providerId) => resolveTeamProviderId(providerId))
        .filter((providerId): providerId is TeamProviderId => Boolean(providerId))
    )
  ).sort((left, right) => left.localeCompare(right));
}

export function normalizePrepareModelIds(modelIds: readonly string[] | undefined): string[] {
  return Array.from(
    new Set((modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right));
}

export function normalizePrepareModelChecks(
  checks: readonly TeamProvisioningModelCheckRequest[] | undefined
): TeamProvisioningModelCheckRequest[] {
  return normalizeProvisioningModelCheckRequests(checks).sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      left.model.localeCompare(right.model) ||
      (left.effort ?? '').localeCompare(right.effort ?? '')
  );
}
