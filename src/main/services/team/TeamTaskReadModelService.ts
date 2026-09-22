import { yieldToEventLoop } from '@main/utils/asyncYield';
import { getReviewStateFromTask } from '@shared/utils/reviewState';

import { buildTaskChangePresenceDescriptor } from './taskChangePresenceUtils';
import { resolveProjectPathFromConfig } from './TeamConfigReaderSupport';
import { getTeamTaskWorkflowColumn } from './teamTaskActiveState';

import type { PersistedTaskChangePresenceIndex } from './cache/taskChangePresenceCacheTypes';
import type {
  GlobalTask,
  KanbanState,
  TaskChangePresenceState,
  TeamConfig,
  TeamSummary,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';

const TASK_MAP_YIELD_EVERY = 250;
const GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY = 12;

export interface TaskChangeLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
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

export interface TeamTaskReadModelReaderPort {
  getTasks(teamName: string): Promise<TeamTask[]>;
  getTasksProjectionSnapshot?(teamName: string): Promise<readonly TeamTask[]>;
  getAllTasks(): Promise<(TeamTask & { teamName: string })[]>;
  getAllTasksProjectionSnapshot?(): Promise<readonly (TeamTask & { teamName: string })[]>;
  getDeletedTasks(teamName: string): Promise<TeamTask[]>;
}

export interface TeamTaskReadModelConfigReaderPort {
  listTeams(): Promise<TeamSummary[]>;
  getConfig?(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot?(teamName: string): Promise<TeamConfig | null>;
}

export interface TeamTaskReadModelKanbanReaderPort {
  getState(teamName: string): Promise<KanbanState>;
}

export interface TeamTaskChangePresenceRepositoryPort {
  load(teamName: string): Promise<PersistedTaskChangePresenceIndex | null>;
}

export interface TeamTaskChangePresenceTrackerPort {
  getSnapshot?(teamName: string): TaskChangeLogSourceSnapshot | null;
  enableTracking(teamName: string, consumer: 'change_presence'): Promise<unknown>;
  disableTracking(teamName: string, consumer: 'change_presence'): Promise<unknown>;
}

export interface TeamTaskReadModelServicePorts {
  taskReader: TeamTaskReadModelReaderPort;
  configReader: TeamTaskReadModelConfigReaderPort;
  kanbanReader: TeamTaskReadModelKanbanReaderPort;
  readTask(teamName: string, taskId: string): TeamTask | null | undefined;
  invalidateGlobalTaskProjectionCache(): void;
  logDebug(message: string): void;
}

export interface TaskChangePresenceRead {
  enabled: boolean;
  logSourceSnapshot: TaskChangeLogSourceSnapshot | null;
  presenceIndex: Promise<PersistedTaskChangePresenceIndex | null>;
}

function readConfigForUiSnapshot(
  configReader: TeamTaskReadModelConfigReaderPort,
  teamName: string
): Promise<TeamConfig | null> {
  if (typeof configReader.getConfigSnapshot === 'function') {
    return configReader.getConfigSnapshot(teamName);
  }
  return configReader.getConfig!(teamName);
}

export class TeamTaskReadModelService {
  private taskChangePresenceRepository: TeamTaskChangePresenceRepositoryPort | null = null;
  private teamLogSourceTracker: TeamTaskChangePresenceTrackerPort | null = null;

  constructor(private readonly ports: TeamTaskReadModelServicePorts) {}

  private async readGlobalTaskTeamInfoFromListTeams(): Promise<Map<string, GlobalTaskTeamInfo>> {
    const teams = await this.ports.configReader.listTeams();
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
      typeof this.ports.configReader.getConfigSnapshot === 'function' ||
      typeof this.ports.configReader.getConfig === 'function';
    if (!canReadConfigDirectly) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    const teamNames = [...new Set(rawTasks.map((task) => task.teamName))];
    const entries = await mapLimitLocal(
      teamNames,
      GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY,
      async (teamName) => {
        const config = await readConfigForUiSnapshot(this.ports.configReader, teamName).catch(
          () => null
        );
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

  invalidateGlobalTaskProjectionCache(): void {
    this.ports.invalidateGlobalTaskProjectionCache();
  }

  async readTasksForUiSnapshot(teamName: string): Promise<readonly TeamTask[]> {
    const snapshotReader = this.ports.taskReader;
    return typeof snapshotReader.getTasksProjectionSnapshot === 'function'
      ? snapshotReader.getTasksProjectionSnapshot(teamName)
      : snapshotReader.getTasks(teamName);
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

  attachKanbanCompatibility(
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
    const task = this.ports.readTask(teamName, taskId);
    if (!task) {
      return null;
    }

    let kanbanState: KanbanState = {
      teamName,
      reviewers: [],
      tasks: {},
    };
    try {
      kanbanState = await this.ports.kanbanReader.getState(teamName);
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
    repository: TeamTaskChangePresenceRepositoryPort,
    tracker: TeamTaskChangePresenceTrackerPort
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
          this.ports.logDebug(
            `Failed to start change-presence tracking for ${teamName}: ${String(error)}`
          )
        );
      return;
    }

    void this.teamLogSourceTracker
      .disableTracking(teamName, 'change_presence')
      .catch((error) =>
        this.ports.logDebug(
          `Failed to stop change-presence tracking for ${teamName}: ${String(error)}`
        )
      );
  }

  startTaskChangePresenceRead(teamName: string): TaskChangePresenceRead {
    const enabled =
      this.taskChangePresenceRepository !== null && this.teamLogSourceTracker !== null;
    const logSourceSnapshot: TaskChangeLogSourceSnapshot | null =
      enabled && typeof this.teamLogSourceTracker!.getSnapshot === 'function'
        ? (this.teamLogSourceTracker!.getSnapshot(teamName) ?? null)
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
  }

  resolveTaskChangePresenceMap(
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

  async getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>> {
    const config = await readConfigForUiSnapshot(this.ports.configReader, teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }

    const { enabled, logSourceSnapshot, presenceIndex } =
      this.startTaskChangePresenceRead(teamName);
    const [tasks, kanbanState, resolvedPresenceIndex] = await Promise.all([
      this.readTasksForUiSnapshot(teamName).catch(() => [] as readonly TeamTask[]),
      this.ports.kanbanReader
        .getState(teamName)
        .catch(() => ({ teamName, reviewers: [], tasks: {} }) as KanbanState),
      presenceIndex,
    ]);

    const tasksWithKanbanBase: TeamTaskWithKanban[] = tasks.map((task) =>
      this.attachKanbanCompatibility(task, kanbanState.tasks[task.id])
    );

    return this.resolveTaskChangePresenceMap(
      tasksWithKanbanBase,
      enabled,
      resolvedPresenceIndex,
      logSourceSnapshot
    );
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    const taskReader = this.ports.taskReader;
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
          const state = await this.ports.kanbanReader.getState(teamName);
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

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.ports.taskReader.getDeletedTasks(teamName);
  }
}
