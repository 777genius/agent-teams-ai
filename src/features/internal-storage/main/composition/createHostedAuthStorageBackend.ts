import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedAuthStorageGateway } from '../../contracts/hostedAuthStorageContracts';
import type { HostedTeamConfigurationStorageGateway } from '../../contracts/hostedTeamConfigurationStorageContracts';
import type { CoordinationDurabilityStorageGateway } from '../application/coordinationDurabilityStorage';

export type HostedCoordinationEventStorageGateway = Pick<
  CoordinationDurabilityStorageGateway,
  | 'coordinationEventInitialize'
  | 'coordinationEventGetWatermark'
  | 'coordinationEventRead'
  | 'coordinationEventAppend'
  | 'coordinationEventPrune'
>;

export interface HostedAuthStorageBackend {
  readonly gateway: HostedAuthStorageGateway;
  /** Durable team-configuration operations on the same hosted-only worker. */
  readonly teamConfigurations: HostedTeamConfigurationStorageGateway;
  /** Event-journal operations on the same worker/client as hosted auth. */
  readonly coordinationEvents: HostedCoordinationEventStorageGateway;
  dispose(): Promise<void>;
}

/**
 * Narrow standalone composition for hosted authentication. It deliberately
 * exposes no desktop journals, team identity readers, or fallback stores.
 */
export function createHostedAuthStorageBackend(databasePath: string): HostedAuthStorageBackend {
  const client = new InternalStorageWorkerClient({
    databasePath,
  });
  if (!client.isAvailable()) {
    throw new Error('Hosted authentication storage worker is unavailable.');
  }
  const coordinationEvents: HostedCoordinationEventStorageGateway = Object.freeze({
    coordinationEventInitialize: (input) => client.coordinationEventInitialize(input),
    coordinationEventGetWatermark: (deploymentId) =>
      client.coordinationEventGetWatermark(deploymentId),
    coordinationEventRead: (input) => client.coordinationEventRead(input),
    coordinationEventAppend: (input) => client.coordinationEventAppend(input),
    coordinationEventPrune: (input) => client.coordinationEventPrune(input),
  });
  const teamConfigurations: HostedTeamConfigurationStorageGateway = Object.freeze({
    createHostedTeamConfiguration: (
      request: Parameters<
        HostedTeamConfigurationStorageGateway['createHostedTeamConfiguration']
      >[0],
      options: Parameters<HostedTeamConfigurationStorageGateway['createHostedTeamConfiguration']>[1]
    ) => client.createHostedTeamConfiguration(request, options),
    readHostedTeamConfiguration: (
      input: Parameters<HostedTeamConfigurationStorageGateway['readHostedTeamConfiguration']>[0]
    ) => client.readHostedTeamConfiguration(input),
    updateHostedTeamConfiguration: (
      request: Parameters<
        HostedTeamConfigurationStorageGateway['updateHostedTeamConfiguration']
      >[0],
      options: Parameters<HostedTeamConfigurationStorageGateway['updateHostedTeamConfiguration']>[1]
    ) => client.updateHostedTeamConfiguration(request, options),
    deleteHostedTeamConfiguration: (
      request: Parameters<
        HostedTeamConfigurationStorageGateway['deleteHostedTeamConfiguration']
      >[0],
      options: Parameters<HostedTeamConfigurationStorageGateway['deleteHostedTeamConfiguration']>[1]
    ) => client.deleteHostedTeamConfiguration(request, options),
  });
  let disposal: Promise<void> | null = null;
  return Object.freeze({
    gateway: client,
    coordinationEvents,
    teamConfigurations,
    dispose: () => (disposal ??= client.close()),
  });
}
