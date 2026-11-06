import type { TeamProvisioningModelCheckRequest } from '../types/team';

/** Product selection only; native/account identities never cross this boundary. */
export function capturedTeamSelectionSignature(input: {
  cwd?: string;
  selectedModelChecks?: readonly TeamProvisioningModelCheckRequest[];
  limitContext?: boolean;
}): string {
  return JSON.stringify([
    input.cwd ?? null,
    input.limitContext ?? null,
    (input.selectedModelChecks ?? []).map((check) => [
      check.providerId,
      check.model,
      check.effort ?? null,
      check.targets?.map((target) =>
        target.kind === 'lead' ? ['lead'] : [target.kind, target.name, target.originalName ?? null]
      ) ?? null,
    ]),
  ]);
}
