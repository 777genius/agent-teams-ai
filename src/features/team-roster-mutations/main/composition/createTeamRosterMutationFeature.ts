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
  addMember: Pick<AddTeamRosterMember, 'execute'>;
  replaceMembers: Pick<ReplaceTeamRosterMembers, 'execute'>;
  removeMember: Pick<RemoveTeamRosterMember, 'execute'>;
  restoreMember: Pick<RestoreTeamRosterMember, 'execute'>;
  updateMemberRole: Pick<UpdateTeamRosterMemberRole, 'execute'>;
  replaceMembersWithSettingsRelaunch(
    teamName: string,
    members: RosterMemberInput[],
    intent: unknown
  ): Promise<void>;
  logger: TeamRosterLoggerPort;
}

export function createTeamRosterMutationFeature(dependencies: {
  repository: TeamRosterRepositorySource;
  runtime: { isTeamAlive(teamName: string): boolean };
  lifecycle: TeamRosterLifecycleSource;
  messaging: { sendMessageToTeam(teamName: string, message: string): Promise<void> };
  logger: TeamRosterLoggerPort;
  persistMemberSettingsRelaunch?(
    teamName: string,
    members: RosterMemberInput[],
    intent: unknown
  ): Promise<void>;
  metadata?: TeamRosterMetadataPort;
  cache?: TeamRosterCachePort;
  withWriterAdmission?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
  withWriterWorkflow?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
}): TeamRosterMutationFeature {
  const admitted = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterAdmission?.(teamName, operation) ?? operation();
  const workflow = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterWorkflow?.(teamName, operation) ?? operation();
  const repository: TeamRosterMutationRepositoryPort = {
    getMembers: async (teamName) => {
      const snapshot = await dependencies.repository.getTeamData(teamName);
      return snapshot.members as RuntimeRosterMutationMember[];
    },
    addMember: (teamName, member) =>
      admitted(teamName, () => dependencies.repository.addMember(teamName, member)),
    replaceMembers: (teamName, request) =>
      admitted(teamName, () => dependencies.repository.replaceMembers(teamName, request)),
    removeMember: (teamName, memberName) =>
      admitted(teamName, () => dependencies.repository.removeMember(teamName, memberName)),
    restoreMember: (teamName, memberName) =>
      admitted(teamName, () => dependencies.repository.restoreMember(teamName, memberName)),
    updateMemberRole: (teamName, memberName, role) =>
      admitted(teamName, () =>
        dependencies.repository.updateMemberRole(teamName, memberName, role)
      ),
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
  const metadataStore = dependencies.metadata ?? new TeamRosterMetadataStore();
  const metadata: TeamRosterMetadataPort = {
    getSnapshot: (teamName) => metadataStore.getSnapshot(teamName),
    writeSnapshot: (teamName, snapshot) =>
      admitted(teamName, () => metadataStore.writeSnapshot(teamName, snapshot)),
  };
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
  const addMember = new AddTeamRosterMember(featureDependencies);
  const replaceMembers = new ReplaceTeamRosterMembers(featureDependencies);
  const removeMember = new RemoveTeamRosterMember(featureDependencies);
  const restoreMember = new RestoreTeamRosterMember(featureDependencies);
  const updateMemberRole = new UpdateTeamRosterMemberRole(featureDependencies);

  return {
    addMember: {
      execute: (teamName, member) => workflow(teamName, () => addMember.execute(teamName, member)),
    },
    replaceMembers: {
      execute: (teamName, members) =>
        workflow(teamName, () => replaceMembers.execute(teamName, members)),
    },
    removeMember: {
      execute: (teamName, memberName) =>
        workflow(teamName, () => removeMember.execute(teamName, memberName)),
    },
    restoreMember: {
      execute: (teamName, memberName) =>
        workflow(teamName, () => restoreMember.execute(teamName, memberName)),
    },
    updateMemberRole: {
      execute: (teamName, memberName, role) =>
        workflow(teamName, () => updateMemberRole.execute(teamName, memberName, role)),
    },
    replaceMembersWithSettingsRelaunch: (teamName, members, intent) =>
      workflow(teamName, () =>
        dependencies.lifecycle.runLiveRosterMutation(teamName, () => {
          if (!dependencies.persistMemberSettingsRelaunch) {
            throw new Error('Member settings relaunch persistence is unavailable');
          }
          return admitted(teamName, () =>
            dependencies.persistMemberSettingsRelaunch!(teamName, members, intent)
          );
        })
      ),
    logger: dependencies.logger,
  };
}
