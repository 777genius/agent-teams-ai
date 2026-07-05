import type { TeamProvisioningLaunchExpectedMembersPorts } from './TeamProvisioningLaunchExpectedMembers';
import type { TeamMember } from '@shared/types';

export interface TeamProvisioningLaunchExpectedMembersPortsFactoryDeps {
  launchStateStore: {
    read(teamName: string): Promise<unknown>;
  };
  readBootstrapLaunchSnapshot(teamName: string): Promise<unknown>;
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
  };
  inboxReader: {
    listInboxNames(teamName: string): Promise<string[]>;
  };
  logger: {
    warn(message: string): void;
  };
}

export function createTeamProvisioningLaunchExpectedMembersPorts(
  deps: TeamProvisioningLaunchExpectedMembersPortsFactoryDeps
): TeamProvisioningLaunchExpectedMembersPorts {
  return {
    readLaunchState: (teamName) => deps.launchStateStore.read(teamName),
    readBootstrapLaunchSnapshot: (teamName) => deps.readBootstrapLaunchSnapshot(teamName),
    getMembers: (teamName) => deps.membersMetaStore.getMembers(teamName),
    listInboxNames: (teamName) => deps.inboxReader.listInboxNames(teamName),
    warn: (message) => deps.logger.warn(message),
  };
}
