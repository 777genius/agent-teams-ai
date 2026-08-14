import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { ExternalWriterObservationCheckpointStorageGateway } from '../../contracts/externalWriterObservationStorageContracts';
import type {
  ExternalWriterCleanHandoffConsumeRequest,
  ExternalWriterCleanHandoffSaveRequest,
  ExternalWriterObservationCheckpointIdentity,
  ExternalWriterObservationCheckpointSaveRequest,
} from '../../contracts/externalWriterObservationStorageContracts';
import type { ExternalWriterReconciliationStorageGateway } from '../../contracts/externalWriterReconciliationStorageContracts';
import type { HostedAuthStorageGateway } from '../../contracts/hostedAuthStorageContracts';
import type { HostedTeamApprovalAuthorityStorageGateway } from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type { HostedTeamConfigurationStorageGateway } from '../../contracts/hostedTeamConfigurationStorageContracts';
import type {
  ExternalWriterIdentityInventoryCapture,
  TeamIdentityReadGateway,
} from '../../contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted';
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
  /** Live canonical identities served by this same serialized hosted worker. */
  readonly teamIdentities: TeamIdentityReadGateway & {
    captureExternalWriterTeamIdentities(request: {
      readonly retirementCandidates: readonly TeamId[];
    }): Promise<ExternalWriterIdentityInventoryCapture>;
  };
  /** Durable team-configuration operations on the same hosted-only worker. */
  readonly teamConfigurations: HostedTeamConfigurationStorageGateway;
  /** Durable approval authority and delivery outbox on the hosted worker. */
  readonly teamApprovals: HostedTeamApprovalAuthorityStorageGateway;
  /** Event-journal operations on the same worker/client as hosted auth. */
  readonly coordinationEvents: HostedCoordinationEventStorageGateway;
  /** Complete observer checkpoints on the same serialized hosted worker. */
  readonly externalWriterObservations: ExternalWriterObservationCheckpointStorageGateway;
  readonly externalWriterReconciliations: ExternalWriterReconciliationStorageGateway;
  dispose(): Promise<void>;
}

/**
 * Narrow standalone composition for hosted authentication. It deliberately
 * exposes no desktop journals or fallback stores. The narrow identity view is deliberately the
 * same live worker/client as auth so hosted reads cannot freeze a second startup snapshot.
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
  const externalWriterObservations: ExternalWriterObservationCheckpointStorageGateway =
    Object.freeze({
      loadExternalWriterObservationCheckpoint: (
        identity: ExternalWriterObservationCheckpointIdentity
      ) => client.loadExternalWriterObservationCheckpoint(identity),
      saveExternalWriterObservationCheckpoint: (
        request: ExternalWriterObservationCheckpointSaveRequest
      ) => client.saveExternalWriterObservationCheckpoint(request),
      saveExternalWriterCleanHandoffEligibility: (request: ExternalWriterCleanHandoffSaveRequest) =>
        client.saveExternalWriterCleanHandoffEligibility(request),
      consumeExternalWriterCleanHandoffEligibility: (
        request: ExternalWriterCleanHandoffConsumeRequest
      ) => client.consumeExternalWriterCleanHandoffEligibility(request),
    });
  const externalWriterReconciliations: ExternalWriterReconciliationStorageGateway = Object.freeze({
    getExternalWriterReconciliation: (
      input: Parameters<
        ExternalWriterReconciliationStorageGateway['getExternalWriterReconciliation']
      >[0]
    ) => client.getExternalWriterReconciliation(input),
    commitExternalWriterReconciliation: (
      input: Parameters<
        ExternalWriterReconciliationStorageGateway['commitExternalWriterReconciliation']
      >[0]
    ) => client.commitExternalWriterReconciliation(input),
  });
  let disposal: Promise<void> | null = null;
  return Object.freeze({
    gateway: client,
    teamIdentities: client,
    coordinationEvents,
    teamConfigurations,
    teamApprovals: client,
    externalWriterObservations,
    externalWriterReconciliations,
    dispose: () => (disposal ??= client.close()),
  });
}
