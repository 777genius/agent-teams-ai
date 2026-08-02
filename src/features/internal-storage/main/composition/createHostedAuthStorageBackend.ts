import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedAuthStorageGateway } from '../../contracts/hostedAuthStorageContracts';
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
  let disposal: Promise<void> | null = null;
  return Object.freeze({
    gateway: client,
    coordinationEvents,
    dispose: () => (disposal ??= client.close()),
  });
}
