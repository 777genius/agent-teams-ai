import * as path from 'node:path';

import {
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
} from '@features/internal-storage/contracts';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';

import type { TeamLifecycleReadOnlyIdentityGateway } from './teamLifecycleReadOnlyIdentitySource';

export interface HostedTeamIdentityReadBackend {
  readonly gateway: TeamLifecycleReadOnlyIdentityGateway;
  dispose(): Promise<void>;
}

/**
 * Opens the launcher-admitted identity database through a dedicated query-only worker. Startup
 * descriptor and schema admission remains the responsibility of TeamLifecycleReadOnlyIdentitySource;
 * this backend only prevents later live reads from racing SQLite journals on the main thread.
 */
export function createHostedTeamIdentityReadBackend(
  appDataRoot: string
): HostedTeamIdentityReadBackend {
  const client = new InternalStorageWorkerClient({
    databasePath: path.join(
      appDataRoot,
      INTERNAL_STORAGE_DIRNAME,
      INTERNAL_STORAGE_DATABASE_FILENAME
    ),
    mode: 'team-identity-read-only',
  });
  if (!client.isAvailable()) {
    throw new Error('hosted-team-identity-read-worker-unavailable');
  }
  const gateway: TeamLifecycleReadOnlyIdentityGateway = Object.freeze({
    listTeamIdentities: () => client.listTeamIdentities(),
    getTeamIdentity: (teamId) => client.getTeamIdentity(teamId),
    captureExternalWriterTeamIdentities: (input) =>
      client.captureExternalWriterTeamIdentities(input),
  });
  let disposal: Promise<void> | null = null;
  return Object.freeze({
    gateway,
    dispose: () => (disposal ??= client.close()),
  });
}
