import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';
import type { LeadRuntimeFailureObservation } from './TeamProvisioningRuntimeFailureObservationBoundary';

export interface HostedApprovalRuntimeRevocationLogger {
  error(message: string, error: unknown): void;
}

export interface HostedApprovalRuntimeShutdownPort {
  getAliveTeams(): string[];
  stopAllTeams(): Promise<void>;
}

export function observeHostedApprovalRuntimeFailure(
  runtime: HostedApprovalRuntimeTransitionService | null,
  failure: LeadRuntimeFailureObservation,
  logger: HostedApprovalRuntimeRevocationLogger
): Promise<void> {
  if (!runtime) return Promise.resolve();
  return runtime
    .beforeFailure(failure.teamName, async () => undefined)
    .catch((error: unknown) => {
      logger.error('Hosted approval runtime failure revocation failed:', error);
      throw error;
    });
}

export function stopAllTeamsWithHostedApprovalRuntime(
  runtime: HostedApprovalRuntimeTransitionService | null,
  provisioning: HostedApprovalRuntimeShutdownPort
): Promise<void> {
  return (
    runtime?.beforeShutdown(provisioning.getAliveTeams(), () => provisioning.stopAllTeams()) ??
    provisioning.stopAllTeams()
  );
}
