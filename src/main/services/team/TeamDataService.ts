import { TaskBoardCommandFacade } from '@features/task-board-commands';
import {
  createTeamMessagePersistenceFacade,
  type TeamMessagePersistenceFacade,
} from '@features/team-message-delivery/main';
import { createTeamRosterPersistenceRepository } from '@features/team-roster-mutations/main';
import { createApplicationCommandHasher } from '@main/composition/applicationCommandLedgerComposition';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamDataConfigurationCompatibilityService } from './TeamDataConfigurationCompatibilityService';
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
import { TeamTaskWriter } from './TeamTaskWriter';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { PermanentTeamDataDeletionOptions } from './permanentTeamDataDeletion';
import type { TaskCommentNotificationJournalStore } from './TaskCommentNotificationJournalStore';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamNotificationContext } from './TeamViewReadModelService';
import type { TeamRosterPersistenceRepositoryPort } from '@features/team-roster-mutations/main';
import type { TeamArtifactReconciliationTrigger } from '@features/team-task-board';
import type { TeamLeadSessionMessageReader } from '@features/team-view-read-model/main';
import type {
  AddMemberRequest,
  AttachmentMeta,
  CreateTaskRequest,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  MessagesPage,
  ReplaceMembersRequest,
  SendMessageRequest,
  SendMessageResult,
  TaskAttachmentMeta,
  TaskChangePresenceState,
  TaskComment,
  TaskRef,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamGetDataOptions,
  TeamMember,
  TeamMemberActivityMeta,
  TeamProcess,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamTaskWithKanban,
  TeamViewSnapshot,
  UpdateKanbanPatch,
} from '@shared/types';
import type { AgentTeamsController } from 'agent-teams-controller';

const { createController } = agentTeamsControllerModule;

const logger = createLogger('Service:TeamDataService');

function createNonDurableTaskBoardCommandFacade(): TaskBoardCommandFacade {
  const hasher = createApplicationCommandHasher();
  return new TaskBoardCommandFacade(null, {
    hashPayload: (payload) => hasher.hashJson(payload),
  });
}

function toTeamMessageLeadContext(config: TeamConfig | null) {
  if (!config) return null;
  return {
    members: config.members?.map(({ name, agentType, role }) => ({ name, agentType, role })),
    leadSessionId: config.leadSessionId,
  };
}

type RuntimeAgentTeamsController = Omit<
  AgentTeamsController,
  'tasks' | 'kanban' | 'review' | 'taskBoard'
> & {
  tasks?: Partial<AgentTeamsController['tasks']>;
  kanban?: Partial<AgentTeamsController['kanban']>;
  review?: Partial<AgentTeamsController['review']>;
  taskBoard?: AgentTeamsController['taskBoard'];
};

type TeamLeadSessionParseCache = ReturnType<
  (typeof TeamLeadSessionMessageReader)['createParseCache']
>;

