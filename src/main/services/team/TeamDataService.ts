import { TaskBoardCommandFacade } from '@features/task-board-commands';
import { createTeamRosterPersistenceRepository } from '@features/team-roster-mutations/main';
import {
  TeamLeadSessionMessageReader,
  type TeamLeadSessionMessageReaderParseCache,
  TeamViewSnapshotAssembler,
} from '@features/team-view-read-model/main';
import { createApplicationCommandHasher } from '@main/composition/applicationCommandLedgerComposition';
import { yieldToEventLoop } from '@main/utils/asyncYield';
import { getClaudeBasePath, getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { classifyIdleNotificationText } from '@shared/utils/idleNotificationSemantics';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';
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
import { MemberActivityMetaService } from './MemberActivityMetaService';
import { mergeLiveLeadProcessMessagesPage } from './mergeLiveLeadProcessMessages';
import {
  permanentlyDeleteTeamData,
  type PermanentTeamDataDeletionOptions,
} from './permanentTeamDataDeletion';
import { buildTaskChangePresenceDescriptor } from './taskChangePresenceUtils';
import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { resolveProjectPathFromConfig, TeamConfigReader } from './TeamConfigReader';
import { capMessagesPageLiveOverlay } from './teamInboxOrdering';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMessageFeedService } from './TeamMessageFeedService';
import {
  type TeamMessageLeadContext,
  TeamMessagePersistenceCoordinator,
  type TeamMessagePersistenceRequest,
  type TeamMessagePersistenceResult,
} from './TeamMessagePersistenceCoordinator';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { getTeamTaskWorkflowColumn, selectCurrentActiveTeamTask } from './teamTaskActiveState';
import { TeamTaskCommentNotificationCoordinator } from './TeamTaskCommentNotificationCoordinator';
import { TeamTaskCommentNotificationJournal } from './TeamTaskCommentNotificationJournal';
import { TeamTaskReader } from './TeamTaskReader';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';
import { TeamTaskStartCoordinator } from './TeamTaskStartCoordinator';
import { TeamTaskWriter } from './TeamTaskWriter';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type { PersistedTaskChangePresenceIndex } from './cache/taskChangePresenceCacheTypes';
import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { TaskCommentNotificationJournalStore } from './TaskCommentNotificationJournalStore';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamRosterPersistenceRepositoryPort } from '@features/team-roster-mutations/main';
import type {
  AddMemberRequest,
  AttachmentMeta,
  CreateTaskRequest,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  KanbanState,
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
const TASK_MAP_YIELD_EVERY = 250;
const PASSIVE_USER_REPLY_LINK_WINDOW_MS = 15_000;
const GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY = 12;

function createNonDurableTaskBoardCommandFacade(): TaskBoardCommandFacade {
  const hasher = createApplicationCommandHasher();
  return new TaskBoardCommandFacade(null, {
    hashPayload: (payload) => hasher.hashJson(payload),
  });
}
const TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS = 5_000;

type RuntimeAgentTeamsController = Omit<
  AgentTeamsController,
  'tasks' | 'kanban' | 'review' | 'taskBoard'
> & {
  tasks?: Partial<AgentTeamsController['tasks']>;
  kanban?: Partial<AgentTeamsController['kanban']>;
  review?: Partial<AgentTeamsController['review']>;
  taskBoard?: AgentTeamsController['taskBoard'];
};

interface TeamNotificationContext {
  displayName: string;
  projectPath?: string;
}

interface TeamNotificationContextCacheEntry {
  value: TeamNotificationContext;
  cachedAt: number;
  generation: number;
}

interface InFlightTeamNotificationContext {
  promise: Promise<TeamNotificationContext>;
  generation: number;
}

interface TaskChangeLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

interface FileWatchReconcileDiagnostics {
  inFlight: number;
  burstCount: number;
  windowStartedAt: number;
  lastPressureLogAt: number;
}

interface GlobalTaskTeamInfo {
  displayName: string;
  projectPath?: string;
  deletedAt?: string;
}

async function mapLimitLocal<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index]);
      }
    })
  );

  return results;
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

function normalizePassiveUserReplyLinkText(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?…]+$/g, '')
    .trim();
}

