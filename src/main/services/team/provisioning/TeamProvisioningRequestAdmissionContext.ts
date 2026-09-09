import { AsyncLocalStorage } from 'node:async_hooks';

export interface TeamProvisioningRequestAdmissionContext {
  active: boolean;
  lockKey: string;
  publicationIsAuthorized: () => boolean;
  parent: TeamProvisioningRequestAdmissionContext | undefined;
}

// The existing request/reentrancy scope also carries the original publication
// admission through preparation and its nested runtime/store wrappers.
export const teamProvisioningRequestAdmissionContext =
  new AsyncLocalStorage<TeamProvisioningRequestAdmissionContext>();

export function getAdmittedTeamPublicationAuthority(teamName: string): (() => boolean) | undefined {
  for (
    let context = teamProvisioningRequestAdmissionContext.getStore();
    context;
    context = context.parent
  ) {
    if (context.active && context.lockKey === teamName) return context.publicationIsAuthorized;
  }
  return undefined;
}
