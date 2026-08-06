import { createLogger } from '@shared/utils/logger';

import {
  TeamDataServiceLegacyCompatibilityComposition,
  type TeamDataServiceLegacyCompatibilityCompositionDependencies,
} from './TeamDataServiceLegacyCompatibilityComposition';

import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { PermanentTeamDataDeletionOptions } from './permanentTeamDataDeletion';
import type { TaskCommentNotificationJournalStore } from './TaskCommentNotificationJournalStore';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import type { TeamNotificationContext } from './TeamViewReadModelService';
import type { TaskBoardCommandFacade } from '@features/task-board-commands';
import type { TeamMessagePersistenceFacade } from '@features/team-message-delivery/main';
import type { TeamArtifactReconciliationTrigger } from '@features/team-task-board';
import type * as Team from '@shared/types';

type LegacyDependencies = TeamDataServiceLegacyCompatibilityCompositionDependencies;

const logger = createLogger('Service:TeamDataService');

export class TeamDataService {
  readonly messagePersistence: TeamMessagePersistenceFacade;
  private readonly legacy: TeamDataServiceLegacyCompatibilityComposition;

  private readonly processCompatibilityService: TeamDataServiceLegacyCompatibilityComposition['processCompatibilityService'];
  private readonly viewReadModelService: TeamDataServiceLegacyCompatibilityComposition['viewReadModelService'];

  constructor(
    configReader?: LegacyDependencies['configReader'],
    taskReader?: LegacyDependencies['taskReader'],
    inboxReader?: LegacyDependencies['inboxReader'],
    inboxWriter?: LegacyDependencies['inboxWriter'],
    _taskWriter?: unknown,
    memberResolver?: LegacyDependencies['memberResolver'],
    kanbanManager?: LegacyDependencies['kanbanManager'],
    _legacyToolsInstaller?: unknown,
    membersMetaStore?: LegacyDependencies['membersMetaStore'],
    sentMessagesStore?: LegacyDependencies['sentMessagesStore'],
    controllerFactory?: LegacyDependencies['controllerFactory'],
    taskCommentNotificationJournal?: LegacyDependencies['taskCommentNotificationJournal'],
    teamMetaStore?: LegacyDependencies['teamMetaStore'],
    memberRuntimeAdvisoryService?: TeamMemberRuntimeAdvisoryService,
    leadSessionParseCache?: LegacyDependencies['leadSessionParseCache'],
    projectResolver?: LegacyDependencies['projectResolver'],
    launchStateStore?: LegacyDependencies['launchStateStore']
  ) {
    this.legacy = new TeamDataServiceLegacyCompatibilityComposition({
      configReader,
      taskReader,
      inboxReader,
      inboxWriter,
      memberResolver,
      kanbanManager,
      membersMetaStore,
      sentMessagesStore,
      controllerFactory,
      taskCommentNotificationJournal,
      teamMetaStore,
      memberRuntimeAdvisoryService,
      leadSessionParseCache,
      projectResolver,
      launchStateStore,
    });
    this.messagePersistence = this.legacy.messagePersistence;
    this.processCompatibilityService = this.legacy.processCompatibilityService;
    this.viewReadModelService = this.legacy.viewReadModelService;
  }

  private get mutations() {
    return this.legacy.taskMutationCoordinator;
  }

  setMemberRuntimeAdvisoryService(service: TeamMemberRuntimeAdvisoryService): void {
    this.legacy.setMemberRuntimeAdvisoryService(service);
  }

  setTaskBoardCommandFacade(facade: TaskBoardCommandFacade | null): void {
    this.legacy.setTaskBoardCommandFacade(facade);
  }

  setTaskCommentNotificationJournalStore(store: TaskCommentNotificationJournalStore): void {
    this.legacy.setTaskCommentNotificationJournalStore(store);
  }

  invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void {
    this.legacy.invalidateMemberRuntimeAdvisory(teamName, memberName);
  }

  invalidateTeamRuntimeAdvisories(teamName: string): void {
    this.legacy.invalidateTeamRuntimeAdvisories(teamName);
  }

