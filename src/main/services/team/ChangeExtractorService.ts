import { appendOpenCodeTaskChangeDiag } from '@main/utils/openCodeTaskChangeDiagLog';
import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { resolveTaskChangePresenceFromResult } from '@shared/utils/taskChangePresence';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import {
  getTaskChangeStateBucket,
  isTaskChangeSummaryCacheable,
  type TaskChangeStateBucket,
} from '@shared/utils/taskChangeState';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { JsonTaskChangeSummaryCacheRepository } from './cache/JsonTaskChangeSummaryCacheRepository';
import { OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION } from './opencode/bridge/OpenCodeBridgeCommandContract';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeTeamRuntimeDirectory,
  readOpenCodeRuntimeLaneIndex,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TaskChangeComputer } from './TaskChangeComputer';
import { TaskChangeLedgerReader } from './TaskChangeLedgerReader';
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
import { TeamConfigReader } from './TeamConfigReader';
import { TeamMetaStore } from './TeamMetaStore';

import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { OpenCodeLedgerBackfillPort } from './opencode/bridge/OpenCodeReadinessBridge';
import type { OpenCodePromptDeliveryLedgerRecord } from './opencode/delivery/OpenCodePromptDeliveryLedger';
import type { TaskBoundaryParser } from './TaskBoundaryParser';
import type { TaskChangeWorkerClient } from './TaskChangeWorkerClient';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type {
  AgentChangeSet,
  ChangeStats,
  TaskChangeReviewability,
  TaskChangeSetV2,
  TeamConfig,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryItem,
  TeamTaskChangeSummaryRequest,
} from '@shared/types';

const logger = createLogger('Service:ChangeExtractorService');
const OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE = 'strict-delivery' as const;
const OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE = 'opencode-session-snapshot-v1' as const;
const OPEN_CODE_MAX_DISCOVERED_LANES = 500;
const TEAM_TASK_CHANGE_SUMMARY_BATCH_INSPECT_LIMIT = 1_000;
const TEAM_TASK_CHANGE_SUMMARY_BATCH_LIMIT = 200;
const TEAM_TASK_CHANGE_SUMMARY_BATCH_CONCURRENCY = 3;
const TEAM_TASK_CHANGE_SUMMARY_TASK_TIMEOUT_MS = 15_000;
const TEAM_TASK_CHANGE_SUMMARY_BATCH_TIMEOUT_MS = 30_000;

function shouldClearStaleTaskChangePresence(input: {
  result: TaskChangeSetV2;
  taskMeta: TaskChangeTaskMeta;
  effectiveOptions: TaskChangeEffectiveOptions;
  reviewability: TaskChangeReviewability;
}): boolean {
  if (input.reviewability !== 'unknown') {
    return false;
  }
  if (!Array.isArray(input.result.files) || !Array.isArray(input.result.warnings)) {
    return false;
  }
  if (input.result.files.length > 0 || input.result.warnings.length > 0) {
    return false;
  }
  const status = getTaskMetaPreferredStatus(input.taskMeta, input.effectiveOptions);
  return (
    getTaskChangeStateBucket({
      status,
      reviewState: input.taskMeta.reviewState,
      historyEvents: input.taskMeta.historyEvents,
      kanbanColumn: input.taskMeta.kanbanColumn,
    }) === 'active'
  );
}

function getTaskMetaPreferredStatus(
  taskMeta: TaskChangeTaskMeta | null,
  effectiveOptions: TaskChangeEffectiveOptions
): string | undefined {
  return taskMeta?.status?.trim() || effectiveOptions.status?.trim() || undefined;
}

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

interface OpenCodeBackfillCacheEntry {
  backfilledAt: number;
  expiresAt: number;
}