export class TeamDataService {
  readonly messagePersistence: TeamMessagePersistenceFacade;
  private readonly features: TeamDataServiceFeatureComposition;
  private readonly configurationCompatibilityService: TeamDataConfigurationCompatibilityService;
  private readonly processCompatibilityService: TeamDataProcessCompatibilityService;
  private readonly projectResolver: TeamTranscriptProjectResolver;
  private readonly rosterPersistenceRepository: TeamRosterPersistenceRepositoryPort;
  private taskBoardCommandFacade = createNonDurableTaskBoardCommandFacade();

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    _taskWriter: TeamTaskWriter = new TeamTaskWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    _legacyToolsInstaller: unknown = null,
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly controllerFactory: (teamName: string) => AgentTeamsController = (teamName) =>
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }),
    private readonly taskCommentNotificationJournal: TeamTaskCommentNotificationJournal = new TeamTaskCommentNotificationJournal(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private memberRuntimeAdvisoryService: TeamMemberRuntimeAdvisoryService = new TeamMemberRuntimeAdvisoryService(),
    private readonly leadSessionParseCache?: TeamLeadSessionParseCache,
    projectResolver?: TeamTranscriptProjectResolver,
    private readonly launchStateStore: TeamLaunchStateStore = new TeamLaunchStateStore()
  ) {
    this.configurationCompatibilityService = new TeamDataConfigurationCompatibilityService(
      this.configReader,
      this.membersMetaStore,
      this.teamMetaStore,
      (teamName) => this.invalidateNotificationContext(teamName),
      () => this.features.taskReadModelService.invalidateGlobalTaskProjectionCache()
    );
    this.projectResolver =
      projectResolver ?? this.configurationCompatibilityService.createUiSnapshotProjectResolver();
    this.processCompatibilityService = new TeamDataProcessCompatibilityService({
      listTeams: () => this.configurationCompatibilityService.listTeams(),
      listProcesses: (teamName) =>
        this.getController(teamName).processes.listProcesses() as TeamProcess[],
      stopProcess: (teamName, pid) => {
        this.getController(teamName).processes.stopProcess({ pid });
      },
      killProcessByPid,
    });
    this.rosterPersistenceRepository = createTeamRosterPersistenceRepository({
      members: this.membersMetaStore,
      config: this.configReader,
      inbox: this.inboxReader,
      teamMetadata: this.teamMetaStore,
      launchSnapshots: {
        readBootstrap: (teamName) => readBootstrapLaunchSnapshot(teamName),
        readPersisted: (teamName) => this.launchStateStore.read(teamName),
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
          (await this.membersMetaStore.getMembers(teamName)).map(({ name, agentType, role }) => ({
            name,
            agentType,
            role,
          })),
      },
      controllerPersistence: {
        sendMessage: (teamName, request) =>
          this.getController(teamName).messages.sendMessage(
            request as unknown as Record<string, unknown>
          ) as SendMessageResult,
        appendSentMessage: (teamName, request) =>
          this.getController(teamName).messages.appendSentMessage(
            request as unknown as Record<string, unknown>
          ) as InboxMessage,
      },
      runtimeRecipientInbox: {
        sendMessage: (teamName, request) => this.inboxWriter.sendMessage(teamName, request),
      },
      messageFeed: {
        invalidate: (teamName) => this.invalidateMessageFeed(teamName),
      },
      identity: {
        createMessageId: () => randomUUID(),
      },
    });
    this.features = new TeamDataServiceFeatureComposition({
      configReader: this.configReader,
      taskReader: this.taskReader,
      inboxReader: this.inboxReader,
      inboxWriter: this.inboxWriter,
      memberResolver: this.memberResolver,
      kanbanManager: this.kanbanManager,
      membersMetaStore: this.membersMetaStore,
      sentMessagesStore: this.sentMessagesStore,
      taskCommentNotificationJournal: this.taskCommentNotificationJournal,
      teamMetaStore: this.teamMetaStore,
      projectResolver: this.projectResolver,
      leadSessionParseCache: this.leadSessionParseCache,
      memberBranchConcurrency: process.platform === 'win32' ? 4 : 8,
      getTaskBoard: (teamName) => this.getTaskBoard(teamName),
      getTaskBoardCommandFacade: () => this.taskBoardCommandFacade,
      getMemberRuntimeAdvisoryService: () => this.memberRuntimeAdvisoryService,
      reconcileArtifacts: (teamName, request) =>
        this.getController(teamName).maintenance.reconcileArtifacts({ reason: request.reason }),
      messagePersistence: this.messagePersistence,
      readSnapshotConfig: (teamName) =>
        this.configurationCompatibilityService.readConfigForUiSnapshot(teamName),
      readLaunchSnapshot: async (teamName) => {
        const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
          readBootstrapLaunchSnapshot(teamName),
          this.launchStateStore.read(teamName),
        ]);
        return choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
      },
      readProcesses: (teamName) => this.processCompatibilityService.readProcesses(teamName),
      listTeams: () => this.listTeams(),
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
  }

  private get viewReadModelService() {
    return this.features.viewReadModelService;
  }

  /**
   * Legacy facade policy alias. The compatibility service remains the sole owner of
   * process-health tracking state and polling behavior.
   */
  private get processHealthTeams(): TeamDataProcessCompatibilityService {
    return this.processCompatibilityService;
  }

  private invalidateNotificationContext(teamName: string): void {
    this.viewReadModelService.invalidateNotificationContext(teamName);
  }

  private get mutations() {
    return this.features.taskMutationCoordinator;
  }

  private getController(teamName: string): AgentTeamsController {
    return this.controllerFactory(teamName);
  }

  private getTaskBoard(teamName: string): AgentTeamsController['taskBoard'] {
    const controller = this.getController(teamName) as RuntimeAgentTeamsController;
    const taskBoard = controller.taskBoard ?? this.buildLegacyTaskBoard(controller);
    if (!taskBoard) {
      throw new Error('Agent teams controller taskBoard API is unavailable');
    }
    return taskBoard;
  }

  private buildLegacyTaskBoard(
    controller: RuntimeAgentTeamsController
  ): AgentTeamsController['taskBoard'] | null {
    if (!controller.tasks && !controller.kanban && !controller.review) {
      return null;
    }
    return {
      ...(controller.tasks ?? {}),
      ...(controller.kanban ?? {}),
      ...(controller.review ?? {}),
    } as AgentTeamsController['taskBoard'];
  }

  setMemberRuntimeAdvisoryService(service: TeamMemberRuntimeAdvisoryService): void {
    this.memberRuntimeAdvisoryService = service;
  }

  setTaskBoardCommandFacade(facade: TaskBoardCommandFacade | null): void {
    this.taskBoardCommandFacade = facade ?? createNonDurableTaskBoardCommandFacade();
  }

  /** Composition-time backend swap; must run before notification processing starts. */
  setTaskCommentNotificationJournalStore(store: TaskCommentNotificationJournalStore): void {
    this.taskCommentNotificationJournal.setStore(store);
  }

  invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void {
    this.memberRuntimeAdvisoryService.invalidateMemberAdvisory(teamName, memberName);
  }

  invalidateTeamRuntimeAdvisories(teamName: string): void {
    this.memberRuntimeAdvisoryService.invalidateTeamAdvisories(teamName);
  }

  async getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null> {
    return this.features.taskReadModelService.getTask(teamName, taskId);
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.features.taskReadModelService.setTaskChangePresenceServices(repository, tracker);
  }

  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
    this.features.taskReadModelService.setTaskChangePresenceTracking(teamName, enabled);
  }

  async getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>> {
    return this.features.taskReadModelService.getTaskChangePresence(teamName);
  }

  async listTeams(): Promise<TeamSummary[]> {
    return this.configurationCompatibilityService.listTeams();
  }

  async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
    return this.configurationCompatibilityService.getSavedRequest(teamName);
  }

  async listAliveProcessTeams(): Promise<string[]> {
    return this.processCompatibilityService.listAliveProcessTeams();
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    return this.features.taskReadModelService.getAllTasks();
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    return this.configurationCompatibilityService.updateConfig(teamName, updates);
  }

  async deleteTeam(teamName: string): Promise<void> {
    return this.configurationCompatibilityService.deleteTeam(teamName);
  }

  async restoreTeam(teamName: string): Promise<void> {
    return this.configurationCompatibilityService.restoreTeam(teamName);
  }

  async permanentlyDeleteTeam(teamName: string): Promise<void>;
  async permanentlyDeleteTeam(
    teamName: string,
    isTeamDataCurrent: (detachedPath?: string) => Promise<boolean>,
    isTaskDataCurrent?: (detachedPath?: string) => Promise<boolean>,
    options?: PermanentTeamDataDeletionOptions
  ): Promise<boolean>;
  async permanentlyDeleteTeam(
    teamName: string,
    isTeamDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    isTaskDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    options: PermanentTeamDataDeletionOptions = {}
  ): Promise<boolean | void> {
    return this.configurationCompatibilityService.permanentlyDeleteTeam(
      teamName,
      isTeamDataCurrent,
      isTaskDataCurrent,
      options
    );
  }

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const snapshot = await this.viewReadModelService.getTeamData(teamName, options);
    this.processHealthTeams.observeTeamAlive(teamName, snapshot.isAlive === true);
    return snapshot;
  }

  async getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number; liveMessages?: InboxMessage[] }
  ): Promise<MessagesPage> {
    return this.viewReadModelService.getMessagesPage(teamName, options);
  }

  async getMessageFeed(
    teamName: string
  ): Promise<{ teamName: string; feedRevision: string; messages: InboxMessage[] }> {
    return this.viewReadModelService.getMessageFeed(teamName);
  }

  async getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    return this.viewReadModelService.getMemberActivityMeta(teamName);
  }

  invalidateMessageFeed(teamName: string): void {
    this.viewReadModelService.invalidateMessageFeed(teamName);
  }

  startProcessHealthPolling(): void {
    this.processCompatibilityService.startProcessHealthPolling();
  }

  stopProcessHealthPolling(): void {
    this.processCompatibilityService.stopProcessHealthPolling();
  }

  trackProcessHealthForTeam(teamName: string): void {
    this.processCompatibilityService.trackProcessHealthForTeam(teamName);
  }

  untrackProcessHealthForTeam(teamName: string): void {
    this.processCompatibilityService.untrackProcessHealthForTeam(teamName);
  }

  async killProcess(teamName: string, pid: number): Promise<void> {
    return this.processCompatibilityService.killProcess(teamName, pid);
  }

  async addMember(teamName: string, request: AddMemberRequest): Promise<void> {
    return this.rosterPersistenceRepository.addMember(teamName, request);
  }

  async updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }> {
    return this.rosterPersistenceRepository.updateMemberRole(teamName, memberName, newRole);
  }

  async replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void> {
    return this.rosterPersistenceRepository.replaceMembers(teamName, request);
  }

  async removeMember(teamName: string, memberName: string): Promise<void> {
    return this.rosterPersistenceRepository.removeMember(teamName, memberName);
  }

  async restoreMember(teamName: string, memberName: string): Promise<TeamMember> {
    return this.rosterPersistenceRepository.restoreMember(teamName, memberName);
  }

  async createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask> {
    return this.features.taskStartCoordinator.createTask(teamName, request);
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.features.taskStartCoordinator.startTask(teamName, taskId);
  }

  /**
   * Start a task triggered by the user via UI.
   * Unlike startTask(), this always notifies the owner (including the lead in solo teams).
   */
  async startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.features.taskStartCoordinator.startTaskByUser(teamName, taskId);
  }

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string
  ): Promise<void> {
    return this.mutations.updateTaskStatus(teamName, taskId, status, actor);
  }

  /**
   * Called when a task file changes on disk (e.g. teammate CLI wrote it).
   * If the latest historyEvents entry shows a non-user actor started the task,
   * sends an inbox notification to the team lead.
   */
  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    await this.features.taskStartCoordinator.notifyLeadOnTeammateTaskStart(teamName, taskId);
  }

  async notifyLeadOnTeammateTaskComment(teamName: string, taskId: string): Promise<void> {
    try {
      await this.features.taskCommentNotificationCoordinator.notifyLeadOnTeammateTaskComment(
        teamName,
        taskId
      );
    } catch (error) {
      logger.warn(`[TeamDataService] notifyLeadOnTeammateTaskComment failed: ${String(error)}`);
    }
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    return this.mutations.softDeleteTask(teamName, taskId);
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    return this.mutations.restoreTask(teamName, taskId);
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.features.taskReadModelService.getDeletedTasks(teamName);
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    return this.mutations.updateTaskOwner(teamName, taskId, owner);
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    return this.mutations.updateTaskFields(teamName, taskId, fields);
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: TaskAttachmentMeta
  ): Promise<void> {
    return this.mutations.addTaskAttachment(teamName, taskId, meta);
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    return this.mutations.removeTaskAttachment(teamName, taskId, attachmentId);
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    return this.mutations.setTaskNeedsClarification(teamName, taskId, value);
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    return this.mutations.addTaskRelationship(teamName, taskId, targetId, type);
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    return this.mutations.removeTaskRelationship(teamName, taskId, targetId, type);
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    return this.mutations.addTaskComment(teamName, taskId, text, attachments, taskRefs);
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return this.messagePersistence.sendMessage(teamName, request);
  }

  async sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageResult> {
    return this.messagePersistence.sendRuntimeRecipientMessage(teamName, request);
  }

  async sendSystemNotificationToLead(args: {
    teamName: string;
    summary: string;
    text: string;
    taskRefs?: TaskRef[];
  }): Promise<SendMessageResult> {
    return this.messagePersistence.sendSystemNotificationToLead(args, (teamName, request) =>
      this.sendMessage(teamName, request)
    );
  }

  async initializeTaskCommentNotificationState(): Promise<void> {
    await this.features.taskCommentNotificationCoordinator.initializeTaskCommentNotificationState();
  }

  async sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string
  ): Promise<SendMessageResult> {
    return this.messagePersistence.sendDirectToLead(
      teamName,
      leadName,
      text,
      summary,
      attachments,
      taskRefs,
      messageId
    );
  }

  async getLeadMemberName(teamName: string): Promise<string | null> {
    return this.messagePersistence.getLeadMemberName(teamName);
  }

  async getTeamDisplayName(teamName: string): Promise<string> {
    return this.viewReadModelService.getTeamDisplayName(teamName);
  }

  async getTeamNotificationContext(teamName: string): Promise<TeamNotificationContext> {
    return this.viewReadModelService.getTeamNotificationContext(teamName);
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    return this.mutations.requestReview(teamName, taskId);
  }

  async createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
    return this.configurationCompatibilityService.createTeamConfig(request);
  }

  async reconcileTeamArtifacts(
    teamName: string,
    trigger?: TeamArtifactReconciliationTrigger
  ): Promise<void> {
    return this.features.artifactReconciliationCoordinator.reconcile(teamName, trigger);
  }

  async updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    return this.mutations.updateKanban(teamName, taskId, patch);
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    return this.mutations.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
  }
}
