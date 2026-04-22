import type { TeamProviderId } from '@shared/types';

export function buildProviderPrepareModelCacheKey({
  cwd,
  providerId,
  backendSummary,
  limitContext,
  runtimeStatusSignature,
}: {
  cwd: string;
  providerId: TeamProviderId;
  backendSummary: string | null | undefined;
  limitContext: boolean;
  runtimeStatusSignature?: string | null | undefined;
}): string {
  return [
    cwd,
    providerId,
    backendSummary ?? '',
    limitContext ? 'limit-context:on' : 'limit-context:off',
    runtimeStatusSignature ?? '',
  ].join('::');
}
