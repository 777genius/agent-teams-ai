import type { TeamProviderId, TeamProvisioningPrepareContext } from '@shared/types';

export function buildProviderPrepareModelCacheKey({
  cwd,
  providerId,
  backendSummary,
  limitContext,
  runtimeStatusSignature,
  modelChecksSignature,
  context,
  invalidationEpoch,
}: {
  cwd: string;
  providerId: TeamProviderId;
  backendSummary: string | null | undefined;
  limitContext: boolean;
  runtimeStatusSignature?: string | null;
  modelChecksSignature?: string | null;
  context?: TeamProvisioningPrepareContext;
  invalidationEpoch?: number;
}): string {
  const baseKey = appendProviderPrepareInvalidationEpoch(
    [
      cwd,
      providerId,
      backendSummary ?? '',
      limitContext ? 'limit-context:on' : 'limit-context:off',
      runtimeStatusSignature ?? '',
      modelChecksSignature ?? '',
    ].join('::'),
    invalidationEpoch
  );
  return context ? JSON.stringify([context, baseKey]) : baseKey;
}

/** Explicit settings changes invalidate model evidence without invalidating unrelated selections. */
export function appendProviderPrepareInvalidationEpoch(key: string, epoch = 0): string {
  return epoch > 0 ? `${key}::settings-invalidation:${epoch}` : key;
}
