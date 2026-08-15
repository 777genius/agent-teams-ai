import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';
import type { LeadRuntimeFailureObservation } from './TeamProvisioningRuntimeFailureObservationBoundary';
import type { TeamChangeEvent } from '@shared/types';

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

export function observeHostedApprovalRuntimeTeamChange(
  runtime: HostedApprovalRuntimeTransitionService | null,
  event: TeamChangeEvent,
  logger: HostedApprovalRuntimeRevocationLogger
): Promise<void> {
  if (
    event.type !== 'process' ||
    (event.detail !== 'failed' &&
      event.detail !== 'disconnected' &&
      event.detail !== 'stopped' &&
      event.detail !== 'cancelled')
  ) {
    return Promise.resolve();
  }
  const revoke =
    event.detail === 'failed'
      ? runtime?.beforeFailure(event.teamName, async () => undefined)
      : runtime?.beforeOwnerLoss(event.teamName, async () => undefined);
  if (!revoke) return Promise.resolve();
  return revoke.catch((error: unknown) => {
    logger.error('Hosted approval runtime owner-loss revocation failed:', error);
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
