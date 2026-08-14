import type {
  ExternalWriterTeamIdentityInventory,
  TeamLifecycleReadOnlyIdentityGateway,
} from './teamLifecycleReadOnlyIdentitySource';
import type { TeamIdentityRecord } from '@features/internal-storage/contracts';

export interface HostedTeamIdentityGatewayBinding {
  readonly gateway: TeamLifecycleReadOnlyIdentityGateway;
  bindLiveGateway(gateway: TeamLifecycleReadOnlyIdentityGateway): void;
}

/**
 * Keeps startup admission read-only, then moves every already-composed consumer onto the canonical
 * hosted worker once that worker is available. This avoids immutable-file reads racing the worker's
 * live SQLite WAL without creating a second database connection.
 */
export function createHostedTeamIdentityGatewayBinding(
  startupGateway: TeamLifecycleReadOnlyIdentityGateway
): HostedTeamIdentityGatewayBinding {
  let delegate = startupGateway;
  let liveBound = false;
  return Object.freeze({
    gateway: Object.freeze({
      listTeamIdentities: () => delegate.listTeamIdentities(),
      getTeamIdentity: (teamId: TeamIdentityRecord['teamId']) => delegate.getTeamIdentity(teamId),
      captureExternalWriterTeamIdentities: (input: {
        readonly retirementCandidates: readonly TeamIdentityRecord['teamId'][];
      }): Promise<ExternalWriterTeamIdentityInventory> =>
        delegate.captureExternalWriterTeamIdentities(input),
    }),
    bindLiveGateway: (gateway: TeamLifecycleReadOnlyIdentityGateway): void => {
      if (liveBound) throw new Error('hosted-team-identity-live-gateway-already-bound');
      if (gateway === startupGateway) {
        throw new Error('hosted-team-identity-live-gateway-invalid');
      }
      delegate = gateway;
      liveBound = true;
    },
  });
}
