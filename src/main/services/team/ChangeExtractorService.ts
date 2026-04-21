import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import {
  getTaskChangeStateBucket,
  isTaskChangeSummaryCacheable,
  type TaskChangeStateBucket,
} from '@shared/utils/taskChangeState';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';

import { JsonTaskChangeSummaryCacheRepository } from './cache/JsonTaskChangeSummaryCacheRepository';
import { TaskChangeComputer } from './TaskChangeComputer';
import {
  buildTaskChangePresenceDescriptor,
  computeTaskChangePresenceProjectFingerprint,
  normalizeTaskChangePresenceFilePath,
} from './taskChangePresenceUtils';
import { getTaskChangeWorkerClient } from './TaskChangeWorkerClient';
import {
  type ResolvedTaskChangeComputeInput,
  type TaskChangeEffectiveOptions,
  type TaskChangeTaskMeta,
} from './taskChangeWorkerTypes';
import { TaskChangeLedgerReader } from './TaskChangeLedgerReader';
import { TeamConfigReader } from './TeamConfigReader';

import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { TaskBoundaryParser } from './TaskBoundaryParser';
import type { TaskChangeWorkerClient } from './TaskChangeWorkerClient';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { AgentChangeSet, ChangeStats, TaskChangeSetV2 } from '@shared/types';
import { resolveTaskChangePresenceFromResult } from '@shared/utils/taskChangePresence';

const logger = createLogger('Service:ChangeExtractorService');

/** Кеш-запись: данные + mtime файла + время протухания */
interface CacheEntry {
  data: AgentChangeSet;
  mtime: number;
  expiresAt: number;
}

interface TaskChangeSummaryCacheEntry {
  data: TaskChangeSetV2;
  expiresAt: number;
}

interface LogFileRef {
  filePath: string;
  memberName: string;
}

