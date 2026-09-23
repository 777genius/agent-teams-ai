import { createTeamConfigurationTransport } from './createTeamConfigurationTransport';
import { createTeamProvisioningPreparationTransport } from './createTeamProvisioningPreparationTransport';
import { createTeamRosterMutationTransport } from './createTeamRosterMutationTransport';

export const teamConfigurationTransport = createTeamConfigurationTransport();
export const teamProvisioningPreparationTransport = createTeamProvisioningPreparationTransport();
export const teamRosterMutationTransport = createTeamRosterMutationTransport();
