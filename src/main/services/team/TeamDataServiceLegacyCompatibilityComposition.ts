import { TaskBoardCommandFacade } from '@features/task-board-commands';
import {
  createTeamMessagePersistenceFacade,
  type TeamMessagePersistenceFacade,
} from '@features/team-message-delivery/main';
import { createTeamRosterPersistenceRepository } from '@features/team-roster-mutations/main';
import { createApplicationCommandHasher } from '@main/composition/applicationCommandLedgerComposition';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamDataConfigurationCompatibilityService } from './TeamDataConfigurationCompatibilityService';
import {
  TeamDataControllerCompatibilityAdapter,
  type TeamDataControllerFactory,
} from './TeamDataControllerCompatibilityAdapter';
import { TeamDataLegacyTaskBoardAdapter } from './TeamDataLegacyTaskBoardAdapter';
import { TeamDataProcessCompatibilityAdapter } from './TeamDataProcessCompatibilityAdapter';
import { TeamDataProcessCompatibilityService } from './TeamDataProcessCompatibilityService';
import { TeamDataServiceFeatureComposition } from './TeamDataServiceFeatureComposition';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { selectCurrentActiveTeamTask } from './teamTaskActiveState';
import { TeamTaskCommentNotificationJournal } from './TeamTaskCommentNotificationJournal';
import { TeamTaskReader } from './TeamTaskReader';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type { TeamTaskCommentNotificationCoordinator } from './TeamTaskCommentNotificationCoordinator';
import type { TeamTaskReadModelService } from './TeamTaskReadModelService';
import type { TeamViewReadModelService } from './TeamViewReadModelService';
import type { TeamRosterPersistenceRepositoryPort } from '@features/team-roster-mutations/main';
import type { TeamArtifactReconciliationCoordinator } from '@features/team-task-board';
import type {
  TeamTaskMutationCoordinator,
  TeamTaskStartCoordinator,
} from '@features/team-task-board/main';
import type { TeamLeadSessionMessageReader } from '@features/team-view-read-model/main';

type TeamLeadSessionParseCache = ReturnType<
  (typeof TeamLeadSessionMessageReader)['createParseCache']
>;

const logger = createLogger('Service:TeamDataService');

function createNonDurableTaskBoardCommandFacade(): TaskBoardCommandFacade {
  const hasher = createApplicationCommandHasher();
  return new TaskBoardCommandFacade(null, {
    hashPayload: (payload) => hasher.hashJson(payload),
  });
}

function toTeamMessageLeadContext(
  config: {
    members?: Array<{ name: string; agentType?: string; role?: string }>;
    leadSessionId?: string;
  } | null
) {
  if (!config) return null;
  return {
    members: config.members?.map(({ name, agentType, role }) => ({ name, agentType, role })),
    leadSessionId: config.leadSessionId,
  };
}

export interface TeamDataServiceLegacyCompatibilityCompositionDependencies {
  configReader?: TeamConfigReader;
  taskReader?: TeamTaskReader;
  inboxReader?: TeamInboxReader;
  inboxWriter?: TeamInboxWriter;
  memberResolver?: TeamMemberResolver;
  kanbanManager?: TeamKanbanManager;
  membersMetaStore?: TeamMembersMetaStore;
  sentMessagesStore?: TeamSentMessagesStore;
  controllerFactory?: TeamDataControllerFactory;
  taskCommentNotificationJournal?: TeamTaskCommentNotificationJournal;
  teamMetaStore?: TeamMetaStore;
  memberRuntimeAdvisoryService?: TeamMemberRuntimeAdvisoryService;
  leadSessionParseCache?: TeamLeadSessionParseCache;
  projectResolver?: TeamTranscriptProjectResolver;
  launchStateStore?: TeamLaunchStateStore;
}

/**
 * Wires the retained desktop compatibility collaborators around feature-owned
 * task, roster, message, and read-model responsibilities.
 */