export class ChangeExtractorService {
  private cache = new Map<string, CacheEntry>();
  private taskChangeSummaryCache = new Map<string, TaskChangeSummaryCacheEntry>();
  private taskChangeSummaryInFlight = new Map<string, Promise<TaskChangeSetV2>>();
  private taskChangeSummaryVersionByTask = new Map<string, number>();
  private taskChangeSummaryValidationInFlight = new Set<string>();
  private readonly cacheTtl = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk
  private readonly taskChangeSummaryCacheTtl = 60 * 1000;
  private readonly emptyTaskChangeSummaryCacheTtl = 10 * 1000;
  private readonly persistedTaskChangeSummaryTtl = 24 * 60 * 60 * 1000;
  private readonly maxTaskChangeSummaryCacheEntries = 200;
  private readonly isPersistedTaskChangeCacheEnabled =
    process.env.CLAUDE_TEAM_ENABLE_PERSISTED_TASK_CHANGE_CACHE !== '0';
  private taskChangePresenceRepository: TaskChangePresenceRepository | null = null;
  private teamLogSourceTracker: TeamLogSourceTracker | null = null;
  private readonly taskChangeComputer: TaskChangeComputer;
  private readonly taskChangeLedgerReader = new TaskChangeLedgerReader();

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    boundaryParser: TaskBoundaryParser,
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskChangeSummaryRepository = new JsonTaskChangeSummaryCacheRepository(),
    private readonly taskChangeWorkerClient: TaskChangeWorkerClient = getTaskChangeWorkerClient()
  ) {
    this.taskChangeComputer = new TaskChangeComputer(logsFinder, boundaryParser);
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.taskChangePresenceRepository = repository;
    this.teamLogSourceTracker = tracker;
  }

  /** Получить все изменения агента */
  async getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet> {
    const cacheKey = `${teamName}:${memberName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const projectPath = await this.resolveProjectPath(teamName);
    const { result, latestMtime } = await this.taskChangeComputer.computeAgentChanges(
      teamName,
      memberName,
      projectPath
    );

    this.cache.set(cacheKey, {
      data: result,
      mtime: latestMtime,
      expiresAt: Date.now() + this.cacheTtl,
    });

    return result;
  }

  /** Получить изменения для конкретной задачи (Phase 3: per-task scoping) */
  async getTaskChanges(
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
      stateBucket?: TaskChangeStateBucket;
      summaryOnly?: boolean;
      forceFresh?: boolean;
    }
  ): Promise<TaskChangeSetV2> {
    const initialVersion = this.getTaskChangeSummaryVersion(teamName, taskId);
    const includeDetails = options?.summaryOnly !== true;
    const taskMeta = await this.readTaskMeta(teamName, taskId);
    const effectiveOptions: TaskChangeEffectiveOptions = {
      owner: options?.owner ?? taskMeta?.owner,
      status: options?.status ?? taskMeta?.status,
      intervals: options?.intervals ?? taskMeta?.intervals,
      since: options?.since,
    };
    const projectPath = await this.resolveProjectPath(teamName);
    const effectiveStateBucket = taskMeta
      ? getTaskChangeStateBucket({
          status: effectiveOptions.status,
          reviewState: taskMeta.reviewState,
          historyEvents: taskMeta.historyEvents,
          kanbanColumn: taskMeta.kanbanColumn,
        })
      : (options?.stateBucket ??
        getTaskChangeStateBucket({
          status: effectiveOptions.status,
        }));
    const summaryCacheableState = isTaskChangeSummaryCacheable(effectiveStateBucket);
    const shouldUseSummaryCache = !includeDetails && summaryCacheableState;

    let version = initialVersion;
    if (!summaryCacheableState || options?.forceFresh === true) {
      await this.invalidateTaskChangeSummaries(teamName, [taskId], {
        deletePersisted: true,
      });
      version = this.getTaskChangeSummaryVersion(teamName, taskId);
    }

    const resolvedInput: ResolvedTaskChangeComputeInput = {
      teamName,
      taskId,
      taskMeta,
      effectiveOptions,
      projectPath,
      includeDetails,
    };

    const ledgerResult = await this.readLedgerTaskChanges(resolvedInput);
    if (ledgerResult) {
      await this.recordTaskChangePresence(
        teamName,
        taskId,
        taskMeta,
        effectiveOptions,
        ledgerResult
      );
      return ledgerResult;
    }

    if (!shouldUseSummaryCache) {
      const result = await this.computeTaskChangesPreferred(resolvedInput);
      await this.recordTaskChangePresence(teamName, taskId, taskMeta, effectiveOptions, result);
      return result;
    }

    const cacheKey = this.buildTaskChangeSummaryCacheKey(
      teamName,
      taskId,
      effectiveOptions,
      effectiveStateBucket,
      version
    );

    if (options?.forceFresh !== true) {
      const cached = this.taskChangeSummaryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        await this.recordTaskChangePresence(
          teamName,
          taskId,
          taskMeta,
          effectiveOptions,
          cached.data
        );
        return cached.data;
      }
      this.taskChangeSummaryCache.delete(cacheKey);

      const inFlight = this.taskChangeSummaryInFlight.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }

      const persisted = await this.readPersistedTaskChangeSummary(
        teamName,
        taskId,
        effectiveOptions,
        effectiveStateBucket,
        taskMeta
      );
      if (persisted) {
        this.setTaskChangeSummaryCache(cacheKey, persisted);
        await this.recordTaskChangePresence(
          teamName,
          taskId,
          taskMeta,
          effectiveOptions,
          persisted
        );
        return persisted;
      }
    }

    const promise = this.computeTaskChangesPreferred({ ...resolvedInput, includeDetails: false })
      .then(async (result) => {
        if (this.getTaskChangeSummaryVersion(teamName, taskId) !== version) {
          return result;
        }

        this.setTaskChangeSummaryCache(cacheKey, result);
        await this.persistTaskChangeSummary(
          teamName,
          taskId,
          effectiveOptions,
          effectiveStateBucket,
          result,
          version
        );
        await this.recordTaskChangePresence(teamName, taskId, taskMeta, effectiveOptions, result);
        return result;
      })
      .finally(() => {
        this.taskChangeSummaryInFlight.delete(cacheKey);
      });

    this.taskChangeSummaryInFlight.set(cacheKey, promise);
    return promise;
  }

  async invalidateTaskChangeSummaries(
    teamName: string,
    taskIds: string[],
    options?: { deletePersisted?: boolean }
  ): Promise<void> {
    const uniqueTaskIds = [...new Set(taskIds.filter((taskId) => taskId.length > 0))];
    await Promise.all(
      uniqueTaskIds.map(async (taskId) => {
        this.bumpTaskChangeSummaryVersion(teamName, taskId);
        for (const key of [...this.taskChangeSummaryCache.keys()]) {
          if (this.isTaskChangeSummaryCacheKeyForTask(key, teamName, taskId)) {
            this.taskChangeSummaryCache.delete(key);
          }
        }
        for (const key of [...this.taskChangeSummaryInFlight.keys()]) {
          if (this.isTaskChangeSummaryCacheKeyForTask(key, teamName, taskId)) {
            this.taskChangeSummaryInFlight.delete(key);
          }
        }
        if (options?.deletePersisted !== false && this.isPersistedTaskChangeCacheEnabled) {
          await this.taskChangeSummaryRepository.delete(teamName, taskId);
        }
      })
    );
  }

  private async computeTaskChangesPreferred(
    input: ResolvedTaskChangeComputeInput
  ): Promise<TaskChangeSetV2> {
    if (!this.taskChangeWorkerClient.isAvailable()) {
      return this.taskChangeComputer.computeTaskChanges(input);
    }

    try {
      const result = await this.taskChangeWorkerClient.computeTaskChanges(input);
      if (this.isValidWorkerTaskChangeResult(result, input)) {
        return result;
      }
      logger.warn(
        `Task change worker returned malformed result for ${input.teamName}/${input.taskId}; falling back inline.`
      );
    } catch (error) {
      logger.warn(
        `Task change worker failed for ${input.teamName}/${input.taskId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.taskChangeComputer.computeTaskChanges(input);
  }

  private async readLedgerTaskChanges(
    input: ResolvedTaskChangeComputeInput
  ): Promise<TaskChangeSetV2 | null> {
    try {
      if (typeof this.logsFinder.getLogSourceWatchContext !== 'function') {
        return null;
      }
      const context = await this.logsFinder.getLogSourceWatchContext(input.teamName);
      if (!context?.projectDir) {
        return null;
      }
      return await this.taskChangeLedgerReader.readTaskChanges({
        teamName: input.teamName,
        taskId: input.taskId,
        projectDir: context.projectDir,
        projectPath: input.projectPath ?? context.projectPath,
        includeDetails: input.includeDetails,
      });
    } catch (error) {
      logger.warn(
        `Task change ledger read failed for ${input.teamName}/${input.taskId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private isValidWorkerTaskChangeResult(
    result: TaskChangeSetV2,
    input: ResolvedTaskChangeComputeInput
  ): boolean {
    return (
      !!result &&
      typeof result === 'object' &&
      result.teamName === input.teamName &&
      result.taskId === input.taskId &&
      Array.isArray(result.files)
    );
  }

  /** Получить краткую статистику */
  async getChangeStats(teamName: string, memberName: string): Promise<ChangeStats> {
    const changes = await this.getAgentChanges(teamName, memberName);
    return {
      linesAdded: changes.totalLinesAdded,
      linesRemoved: changes.totalLinesRemoved,
      filesChanged: changes.totalFiles,
    };
  }

  // ---- Private methods ----

  /** Read task metadata (owner, status) from the task JSON file */
  private async readTaskMeta(teamName: string, taskId: string): Promise<TaskChangeTaskMeta | null> {
    try {
      const taskPath = path.join(getTasksBasePath(), teamName, `${taskId}.json`);
      const raw = await readFile(taskPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const intervals = Array.isArray(parsed.workIntervals)
        ? (parsed.workIntervals as unknown[]).filter(
            (i): i is { startedAt: string; completedAt?: string } =>
              Boolean(i) &&
              typeof i === 'object' &&
              typeof (i as Record<string, unknown>).startedAt === 'string' &&
              ((i as Record<string, unknown>).completedAt === undefined ||
                typeof (i as Record<string, unknown>).completedAt === 'string')
          )
        : undefined;

      const derivedIntervals = (() => {
        if (Array.isArray(intervals) && intervals.length > 0) return intervals;
        const rawHistory = parsed.historyEvents;
        if (!Array.isArray(rawHistory)) return undefined;

        const transitions = rawHistory
          .map((h) => (h && typeof h === 'object' ? (h as Record<string, unknown>) : null))
          .filter((h): h is Record<string, unknown> => h !== null)
          .filter((h) => h.type === 'status_changed')
          .map((h) => ({
            to: typeof h.to === 'string' ? h.to : null,
            timestamp: typeof h.timestamp === 'string' ? h.timestamp : null,
          }))
          .filter(
            (t): t is { to: string; timestamp: string } => t.to !== null && t.timestamp !== null
          )
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

        if (transitions.length === 0) return undefined;

        const derived: { startedAt: string; completedAt?: string }[] = [];
        let currentStart: string | null = null;
        for (const t of transitions) {
          if (t.to === 'in_progress') {
            if (!currentStart) currentStart = t.timestamp;
            continue;
          }
          if (currentStart) {
            derived.push({ startedAt: currentStart, completedAt: t.timestamp });
            currentStart = null;
          }
        }
        if (currentStart) derived.push({ startedAt: currentStart });

        return derived.length > 0 ? derived : undefined;
      })();
      return {
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
        owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
        intervals: derivedIntervals,
        reviewState:
          parsed.reviewState === 'review' ||
          parsed.reviewState === 'needsFix' ||
          parsed.reviewState === 'approved'
            ? parsed.reviewState
            : 'none',
        historyEvents: Array.isArray(parsed.historyEvents) ? parsed.historyEvents : undefined,
        kanbanColumn:
          parsed.kanbanColumn === 'review' || parsed.kanbanColumn === 'approved'
            ? parsed.kanbanColumn
            : undefined,
      };
    } catch (error) {
      logger.debug(`Failed to read task meta for ${teamName}/${taskId}: ${String(error)}`);
      return null;
    }
  }

  /** Получить projectPath из конфига команды */
  private async resolveProjectPath(teamName: string): Promise<string | undefined> {
    try {
      const config = await this.configReader.getConfig(teamName);
      return config?.projectPath?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private buildTaskChangeSummaryCacheKey(
    teamName: string,
    taskId: string,
    options: TaskChangeEffectiveOptions,
    stateBucket: TaskChangeStateBucket,
    version: number
  ): string {
    return `${teamName}:${taskId}:v${version}:${this.buildTaskSignature(options, stateBucket)}`;
  }

  private normalizeFilePathKey(filePath: string): string {
    return normalizeTaskChangePresenceFilePath(filePath);
  }

  private buildTaskSignature(
    options: TaskChangeEffectiveOptions,
    stateBucket: TaskChangeStateBucket
  ): string {
    const owner = typeof options.owner === 'string' ? options.owner.trim() : '';
    const status = typeof options.status === 'string' ? options.status.trim() : '';
    const since = typeof options.since === 'string' ? options.since : '';
    const intervals = Array.isArray(options.intervals)
      ? options.intervals.map((interval) => ({
          startedAt: interval.startedAt,
          completedAt: interval.completedAt ?? '',
        }))
      : [];
    return JSON.stringify({ owner, status, since, stateBucket, intervals });
  }

  private setTaskChangeSummaryCache(cacheKey: string, result: TaskChangeSetV2): void {
    this.pruneExpiredTaskChangeSummaryCache();
    this.taskChangeSummaryCache.set(cacheKey, {
      data: result,
      expiresAt:
        Date.now() +
        (result.files.length > 0
          ? this.taskChangeSummaryCacheTtl
          : this.emptyTaskChangeSummaryCacheTtl),
    });
    while (this.taskChangeSummaryCache.size > this.maxTaskChangeSummaryCacheEntries) {
      const oldestKey = this.taskChangeSummaryCache.keys().next().value;
      if (!oldestKey) break;
      this.taskChangeSummaryCache.delete(oldestKey);
    }
  }

  private pruneExpiredTaskChangeSummaryCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.taskChangeSummaryCache.entries()) {
      if (entry.expiresAt <= now) {
        this.taskChangeSummaryCache.delete(key);
      }
    }
  }

  private getTaskChangeSummaryVersionKey(teamName: string, taskId: string): string {
    return `${teamName}:${taskId}`;
  }

  private getTaskChangeSummaryVersion(teamName: string, taskId: string): number {
    return (
      this.taskChangeSummaryVersionByTask.get(
        this.getTaskChangeSummaryVersionKey(teamName, taskId)
      ) ?? 0
    );
  }

  private bumpTaskChangeSummaryVersion(teamName: string, taskId: string): void {
    const key = this.getTaskChangeSummaryVersionKey(teamName, taskId);
    this.taskChangeSummaryVersionByTask.set(
      key,
      this.getTaskChangeSummaryVersion(teamName, taskId) + 1
    );
  }

  private isTaskChangeSummaryCacheKeyForTask(
    cacheKey: string,
    teamName: string,
    taskId: string
  ): boolean {
    return cacheKey.startsWith(`${teamName}:${taskId}:`);
  }

  private async readPersistedTaskChangeSummary(
    teamName: string,
    taskId: string,
    effectiveOptions: TaskChangeEffectiveOptions,
    stateBucket: TaskChangeStateBucket,
    taskMeta: TaskChangeTaskMeta | null
  ): Promise<TaskChangeSetV2 | null> {
    if (!this.isPersistedTaskChangeCacheEnabled) {
      return null;
    }
    if (!taskMeta || !isTaskChangeSummaryCacheable(stateBucket)) {
      await this.taskChangeSummaryRepository.delete(teamName, taskId);
      return null;
    }

    const currentBucket = getTaskChangeStateBucket({
      status: taskMeta.status,
      reviewState: taskMeta.reviewState,
      historyEvents: taskMeta.historyEvents,
      kanbanColumn: taskMeta.kanbanColumn,
    });
    if (!isTaskChangeSummaryCacheable(currentBucket)) {
      await this.taskChangeSummaryRepository.delete(teamName, taskId);
      return null;
    }

    const entry = await this.taskChangeSummaryRepository.load(teamName, taskId);
    if (!entry) {
      return null;
    }

    const projectFingerprint = await this.computeProjectFingerprint(teamName);
    const taskSignature = this.buildTaskSignature(effectiveOptions, currentBucket);

    if (
      !projectFingerprint ||
      entry.taskSignature !== taskSignature ||
      entry.projectFingerprint !== projectFingerprint ||
      entry.stateBucket !== currentBucket
    ) {
      logger.debug(`Rejecting persisted task-change summary for ${teamName}/${taskId}`);
      await this.taskChangeSummaryRepository.delete(teamName, taskId);
      return null;
    }

    this.schedulePersistedTaskChangeSummaryValidation(
      teamName,
      taskId,
      effectiveOptions,
      currentBucket,
      entry.sourceFingerprint
    );

    return entry.summary;
  }

  private schedulePersistedTaskChangeSummaryValidation(
    teamName: string,
    taskId: string,
    effectiveOptions: TaskChangeEffectiveOptions,
    expectedBucket: TaskChangeStateBucket,
    expectedSourceFingerprint: string
  ): void {
    const validationKey = `${teamName}:${taskId}`;
    if (this.taskChangeSummaryValidationInFlight.has(validationKey)) {
      return;
    }

    const version = this.getTaskChangeSummaryVersion(teamName, taskId);
    this.taskChangeSummaryValidationInFlight.add(validationKey);

    setTimeout(() => {
      void this.validatePersistedTaskChangeSummary(
        teamName,
        taskId,
        effectiveOptions,
        expectedBucket,
        expectedSourceFingerprint,
        version
      )
        .catch((error) => {
          logger.debug(
            `Background persisted summary validation failed for ${teamName}/${taskId}: ${String(error)}`
          );
        })
        .finally(() => {
          this.taskChangeSummaryValidationInFlight.delete(validationKey);
        });
    }, 0);
  }

  private async validatePersistedTaskChangeSummary(
    teamName: string,
    taskId: string,
    effectiveOptions: TaskChangeEffectiveOptions,
    expectedBucket: TaskChangeStateBucket,
    expectedSourceFingerprint: string,
    version: number
  ): Promise<void> {
    if (this.getTaskChangeSummaryVersion(teamName, taskId) !== version) {
      return;
    }

    const taskMeta = await this.readTaskMeta(teamName, taskId);
    if (!taskMeta) {
      await this.invalidateTaskChangeSummaries(teamName, [taskId], { deletePersisted: true });
      return;
    }

    const currentBucket = getTaskChangeStateBucket({
      status: taskMeta.status ?? effectiveOptions.status,
      reviewState: taskMeta.reviewState,
      historyEvents: taskMeta.historyEvents,
      kanbanColumn: taskMeta.kanbanColumn,
    });
    if (!isTaskChangeSummaryCacheable(currentBucket) || currentBucket !== expectedBucket) {
      await this.invalidateTaskChangeSummaries(teamName, [taskId], { deletePersisted: true });
      return;
    }

    const logRefs = await this.logsFinder.findLogFileRefsForTask(
      teamName,
      taskId,
      effectiveOptions
    );
    const sourceFingerprint = await this.computeSourceFingerprint(logRefs);
    if (!sourceFingerprint || sourceFingerprint !== expectedSourceFingerprint) {
      await this.invalidateTaskChangeSummaries(teamName, [taskId], { deletePersisted: true });
    }
  }

  private async persistTaskChangeSummary(
    teamName: string,
    taskId: string,
    effectiveOptions: TaskChangeEffectiveOptions,
    stateBucket: TaskChangeStateBucket,
    result: TaskChangeSetV2,
    generation: number
  ): Promise<void> {
    if (!this.isPersistedTaskChangeCacheEnabled) return;
    if (!isTaskChangeSummaryCacheable(stateBucket)) return;
    if (result.files.length === 0) return;
    if (result.confidence !== 'high' && result.confidence !== 'medium') {
      await this.taskChangeSummaryRepository.delete(teamName, taskId);
      return;
    }
    if (this.getTaskChangeSummaryVersion(teamName, taskId) !== generation) {
      return;
    }
    const currentTaskMeta = await this.readTaskMeta(teamName, taskId);
    if (!currentTaskMeta) return;
    const currentBucket = getTaskChangeStateBucket({
      status: currentTaskMeta.status ?? effectiveOptions.status,
      reviewState: currentTaskMeta.reviewState,
      historyEvents: currentTaskMeta.historyEvents,
      kanbanColumn: currentTaskMeta.kanbanColumn,
    });
    if (!isTaskChangeSummaryCacheable(currentBucket)) {
      await this.taskChangeSummaryRepository.delete(teamName, taskId);
      return;
    }

    const logRefs = await this.logsFinder.findLogFileRefsForTask(
      teamName,
      taskId,
      effectiveOptions
    );
    const sourceFingerprint = await this.computeSourceFingerprint(logRefs);
    const projectFingerprint = await this.computeProjectFingerprint(teamName);
    if (!sourceFingerprint || !projectFingerprint) {
      return;
    }

    const expiresAt = new Date(Date.now() + this.persistedTaskChangeSummaryTtl).toISOString();
    await this.taskChangeSummaryRepository.save(
      {
        version: 1,
        teamName,
        taskId,
        stateBucket: currentBucket === 'approved' ? 'approved' : 'completed',
        taskSignature: this.buildTaskSignature(effectiveOptions, currentBucket),
        sourceFingerprint,
        projectFingerprint,
        writtenAt: new Date().toISOString(),
        expiresAt,
        extractorConfidence: result.confidence,
        summary: result,
        debugMeta: {
          sourceCount: logRefs.length,
          projectPathHash: projectFingerprint,
        },
      },
      { generation }
    );
  }

  private async computeSourceFingerprint(logRefs: LogFileRef[]): Promise<string | null> {
    if (logRefs.length === 0) return null;
    const parts: string[] = [];
    for (const ref of [...logRefs].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      try {
        const stats = await stat(ref.filePath);
        parts.push(`${this.normalizeFilePathKey(ref.filePath)}:${stats.size}:${stats.mtimeMs}`);
      } catch {
        return null;
      }
    }
    return createHash('sha256').update(parts.join('|')).digest('hex');
  }

  private async computeProjectFingerprint(teamName: string): Promise<string | null> {
    const projectPath = await this.resolveProjectPath(teamName);
    return computeTaskChangePresenceProjectFingerprint(projectPath);
  }

  private async recordTaskChangePresence(
    teamName: string,
    taskId: string,
    taskMeta: TaskChangeTaskMeta | null,
    effectiveOptions: TaskChangeEffectiveOptions,
    result: TaskChangeSetV2
  ): Promise<void> {
    if (!this.taskChangePresenceRepository || !this.teamLogSourceTracker || !taskMeta) {
      return;
    }

    const snapshot = await this.teamLogSourceTracker.ensureTracking(teamName);
    if (!snapshot.projectFingerprint || !snapshot.logSourceGeneration) {
      return;
    }

    const resolvedPresence = resolveTaskChangePresenceFromResult(result);
    if (!resolvedPresence) {
      return;
    }

    const descriptor = buildTaskChangePresenceDescriptor({
      createdAt: taskMeta.createdAt,
      owner: effectiveOptions.owner ?? taskMeta.owner,
      status: effectiveOptions.status ?? taskMeta.status,
      intervals: effectiveOptions.intervals ?? taskMeta.intervals,
      since: effectiveOptions.since,
      reviewState: taskMeta.reviewState,
      historyEvents: taskMeta.historyEvents,
      kanbanColumn: taskMeta.kanbanColumn,
    });

    const now = new Date().toISOString();
    await this.taskChangePresenceRepository.upsertEntry(
      teamName,
      {
        projectFingerprint: snapshot.projectFingerprint,
        logSourceGeneration: snapshot.logSourceGeneration,
        writtenAt: now,
      },
      {
        taskId,
        taskSignature: descriptor.taskSignature,
        presence: resolvedPresence,
        writtenAt: now,
        logSourceGeneration: snapshot.logSourceGeneration,
      }
    );
  }
}
