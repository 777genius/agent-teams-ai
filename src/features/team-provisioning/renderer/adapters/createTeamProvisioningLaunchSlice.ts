import { createTeamProvisioningLaunchSlice as createSlice } from '../slices/createTeamProvisioningLaunchSlice';

import { createTeamProvisioningLaunchPersistence } from './createTeamProvisioningLaunchPersistence';
import { createTeamProvisioningLaunchTransport } from './createTeamProvisioningLaunchTransport';

import type {
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchPersistencePort,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchSliceDependencies as CanonicalDependencies,
  TeamProvisioningLaunchTransportPort,
} from '../ports/TeamProvisioningLaunchPorts';

export type TeamProvisioningLaunchSliceDependencies<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
> = Omit<CanonicalDependencies<TMessageEntry, TContext>, 'persistence' | 'transport'> & {
  persistence?: TeamProvisioningLaunchPersistencePort;
  transport?: TeamProvisioningLaunchTransportPort;
};

export function createTeamProvisioningLaunchSlice<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
>(
  dependencies: TeamProvisioningLaunchSliceDependencies<TMessageEntry, TContext>
): TeamProvisioningLaunchSlice {
  return createSlice({
    ...dependencies,
    persistence: dependencies.persistence ?? createTeamProvisioningLaunchPersistence(),
    transport: dependencies.transport ?? createTeamProvisioningLaunchTransport(),
  });
}
