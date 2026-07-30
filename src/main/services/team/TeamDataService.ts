import { TaskBoardCommandFacade } from '@features/task-board-commands';
import { createTeamRosterPersistenceRepository } from '@features/team-roster-mutations/main';
import { TeamTaskMutationCoordinator } from '@features/team-task-board/main';
import { createApplicationCommandHasher } from '@main/composition/applicationCommandLedgerComposition';
import { getClaudeBasePath, getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import { atomicWriteAsync } from './atomicWrite';
import {
  permanentlyDeleteTeamData,
  type PermanentTeamDataDeletionOptions,
} from './permanentTeamDataDeletion';
import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import {
  type TeamMessageLeadContext,
  TeamMessagePersistenceCoordinator,
  type TeamMessagePersistenceRequest,
  type TeamMessagePersistenceResult,
} from './TeamMessagePersistenceCoordinator';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { selectCurrentActiveTeamTask } from './teamTaskActiveState';
import { TeamTaskCommentNotificationCoordinator } from './TeamTaskCommentNotificationCoordinator';
import { TeamTaskCommentNotificationJournal } from './TeamTaskCommentNotificationJournal';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamTaskReadModelService } from './TeamTaskReadModelService';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';
import { TeamTaskStartCoordinator } from './TeamTaskStartCoordinator';
import { TeamTaskWriter } from './TeamTaskWriter';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';
import { TeamViewReadModelService } from './TeamViewReadModelService';

import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { TaskCommentNotificationJournalStore } from './TaskCommentNotificationJournalStore';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamNotificationContext } from './TeamViewReadModelService';
import type { TeamRosterPersistenceRepositoryPort } from '@features/team-roster-mutations/main';
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
const PROCESS_HEALTH_INTERVAL_MS = 2_000;