  async getTask(teamName: string, taskId: string): Promise<Team.TeamTaskWithKanban | null> {
    return this.legacy.taskReadModelService.getTask(teamName, taskId);
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.legacy.taskReadModelService.setTaskChangePresenceServices(repository, tracker);
  }

  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
    this.legacy.taskReadModelService.setTaskChangePresenceTracking(teamName, enabled);
  }

  async getTaskChangePresence(
    teamName: string
  ): Promise<Record<string, Team.TaskChangePresenceState>> {
    return this.legacy.taskReadModelService.getTaskChangePresence(teamName);
  }

  async listTeams(): Promise<Team.TeamSummary[]> {
    return this.legacy.configurationCompatibilityService.listTeams();
  }

  async getSavedRequest(teamName: string): Promise<Team.TeamCreateRequest | null> {
    return this.legacy.configurationCompatibilityService.getSavedRequest(teamName);
  }

  async listAliveProcessTeams(): Promise<string[]> {
    return this.processCompatibilityService.listAliveProcessTeams();
  }

  async getAllTasks(): Promise<Team.GlobalTask[]> {
    return this.legacy.taskReadModelService.getAllTasks();
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<Team.TeamConfig | null> {
    return this.legacy.configurationCompatibilityService.updateConfig(teamName, updates);
  }

  async deleteTeam(teamName: string): Promise<void> {
    return this.legacy.configurationCompatibilityService.deleteTeam(teamName);
  }

  async restoreTeam(teamName: string): Promise<void> {
    return this.legacy.configurationCompatibilityService.restoreTeam(teamName);
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
    return this.legacy.configurationCompatibilityService.permanentlyDeleteTeam(
      teamName,
      isTeamDataCurrent,
      isTaskDataCurrent,
      options
    );
  }

  async getTeamData(
    teamName: string,
    options?: Team.TeamGetDataOptions
  ): Promise<Team.TeamViewSnapshot> {
    const snapshot = await this.viewReadModelService.getTeamData(teamName, options);
    this.processCompatibilityService.observeTeamAlive(teamName, snapshot.isAlive === true);
    return snapshot;
  }

  async getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number; liveMessages?: Team.InboxMessage[] }
  ): Promise<Team.MessagesPage> {
    return this.viewReadModelService.getMessagesPage(teamName, options);
  }

  async getMessageFeed(
    teamName: string
  ): Promise<{ teamName: string; feedRevision: string; messages: Team.InboxMessage[] }> {
    return this.viewReadModelService.getMessageFeed(teamName);
  }

  async getMemberActivityMeta(teamName: string): Promise<Team.TeamMemberActivityMeta> {
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

  async addMember(teamName: string, request: Team.AddMemberRequest): Promise<void> {
    return this.legacy.rosterPersistenceRepository.addMember(teamName, request);
  }

  async updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }> {
    return this.legacy.rosterPersistenceRepository.updateMemberRole(teamName, memberName, newRole);
  }

  async replaceMembers(teamName: string, request: Team.ReplaceMembersRequest): Promise<void> {
    return this.legacy.rosterPersistenceRepository.replaceMembers(teamName, request);
  }

  async removeMember(teamName: string, memberName: string): Promise<void> {
    return this.legacy.rosterPersistenceRepository.removeMember(teamName, memberName);
  }

  async restoreMember(teamName: string, memberName: string): Promise<Team.TeamMember> {
    return this.legacy.rosterPersistenceRepository.restoreMember(teamName, memberName);
  }

  async createTask(teamName: string, request: Team.CreateTaskRequest): Promise<Team.TeamTask> {
    return this.legacy.taskStartCoordinator.createTask(teamName, request);
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.legacy.taskStartCoordinator.startTask(teamName, taskId);
  }

  async startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.legacy.taskStartCoordinator.startTaskByUser(teamName, taskId);
  }

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: Team.TeamTaskStatus,
    actor?: string
  ): Promise<void> {
    return this.mutations.updateTaskStatus(teamName, taskId, status, actor);
  }

  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    await this.legacy.taskStartCoordinator.notifyLeadOnTeammateTaskStart(teamName, taskId);
  }

  async notifyLeadOnTeammateTaskComment(teamName: string, taskId: string): Promise<void> {
    try {
      await this.legacy.taskCommentNotificationCoordinator.notifyLeadOnTeammateTaskComment(
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

  async getDeletedTasks(teamName: string): Promise<Team.TeamTask[]> {
    return this.legacy.taskReadModelService.getDeletedTasks(teamName);
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
    meta: Team.TaskAttachmentMeta
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
    attachments?: Team.TaskAttachmentMeta[],
    taskRefs?: Team.TaskRef[]
  ): Promise<Team.TaskComment> {
    return this.mutations.addTaskComment(teamName, taskId, text, attachments, taskRefs);
  }

  async sendMessage(
    teamName: string,
    request: Team.SendMessageRequest
  ): Promise<Team.SendMessageResult> {
    return this.messagePersistence.sendMessage(teamName, request);
  }

  async sendRuntimeRecipientMessage(
    teamName: string,
    request: Team.SendMessageRequest
  ): Promise<Team.SendMessageResult> {
    return this.messagePersistence.sendRuntimeRecipientMessage(teamName, request);
  }

  async sendSystemNotificationToLead(args: {
    teamName: string;
    summary: string;
    text: string;
    taskRefs?: Team.TaskRef[];
  }): Promise<Team.SendMessageResult> {
    return this.messagePersistence.sendSystemNotificationToLead(args, (teamName, request) =>
      this.sendMessage(teamName, request)
    );
  }

  async initializeTaskCommentNotificationState(): Promise<void> {
    await this.legacy.taskCommentNotificationCoordinator.initializeTaskCommentNotificationState();
  }

  async sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: Team.AttachmentMeta[],
    taskRefs?: Team.TaskRef[],
    messageId?: string
  ): Promise<Team.SendMessageResult> {
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

  async createTeamConfig(request: Team.TeamCreateConfigRequest): Promise<void> {
    return this.legacy.configurationCompatibilityService.createTeamConfig(request);
  }

  async reconcileTeamArtifacts(
    teamName: string,
    trigger?: TeamArtifactReconciliationTrigger
  ): Promise<void> {
    return this.legacy.artifactReconciliationCoordinator.reconcile(teamName, trigger);
  }

  async updateKanban(
    teamName: string,
    taskId: string,
    patch: Team.UpdateKanbanPatch
  ): Promise<void> {
    return this.mutations.updateKanban(teamName, taskId, patch);
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: Team.KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    return this.mutations.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
  }
}