export class TeamDataServiceLegacyCompatibilityComposition {
  readonly artifactReconciliationCoordinator: TeamArtifactReconciliationCoordinator;
  readonly configurationCompatibilityService: TeamDataConfigurationCompatibilityService;
  readonly messagePersistence: TeamMessagePersistenceFacade;
  readonly processCompatibilityService: TeamDataProcessCompatibilityService;
  readonly rosterPersistenceRepository: TeamRosterPersistenceRepositoryPort;
  readonly taskCommentNotificationCoordinator: TeamTaskCommentNotificationCoordinator;
  readonly taskMutationCoordinator: TeamTaskMutationCoordinator;
  readonly taskReadModelService: TeamTaskReadModelService;
  readonly taskStartCoordinator: TeamTaskStartCoordinator;
  readonly viewReadModelService: TeamViewReadModelService;

  private readonly taskCommentNotificationJournal: TeamTaskCommentNotificationJournal;
  private taskBoardCommandFacade = createNonDurableTaskBoardCommandFacade();
  private memberRuntimeAdvisoryService: TeamMemberRuntimeAdvisoryService;

  constructor(dependencies: TeamDataServiceLegacyCompatibilityCompositionDependencies = {}) {
    const configReader = dependencies.configReader ?? new TeamConfigReader();
    const taskReader = dependencies.taskReader ?? new TeamTaskReader();
    const inboxReader = dependencies.inboxReader ?? new TeamInboxReader();
    const inboxWriter = dependencies.inboxWriter ?? new TeamInboxWriter();
    const memberResolver = dependencies.memberResolver ?? new TeamMemberResolver();
    const kanbanManager = dependencies.kanbanManager ?? new TeamKanbanManager();
    const membersMetaStore = dependencies.membersMetaStore ?? new TeamMembersMetaStore();
    const sentMessagesStore = dependencies.sentMessagesStore ?? new TeamSentMessagesStore();
    const teamMetaStore = dependencies.teamMetaStore ?? new TeamMetaStore();
    const launchStateStore = dependencies.launchStateStore ?? new TeamLaunchStateStore();

    this.taskCommentNotificationJournal =
      dependencies.taskCommentNotificationJournal ?? new TeamTaskCommentNotificationJournal();
    this.memberRuntimeAdvisoryService =
      dependencies.memberRuntimeAdvisoryService ?? new TeamMemberRuntimeAdvisoryService();
    this.configurationCompatibilityService = new TeamDataConfigurationCompatibilityService(
      configReader,
      membersMetaStore,
      teamMetaStore,
      (teamName) => this.viewReadModelService.invalidateNotificationContext(teamName),
      () => this.taskReadModelService.invalidateGlobalTaskProjectionCache()
    );

    const projectResolver =
      dependencies.projectResolver ??
      this.configurationCompatibilityService.createUiSnapshotProjectResolver();
    const controllerCapabilities = new TeamDataControllerCompatibilityAdapter(
      dependencies.controllerFactory
    );
    const taskBoards = new TeamDataLegacyTaskBoardAdapter(controllerCapabilities.taskBoard);
    this.processCompatibilityService = new TeamDataProcessCompatibilityService(
      new TeamDataProcessCompatibilityAdapter(controllerCapabilities.processes, () =>
        this.configurationCompatibilityService.listTeams()
      )
    );
    this.rosterPersistenceRepository = createTeamRosterPersistenceRepository({
      members: membersMetaStore,
      config: configReader,
      inbox: inboxReader,
      teamMetadata: teamMetaStore,
      launchSnapshots: {
        readBootstrap: (teamName) => readBootstrapLaunchSnapshot(teamName),
        readPersisted: (teamName) => launchStateStore.read(teamName),
      },
      processes: {
        listProcesses: (teamName) => this.processCompatibilityService.readProcesses(teamName),
      },
      now: () => Date.now(),
    });
    this.messagePersistence = createTeamMessagePersistenceFacade({
      leadContext: {
        readLeadContext: async (teamName) =>
          toTeamMessageLeadContext(
            await this.configurationCompatibilityService.readConfigForUiSnapshot(teamName)
          ),
      },
      memberMeta: {
        readMembers: async (teamName) =>
          (await membersMetaStore.getMembers(teamName)).map(({ name, agentType, role }) => ({
            name,
            agentType,
            role,
          })),
      },
      controllerPersistence: {
        sendMessage: (teamName, request) =>
          controllerCapabilities.messagePersistence.sendMessage(
            teamName,
            request as unknown as Record<string, unknown>
          ),
        appendSentMessage: (teamName, request) =>
          controllerCapabilities.messagePersistence.appendSentMessage(
            teamName,
            request as unknown as Record<string, unknown>
          ),
      },
      runtimeRecipientInbox: {
        sendMessage: (teamName, request) => inboxWriter.sendMessage(teamName, request),
      },
      messageFeed: {
        invalidate: (teamName) => this.viewReadModelService.invalidateMessageFeed(teamName),
      },
      identity: {
        createMessageId: () => randomUUID(),
      },
    });

    const features = new TeamDataServiceFeatureComposition({
      configReader,
      taskReader,
      inboxReader,
      inboxWriter,
      memberResolver,
      kanbanManager,
      membersMetaStore,
      sentMessagesStore,
      taskCommentNotificationJournal: this.taskCommentNotificationJournal,
      teamMetaStore,
      projectResolver,
      leadSessionParseCache: dependencies.leadSessionParseCache,
      memberBranchConcurrency: process.platform === 'win32' ? 4 : 8,
      getTaskBoard: (teamName) => taskBoards.getTaskBoard(teamName),
      getTaskBoardCommandFacade: () => this.taskBoardCommandFacade,
      getMemberRuntimeAdvisoryService: () => this.memberRuntimeAdvisoryService,
      reconcileArtifacts: (teamName, request) =>
        controllerCapabilities.artifactMaintenance.reconcileArtifacts(teamName, request),
      messagePersistence: this.messagePersistence,
      readSnapshotConfig: (teamName) =>
        this.configurationCompatibilityService.readConfigForUiSnapshot(teamName),
      readLaunchSnapshot: async (teamName) => {
        const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
          readBootstrapLaunchSnapshot(teamName),
          launchStateStore.read(teamName),
        ]);
        return choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
      },
      readProcesses: (teamName) => this.processCompatibilityService.readProcesses(teamName),
      listTeams: () => this.configurationCompatibilityService.listTeams(),
      resolveLeadNameFromConfig: (config) =>
        this.messagePersistence.resolveLeadNameFromConfig(toTeamMessageLeadContext(config)),
      invalidateGlobalTaskProjectionCache: () => TeamTaskReader.invalidateAllTasksCache(),
      createMessageId: () => randomUUID(),
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      resolveGitBranch: (cwd) => gitIdentityResolver.getBranch(path.normalize(cwd)),
      selectCurrentActiveTask: (tasks) => selectCurrentActiveTeamTask(tasks),
      compactTask: (task) => compactTeamTaskForSnapshot(task),
      logDebug: (message) => logger.debug(message),
      logWarning: (message) => logger.warn(message),
    });

    this.artifactReconciliationCoordinator = features.artifactReconciliationCoordinator;
    this.taskCommentNotificationCoordinator = features.taskCommentNotificationCoordinator;
    this.taskMutationCoordinator = features.taskMutationCoordinator;
    this.taskReadModelService = features.taskReadModelService;
    this.taskStartCoordinator = features.taskStartCoordinator;
    this.viewReadModelService = features.viewReadModelService;
  }

  setMemberRuntimeAdvisoryService(service: TeamMemberRuntimeAdvisoryService): void {
    this.memberRuntimeAdvisoryService = service;
  }

  setTaskBoardCommandFacade(facade: TaskBoardCommandFacade | null): void {
    this.taskBoardCommandFacade = facade ?? createNonDurableTaskBoardCommandFacade();
  }

  setTaskCommentNotificationJournalStore(
    store: Parameters<TeamTaskCommentNotificationJournal['setStore']>[0]
  ): void {
    this.taskCommentNotificationJournal.setStore(store);
  }

  invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void {
    this.memberRuntimeAdvisoryService.invalidateMemberAdvisory(teamName, memberName);
  }

  invalidateTeamRuntimeAdvisories(teamName: string): void {
    this.memberRuntimeAdvisoryService.invalidateTeamAdvisories(teamName);
  }
}
