import { parseHostTeamSelectionKey } from '@features/agent-backend/contracts';

import type { ProvisioningProviderCheck } from './provisioningProviderChecks';

export interface CapturedTeamReadinessScope {
  teamName: string;
  preparationId: string;
  selectionSignature: string;
  draftSignature: string;
  open: boolean;
}
/** Presentation evidence only; Host admission remains the authority for every mutation. */
export function hasCapturedTeamLaunchReadiness(
  scope: CapturedTeamReadinessScope,
  checks: readonly ProvisioningProviderCheck[],
  providerId: string,
  now: number
): boolean {
  if (
    !scope.open ||
    !['anthropic', 'codex', 'opencode'].includes(providerId) ||
    !Number.isFinite(now)
  )
    return false;
  let handleId: string;
  try {
    handleId = parseHostTeamSelectionKey(scope.teamName);
  } catch {
    return false;
  }
  const check = checks.find((row) => row.providerId === providerId);
  const proof = check?.capturedTeamReadiness;
  return Boolean(
    check?.status === 'ready' &&
    proof &&
    check.capturedTeamDraftSignature === scope.draftSignature &&
    proof.handleId === handleId &&
    proof.preparationId === scope.preparationId &&
    proof.selectionSignature === scope.selectionSignature &&
    proof.launchId &&
    proof.rosterRevision &&
    Number.isFinite(proof.expiresAt) &&
    proof.expiresAt > now
  );
}
