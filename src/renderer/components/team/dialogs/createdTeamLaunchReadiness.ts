import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CreatedTeamReadiness } from '@shared/types/team';

/** Presentation evidence only. Main and the captured Host admit every Create mutation. */
export function currentCreatedTeamReadiness(
  scope: {
    open: boolean;
    preparationId: string;
    selectionSignature: string;
    draftSignature: string;
  },
  checks: readonly ProvisioningProviderCheck[],
  now: number
): CreatedTeamReadiness | undefined {
  if (!scope.open || !Number.isFinite(now)) return undefined;
  const check = checks.find((row) => row.providerId === 'anthropic');
  const proof = check?.createdTeamReadiness;
  return check?.status === 'ready' &&
    proof &&
    check.createdTeamDraftSignature === scope.draftSignature &&
    proof.preparationId === scope.preparationId &&
    proof.selectionSignature === scope.selectionSignature &&
    Boolean(proof.draftDigest) &&
    Number.isFinite(proof.expiresAt) &&
    proof.expiresAt > now
    ? proof
    : undefined;
}