function extractPassiveUserPeerSummaryBody(text: string): string | null {
  const classified = classifyIdleNotificationText(text);
  if (classified?.primaryKind !== 'heartbeat' || !classified.peerSummary) {
    return null;
  }

  const match = /^\[to\s+user\]\s*(.*)$/i.exec(classified.peerSummary);
  if (!match) {
    return null;
  }

  const body = match[1]?.trim() ?? '';
  return body.length > 0 ? body : null;
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
  private taskChangePresenceRepository: TaskChangePresenceRepository | null = null;
  private teamLogSourceTracker: TeamLogSourceTracker | null = null;
  private fileWatchReconcileDiagnostics = new Map<string, FileWatchReconcileDiagnostics>();
  private readonly messageFeedService: TeamMessageFeedService;
  private readonly memberActivityMetaService: MemberActivityMetaService;
  private readonly leadSessionMessageReader: TeamLeadSessionMessageReader;
  private readonly messagePersistenceCoordinator: TeamMessagePersistenceCoordinator;
  private readonly taskCommentNotificationCoordinator: TeamTaskCommentNotificationCoordinator;
  private readonly taskStartCoordinator: TeamTaskStartCoordinator;
  private readonly rosterPersistenceRepository: TeamRosterPersistenceRepositoryPort;
  private readonly notificationContextCache = new Map<string, TeamNotificationContextCacheEntry>();
  private readonly notificationContextInFlight = new Map<string, InFlightTeamNotificationContext>();
  private readonly notificationContextGenerationByTeam = new Map<string, number>();
  private taskBoardCommandFacade = createNonDurableTaskBoardCommandFacade();
  private readonly teamViewSnapshotAssembler: TeamViewSnapshotAssembler<
    PersistedTaskChangePresenceIndex,
    TaskChangeLogSourceSnapshot
  >;

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
    private readonly leadSessionParseCache: TeamLeadSessionMessageReaderParseCache = TeamLeadSessionMessageReader.createParseCache(),
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
      invalidateTaskProjection: () => this.invalidateGlobalTaskProjectionCache(),
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
    this.teamViewSnapshotAssembler = new TeamViewSnapshotAssembler({
      readConfig: (teamName) => this.readSnapshotConfig(teamName),
      readTasks: (teamName) => this.readTasksForUiSnapshot(teamName),
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
      startTaskChangePresenceRead: (teamName) => {
        const enabled =
          this.taskChangePresenceRepository !== null && this.teamLogSourceTracker !== null;
        const logSourceSnapshot: TaskChangeLogSourceSnapshot | null =
          enabled &&
          typeof (this.teamLogSourceTracker as { getSnapshot?: (name: string) => unknown })
            .getSnapshot === 'function'
            ? ((
                this.teamLogSourceTracker as {
                  getSnapshot: (name: string) => TaskChangeLogSourceSnapshot | null;
                }
              ).getSnapshot(teamName) ?? null)
            : null;
        const presenceIndex =
          enabled && logSourceSnapshot?.projectFingerprint && logSourceSnapshot.logSourceGeneration
            ? this.taskChangePresenceRepository!.load(teamName)
            : Promise.resolve(null);
        return {
          enabled,
          logSourceSnapshot,
          presenceIndex,
        };
      },
      projectTaskWithKanban: (task, kanbanTaskState) =>
        this.attachKanbanCompatibility(task, kanbanTaskState),
      projectTaskChangePresence: (tasks, presenceIndex, logSourceSnapshot) =>
        this.resolveTaskChangePresenceMap(tasks, true, presenceIndex, logSourceSnapshot),
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
    });

    const getInboxMessagesWindow =
      typeof this.inboxReader.getMessagesWindow === 'function'
        ? (teamName: string, options: Parameters<TeamInboxReader['getMessagesWindow']>[1]) =>
            this.inboxReader.getMessagesWindow(teamName, options)
        : undefined;

    this.leadSessionMessageReader = new TeamLeadSessionMessageReader(
      this.projectResolver,
      this.leadSessionParseCache
    );
    this.messageFeedService = new TeamMessageFeedService({
      getConfig: (teamName) => this.readSnapshotConfig(teamName),
      getInboxMessages: (teamName) => this.inboxReader.getMessages(teamName),
      getInboxMessagesWindow,
      getLeadSessionMessages: (teamName, config) =>
        this.leadSessionMessageReader.read(teamName, config),
      getSentMessages: (teamName) => this.sentMessagesStore.readMessages(teamName),
    });
    this.memberActivityMetaService = new MemberActivityMetaService(this.messageFeedService);
  }

  private readSnapshotConfig(teamName: string): Promise<TeamConfig | null> {
    return readConfigForUiSnapshot(this.configReader, teamName);
  }

  private getNotificationContextGeneration(teamName: string): number {
    return this.notificationContextGenerationByTeam.get(teamName) ?? 0;
  }

  private invalidateNotificationContext(teamName: string): void {
    this.notificationContextCache.delete(teamName);
    this.notificationContextGenerationByTeam.set(
      teamName,
      this.getNotificationContextGeneration(teamName) + 1
    );
  }

  private async readGlobalTaskTeamInfoFromListTeams(): Promise<Map<string, GlobalTaskTeamInfo>> {
    const teams = await this.configReader.listTeams();
    const teamInfoMap = new Map<string, GlobalTaskTeamInfo>();
    for (const team of teams) {
      teamInfoMap.set(team.teamName, {
        displayName: team.displayName,
        projectPath: team.projectPath,
        deletedAt: team.deletedAt,
      });
    }
    return teamInfoMap;
  }

  private async readGlobalTaskTeamInfo(
    rawTasks: readonly (TeamTask & { teamName: string })[]
  ): Promise<Map<string, GlobalTaskTeamInfo>> {
    const canReadConfigDirectly =
      typeof (this.configReader as { getConfigSnapshot?: unknown }).getConfigSnapshot ===
        'function' ||
      typeof (this.configReader as { getConfig?: unknown }).getConfig === 'function';
    if (!canReadConfigDirectly) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    const teamNames = [...new Set(rawTasks.map((task) => task.teamName))];
    const entries = await mapLimitLocal(
      teamNames,
      GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY,
      async (teamName) => {
        const config = await readConfigForUiSnapshot(this.configReader, teamName).catch(() => null);
        const displayName = config?.name?.trim();
        if (!config || !displayName) {
          return null;
        }
        return [
          teamName,
          {
            displayName,
            projectPath: resolveProjectPathFromConfig(config),
            deletedAt: typeof config.deletedAt === 'string' ? config.deletedAt : undefined,
          },
        ] as const;
      }
    );

    if (entries.some((entry) => entry === null)) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }

  private invalidateGlobalTaskProjectionCache(): void {
    TeamTaskReader.invalidateAllTasksCache();
  }

  private async readTasksForUiSnapshot(teamName: string): Promise<readonly TeamTask[]> {
    const snapshotReader = this.taskReader as TeamTaskReader & {
      getTasksProjectionSnapshot?: (teamName: string) => Promise<readonly TeamTask[]>;
    };
    return typeof snapshotReader.getTasksProjectionSnapshot === 'function'
      ? snapshotReader.getTasksProjectionSnapshot(teamName)
      : this.taskReader.getTasks(teamName);
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

  private resolveTaskReviewState(
    task: Pick<TeamTask, 'reviewState' | 'historyEvents' | 'status'>,
    kanbanTaskState?: KanbanState['tasks'][string]
  ): 'none' | 'review' | 'needsFix' | 'approved' {
    const kanbanColumn = kanbanTaskState?.column;
    const kanbanWorkflowColumn = kanbanColumn
      ? getTeamTaskWorkflowColumn({
          status: task.status,
          reviewState: 'none',
          kanbanColumn,
        })
      : undefined;
    if (kanbanWorkflowColumn) {
      return kanbanWorkflowColumn;
    }

    const reviewState = getReviewStateFromTask({
      historyEvents: task.historyEvents,
      reviewState: task.reviewState,
      status: task.status,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });
    const workflowColumn = getTeamTaskWorkflowColumn({
      status: task.status,
      reviewState,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });

    if (workflowColumn) {
      return workflowColumn;
    }

    return reviewState;
  }

  private attachKanbanCompatibility(
    task: TeamTask,
    kanbanTaskState?: KanbanState['tasks'][string]
  ): TeamTaskWithKanban {
    const reviewState = this.resolveTaskReviewState(task, kanbanTaskState);
    const reviewer = this.resolveReviewerFromHistory(task, kanbanTaskState, reviewState) ?? null;
    const kanbanColumn = this.resolveTaskKanbanColumn(task, kanbanTaskState, reviewState);
    return {
      ...task,
      reviewState,
      ...(kanbanColumn ? { kanbanColumn } : {}),
      reviewer,
    };
  }

  async getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null> {
    const taskBoard = this.getTaskBoard(teamName);
    const task = taskBoard.getTask?.(taskId) as TeamTask | null | undefined;
    if (!task) {
      return null;
    }

    let kanbanState: KanbanState = {
      teamName,
      reviewers: [],
      tasks: {},
    };
    try {
      kanbanState = await this.kanbanManager.getState(teamName);
    } catch {
      // Task detail must still open if kanban state is temporarily unreadable.
    }

    return this.attachKanbanCompatibility(task, kanbanState.tasks[task.id]);
  }

  private resolveTaskKanbanColumn(
    task: Pick<TeamTask, 'status'>,
    kanbanTaskState?: KanbanState['tasks'][string],
    reviewState: 'none' | 'review' | 'needsFix' | 'approved' = 'none'
  ): 'review' | 'approved' | undefined {
    return getTeamTaskWorkflowColumn({
      status: task.status,
      reviewState,
      ...(kanbanTaskState?.column ? { kanbanColumn: kanbanTaskState.column } : {}),
    });
  }

  /**
   * Extract reviewer name from the current review cycle history.
   * For legacy boards that stored reviewer only in kanban state, preserve that
   * value as a migration fallback while the task is still actively in review.
   */
  private resolveReviewerFromHistory(
    task: TeamTask,
    kanbanTaskState?: KanbanState['tasks'][string],
    reviewState: 'none' | 'review' | 'needsFix' | 'approved' = this.resolveTaskReviewState(
      task,
      kanbanTaskState
    )
  ): string | null {
    if (reviewState !== 'review') {
      return null;
    }

    if (task.historyEvents?.length) {
      for (let i = task.historyEvents.length - 1; i >= 0; i--) {
        const event = task.historyEvents[i];
        if (event.type === 'review_started' && event.actor) {
          return event.actor;
        }
        if (event.type === 'review_requested' && event.reviewer) {
          return event.reviewer;
        }
        if (event.type === 'review_approved' || event.type === 'review_changes_requested') {
          break;
        }
        if (
          event.type === 'status_changed' &&
          (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted')
        ) {
          break;
        }
        if (event.type === 'task_created') {
          break;
        }
      }
    }

    if (
      reviewState === 'review' &&
      kanbanTaskState?.column === 'review' &&
      typeof kanbanTaskState.reviewer === 'string' &&
      kanbanTaskState.reviewer.trim().length > 0
    ) {
      return kanbanTaskState.reviewer.trim();
    }

    return null;
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.taskChangePresenceRepository = repository;
    this.teamLogSourceTracker = tracker;
  }

  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
    if (!this.teamLogSourceTracker) {
      return;
    }

    if (enabled) {
      void this.teamLogSourceTracker
        .enableTracking(teamName, 'change_presence')
        .catch((error) =>
          logger.debug(`Failed to start change-presence tracking for ${teamName}: ${String(error)}`)
        );
      return;
    }

    void this.teamLogSourceTracker
      .disableTracking(teamName, 'change_presence')
      .catch((error) =>
        logger.debug(`Failed to stop change-presence tracking for ${teamName}: ${String(error)}`)
      );
  }

  private resolveTaskChangePresenceMap(
    tasks: readonly TeamTaskWithKanban[],
    changePresenceEnabled: boolean,
    presenceIndex: PersistedTaskChangePresenceIndex | null,
    logSourceSnapshot: TaskChangeLogSourceSnapshot | null
  ): Record<string, TaskChangePresenceState> {
    const result: Record<string, TaskChangePresenceState> = {};
    if (
      !changePresenceEnabled ||
      !presenceIndex ||
      !logSourceSnapshot?.projectFingerprint ||
      !logSourceSnapshot.logSourceGeneration ||
      presenceIndex.projectFingerprint !== logSourceSnapshot.projectFingerprint ||
      presenceIndex.logSourceGeneration !== logSourceSnapshot.logSourceGeneration
    ) {
      for (const task of tasks) {
        result[task.id] = 'unknown';
      }
      return result;
    }

    for (const task of tasks) {
      const descriptor = buildTaskChangePresenceDescriptor({
        createdAt: task.createdAt,
        owner: task.owner,
        status: task.status,
        intervals: task.workIntervals,
        reviewState: task.reviewState,
        historyEvents: task.historyEvents,
        kanbanColumn: task.kanbanColumn,
      });
      const presenceEntry = presenceIndex.entries[task.id];
      result[task.id] =
        presenceEntry?.taskSignature === descriptor.taskSignature &&
        presenceEntry.logSourceGeneration === logSourceSnapshot.logSourceGeneration
          ? presenceEntry.presence
          : 'unknown';
    }

    return result;
  }

  private isLeadThoughtCandidateForSlashResult(message: InboxMessage): boolean {
    if (typeof message.to === 'string' && message.to.trim().length > 0) return false;
    if (message.from === 'system') return false;
    return message.source === 'lead_session' || message.source === 'lead_process';
  }

  private annotateSlashCommandResponses(messages: InboxMessage[]): void {
    let pendingSlash = null as InboxMessage['slashCommand'] | null;

    for (const message of messages) {
      const slashCommand =
        message.source === 'user_sent'
          ? (message.slashCommand ?? buildStandaloneSlashCommandMeta(message.text))
          : null;

      if (slashCommand) {
        pendingSlash = slashCommand;
        continue;
      }

      if (!pendingSlash) {
        continue;
      }

      if (message.messageKind === 'slash_command_result') {
        continue;
      }

      if (this.isLeadThoughtCandidateForSlashResult(message)) {
        message.messageKind = 'slash_command_result';
        message.commandOutput = {
          stream: 'stdout',
          commandLabel: pendingSlash.command,
        };
        continue;
      }

      pendingSlash = null;
    }
  }

  private linkPassiveUserReplySummaries(messages: InboxMessage[]): InboxMessage[] {
    const canonicalReplies = messages
      .map((message) => {
        const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
        if (!messageId || message.to !== 'user') {
          return null;
        }
        if (classifyIdleNotificationText(message.text)) {
          return null;
        }

        const time = Date.parse(message.timestamp);
        if (!Number.isFinite(time)) {
          return null;
        }

        return {
          messageId,
          from: message.from,
          time,
          normalizedSummary: normalizePassiveUserReplyLinkText(message.summary),
          normalizedText: normalizePassiveUserReplyLinkText(message.text),
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    if (canonicalReplies.length === 0) {
      return messages;
    }

    let didLink = false;
    const linkedMessages = messages.map((message) => {
      if (
        typeof message.relayOfMessageId === 'string' &&
        message.relayOfMessageId.trim().length > 0
      ) {
        return message;
      }

      const body = extractPassiveUserPeerSummaryBody(message.text);
      if (!body) {
        return message;
      }

      const passiveTime = Date.parse(message.timestamp);
      if (!Number.isFinite(passiveTime)) {
        return message;
      }

      const normalizedBody = normalizePassiveUserReplyLinkText(body);
      if (!normalizedBody) {
        return message;
      }

      const matches = canonicalReplies.filter((candidate) => {
        if (candidate.from !== message.from) {
          return false;
        }
        const deltaMs = passiveTime - candidate.time;
        if (deltaMs < 0 || deltaMs > PASSIVE_USER_REPLY_LINK_WINDOW_MS) {
          return false;
        }
        if (candidate.normalizedSummary === normalizedBody) {
          return true;
        }
        return normalizedBody.length >= 6 && candidate.normalizedText.includes(normalizedBody);
      });

      if (matches.length !== 1) {
        return message;
      }

      didLink = true;
      return {
        ...message,
        relayOfMessageId: matches[0].messageId,
      };
    });

    return didLink ? linkedMessages : messages;
  }

  async getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>> {
    const config = await this.readSnapshotConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }

    const changePresenceEnabled =
      this.taskChangePresenceRepository !== null && this.teamLogSourceTracker !== null;
    const logSourceSnapshot: TaskChangeLogSourceSnapshot | null =
      changePresenceEnabled &&
      typeof (this.teamLogSourceTracker as { getSnapshot?: (teamName: string) => unknown })
        .getSnapshot === 'function'
        ? ((
            this.teamLogSourceTracker as {
              getSnapshot: (teamName: string) => TaskChangeLogSourceSnapshot | null;
            }
          ).getSnapshot(teamName) ?? null)
        : null;

    const [tasks, kanbanState, presenceIndex] = await Promise.all([
      this.readTasksForUiSnapshot(teamName).catch(() => [] as readonly TeamTask[]),
      this.kanbanManager
        .getState(teamName)
        .catch(() => ({ teamName, reviewers: [], tasks: {} }) as KanbanState),
      changePresenceEnabled &&
      logSourceSnapshot?.projectFingerprint &&
      logSourceSnapshot.logSourceGeneration
        ? this.taskChangePresenceRepository!.load(teamName)
        : Promise.resolve(null),
    ]);

    const tasksWithKanbanBase: TeamTaskWithKanban[] = tasks.map((task) =>
      this.attachKanbanCompatibility(task, kanbanState.tasks[task.id])
    );

    return this.resolveTaskChangePresenceMap(
      tasksWithKanbanBase,
      changePresenceEnabled,
      presenceIndex,
      logSourceSnapshot
    );
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
    const taskReader = this.taskReader as TeamTaskReader & {
      getAllTasksProjectionSnapshot?: () => Promise<readonly (TeamTask & { teamName: string })[]>;
    };
    const rawTasks =
      typeof taskReader.getAllTasksProjectionSnapshot === 'function'
        ? await taskReader.getAllTasksProjectionSnapshot()
        : await taskReader.getAllTasks();
    const teamInfoMap = await this.readGlobalTaskTeamInfo(rawTasks);

    const MAX_GLOBAL_TASKS_EXPORTED = 500;
    let tasksToExport = rawTasks.filter((task) => teamInfoMap.has(task.teamName));
    if (tasksToExport.length > MAX_GLOBAL_TASKS_EXPORTED) {
      // Prefer newest first before reading kanban and building the lightweight IPC projection.
      tasksToExport = tasksToExport
        .slice()
        .sort((a, b) => {
          const at = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
          const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
          return bt - at;
        })
        .slice(0, MAX_GLOBAL_TASKS_EXPORTED);
    }

    const teamNames = [...new Set(tasksToExport.map((task) => task.teamName))];
    const kanbanByTeam = new Map<string, KanbanState>();
    await Promise.all(
      teamNames.map(async (teamName) => {
        try {
          const state = await this.kanbanManager.getState(teamName);
          kanbanByTeam.set(teamName, state);
        } catch {
          // ignore
        }
      })
    );

    const out: GlobalTask[] = [];
    let processed = 0;
    for (const task of tasksToExport) {
      const info = teamInfoMap.get(task.teamName)!;
      const kanbanTaskState = kanbanByTeam.get(task.teamName)?.tasks[task.id];
      const reviewState = this.resolveTaskReviewState(task, kanbanTaskState);
      const kanbanColumn = this.resolveTaskKanbanColumn(task, kanbanTaskState, reviewState);

      // IPC payload safety: GlobalTask lists can be enormous (especially comments and large nested fields).
      // Return a "light" task object and defer heavy details to team/task detail views.
      const projectPath = task.projectPath ?? info.projectPath;
      const subject =
        typeof task.subject === 'string'
          ? task.subject.slice(0, 300)
          : String(task.subject).slice(0, 300);
      out.push({
        id: task.id,
        subject,
        owner: task.owner,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        projectPath,
        needsClarification: task.needsClarification,
        deletedAt: task.deletedAt,
        reviewState,
        // IMPORTANT: comments MUST be included here (at least lightweight metadata).
        //
        // Previously comments were omitted from GlobalTask payload to keep IPC small.
        // This silently broke task comment notifications in the renderer: the store's
        // detectTaskCommentNotifications() compares oldTask.comments vs newTask.comments
        // to find new comments and fire native OS toasts. Without comments in the payload,
        // both counts were always 0 → newCommentCount <= oldCommentCount → every comment
        // was silently skipped → "Task comment notifications" toggle had no effect.
        //
        // Fix: include lightweight comment metadata (id, author, truncated text for toast
        // preview, createdAt, type). Full text and attachments are still omitted — those
        // are loaded on-demand by the task detail view via team:getTask.
        comments: Array.isArray(task.comments)
          ? task.comments.map((c) => ({
              id: c.id,
              author: c.author,
              text: c.text.slice(0, 120),
              createdAt: c.createdAt,
              type: c.type,
            }))
          : undefined,
        kanbanColumn,
        teamName: task.teamName,
        teamDisplayName: info.displayName,
        teamDeleted: Boolean(info.deletedAt) || undefined,
      });
      processed++;
      if (processed % TASK_MAP_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }

    return out;
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
      onTaskDataDeleted: () => TeamTaskReader.invalidateAllTasksCache(),
    });
  }

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const snapshot = await this.teamViewSnapshotAssembler.getTeamData(teamName, options);
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
    const liveMessages = capMessagesPageLiveOverlay(options.liveMessages);
    const pageOptions =
      liveMessages.length > 0
        ? {
            ...options,
            liveMessages,
          }
        : {
            cursor: options.cursor,
            limit: options.limit,
          };
    const page = await this.messageFeedService.getPage(teamName, pageOptions);
    if (options.cursor || liveMessages.length === 0) {
      return {
        messages: page.messages,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        feedRevision: page.feedRevision,
      };
    }

    return mergeLiveLeadProcessMessagesPage({
      durableMessages: page.durableWindowMessages,
      liveMessages,
      limit: options.limit,
      feedRevision: page.feedRevision,
      durableHasMoreAfterWindow: page.durableHasMoreAfterWindow,
    });
  }

  async getMessageFeed(
    teamName: string
  ): Promise<{ teamName: string; feedRevision: string; messages: InboxMessage[] }> {
    return this.messageFeedService.getFeed(teamName);
  }

  async getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    return this.memberActivityMetaService.getMeta(teamName);
  }

  invalidateMessageFeed(teamName: string): void {
    this.messageFeedService.invalidate(teamName);
    this.memberActivityMetaService.invalidate(teamName);
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
    this.getTaskBoard(teamName).setTaskStatus(taskId, status, actor);
    this.invalidateGlobalTaskProjectionCache();
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
    this.getTaskBoard(teamName).softDeleteTask(taskId, 'user');
    this.invalidateGlobalTaskProjectionCache();
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    this.getTaskBoard(teamName).restoreTask(taskId, 'user');
    this.invalidateGlobalTaskProjectionCache();
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.taskReader.getDeletedTasks(teamName);
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    this.getTaskBoard(teamName).setTaskOwner(taskId, owner, 'user');
    this.invalidateGlobalTaskProjectionCache();
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    this.getTaskBoard(teamName).updateTaskFields(taskId, fields);
    this.invalidateGlobalTaskProjectionCache();
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: TaskAttachmentMeta
  ): Promise<void> {
    this.getTaskBoard(teamName).addTaskAttachmentMeta(
      taskId,
      meta as unknown as Record<string, unknown>
    );
    this.invalidateGlobalTaskProjectionCache();
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    this.getTaskBoard(teamName).removeTaskAttachment(taskId, attachmentId);
    this.invalidateGlobalTaskProjectionCache();
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    this.getTaskBoard(teamName).setNeedsClarification(taskId, value);
    this.invalidateGlobalTaskProjectionCache();
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    this.getTaskBoard(teamName).linkTask(
      taskId,
      targetId,
      type === 'blockedBy' ? 'blocked-by' : type
    );
    this.invalidateGlobalTaskProjectionCache();
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    this.getTaskBoard(teamName).unlinkTask(
      taskId,
      targetId,
      type === 'blockedBy' ? 'blocked-by' : type
    );
    this.invalidateGlobalTaskProjectionCache();
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    const taskBoard = this.getTaskBoard(teamName);
    const addResult = taskBoard.addTaskComment(taskId, {
      from: 'user',
      text,
      attachments,
      taskRefs,
    }) as { task?: TeamTask; comment?: TaskComment };
    this.invalidateGlobalTaskProjectionCache();
    const comment =
      addResult.comment ??
      ({
        id: randomUUID(),
        author: 'user',
        text,
        createdAt: new Date().toISOString(),
        type: 'regular',
        ...(taskRefs && taskRefs.length > 0 ? { taskRefs } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      } as TaskComment);

    return comment;
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
    try {
      const config = await this.readSnapshotConfig(teamName);
      const displayName = config?.name?.trim();
      return displayName || teamName;
    } catch {
      return teamName;
    }
  }

  async getTeamNotificationContext(teamName: string): Promise<TeamNotificationContext> {
    const now = Date.now();
    const generation = this.getNotificationContextGeneration(teamName);
    const cached = this.notificationContextCache.get(teamName);
    if (
      cached?.generation === generation &&
      now - cached.cachedAt < TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS
    ) {
      return cached.value;
    }

    const existing = this.notificationContextInFlight.get(teamName);
    if (existing?.generation === generation) {
      return existing.promise;
    }

    const promise = this.readTeamNotificationContext(teamName, generation, now).finally(() => {
      if (this.notificationContextInFlight.get(teamName)?.promise === promise) {
        this.notificationContextInFlight.delete(teamName);
      }
    });
    this.notificationContextInFlight.set(teamName, { promise, generation });
    return promise;
  }

  private async readTeamNotificationContext(
    teamName: string,
    generationAtStart: number,
    now: number
  ): Promise<TeamNotificationContext> {
    try {
      const config = await this.readSnapshotConfig(teamName);
      const displayName = config?.name?.trim() || teamName;
      const projectPath =
        typeof config?.projectPath === 'string' && config.projectPath.trim().length > 0
          ? config.projectPath
          : undefined;
      const value: TeamNotificationContext = projectPath
        ? { displayName, projectPath }
        : { displayName };
      if (this.getNotificationContextGeneration(teamName) === generationAtStart) {
        this.notificationContextCache.set(teamName, {
          value,
          cachedAt: now,
          generation: generationAtStart,
        });
      }
      return value;
    } catch {
      const value = { displayName: teamName };
      if (this.getNotificationContextGeneration(teamName) === generationAtStart) {
        this.notificationContextCache.set(teamName, {
          value,
          cachedAt: now,
          generation: generationAtStart,
        });
      }
      return value;
    }
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    const { leadName, leadSessionId } =
      await this.messagePersistenceCoordinator.resolveLeadRuntimeContext(teamName);
    this.getTaskBoard(teamName).requestReview(taskId, {
      from: leadName,
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  }

  private getControllerTaskWorkflowColumn(
    taskBoard: AgentTeamsController['taskBoard'],
    taskId: string
  ): 'review' | 'approved' | undefined | null {
    if (!taskBoard.getTask || !taskBoard.getKanbanState) {
      return null;
    }

    const task = taskBoard.getTask(taskId) as TeamTask | null | undefined;
    if (!task || typeof task.status !== 'string') {
      return null;
    }

    const kanbanState = taskBoard.getKanbanState() as KanbanState | null | undefined;
    const kanbanColumn = kanbanState?.tasks?.[task.id]?.column;
    const kanbanWorkflowColumn = kanbanColumn
      ? getTeamTaskWorkflowColumn({
          status: task.status,
          reviewState: 'none',
          kanbanColumn,
        })
      : undefined;
    if (kanbanWorkflowColumn) {
      return kanbanWorkflowColumn;
    }

    const reviewState = getReviewStateFromTask({
      historyEvents: task.historyEvents,
      reviewState: task.reviewState,
      status: task.status,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });
    return getTeamTaskWorkflowColumn({
      status: task.status,
      reviewState,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });
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
    const taskBoard = this.getTaskBoard(teamName);

    if (patch.op === 'remove') {
      taskBoard.clearKanban(taskId);
      return;
    }

    if (patch.op === 'set_column') {
      if (patch.column === 'review') {
        const { leadName, leadSessionId } =
          await this.messagePersistenceCoordinator.resolveLeadRuntimeContext(teamName);
        taskBoard.requestReview(taskId, {
          from: leadName,
          ...(leadSessionId ? { leadSessionId } : {}),
        });
      } else {
        const { leadName, leadSessionId } =
          await this.messagePersistenceCoordinator.resolveLeadRuntimeContext(teamName);
        const workflowColumn = this.getControllerTaskWorkflowColumn(taskBoard, taskId);
        if (workflowColumn === undefined) {
          taskBoard.setKanbanColumn(taskId, 'approved', {
            transition: 'manual_approve',
          });
        } else {
          taskBoard.approveReview(taskId, {
            from: leadName,
            suppressTaskComment: true,
            'notify-owner': true,
            ...(leadSessionId ? { leadSessionId } : {}),
          });
        }
      }
      return;
    }

    const { leadName, leadSessionId } =
      await this.messagePersistenceCoordinator.resolveLeadRuntimeContext(teamName);
    taskBoard.requestChanges(taskId, {
      from: leadName,
      comment: patch.comment?.trim() || 'Reviewer requested changes.',
      ...(patch.op === 'request_changes' && patch.taskRefs?.length
        ? { taskRefs: patch.taskRefs }
        : {}),
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    this.getTaskBoard(teamName).updateColumnOrder(columnId, orderedTaskIds);
  }
}
