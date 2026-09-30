import * as path from 'node:path';

import {
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
} from '../../contracts/internalStorageContracts';
import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type {
  ExternalWriterIdentityInventoryCapture,
  TeamIdentityReadGateway,
} from '../../contracts/teamIdentityStorageContracts';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedTeamIdentityReadGateway extends TeamIdentityReadGateway {
  captureExternalWriterTeamIdentities(input: {
    readonly retirementCandidates: readonly TeamId[];
  }): Promise<ExternalWriterIdentityInventoryCapture>;
}

export interface HostedTeamIdentityReadBackend {
  readonly gateway: HostedTeamIdentityReadGateway;
  dispose(): Promise<void>;
}

/** Opens the launcher-admitted identity database through a dedicated query-only worker. */
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
  const gateway: HostedTeamIdentityReadGateway = Object.freeze({
    listTeamIdentities: () => client.listTeamIdentities(),
    getTeamIdentity: (teamId: TeamId) => client.getTeamIdentity(teamId),
    captureExternalWriterTeamIdentities: (input: {
      readonly retirementCandidates: readonly TeamId[];
    }) =>
      client.captureExternalWriterTeamIdentities(input),
  });
  let disposal: Promise<void> | null = null;
  return Object.freeze({
    gateway,
    dispose: () => (disposal ??= client.close()),
  });
}
