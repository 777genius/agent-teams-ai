import { LiveRosterRollback } from '../../core/application/services/LiveRosterRollback';
import { AddTeamRosterMember } from '../../core/application/use-cases/AddTeamRosterMember';
import { RemoveTeamRosterMember } from '../../core/application/use-cases/RemoveTeamRosterMember';
import { ReplaceTeamRosterMembers } from '../../core/application/use-cases/ReplaceTeamRosterMembers';
import { RestoreTeamRosterMember } from '../../core/application/use-cases/RestoreTeamRosterMember';
import { UpdateTeamRosterMemberRole } from '../../core/application/use-cases/UpdateTeamRosterMemberRole';
import { TeamRosterMetadataStore } from '../adapters/output/TeamRosterMetadataStore';
import { TeamRosterSnapshotCache } from '../adapters/output/TeamRosterSnapshotCache';

import type {
  TeamRosterCachePort,
  TeamRosterLifecyclePort,
  TeamRosterLoggerPort,
  TeamRosterMetadataPort,
  TeamRosterMutationRepositoryPort,
} from '../../core/application/ports/TeamRosterMutationPorts';
import type {
  RosterMemberInput,
  RuntimeRosterMutationMember,
} from '../../core/domain/rosterMutationModels';
import type { TeamRosterSnapshotCacheSource } from '@main/services/team/invalidateTeamRosterSnapshotCaches';

interface TeamRosterRepositorySource extends TeamRosterSnapshotCacheSource {
  getTeamData(teamName: string): Promise<{ members: unknown[] }>;
  addMember(teamName: string, member: RosterMemberInput): Promise<void>;
  replaceMembers(teamName: string, request: { members: RosterMemberInput[] }): Promise<void>;
  removeMember(teamName: string, memberName: string): Promise<void>;
  restoreMember(teamName: string, memberName: string): Promise<unknown>;
  updateMemberRole(
    teamName: string,
    memberName: string,
    role: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }>;
}

interface TeamRosterLifecycleSource {
  runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_restored' | 'member_updated' }
  ): Promise<void>;
  detachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
}

export interface TeamRosterMutationFeature {
  addMember: AddTeamRosterMember;
  replaceMembers: ReplaceTeamRosterMembers;
  removeMember: RemoveTeamRosterMember;
  restoreMember: RestoreTeamRosterMember;
  updateMemberRole: UpdateTeamRosterMemberRole;
  logger: TeamRosterLoggerPort;
}

export function createTeamRosterMutationFeature(dependencies: {
  repository: TeamRosterRepositorySource;
  runtime: { isTeamAlive(teamName: string): boolean };
  lifecycle: TeamRosterLifecycleSource;
  messaging: { sendMessageToTeam(teamName: string, message: string): Promise<void> };
  logger: TeamRosterLoggerPort;
  metadata?: TeamRosterMetadataPort;
  cache?: TeamRosterCachePort;
}): TeamRosterMutationFeature {
  const repository: TeamRosterMutationRepositoryPort = {
    getMembers: async (teamName) => {
      const snapshot = await dependencies.repository.getTeamData(teamName);
      return snapshot.members as RuntimeRosterMutationMember[];
    },
    addMember: (teamName, member) => dependencies.repository.addMember(teamName, member),
    replaceMembers: (teamName, request) =>
      dependencies.repository.replaceMembers(teamName, request),
    removeMember: (teamName, memberName) =>
      dependencies.repository.removeMember(teamName, memberName),
    restoreMember: (teamName, memberName) =>
      dependencies.repository.restoreMember(teamName, memberName),
    updateMemberRole: (teamName, memberName, role) =>
      dependencies.repository.updateMemberRole(teamName, memberName, role),
  };
  const lifecycle: TeamRosterLifecyclePort = {
    runMutation: (teamName, mutation) =>
      dependencies.lifecycle.runLiveRosterMutation(teamName, mutation),
    attach: (teamName, memberName, options) =>
      dependencies.lifecycle.attachLiveRosterMember(teamName, memberName, options),
    detach: (teamName, memberName) =>
      dependencies.lifecycle.detachLiveRosterMember(teamName, memberName),
  };
  const runtime = { isAlive: (teamName: string) => dependencies.runtime.isTeamAlive(teamName) };
  const messaging = {
    notifyLead: (teamName: string, message: string) =>
      dependencies.messaging.sendMessageToTeam(teamName, message),
  };
  const metadata = dependencies.metadata ?? new TeamRosterMetadataStore();
  const cache = dependencies.cache ?? new TeamRosterSnapshotCache(dependencies.repository);
  const rollback = new LiveRosterRollback({
    repository,
    metadata,
    lifecycle,
    cache,
    logger: dependencies.logger,
  });
  const featureDependencies = {
    repository,
    metadata,
    lifecycle,
    runtime,
    messaging,
    cache,
    rollback,
    logger: dependencies.logger,
  };

  return {
    addMember: new AddTeamRosterMember(featureDependencies),
    replaceMembers: new ReplaceTeamRosterMembers(featureDependencies),
    removeMember: new RemoveTeamRosterMember(featureDependencies),
    restoreMember: new RestoreTeamRosterMember(featureDependencies),
    updateMemberRole: new UpdateTeamRosterMemberRole(featureDependencies),
    logger: dependencies.logger,
  };
}