interface OpenCodeBackfillAttempt {
  attempted: boolean;
  backfilled: boolean;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    (timeoutId as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

interface OpenCodeDeliveryContextTempFile {
  filePath: string | null;
  hash: string | null;
  cleanup: () => Promise<void>;
}

interface OpenCodeDeliveryContextPayload {
  rawContext: string;
  hash: string;
}

export class ChangeExtractorService {
  private cache = new Map<string, CacheEntry>();
  private taskChangeSummaryCache = new Map<string, TaskChangeSummaryCacheEntry>();
  private taskChangeSummaryInFlight = new Map<string, Promise<TaskChangeSetV2>>();
  private taskChangeSummaryVersionByTask = new Map<string, number>();
  private taskChangeSummaryValidationInFlight = new Set<string>();
  private openCodeBackfillInFlight = new Map<string, Promise<OpenCodeBackfillAttempt>>();
  private openCodeBackfillCache = new Map<string, OpenCodeBackfillCacheEntry>();
  private openCodeTeamEligibilityCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly cacheTtl = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk
  private readonly taskChangeSummaryCacheTtl = 60 * 1000;
  private readonly emptyTaskChangeSummaryCacheTtl = 10 * 1000;
  private readonly persistedTaskChangeSummaryTtl = 24 * 60 * 60 * 1000;
  private readonly openCodeBackfillCacheTtl = 60 * 1000;
  private readonly openCodeTeamEligibilityCacheTtl = 30 * 1000;
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
    private readonly taskChangeWorkerClient: TaskChangeWorkerClient = getTaskChangeWorkerClient(),
    private readonly openCodeLedgerBackfillPort: OpenCodeLedgerBackfillPort | null = null,
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore()
  ) {
    this.taskChangeComputer = new TaskChangeComputer(logsFinder, boundaryParser);
  }

  private readConfigForObservation(teamName: string): Promise<TeamConfig | null> {
    return typeof this.configReader.getConfigSnapshot === 'function'
      ? this.configReader.getConfigSnapshot(teamName)
      : this.configReader.getConfig(teamName);
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
      status: taskMeta?.status?.trim() || options?.status?.trim(),
      intervals: options?.intervals ?? taskMeta?.intervals,
      since: options?.since,
    };
    const projectPath = await this.resolveProjectPath(teamName);
    const cacheOptions: TaskChangeEffectiveOptions = {
      ...effectiveOptions,
      status: getTaskMetaPreferredStatus(taskMeta, effectiveOptions),
    };
    const effectiveStateBucket = taskMeta
      ? getTaskChangeStateBucket({
          status: cacheOptions.status,
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
      const recoveredLedgerResult = await this.recoverWarningOnlyLedgerResult(
        resolvedInput,
        ledgerResult
      );
      const result = recoveredLedgerResult ?? ledgerResult;
      await this.recordTaskChangePresence(teamName, taskId, taskMeta, effectiveOptions, result);
      return result;
    }

    const openCodeBackfill = await this.tryBackfillOpenCodeLedger(resolvedInput);
    if (openCodeBackfill.backfilled || openCodeBackfill.attempted) {
      const backfilledLedgerResult = await this.readLedgerTaskChanges(resolvedInput);
      if (backfilledLedgerResult) {
        await this.recordTaskChangePresence(
          teamName,
          taskId,
          taskMeta,
          effectiveOptions,
          backfilledLedgerResult
        );
        return backfilledLedgerResult;
      }
    }

    if (!shouldUseSummaryCache) {
      const result = await this.computeTaskChangesPreferred(resolvedInput);
      await this.recordTaskChangePresence(teamName, taskId, taskMeta, effectiveOptions, result);
      return result;
    }

    const cacheKey = this.buildTaskChangeSummaryCacheKey(
      teamName,
      taskId,
      cacheOptions,
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
        cacheOptions,
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
          cacheOptions,
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

  async getTeamTaskChangeSummaries(
    teamName: string,
    requests: TeamTaskChangeSummaryRequest[]
  ): Promise<TeamTaskChangeSummariesResponse> {
    const inputRequests = Array.isArray(requests) ? requests : [];
    const seenTaskIds = new Set<string>();
    const uniqueRequests: TeamTaskChangeSummaryRequest[] = [];
    let inspectedRequests = 0;
    for (const request of inputRequests.slice(0, TEAM_TASK_CHANGE_SUMMARY_BATCH_INSPECT_LIMIT)) {
      inspectedRequests += 1;
      if (!request || typeof request !== 'object') {
        continue;
      }
      const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
      if (!taskId || seenTaskIds.has(taskId)) {
        continue;
      }
      seenTaskIds.add(taskId);
      uniqueRequests.push({ ...request, taskId });
      if (uniqueRequests.length > TEAM_TASK_CHANGE_SUMMARY_BATCH_LIMIT) {
        break;
      }
    }
    const cappedRequests = uniqueRequests.slice(0, TEAM_TASK_CHANGE_SUMMARY_BATCH_LIMIT);
    const items: TeamTaskChangeSummaryItem[] = cappedRequests.map((request) => ({
      taskId: request.taskId.trim(),
      changeSet: null,
    }));
    let cursor = 0;
    let timedOut = false;
    const batchDeadline = Date.now() + TEAM_TASK_CHANGE_SUMMARY_BATCH_TIMEOUT_MS;

    const runNext = async (): Promise<void> => {
      while (cursor < cappedRequests.length) {
        const index = cursor;
        cursor += 1;
        const request = cappedRequests[index];
        const taskId = request.taskId.trim();
        const remainingBatchMs = batchDeadline - Date.now();
        if (remainingBatchMs <= 0) {
          timedOut = true;
          continue;
        }

        try {
          const changeSet = await withTimeout(
            this.getTaskChanges(teamName, taskId, {
              ...request.options,
              summaryOnly: true,
            }),
            Math.max(1, Math.min(TEAM_TASK_CHANGE_SUMMARY_TASK_TIMEOUT_MS, remainingBatchMs)),
            'Task change summary timed out; refresh later or open the task logs.'
          );
          items[index] = { taskId, changeSet };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.toLowerCase().includes('timed out')) {
            timedOut = true;
          }
          items[index] = {
            taskId,
            changeSet: null,
            error: message,
          };
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(TEAM_TASK_CHANGE_SUMMARY_BATCH_CONCURRENCY, cappedRequests.length) },
        () => runNext()
      )
    );

    const responseItems = timedOut
      ? items.filter((item) => item.changeSet !== null || Boolean(item.error))
      : items;

    return {
      teamName,
      items: responseItems,
      computedAt: new Date().toISOString(),
      truncated:
        timedOut ||
        uniqueRequests.length > cappedRequests.length ||
        inspectedRequests < inputRequests.length
          ? true
          : undefined,
    };
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

  private async recoverWarningOnlyLedgerResult(
    input: ResolvedTaskChangeComputeInput,
    ledgerResult: TaskChangeSetV2
  ): Promise<TaskChangeSetV2 | null> {
    if (!this.shouldRecoverWarningOnlyLedgerResult(input, ledgerResult)) {
      return null;
    }

    const openCodeBackfill = await this.tryBackfillOpenCodeLedger(input);
    if (openCodeBackfill.backfilled || openCodeBackfill.attempted) {
      const backfilledLedgerResult = await this.readLedgerTaskChanges(input);
      if (backfilledLedgerResult && backfilledLedgerResult.files.length > 0) {
        return this.mergeWarningOnlyLedgerRecovery(ledgerResult, backfilledLedgerResult);
      }
    }

    if (!(await this.shouldUseLegacyWarningOnlyRecovery(input))) {
      return null;
    }

    const fallbackResult = await this.computeTaskChangesPreferred(input);
    if (fallbackResult.files.length === 0) {
      return null;
    }

    return this.mergeWarningOnlyLedgerRecovery(ledgerResult, fallbackResult);
  }

  private shouldRecoverWarningOnlyLedgerResult(
    input: ResolvedTaskChangeComputeInput,
    ledgerResult: TaskChangeSetV2
  ): boolean {
    return (
      ledgerResult.provenance?.sourceKind === 'ledger' &&
      ledgerResult.files.length === 0 &&
      ledgerResult.warnings.some((warning) => warning.trim().length > 0) &&
      this.hasCompletedTaskWorkInterval(input)
    );
  }

  private hasCompletedTaskWorkInterval(input: ResolvedTaskChangeComputeInput): boolean {
    const intervals = input.effectiveOptions.intervals ?? input.taskMeta?.intervals ?? [];
    return intervals.some(
      (interval) =>
        typeof interval.startedAt === 'string' &&
        interval.startedAt.trim().length > 0 &&
        typeof interval.completedAt === 'string' &&
        interval.completedAt.trim().length > 0
    );
  }

  private async shouldUseLegacyWarningOnlyRecovery(
    input: ResolvedTaskChangeComputeInput
  ): Promise<boolean> {
    const providerId = await this.resolveTaskOwnerProviderId(input);
    return providerId === 'codex';
  }

  private async resolveTaskOwnerProviderId(
    input: ResolvedTaskChangeComputeInput
  ): Promise<string | null> {
    const owner = (input.effectiveOptions.owner ?? input.taskMeta?.owner ?? '')
      .trim()
      .toLowerCase();
    if (!owner) {
      return null;
    }

    try {
      const config = await this.readConfigForObservation(input.teamName);
      const member = (config?.members ?? []).find(
        (candidate) => candidate.name.trim().toLowerCase() === owner
      );
      return member?.providerId ?? null;
    } catch {
      return null;
    }
  }

  private mergeWarningOnlyLedgerRecovery(
    warningOnlyLedger: TaskChangeSetV2,
    recovered: TaskChangeSetV2
  ): TaskChangeSetV2 {
    return {
      ...recovered,
      warnings: this.mergeTaskChangeWarnings(warningOnlyLedger.warnings, recovered.warnings),
    };
  }

  private mergeTaskChangeWarnings(...groups: string[][]): string[] {
    const warnings = new Set<string>();
    for (const group of groups) {
      for (const warning of group) {
        const trimmed = warning.trim();
        if (trimmed) warnings.add(trimmed);
      }
    }
    return [...warnings];
  }

  private async tryBackfillOpenCodeLedger(
    input: ResolvedTaskChangeComputeInput
  ): Promise<OpenCodeBackfillAttempt> {
    if (!this.openCodeLedgerBackfillPort) {
      return { attempted: false, backfilled: false };
    }
    if (!(await this.isOpenCodeTeamCandidate(input.teamName))) {
      return { attempted: false, backfilled: false };
    }
    if (typeof this.logsFinder.getLogSourceWatchContext !== 'function') {
      return { attempted: false, backfilled: false };
    }

    const context = await this.logsFinder
      .getLogSourceWatchContext(input.teamName)
      .catch(() => null);
    const projectDir = context?.projectDir;
    const workspaceRoot = input.projectPath ?? context?.projectPath;
    if (
      !projectDir ||
      !workspaceRoot ||
      !path.isAbsolute(projectDir) ||
      !path.isAbsolute(workspaceRoot)
    ) {
      return { attempted: false, backfilled: false };
    }

    const sourceGeneration = this.teamLogSourceTracker
      ? await this.teamLogSourceTracker
          .ensureTracking(input.teamName)
          .then((snapshot) => snapshot.logSourceGeneration)
          .catch(() => null)
      : null;
    const deliveryContextRecords = await this.readOpenCodeDeliveryContextRecords(
      input.teamName,
      input.taskId
    );
    const deliveryContextPayload = this.buildOpenCodeDeliveryContextPayload(
      input.teamName,
      input.taskId,
      deliveryContextRecords
    );
    const backfillMemberName = this.resolveOpenCodeBackfillMemberName(
      input.effectiveOptions.owner,
      deliveryContextRecords
    );
    const deliveryContextFingerprint = deliveryContextPayload.hash;

    const cacheKey = this.buildOpenCodeBackfillCacheKey({
      teamName: input.teamName,
      taskId: input.taskId,
      projectDir,
      workspaceRoot,
      displayId: input.taskMeta?.displayId,
      sourceGeneration,
      deliveryContextFingerprint,
      attributionMode: OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE,
      evidencePipeline: OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE,
    });
    const now = Date.now();
    const cached = this.openCodeBackfillCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { attempted: false, backfilled: cached.backfilledAt > 0 };
    }
    this.openCodeBackfillCache.delete(cacheKey);

    if (deliveryContextRecords.length === 0) {
      this.openCodeBackfillCache.set(cacheKey, {
        backfilledAt: 0,
        expiresAt: Date.now() + this.openCodeBackfillCacheTtl,
      });
      void appendOpenCodeTaskChangeDiag({
        event: 'backfill_skipped',
        reason: 'no-delivery-context',
        teamName: input.teamName,
        taskId: input.taskId,
        displayId: input.taskMeta?.displayId ?? null,
        memberName: backfillMemberName ?? input.effectiveOptions.owner ?? null,
        projectDir,
        workspaceRoot,
        sourceGeneration,
        deliveryRecordCount: 0,
        deliveryContextFingerprint,
        attributionMode: OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE,
        evidencePipeline: OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE,
      }).catch(() => undefined);
      return { attempted: false, backfilled: false };
    }

    const existing = this.openCodeBackfillInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = this.runOpenCodeBackfill(
      input,
      projectDir,
      workspaceRoot,
      cacheKey,
      deliveryContextRecords,
      deliveryContextPayload,
      sourceGeneration,
      backfillMemberName
    ).finally(() => {
      this.openCodeBackfillInFlight.delete(cacheKey);
    });
    this.openCodeBackfillInFlight.set(cacheKey, promise);
    return promise;
  }

  private async runOpenCodeBackfill(
    input: ResolvedTaskChangeComputeInput,
    projectDir: string,
    workspaceRoot: string,
    cacheKey: string,
    deliveryContextRecords: Awaited<
      ReturnType<ChangeExtractorService['readOpenCodeDeliveryContextRecords']>
    >,
    deliveryContextPayload: OpenCodeDeliveryContextPayload,
    sourceGeneration: string | null,
    backfillMemberName?: string
  ): Promise<OpenCodeBackfillAttempt> {
    const deliveryContext = await this.createOpenCodeDeliveryContextTempFile(
      input.teamName,
      input.taskId,
      deliveryContextRecords,
      deliveryContextPayload
    );
    try {
      const result = await this.openCodeLedgerBackfillPort!.backfillOpenCodeTaskLedger({
        teamId: input.teamName,
        teamName: input.teamName,
        taskId: input.taskId,
        taskDisplayId: input.taskMeta?.displayId,
        projectDir,
        workspaceRoot,
        attributionMode: OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE,
        ...(backfillMemberName ? { memberName: backfillMemberName } : {}),
        ...(deliveryContext.filePath
          ? {
              deliveryContextPath: deliveryContext.filePath,
              deliveryContextHash: deliveryContext.hash ?? undefined,
            }
          : {}),
      });
      const evidenceContractVersion =
        typeof result.opencodeTaskLedgerEvidenceContractVersion === 'number' &&
        Number.isInteger(result.opencodeTaskLedgerEvidenceContractVersion)
          ? result.opencodeTaskLedgerEvidenceContractVersion
          : 0;
      const hasExpectedEvidenceContract =
        evidenceContractVersion >= OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION;
      const diagnostics = hasExpectedEvidenceContract
        ? (result.diagnostics ?? [])
        : [
            `OpenCode task ledger evidence contract is unsupported or missing: ${evidenceContractVersion}.`,
            ...(result.diagnostics ?? []),
          ];
      void appendOpenCodeTaskChangeDiag({
        event: 'backfill_result',
        reason:
          !hasExpectedEvidenceContract && result.importedEvents <= 0
            ? 'unsupported-evidence-contract'
            : this.classifyOpenCodeBackfillResult(result),
        teamName: input.teamName,
        taskId: input.taskId,
        displayId: input.taskMeta?.displayId ?? null,
        memberName: backfillMemberName ?? input.effectiveOptions.owner ?? null,
        projectDir,
        workspaceRoot,
        sourceGeneration,
        deliveryRecordCount: deliveryContextRecords.length,
        deliveryContextFingerprint: deliveryContextPayload.hash,
        evidencePipeline: OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE,
        result: {
          opencodeTaskLedgerEvidenceContractVersion: evidenceContractVersion,
          attributionMode: result.attributionMode ?? OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE,
          outcome: result.outcome,
          dryRun: result.dryRun,
          scannedSessions: result.scannedSessions,
          scannedToolparts: result.scannedToolparts,
          candidateEvents: result.candidateEvents,
          importedEvents: result.importedEvents,
          skippedEvents: result.skippedEvents,
        },
        diagnostics: diagnostics.slice(0, 25),
        notices: (result.notices ?? []).slice(0, 25),
      }).catch(() => undefined);
      const backfilled =
        result.importedEvents > 0 ||
        (hasExpectedEvidenceContract &&
          (result.outcome === 'imported' ||
            (result.outcome === 'duplicates-only' && result.candidateEvents > 0)));

      if (result.importedEvents > 0) {
        await this.invalidateTaskChangeSummaries(input.teamName, [input.taskId], {
          deletePersisted: true,
        });
      }

      if ((hasExpectedEvidenceContract && backfilled) || deliveryContextRecords.length === 0) {
        this.openCodeBackfillCache.set(cacheKey, {
          backfilledAt: backfilled ? Date.now() : 0,
          expiresAt: Date.now() + this.openCodeBackfillCacheTtl,
        });
      } else {
        this.openCodeBackfillCache.delete(cacheKey);
      }

      if (diagnostics.length > 0 && result.outcome !== 'no-history') {
        logger.debug(
          `OpenCode ledger backfill for ${input.teamName}/${input.taskId}: ${result.outcome}; ${diagnostics.join('; ')}`
        );
      }
      return { attempted: true, backfilled };
    } catch (error) {
      logger.warn(
        `OpenCode ledger backfill failed for ${input.teamName}/${input.taskId}: ${error instanceof Error ? error.message : String(error)}`
      );
      void appendOpenCodeTaskChangeDiag({
        event: 'backfill_exception',
        reason: 'exception',
        teamName: input.teamName,
        taskId: input.taskId,
        displayId: input.taskMeta?.displayId ?? null,
        memberName: backfillMemberName ?? input.effectiveOptions.owner ?? null,
        projectDir,
        workspaceRoot,
        deliveryRecordCount: deliveryContextRecords.length,
        deliveryContextFingerprint: deliveryContextPayload.hash,
        evidencePipeline: OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      if (deliveryContextRecords.length === 0) {
        this.openCodeBackfillCache.set(cacheKey, {
          backfilledAt: 0,
          expiresAt: Date.now() + this.openCodeBackfillCacheTtl,
        });
      } else {
        this.openCodeBackfillCache.delete(cacheKey);
      }
      return { attempted: true, backfilled: false };
    } finally {
      await deliveryContext.cleanup();
    }
  }

  private classifyOpenCodeBackfillResult(
    result: Awaited<ReturnType<OpenCodeLedgerBackfillPort['backfillOpenCodeTaskLedger']>>
  ): string {
    if (result.importedEvents > 0) {
      return 'imported';
    }
    if (result.candidateEvents > 0 && result.outcome === 'duplicates-only') {
      return 'duplicates-only';
    }
    if (result.scannedSessions > 0 && result.scannedToolparts > 0 && result.candidateEvents === 0) {
      return 'no-write-edit-candidates';
    }
    if (result.outcome === 'no-attribution') {
      return 'no-attribution';
    }
    if (result.outcome === 'no-history') {
      return 'no-history';
    }
    return result.outcome;
  }

  private async isOpenCodeTeamCandidate(teamName: string): Promise<boolean> {
    const cached = this.openCodeTeamEligibilityCache.get(teamName);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    let value = false;
    try {
      const [meta, config] = await Promise.all([
        this.teamMetaStore.getMeta(teamName).catch(() => null),
        this.readConfigForObservation(teamName).catch(() => null),
      ]);
      const hasOpenCodeMember = (config?.members ?? []).some(
        (member) => member.providerId === 'opencode'
      );
      const hasExplicitNonOpenCodeProvider =
        (meta?.providerId != null && meta.providerId !== 'opencode') ||
        ((config?.members?.length ?? 0) > 0 &&
          !hasOpenCodeMember &&
          (config?.members ?? []).some((member) => typeof member.providerId === 'string'));
      value =
        meta?.providerId === 'opencode' ||
        hasOpenCodeMember ||
        (!hasExplicitNonOpenCodeProvider &&
          existsSync(getOpenCodeTeamRuntimeDirectory(getTeamsBasePath(), teamName)));
    } catch {
      value = false;
    }

    this.openCodeTeamEligibilityCache.set(teamName, {
      value,
      expiresAt: now + this.openCodeTeamEligibilityCacheTtl,
    });
    return value;
  }

  private async createOpenCodeDeliveryContextTempFile(
    teamName: string,
    taskId: string,
    records: Awaited<ReturnType<ChangeExtractorService['readOpenCodeDeliveryContextRecords']>>,
    payload = this.buildOpenCodeDeliveryContextPayload(teamName, taskId, records)
  ): Promise<OpenCodeDeliveryContextTempFile> {
    if (records.length === 0) {
      return { filePath: null, hash: null, cleanup: async () => undefined };
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-team-opencode-ledger-context-'));
    await chmod(dir, 0o700).catch(() => undefined);
    const filePath = path.join(dir, 'delivery-context.json');
    await writeFile(filePath, payload.rawContext, { encoding: 'utf8', mode: 0o600 });
    return {
      filePath,
      hash: payload.hash,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  private buildOpenCodeDeliveryContextPayload(
    teamName: string,
    taskId: string,
    records: Awaited<ReturnType<ChangeExtractorService['readOpenCodeDeliveryContextRecords']>>
  ): OpenCodeDeliveryContextPayload {
    const rawContext = `${JSON.stringify(
      {
        schemaVersion: 1,
        teamName,
        taskId,
        records,
      },
      null,
      2
    )}\n`;
    return {
      hash: createHash('sha256').update(rawContext).digest('hex'),
      rawContext,
    };
  }

  private async readOpenCodeDeliveryContextRecords(
    teamName: string,
    taskId: string
  ): Promise<
    {
      memberName: string;
      laneId?: string;
      runtimeSessionId: string | null;
      inboxMessageId: string | null;
      deliveredUserMessageId: string | null;
      observedAssistantMessageId: string | null;
      prePromptCursor: string | null;
      postPromptCursor: string | null;
      taskRefs: { taskId: string; displayId: string; teamName: string }[];
    }[]
  > {
    const teamsBasePath = getTeamsBasePath();
    const laneIds = new Set<string>(['primary']);
    try {
      const index = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName);
      for (const laneId of Object.keys(index.lanes)) {
        if (laneId.trim()) laneIds.add(laneId);
      }
    } catch {
      // Old teams may not have a lane index. The primary fallback covers the initial runtime shape.
    }
    for (const laneId of await this.readOpenCodeRuntimeLaneIdsFromDisk(teamsBasePath, teamName)) {
      laneIds.add(laneId);
    }

    const records: {
      memberName: string;
      laneId?: string;
      runtimeSessionId: string | null;
      inboxMessageId: string | null;
      deliveredUserMessageId: string | null;
      observedAssistantMessageId: string | null;
      prePromptCursor: string | null;
      postPromptCursor: string | null;
      taskRefs: { taskId: string; displayId: string; teamName: string }[];
    }[] = [];

    for (const laneId of laneIds) {
      const filePath = getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath,
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      });
      const laneRecords = await this.readOpenCodePromptDeliveryLedgerRecords(filePath);
      for (const record of laneRecords) {
        if (record.teamName !== teamName) continue;
        const taskRefs = record.taskRefs.filter((taskRef) => taskRef.teamName === teamName);
        if (!taskRefs.some((taskRef) => taskRef.taskId === taskId)) continue;
        records.push({
          memberName: record.memberName,
          laneId: record.laneId || laneId,
          runtimeSessionId: record.runtimeSessionId,
          inboxMessageId: record.inboxMessageId,
          deliveredUserMessageId: record.deliveredUserMessageId,
          observedAssistantMessageId: record.observedAssistantMessageId,
          prePromptCursor: record.prePromptCursor,
          postPromptCursor: record.postPromptCursor,
          taskRefs,
        });
      }
    }

    return records.slice(-200);
  }

  private resolveOpenCodeBackfillMemberName(
    owner: string | undefined,
    records: Awaited<ReturnType<ChangeExtractorService['readOpenCodeDeliveryContextRecords']>>
  ): string | undefined {
    const members = [...new Set(records.map((record) => record.memberName.trim()).filter(Boolean))];
    const normalizedOwner = owner?.trim();
    if (normalizedOwner && members.includes(normalizedOwner)) {
      return normalizedOwner;
    }
    return members.length === 1 ? members[0] : undefined;
  }

  private async readOpenCodeRuntimeLaneIdsFromDisk(
    teamsBasePath: string,
    teamName: string
  ): Promise<string[]> {
    const lanesDir = path.join(getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName), 'lanes');
    const entries = await readdir(lanesDir, { withFileTypes: true }).catch(() => []);
    const laneIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let laneId: string;
      try {
        laneId = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      if (!laneId.trim() || laneId.includes('\0')) continue;
      laneIds.push(laneId);
      if (laneIds.length >= OPEN_CODE_MAX_DISCOVERED_LANES) break;
    }
    return laneIds.sort((left, right) => left.localeCompare(right));
  }

  private async readOpenCodePromptDeliveryLedgerRecords(
    filePath: string
  ): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    try {
      const raw = await readFile(filePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
        return [];
      }
      const parsed = JSON.parse(raw) as { data?: unknown };
      if (!Array.isArray(parsed.data)) {
        return [];
      }
      return parsed.data.filter(isOpenCodePromptDeliveryLedgerRecord);
    } catch {
      return [];
    }
  }

  private buildOpenCodeBackfillCacheKey(input: {
    teamName: string;
    taskId: string;
    displayId?: string;
    projectDir: string;
    workspaceRoot: string;
    sourceGeneration?: string | null;
    deliveryContextFingerprint: string;
    attributionMode: typeof OPEN_CODE_AUTO_BACKFILL_ATTRIBUTION_MODE;
    evidencePipeline: typeof OPEN_CODE_AUTO_BACKFILL_EVIDENCE_PIPELINE;
  }): string {
    return JSON.stringify({
      teamName: input.teamName,
      taskId: input.taskId,
      displayId: input.displayId ?? '',
      projectDir: normalizeTaskChangePresenceFilePath(input.projectDir),
      workspaceRoot: normalizeTaskChangePresenceFilePath(input.workspaceRoot),
      sourceGeneration: input.sourceGeneration ?? '',
      deliveryContextFingerprint: input.deliveryContextFingerprint,
      attributionMode: input.attributionMode,
      evidencePipeline: input.evidencePipeline,
    });
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
        displayId:
          typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
            ? parsed.displayId.trim()
            : undefined,
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
      const config = await this.readConfigForObservation(teamName);
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
      status: getTaskMetaPreferredStatus(taskMeta, effectiveOptions),
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
      status: getTaskMetaPreferredStatus(currentTaskMeta, effectiveOptions),
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

    const reviewability = classifyTaskChangeReviewability(result);
    const resolvedPresence = resolveTaskChangePresenceFromResult(result);
    if (!resolvedPresence) {
      if (
        reviewability.reviewability === 'diagnostic_only' ||
        shouldClearStaleTaskChangePresence({
          result,
          taskMeta,
          effectiveOptions,
          reviewability: reviewability.reviewability,
        })
      ) {
        await this.taskChangePresenceRepository.deleteEntry?.(teamName, taskId);
      }
      return;
    }

    const descriptor = buildTaskChangePresenceDescriptor({
      createdAt: taskMeta.createdAt,
      owner: effectiveOptions.owner ?? taskMeta.owner,
      status: getTaskMetaPreferredStatus(taskMeta, effectiveOptions),
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

function isOpenCodePromptDeliveryLedgerRecord(
  value: unknown
): value is OpenCodePromptDeliveryLedgerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.teamName === 'string' &&
    typeof record.memberName === 'string' &&
    typeof record.laneId === 'string' &&
    typeof record.inboxMessageId === 'string' &&
    Array.isArray(record.taskRefs) &&
    record.taskRefs.every(isOpenCodeTaskRefLike) &&
    isNullableString(record.runtimeSessionId) &&
    isNullableString(record.deliveredUserMessageId) &&
    isNullableString(record.observedAssistantMessageId) &&
    isNullableString(record.prePromptCursor) &&
    isNullableString(record.postPromptCursor)
  );
}

function isOpenCodeTaskRefLike(
  value: unknown
): value is { taskId: string; displayId: string; teamName: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.taskId === 'string' &&
    ref.taskId.length > 0 &&
    typeof ref.displayId === 'string' &&
    typeof ref.teamName === 'string' &&
    ref.teamName.length > 0
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
