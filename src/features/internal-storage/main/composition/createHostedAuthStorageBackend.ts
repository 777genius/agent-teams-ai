import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedAuthStorageGateway } from '../../contracts/hostedAuthStorageContracts';

export interface HostedAuthStorageBackend {
  readonly gateway: HostedAuthStorageGateway;
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
  return Object.freeze({
    gateway: client,
    dispose: () => client.close(),
  });
}
