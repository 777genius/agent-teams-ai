import { createTeamProvisioningControlSlice as createSlice } from '../slices/createTeamProvisioningControlSlice';

import { createTeamProvisioningControlTransport } from './createTeamProvisioningControlTransport';

import type {
  TeamProvisioningControlSlice,
  TeamProvisioningControlSliceDependencies as CanonicalDependencies,
  TeamProvisioningControlTransportPort,
} from '../ports/TeamProvisioningControlPorts';

export type TeamProvisioningControlSliceDependencies = Omit<CanonicalDependencies, 'transport'> & {
  transport?: TeamProvisioningControlTransportPort;
};

export type { TeamProvisioningControlSlice };

export function createTeamProvisioningControlSlice(
  dependencies: TeamProvisioningControlSliceDependencies
): TeamProvisioningControlSlice {
  return createSlice({
    ...dependencies,
    transport: dependencies.transport ?? createTeamProvisioningControlTransport(),
  });
}