function createNonDurableTaskBoardCommandFacade(): TaskBoardCommandFacade {
  const hasher = createApplicationCommandHasher();
  return new TaskBoardCommandFacade(null, {
    hashPayload: (payload) => hasher.hashJson(payload),
  });
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

interface FileWatchReconcileDiagnostics {
  inFlight: number;
  burstCount: number;
  windowStartedAt: number;
  lastPressureLogAt: number;
}

function applyDistinctRosterColors<T extends { name: string; color?: string; removedAt?: number }>(
  members: readonly T[]
): T[] {
  const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
  return members.map((member) => ({
    ...member,
    color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
  }));
}

function readConfigForUiSnapshot(
  configReader: TeamConfigReader & {
    getConfigSnapshot?: (teamName: string) => Promise<TeamConfig | null>;
  },
  teamName: string
): Promise<TeamConfig | null> {
  return typeof configReader.getConfigSnapshot === 'function'
    ? configReader.getConfigSnapshot(teamName)
    : configReader.getConfig(teamName);
}

function createUiSnapshotProjectResolver(
  configReader: TeamConfigReader
): TeamTranscriptProjectResolver {
  return new TeamTranscriptProjectResolver({
    getConfig: (teamName) => readConfigForUiSnapshot(configReader, teamName),
  });
}

interface FileWatchReconcileTrigger {
  source: 'inbox' | 'task';
  detail?: string;
}

function toTeamMessageLeadContext(config: TeamConfig | null): TeamMessageLeadContext | null {
  if (!config) return null;
  return {
    members: config.members?.map(({ name, agentType, role }) => ({ name, agentType, role })),
    leadSessionId: config.leadSessionId,
  };
}

function toTeamMessagePersistenceRequest(
  request: SendMessageRequest
): TeamMessagePersistenceRequest {
  return request;
}

function toSendMessageRequest(request: TeamMessagePersistenceRequest): SendMessageRequest {
  return request;
}

function toTeamMessagePersistenceResult(result: SendMessageResult): TeamMessagePersistenceResult {
  return result;
}

export class TeamDataService {
  private processHealthTimer: ReturnType<typeof setInterval> | null = null;
  private processHealthTeams = new Set<string>();
  private fileWatchReconcileDiagnostics = new Map<string, FileWatchReconcileDiagnostics>();
  private readonly messagePersistenceCoordinator: TeamMessagePersistenceCoordinator;
  private readonly taskCommentNotificationCoordinator: TeamTaskCommentNotificationCoordinator;
  private readonly taskMutationCoordinator: TeamTaskMutationCoordinator;
  private readonly taskReadModelService: TeamTaskReadModelService;
  private readonly taskStartCoordinator: TeamTaskStartCoordinator;
  private readonly rosterPersistenceRepository: TeamRosterPersistenceRepositoryPort;
  private taskBoardCommandFacade = createNonDurableTaskBoardCommandFacade();
  private readonly viewReadModelService: TeamViewReadModelService;

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
    private readonly projectResolver: TeamTranscriptProjectResolver = createUiSnapshotProjectResolver(
      configReader
    ),
    private readonly launchStateStore: TeamLaunchStateStore = new TeamLaunchStateStore()
  ) {
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
        listProcesses: (teamName) => this.readProcesses(teamName),
      },
      now: () => Date.now(),
    });
    this.messagePersistenceCoordinator = new TeamMessagePersistenceCoordinator({
      leadContext: {
        readLeadContext: async (teamName) =>
          toTeamMessageLeadContext(await readConfigForUiSnapshot(this.configReader, teamName)),
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
          toTeamMessagePersistenceResult(
            this.getController(teamName).messages.sendMessage(
              request as unknown as Record<string, unknown>
            ) as SendMessageResult
          ),
        appendSentMessage: (teamName, request) =>
          this.getController(teamName).messages.appendSentMessage(
            request as unknown as Record<string, unknown>
          ) as InboxMessage,
      },
      runtimeRecipientInbox: {
        sendMessage: async (teamName, request) =>
          toTeamMessagePersistenceResult(
            await this.inboxWriter.sendMessage(teamName, toSendMessageRequest(request))
          ),
      },
      messageFeed: {
        invalidate: (teamName) => this.invalidateMessageFeed(teamName),
      },
      identity: {
        createMessageId: () => randomUUID(),
      },
    });
    this.taskReadModelService = new TeamTaskReadModelService({
      taskReader: this.taskReader,
      configReader: this.configReader,
      kanbanReader: this.kanbanManager,
      readTask: (teamName, taskId) =>
        this.getTaskBoard(teamName).getTask?.(taskId) as TeamTask | null | undefined,
      invalidateGlobalTaskProjectionCache: () => TeamTaskReader.invalidateAllTasksCache(),
      logDebug: (message) => logger.debug(message),
    });
    this.taskMutationCoordinator = new TeamTaskMutationCoordinator({
      taskBoards: {
        getTaskBoard: (teamName) => this.getTaskBoard(teamName),
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
        createId: () => randomUUID(),
      },
      clock: {
        nowIso: () => new Date().toISOString(),
      },
    });
    this.taskStartCoordinator = new TeamTaskStartCoordinator({
      getTaskBoard: (teamName) => this.getTaskBoard(teamName),
      readTasks: (teamName) => this.taskReader.getTasks(teamName),
      readTaskCreateProjectPath: async (teamName) => {
        try {
          const config = await readConfigForUiSnapshot(this.configReader, teamName);
          return config?.projectPath;
        } catch {
          return undefined;
        }
      },
      runCreateTaskCommand: (command) => this.taskBoardCommandFacade.createTask(command),
      invalidateTaskProjection: () =>
        this.taskReadModelService.invalidateGlobalTaskProjectionCache(),
      resolveLeadName: (teamName) => this.messagePersistenceCoordinator.resolveLeadName(teamName),
      sendMessage: (teamName, request) => this.sendMessage(teamName, request),
      sendRuntimeRecipientMessage: (teamName, request) =>
        this.sendRuntimeRecipientMessage(teamName, request),
      warn: (message) => logger.warn(message),
    });
    this.taskCommentNotificationCoordinator = new TeamTaskCommentNotificationCoordinator({
      listTeams: () => this.listTeams(),
      readConfig: (teamName) => readConfigForUiSnapshot(this.configReader, teamName),
      resolveLeadName: (config) =>
        this.messagePersistenceCoordinator.resolveLeadNameFromConfig(
          toTeamMessageLeadContext(config)
        ),
      readTasks: (teamName) => this.taskReader.getTasks(teamName),
      readLeadInboxMessages: (teamName, leadName) =>
        this.inboxReader.getMessagesFor(teamName, leadName),
      sendMessage: (teamName, request) => this.inboxWriter.sendMessage(teamName, request),
      journal: this.taskCommentNotificationJournal,
    });
    this.viewReadModelService = new TeamViewReadModelService({
      readConfig: (teamName) => this.readSnapshotConfig(teamName),
      readTasks: (teamName) => this.taskReadModelService.readTasksForUiSnapshot(teamName),
      readInboxNames: (teamName) => this.inboxReader.listInboxNames(teamName),
      readMembersMeta: (teamName) => this.membersMetaStore.getMembers(teamName),
      readTeamMeta: (teamName) => this.teamMetaStore.getMeta(teamName),
      readLaunchSnapshot: async (teamName) => {
        const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
          readBootstrapLaunchSnapshot(teamName),
          this.launchStateStore.read(teamName),
        ]);
        return choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
      },
      readKanbanState: (teamName) => this.kanbanManager.getState(teamName),
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
        this.memberResolver.resolveMembers(config, metaMembers, inboxNames, tasks, options),
      readMemberRuntimeAdvisories: (teamName, members, observedAfterMs) =>
        this.memberRuntimeAdvisoryService.getMemberAdvisories(teamName, members, {
          observedAfterMs,
        }),
      resolveGitBranch: (cwd) => gitIdentityResolver.getBranch(path.normalize(cwd)),
      memberBranchConcurrency: process.platform === 'win32' ? 4 : 8,
      readProcesses: (teamName) => this.readProcesses(teamName),
      selectCurrentActiveTask: (tasks) => selectCurrentActiveTeamTask(tasks),
      compactTask: (task) => compactTeamTaskForSnapshot(task),
      logDebug: (message) => logger.debug(message),
      logWarning: (message) => logger.warn(message),
      projectResolver: this.projectResolver,
      leadSessionParseCache: this.leadSessionParseCache,
      readInboxMessages: (teamName) => this.inboxReader.getMessages(teamName),
      readInboxMessagesWindow:
        typeof this.inboxReader.getMessagesWindow === 'function'
          ? (teamName, options) => this.inboxReader.getMessagesWindow(teamName, options)
          : undefined,
      readSentMessages: (teamName) => this.sentMessagesStore.readMessages(teamName),
    });
  }

  private readSnapshotConfig(teamName: string): Promise<TeamConfig | null> {
    return readConfigForUiSnapshot(this.configReader, teamName);
  }

  private invalidateNotificationContext(teamName: string): void {
    this.viewReadModelService.invalidateNotificationContext(teamName);
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
    return this.taskReadModelService.getTask(teamName, taskId);
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.taskReadModelService.setTaskChangePresenceServices(repository, tracker);
  }

  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
    this.taskReadModelService.setTaskChangePresenceTracking(teamName, enabled);
  }

  async getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>> {
    return this.taskReadModelService.getTaskChangePresence(teamName);
  }

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
    const meta = await this.teamMetaStore.getMeta(teamName);
    if (!meta) {
      return null;
    }

    const membersMeta = await this.membersMetaStore.getMeta(teamName);
    const members = membersMeta?.members ?? [];
    const resolvedProviderId = meta.providerId ?? 'anthropic';

    return {
      teamName,
      displayName: meta.displayName,
      description: meta.description,
      color: meta.color,
      cwd: meta.cwd,
      prompt: meta.prompt,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        meta.providerBackendId ?? membersMeta?.providerBackendId
      ),
      model: meta.model,
      effort: meta.effort as TeamCreateRequest['effort'],
      fastMode: meta.fastMode,
      skipPermissions: meta.skipPermissions,
      worktree: meta.worktree,
      extraCliArgs: meta.extraCliArgs,
      limitContext: meta.limitContext,
      members: members
        .filter((member) => !member.removedAt)
        .map((member) => ({
          name: member.name,
          role: member.role,
          workflow: member.workflow,
          isolation: member.isolation,
          cwd: member.cwd,
          providerId: member.providerId,
          providerBackendId: member.providerBackendId,
          model: member.model,
          effort: member.effort,
          fastMode: member.fastMode,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        })),
    };
  }

  async listAliveProcessTeams(): Promise<string[]> {
    const teams = await this.listTeams();
    const alive: string[] = [];

    for (const team of teams) {
      if (team.deletedAt) {
        continue;
      }
      try {
        const processes = await this.readProcesses(team.teamName);
        if (processes.some((process) => !process.stoppedAt)) {
          alive.push(team.teamName);
        }
      } catch {
        // best-effort per team
      }
    }

    return alive.sort((left, right) => left.localeCompare(right));
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    return this.taskReadModelService.getAllTasks();
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    const updated = await this.configReader.updateConfig(teamName, updates);
    this.invalidateNotificationContext(teamName);
    return updated;
  }

  async deleteTeam(teamName: string): Promise<void> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    config.deletedAt = new Date().toISOString();
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    await TeamConfigReader.primeConfig(teamName, config);
    this.invalidateNotificationContext(teamName);
  }

  async restoreTeam(teamName: string): Promise<void> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    delete config.deletedAt;
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    await TeamConfigReader.primeConfig(teamName, config);
    this.invalidateNotificationContext(teamName);
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
    return permanentlyDeleteTeamData({
      teamName,
      isTeamDataCurrent,
      isTaskDataCurrent,
      options,
      onTeamDataDeleted: () => {
        TeamConfigReader.invalidateTeam(teamName);
        this.invalidateNotificationContext(teamName);
      },
      onTaskDataDeleted: () => this.taskReadModelService.invalidateGlobalTaskProjectionCache(),
    });
  }

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const snapshot = await this.viewReadModelService.getTeamData(teamName, options);
    if (snapshot.isAlive) {
      this.processHealthTeams.add(teamName);
    } else {
      this.processHealthTeams.delete(teamName);
    }
    return snapshot;
  }

  /**
   * Paginated message retrieval for the messages panel.
   * Uses cursor-based pagination by timestamp to handle live message insertion.
   */
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
    if (this.processHealthTimer) return;
    this.processHealthTimer = setInterval(() => {
      void this.processHealthTick();
    }, PROCESS_HEALTH_INTERVAL_MS);
    // Background maintenance should not keep the process alive.
    this.processHealthTimer.unref();
  }

  stopProcessHealthPolling(): void {
    if (this.processHealthTimer) {
      clearInterval(this.processHealthTimer);
      this.processHealthTimer = null;
    }
    this.processHealthTeams.clear();
  }

  trackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.add(teamName);
  }

  untrackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.delete(teamName);
  }

  private async processHealthTick(): Promise<void> {
    for (const teamName of this.processHealthTeams) {
      try {
        this.getController(teamName).processes.listProcesses();
      } catch {
        // best-effort per team
      }
    }
  }

  private async readProcesses(teamName: string): Promise<TeamProcess[]> {
    return this.getController(teamName).processes.listProcesses() as TeamProcess[];
  }

  /**
   * Kill a registered CLI process by PID (SIGTERM) and mark it as stopped in processes.json.
   */
  async killProcess(teamName: string, pid: number): Promise<void> {
    // Try to kill the process (cross-platform: SIGTERM on Unix, taskkill on Windows)
    try {
      killProcessByPid(pid);
    } catch (err: unknown) {
      // ESRCH = process not found — still mark as stopped below
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ESRCH'
      ) {
        throw new Error(`Failed to kill process ${pid}: ${(err as Error).message}`);
      }
    }

    try {
      this.getController(teamName).processes.stopProcess({ pid });
    } catch {
      // Ignore missing persisted registry rows after OS-level stop.
    }
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
    return this.taskStartCoordinator.createTask(teamName, request);
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.taskStartCoordinator.startTask(teamName, taskId);
  }

  /**
   * Start a task triggered by the user via UI.
   * Unlike startTask(), this always notifies the owner (including the lead in solo teams).
   */
  async startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    return this.taskStartCoordinator.startTaskByUser(teamName, taskId);
  }

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string
  ): Promise<void> {
    return this.taskMutationCoordinator.updateTaskStatus(teamName, taskId, status, actor);
  }

  /**
   * Called when a task file changes on disk (e.g. teammate CLI wrote it).
   * If the latest historyEvents entry shows a non-user actor started the task,
   * sends an inbox notification to the team lead.
   */
  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    await this.taskStartCoordinator.notifyLeadOnTeammateTaskStart(teamName, taskId);
  }

  async notifyLeadOnTeammateTaskComment(teamName: string, taskId: string): Promise<void> {
    try {
      await this.taskCommentNotificationCoordinator.notifyLeadOnTeammateTaskComment(
        teamName,
        taskId
      );
    } catch (error) {
      logger.warn(`[TeamDataService] notifyLeadOnTeammateTaskComment failed: ${String(error)}`);
    }
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    return this.taskMutationCoordinator.softDeleteTask(teamName, taskId);
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    return this.taskMutationCoordinator.restoreTask(teamName, taskId);
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.taskReadModelService.getDeletedTasks(teamName);
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    return this.taskMutationCoordinator.updateTaskOwner(teamName, taskId, owner);
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    return this.taskMutationCoordinator.updateTaskFields(teamName, taskId, fields);
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: TaskAttachmentMeta
  ): Promise<void> {
    return this.taskMutationCoordinator.addTaskAttachment(teamName, taskId, meta);
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    return this.taskMutationCoordinator.removeTaskAttachment(teamName, taskId, attachmentId);
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    return this.taskMutationCoordinator.setTaskNeedsClarification(teamName, taskId, value);
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    return this.taskMutationCoordinator.addTaskRelationship(teamName, taskId, targetId, type);
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    return this.taskMutationCoordinator.removeTaskRelationship(teamName, taskId, targetId, type);
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    return this.taskMutationCoordinator.addTaskComment(
      teamName,
      taskId,
      text,
      attachments,
      taskRefs
    );
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return this.messagePersistenceCoordinator.sendMessage(
      teamName,
      toTeamMessagePersistenceRequest(request)
    );
  }

  async sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageResult> {
    return this.messagePersistenceCoordinator.sendRuntimeRecipientMessage(
      teamName,
      toTeamMessagePersistenceRequest(request)
    );
  }

  async sendSystemNotificationToLead(args: {
    teamName: string;
    summary: string;
    text: string;
    taskRefs?: TaskRef[];
  }): Promise<SendMessageResult> {
    return this.messagePersistenceCoordinator.sendSystemNotificationToLead(
      args,
      (teamName, request) => this.sendMessage(teamName, toSendMessageRequest(request))
    );
  }

  async initializeTaskCommentNotificationState(): Promise<void> {
    await this.taskCommentNotificationCoordinator.initializeTaskCommentNotificationState();
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
    return this.messagePersistenceCoordinator.sendDirectToLead(
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
    return this.messagePersistenceCoordinator.getLeadMemberName(teamName);
  }

  async getTeamDisplayName(teamName: string): Promise<string> {
    return this.viewReadModelService.getTeamDisplayName(teamName);
  }

  async getTeamNotificationContext(teamName: string): Promise<TeamNotificationContext> {
    return this.viewReadModelService.getTeamNotificationContext(teamName);
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    return this.taskMutationCoordinator.requestReview(teamName, taskId);
  }

  async createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
    const teamDir = path.join(getTeamsBasePath(), request.teamName);
    const tasksDir = path.join(getTasksBasePath(), request.teamName);
    await Promise.all([
      fs.promises.mkdir(getTeamsBasePath(), { recursive: true }),
      fs.promises.mkdir(getTasksBasePath(), { recursive: true }),
    ]);

    const pathExists = async (targetPath: string): Promise<boolean> => {
      try {
        await fs.promises.lstat(targetPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    if ((await pathExists(teamDir)) || (await pathExists(tasksDir))) {
      throw new Error(`Team already exists: ${request.teamName}`);
    }

    try {
      await fs.promises.mkdir(teamDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Team already exists: ${request.teamName}`);
      }
      throw error;
    }

    let tasksDirectoryCreated = false;
    try {
      await fs.promises.mkdir(tasksDir);
      tasksDirectoryCreated = true;

      const joinedAt = Date.now();

      // Save team-level metadata to team.meta.json (NOT config.json).
      // config.json is CLI territory — created by TeamCreate during provisioning.
      // team.meta.json preserves user's configuration for the Launch flow.
      await this.teamMetaStore.writeMeta(request.teamName, {
        displayName: request.displayName,
        description: request.description,
        color: request.color,
        cwd: request.cwd?.trim() || '',
        prompt: request.prompt,
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        extraCliArgs: request.extraCliArgs,
        limitContext: request.limitContext,
        createdAt: joinedAt,
      });

      const membersToWrite = applyDistinctRosterColors(
        request.members.map((member) => ({
          name: (() => {
            const name = member.name.trim();
            if (!name) throw new Error('Member name cannot be empty');
            const formatError = validateTeamMemberNameFormat(name);
            if (formatError) {
              throw new Error(`Member name "${name}" is invalid: ${formatError}`);
            }
            if (name.toLowerCase() === 'user') {
              throw new Error('Member name "user" is reserved');
            }
            if (name.toLowerCase() === 'team-lead')
              throw new Error('Member name "team-lead" is reserved');
            const suffixInfo = parseNumericSuffixName(name);
            if (suffixInfo && suffixInfo.suffix >= 2) {
              throw new Error(
                `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
              );
            }
            return name;
          })(),
          role: member.role?.trim() || undefined,
          workflow: member.workflow?.trim() || undefined,
          isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: normalizeOptionalTeamProviderId(member.providerId),
          providerBackendId: member.providerBackendId,
          model: member.model?.trim() || undefined,
          effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
          fastMode: member.fastMode,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
          agentType: 'general-purpose' as const,
          joinedAt,
        }))
      );
      await this.membersMetaStore.writeMembers(request.teamName, membersToWrite, {
        providerBackendId: request.providerBackendId,
      });
      TeamConfigReader.invalidateListTeamsCache();
    } catch (error) {
      if (tasksDirectoryCreated) {
        await fs.promises.rm(tasksDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await fs.promises.rm(teamDir, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Team already exists: ${request.teamName}`);
      }
      throw error;
    }
  }

  async reconcileTeamArtifacts(
    teamName: string,
    trigger?: FileWatchReconcileTrigger
  ): Promise<void> {
    const now = Date.now();
    const diagnostics = this.fileWatchReconcileDiagnostics.get(teamName) ?? {
      inFlight: 0,
      burstCount: 0,
      windowStartedAt: now,
      lastPressureLogAt: 0,
    };
    const triggerSource = trigger?.source ?? 'unknown';
    const triggerDetail =
      typeof trigger?.detail === 'string' && trigger.detail.trim().length > 0
        ? ` detail=${trigger.detail.trim()}`
        : '';
    if (now - diagnostics.windowStartedAt > 5_000) {
      diagnostics.windowStartedAt = now;
      diagnostics.burstCount = 0;
    }
    diagnostics.burstCount += 1;
    diagnostics.inFlight += 1;
    this.fileWatchReconcileDiagnostics.set(teamName, diagnostics);

    const concurrentAtStart = diagnostics.inFlight;
    const shouldLogPressure =
      concurrentAtStart > 1 || diagnostics.burstCount >= 8 || diagnostics.burstCount === 1;
    if (shouldLogPressure && now - diagnostics.lastPressureLogAt >= 2_000) {
      diagnostics.lastPressureLogAt = now;
      logger.warn(
        `[reconcileTeamArtifacts] team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} inFlight=${concurrentAtStart} burst=${diagnostics.burstCount}`
      );
    }

    const startedAt = Date.now();
    try {
      const rawResult = this.getController(teamName).maintenance.reconcileArtifacts({
        reason: 'file-watch',
      }) as
        | {
            staleKanbanEntriesRemoved?: number;
            staleColumnOrderRefsRemoved?: number;
            linkedCommentsCreated?: number;
          }
        | undefined;
      const result = (rawResult ?? {}) as {
        staleKanbanEntriesRemoved?: number;
        staleColumnOrderRefsRemoved?: number;
        linkedCommentsCreated?: number;
      };
      const durationMs = Date.now() - startedAt;
      if (
        durationMs >= 100 ||
        concurrentAtStart > 1 ||
        diagnostics.burstCount >= 8 ||
        (result.linkedCommentsCreated ?? 0) > 0 ||
        (result.staleKanbanEntriesRemoved ?? 0) > 0 ||
        (result.staleColumnOrderRefsRemoved ?? 0) > 0
      ) {
        logger.warn(
          `[reconcileTeamArtifacts] completed team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} durationMs=${durationMs} inFlightAtStart=${concurrentAtStart} burst=${diagnostics.burstCount} linkedCommentsCreated=${result.linkedCommentsCreated ?? 0} staleKanbanEntriesRemoved=${result.staleKanbanEntriesRemoved ?? 0} staleColumnOrderRefsRemoved=${result.staleColumnOrderRefsRemoved ?? 0}`
        );
      }
    } finally {
      const current = this.fileWatchReconcileDiagnostics.get(teamName);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        if (current.inFlight === 0 && Date.now() - current.windowStartedAt > 30_000) {
          this.fileWatchReconcileDiagnostics.delete(teamName);
        }
      }
    }
  }

  async updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    return this.taskMutationCoordinator.updateKanban(teamName, taskId, patch);
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    return this.taskMutationCoordinator.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
  }
}
