import type { TeamProviderId } from '@shared/types';

export function buildProviderPrepareModelCacheKey({
  cwd,
  providerId,
  backendSummary,
  limitContext,
  runtimeStatusSignature,
  modelChecksSignature,
  allowExperimentalLocalModels,
}: {
  cwd: string;
  providerId: TeamProviderId;
  backendSummary: string | null | undefined;
  limitContext: boolean;
  runtimeStatusSignature?: string | null;
  modelChecksSignature?: string | null;
  allowExperimentalLocalModels?: boolean;
}): string {
  return [
    cwd,
    providerId,
    backendSummary ?? '',
    limitContext ? 'limit-context:on' : 'limit-context:off',
    runtimeStatusSignature ?? '',
    modelChecksSignature ?? '',
    allowExperimentalLocalModels ? 'experimental-local-models:on' : 'experimental-local-models:off',
  ].join('::');
}
