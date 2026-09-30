import { TeamRosterPersistenceRepository } from '../adapters/output/TeamRosterPersistenceRepository';

import type {
  AddMemberRequest,
  PersistedTeamLaunchSnapshot,
  ReplaceMembersRequest,
  TeamConfig,
  TeamMember,
  TeamProviderId,
} from '@shared/types';

interface TeamRosterPersistenceRepositoryFactoryDependencies {
  members: {
    getMembers(teamName: string): Promise<TeamMember[]>;
    updateMembers(
      teamName: string,
      update: (currentMembers: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
    ): Promise<void>;
  };
  config: {
    getConfig(teamName: string): Promise<TeamConfig | null>;
    persistConfig(teamName: string, config: TeamConfig): Promise<void>;
  };
  inbox: {
    listInboxNames(teamName: string): Promise<string[]>;
  };
  teamMetadata: {
    getMeta(teamName: string): Promise<{
      providerId?: TeamProviderId;
      launchIdentity?: { providerId?: TeamProviderId };
    } | null>;
  };
  launchSnapshots: {
    readBootstrap(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
    readPersisted(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  processes: {
    listProcesses(teamName: string): Promise<{ stoppedAt?: string }[]>;
  };
  now(): number;
}

export interface TeamRosterPersistenceRepositoryPort {
  addMember(teamName: string, request: AddMemberRequest): Promise<void>;
  updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  removeMember(teamName: string, memberName: string): Promise<void>;
  restoreMember(teamName: string, memberName: string): Promise<TeamMember>;
}

export function createTeamRosterPersistenceRepository(
  dependencies: TeamRosterPersistenceRepositoryFactoryDependencies
): TeamRosterPersistenceRepositoryPort {
  return new TeamRosterPersistenceRepository(dependencies);
}
