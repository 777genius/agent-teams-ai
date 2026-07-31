import {
  type TeamArtifactMaintenanceReconciliationRequest,
  TeamArtifactReconciliationCoordinator,
} from '@features/team-task-board';
import {
  type TaskMutationBoardPort,
  TeamTaskMutationCoordinator,
} from '@features/team-task-board/main';

import {
  type ControllerPersistedMessageRequest,
  type LeadSentMessageRequest,
  type TeamMessageLeadContext,
  TeamMessagePersistenceCoordinator,
  type TeamMessagePersistenceRequest,
  type TeamMessagePersistenceResult,
} from './TeamMessagePersistenceCoordinator';
import { TeamTaskCommentNotificationCoordinator } from './TeamTaskCommentNotificationCoordinator';
import { TeamTaskReadModelService } from './TeamTaskReadModelService';
import { type TeamTaskStartBoardPort, TeamTaskStartCoordinator } from './TeamTaskStartCoordinator';
import { TeamViewReadModelService } from './TeamViewReadModelService';

import type { TeamConfigReader } from './TeamConfigReader';
import type { TeamInboxReader } from './TeamInboxReader';
import type { TeamInboxWriter } from './TeamInboxWriter';
import type { TeamKanbanManager } from './TeamKanbanManager';
import type { TeamMemberResolver } from './TeamMemberResolver';
import type { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import type { TeamMembersMetaStore } from './TeamMembersMetaStore';
import type { TeamMetaStore } from './TeamMetaStore';
import type { TeamSentMessagesStore } from './TeamSentMessagesStore';
import type { TeamTaskCommentNotificationJournal } from './TeamTaskCommentNotificationJournal';
import type { TeamTaskReader } from './TeamTaskReader';
import type { TaskBoardCommandFacade } from '@features/task-board-commands';
import type { TeamLeadSessionMessageReader } from '@features/team-view-read-model/main';
import type {
  InboxMessage,
  SendMessageRequest,
  SendMessageResult,
  TeamConfig,
  TeamProcess,
  TeamSummary,
  TeamTask,
} from '@shared/types';

type TeamLeadSessionParseCache = ReturnType<
  (typeof TeamLeadSessionMessageReader)['createParseCache']
>;

type TeamDataServiceTaskBoard = TaskMutationBoardPort & TeamTaskStartBoardPort;

interface TeamDataServiceFeatureCompositionPorts {
  configReader: TeamConfigReader;
  taskReader: TeamTaskReader;
  inboxReader: TeamInboxReader;
  inboxWriter: TeamInboxWriter;
  memberResolver: TeamMemberResolver;
  kanbanManager: TeamKanbanManager;
  membersMetaStore: TeamMembersMetaStore;
  sentMessagesStore: TeamSentMessagesStore;
  taskCommentNotificationJournal: TeamTaskCommentNotificationJournal;
  teamMetaStore: TeamMetaStore;
  projectResolver: ConstructorParameters<typeof TeamViewReadModelService>[0]['projectResolver'];
  leadSessionParseCache?: TeamLeadSessionParseCache;
  memberBranchConcurrency: number;
  getTaskBoard(teamName: string): TeamDataServiceTaskBoard;
  getTaskBoardCommandFacade(): Pick<TaskBoardCommandFacade, 'createTask'>;
  getMemberRuntimeAdvisoryService(): TeamMemberRuntimeAdvisoryService;
  reconcileArtifacts(
    teamName: string,
    request: TeamArtifactMaintenanceReconciliationRequest
  ): unknown;
  controllerSendMessage(
    teamName: string,
    request: ControllerPersistedMessageRequest
  ): TeamMessagePersistenceResult;
  controllerAppendSentMessage(
    teamName: string,
    request: LeadSentMessageRequest
  ): Pick<InboxMessage, 'messageId'>;
  readSnapshotConfig(teamName: string): Promise<TeamConfig | null>;
  readLaunchSnapshot: ConstructorParameters<
    typeof TeamViewReadModelService
  >[0]['readLaunchSnapshot'];
  readProcesses(teamName: string): Promise<TeamProcess[]>;
  listTeams(): Promise<TeamSummary[]>;
  sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult>;
  sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageResult>;
  invalidateMessageFeed(teamName: string): void;
  invalidateGlobalTaskProjectionCache(): void;
  createMessageId(): string;
  nowMs(): number;
  nowIso(): string;
  resolveGitBranch: ConstructorParameters<typeof TeamViewReadModelService>[0]['resolveGitBranch'];
  selectCurrentActiveTask: ConstructorParameters<
    typeof TeamViewReadModelService
  >[0]['selectCurrentActiveTask'];
  compactTask: ConstructorParameters<typeof TeamViewReadModelService>[0]['compactTask'];
  logDebug(message: string): void;
  logWarning(message: string): void;
}

function toTeamMessageLeadContext(config: TeamConfig | null): TeamMessageLeadContext | null {
  if (!config) return null;
  return {
    members: config.members?.map(({ name, agentType, role }) => ({ name, agentType, role })),
    leadSessionId: config.leadSessionId,
  };
}

function toSendMessageRequest(request: TeamMessagePersistenceRequest): SendMessageRequest {
  return request;
}

function toTeamMessagePersistenceResult(result: SendMessageResult): TeamMessagePersistenceResult {
  return result;
}

/**
 * Internal, policy-free wiring for TeamDataService's feature responsibilities.
 *
 * Runtime and lifecycle owners stay in TeamDataService. Mutable collaborators
 * that can be replaced after construction are always resolved through accessors.
 */
export class TeamDataServiceFeatureComposition {
  readonly artifactReconciliationCoordinator: TeamArtifactReconciliationCoordinator;
  readonly messagePersistenceCoordinator: TeamMessagePersistenceCoordinator;
  readonly taskReadModelService: TeamTaskReadModelService;
  readonly taskMutationCoordinator: TeamTaskMutationCoordinator;
  readonly taskStartCoordinator: TeamTaskStartCoordinator;
  readonly taskCommentNotificationCoordinator: TeamTaskCommentNotificationCoordinator;
  readonly viewReadModelService: TeamViewReadModelService;

  constructor(ports: TeamDataServiceFeatureCompositionPorts) {
    this.artifactReconciliationCoordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: (teamName, request) => ports.reconcileArtifacts(teamName, request),
      },
      clock: {
        nowMs: () => ports.nowMs(),
      },
      logger: {
        warn: (message) => ports.logWarning(message),
      },
    });
    this.messagePersistenceCoordinator = new TeamMessagePersistenceCoordinator({
      leadContext: {
        readLeadContext: async (teamName) =>
          toTeamMessageLeadContext(await ports.readSnapshotConfig(teamName)),
      },
      memberMeta: {
        readMembers: async (teamName) =>
          (await ports.membersMetaStore.getMembers(teamName)).map(({ name, agentType, role }) => ({
            name,
            agentType,
            role,
          })),
      },
      controllerPersistence: {
        sendMessage: (teamName, request) => ports.controllerSendMessage(teamName, request),
        appendSentMessage: (teamName, request) =>
          ports.controllerAppendSentMessage(teamName, request),
      },
      runtimeRecipientInbox: {
        sendMessage: async (teamName, request) =>
          toTeamMessagePersistenceResult(
            await ports.inboxWriter.sendMessage(teamName, toSendMessageRequest(request))
          ),
      },
      messageFeed: {
        invalidate: (teamName) => ports.invalidateMessageFeed(teamName),
      },
      identity: {
        createMessageId: () => ports.createMessageId(),
      },
    });
    this.taskReadModelService = new TeamTaskReadModelService({
      taskReader: ports.taskReader,
      configReader: ports.configReader,
      kanbanReader: ports.kanbanManager,
      readTask: (teamName, taskId) =>
        ports.getTaskBoard(teamName).getTask?.(taskId) as TeamTask | null | undefined,
      invalidateGlobalTaskProjectionCache: () => ports.invalidateGlobalTaskProjectionCache(),
      logDebug: (message) => ports.logDebug(message),
    });
    this.taskMutationCoordinator = new TeamTaskMutationCoordinator({
      taskBoards: {
        getTaskBoard: (teamName) => ports.getTaskBoard(teamName),
      },
      taskProjection: {
        invalidateGlobalTaskProjectionCache: () =>
          this.taskReadModelService.invalidateGlobalTaskProjectionCache(),
      },
      leadContext: {
        resolveLeadRuntimeContext: (teamName) =>
          this.messagePersistenceCoordinator.resolveLeadRuntimeContext(teamName),
      },
      identity: {
        createId: () => ports.createMessageId(),
      },
      clock: {
        nowIso: () => ports.nowIso(),
      },
    });
    this.taskStartCoordinator = new TeamTaskStartCoordinator({
      getTaskBoard: (teamName) => ports.getTaskBoard(teamName),
      readTasks: (teamName) => ports.taskReader.getTasks(teamName),
      readTaskCreateProjectPath: async (teamName) => {
        try {
          const config = await ports.readSnapshotConfig(teamName);
          return config?.projectPath;
        } catch {
          return undefined;
        }
      },
      runCreateTaskCommand: (command) => ports.getTaskBoardCommandFacade().createTask(command),
      invalidateTaskProjection: () =>
        this.taskReadModelService.invalidateGlobalTaskProjectionCache(),
      resolveLeadName: (teamName) => this.messagePersistenceCoordinator.resolveLeadName(teamName),
      sendMessage: (teamName, request) => ports.sendMessage(teamName, request),
      sendRuntimeRecipientMessage: (teamName, request) =>
        ports.sendRuntimeRecipientMessage(teamName, request),
      warn: (message) => ports.logWarning(message),
    });
    this.taskCommentNotificationCoordinator = new TeamTaskCommentNotificationCoordinator({
      listTeams: () => ports.listTeams(),
      readConfig: (teamName) => ports.readSnapshotConfig(teamName),
      resolveLeadName: (config) =>
        this.messagePersistenceCoordinator.resolveLeadNameFromConfig(
          toTeamMessageLeadContext(config)
        ),
      readTasks: (teamName) => ports.taskReader.getTasks(teamName),
      readLeadInboxMessages: (teamName, leadName) =>
        ports.inboxReader.getMessagesFor(teamName, leadName),
      sendMessage: (teamName, request) => ports.inboxWriter.sendMessage(teamName, request),
      journal: ports.taskCommentNotificationJournal,
    });
    this.viewReadModelService = new TeamViewReadModelService({
      readConfig: (teamName) => ports.readSnapshotConfig(teamName),
      readTasks: (teamName) => this.taskReadModelService.readTasksForUiSnapshot(teamName),
      readInboxNames: (teamName) => ports.inboxReader.listInboxNames(teamName),
      readMembersMeta: (teamName) => ports.membersMetaStore.getMembers(teamName),
      readTeamMeta: (teamName) => ports.teamMetaStore.getMeta(teamName),
      readLaunchSnapshot: (teamName) => ports.readLaunchSnapshot(teamName),
      readKanbanState: (teamName) => ports.kanbanManager.getState(teamName),
      startTaskChangePresenceRead: (teamName) =>
        this.taskReadModelService.startTaskChangePresenceRead(teamName),
      projectTaskWithKanban: (task, kanbanTaskState) =>
        this.taskReadModelService.attachKanbanCompatibility(task, kanbanTaskState),
      projectTaskChangePresence: (tasks, presenceIndex, logSourceSnapshot) =>
        this.taskReadModelService.resolveTaskChangePresenceMap(
          tasks,
          true,
          presenceIndex,
          logSourceSnapshot
        ),
      resolveMembers: (config, metaMembers, inboxNames, tasks, options) =>
        ports.memberResolver.resolveMembers(config, metaMembers, inboxNames, tasks, options),
      readMemberRuntimeAdvisories: (teamName, members, observedAfterMs) =>
        ports
          .getMemberRuntimeAdvisoryService()
          .getMemberAdvisories(teamName, members, { observedAfterMs }),
      resolveGitBranch: (cwd) => ports.resolveGitBranch(cwd),
      memberBranchConcurrency: ports.memberBranchConcurrency,
      readProcesses: (teamName) => ports.readProcesses(teamName),
      selectCurrentActiveTask: (tasks) => ports.selectCurrentActiveTask(tasks),
      compactTask: (task) => ports.compactTask(task),
      logDebug: (message) => ports.logDebug(message),
      logWarning: (message) => ports.logWarning(message),
      projectResolver: ports.projectResolver,
      leadSessionParseCache: ports.leadSessionParseCache,
      readInboxMessages: (teamName) => ports.inboxReader.getMessages(teamName),
      readInboxMessagesWindow:
        typeof ports.inboxReader.getMessagesWindow === 'function'
          ? (teamName, options) => ports.inboxReader.getMessagesWindow(teamName, options)
          : undefined,
      readSentMessages: (teamName) => ports.sentMessagesStore.readMessages(teamName),
    });
  }
}
