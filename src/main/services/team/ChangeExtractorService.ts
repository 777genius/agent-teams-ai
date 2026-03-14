import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import {
  getTaskChangeStateBucket,
  isTaskChangeSummaryCacheable,
  type TaskChangeStateBucket,
} from '@shared/utils/taskChangeState';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import { JsonTaskChangeSummaryCacheRepository } from './cache/JsonTaskChangeSummaryCacheRepository';
import { TeamConfigReader } from './TeamConfigReader';
import { countLineChanges } from './UnifiedLineCounter';

import type { TaskBoundaryParser } from './TaskBoundaryParser';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type {
  AgentChangeSet,
  ChangeStats,
  FileChangeSummary,
  FileEditEvent,
  FileEditTimeline,
  SnippetDiff,
  TaskChangeScope,
  TaskChangeSetV2,
} from '@shared/types';

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

interface ParsedSnippetsCacheEntry {
  data: SnippetDiff[];
  mtime: number;
  expiresAt: number;
}

/** Ссылка на JSONL файл с привязкой к memberName */
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
  private parsedSnippetsCache = new Map<string, ParsedSnippetsCacheEntry>();
  private readonly cacheTtl = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk
  private readonly taskChangeSummaryCacheTtl = 60 * 1000;
  private readonly emptyTaskChangeSummaryCacheTtl = 10 * 1000;
  private readonly persistedTaskChangeSummaryTtl = 24 * 60 * 60 * 1000;
  private readonly maxTaskChangeSummaryCacheEntries = 200;
  private readonly parsedSnippetsCacheTtl = 20 * 1000; // 20 сек для parsed JSONL snippets
  private readonly isPersistedTaskChangeCacheEnabled =
    process.env.CLAUDE_TEAM_ENABLE_PERSISTED_TASK_CHANGE_CACHE !== '0';

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly boundaryParser: TaskBoundaryParser,
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskChangeSummaryRepository = new JsonTaskChangeSummaryCacheRepository()
  ) {}

  /** Получить все изменения агента */
  async getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet> {
    const cacheKey = `${teamName}:${memberName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
    const projectPath = await this.resolveProjectPath(teamName);

    // Собираем все snippets из всех JSONL файлов параллельно
    const parseResults = await this.parseJSONLFilesWithConcurrency(paths);
    let latestMtime = 0;
    const merged: SnippetDiff[] = [];
    for (const r of parseResults) {
      merged.push(...r.snippets);
      if (r.mtime > latestMtime) latestMtime = r.mtime;
    }
    const allSnippets = this.sortSnippetsChronologically(merged);

    const files = this.aggregateByFile(allSnippets, projectPath);

    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    for (const file of files) {
      totalLinesAdded += file.linesAdded;
      totalLinesRemoved += file.linesRemoved;
    }

    const result: AgentChangeSet = {
      teamName,
      memberName,
      files,
      totalLinesAdded,
      totalLinesRemoved,
      totalFiles: files.length,
      computedAt: new Date().toISOString(),
    };

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
    const includeDetails = options?.summaryOnly !== true;
    const taskMeta = await this.readTaskMeta(teamName, taskId);
    const effectiveOptions = {
      owner: options?.owner ?? taskMeta?.owner,
      status: options?.status ?? taskMeta?.status,
      intervals: options?.intervals ?? taskMeta?.intervals,
      since: options?.since,
    };
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

    if (!summaryCacheableState || options?.forceFresh === true) {
      await this.invalidateTaskChangeSummaries(teamName, [taskId], {
        deletePersisted: true,
      });
    }

    if (!shouldUseSummaryCache) {
      return this.computeTaskChanges(teamName, taskId, effectiveOptions, includeDetails);
    }

    const cacheKey = this.buildTaskChangeSummaryCacheKey(
      teamName,
      taskId,
      effectiveOptions,
      effectiveStateBucket
    );
    const version = this.getTaskChangeSummaryVersion(teamName, taskId);

    if (options?.forceFresh !== true) {
      const cached = this.taskChangeSummaryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
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
        return persisted;
      }
    }

    const promise = this.computeTaskChanges(teamName, taskId, effectiveOptions, false)
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

  private async computeTaskChanges(
    teamName: string,
    taskId: string,
    effectiveOptions: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
    includeDetails: boolean
  ): Promise<TaskChangeSetV2> {
    const taskMeta = await this.readTaskMeta(teamName, taskId);
    const logRefs = await this.logsFinder.findLogFileRefsForTask(
      teamName,
      taskId,
      effectiveOptions
    );
    if (logRefs.length === 0) {
      return this.emptyTaskChangeSet(teamName, taskId);
    }

    const projectPath = await this.resolveProjectPath(teamName);

    // Парсим boundaries для каждого лог-файла и ищем scope данной задачи
    const allScopes: TaskChangeScope[] = [];
    for (const ref of logRefs) {
      const boundaries = await this.boundaryParser.parseBoundaries(ref.filePath);
      const scope = boundaries.scopes.find((s) => s.taskId === taskId);
      if (scope) {
        allScopes.push({ ...scope, memberName: ref.memberName });
      }
    }

    // Если scope не найден — try deterministic interval scoping, else fallback to whole file
    if (allScopes.length === 0) {
      const intervals = effectiveOptions.intervals;
      if (Array.isArray(intervals) && intervals.length > 0) {
        const { files, toolUseIds, startTimestamp, endTimestamp } =
          await this.extractIntervalScopedChanges(logRefs, intervals, projectPath, includeDetails);

        return {
          teamName,
          taskId,
          files,
          totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
          totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
          totalFiles: files.length,
          confidence: 'medium',
          computedAt: new Date().toISOString(),
          scope: {
            taskId,
            memberName: taskMeta?.owner ?? logRefs[0]?.memberName ?? '',
            startLine: 0,
            endLine: 0,
            startTimestamp,
            endTimestamp,
            toolUseIds,
            filePaths: files.map((f) => f.filePath),
            confidence: {
              tier: 2,
              label: 'medium',
              reason: 'Scoped by persisted task workIntervals (timestamp-based)',
            },
          },
          warnings:
            files.length === 0
              ? ['No file edits found within persisted workIntervals.']
              : ['Task boundaries missing — scoped by workIntervals timestamps.'],
        };
      }

      return this.fallbackSingleTaskScope(teamName, taskId, logRefs, projectPath, includeDetails);
    }

    const allowedToolUseIds = new Set(allScopes.flatMap((scope) => scope.toolUseIds));
    const files = await this.extractFilteredChanges(
      logRefs,
      allowedToolUseIds,
      projectPath,
      includeDetails
    );

    const worstTier = Math.max(...allScopes.map((scope) => scope.confidence.tier));
    return {
      teamName,
      taskId,
      files,
      totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
      totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
      totalFiles: files.length,
      confidence: worstTier <= 1 ? 'high' : worstTier <= 2 ? 'medium' : 'low',
      computedAt: new Date().toISOString(),
      scope: allScopes[0],
      warnings: worstTier >= 3 ? ['Some task boundaries could not be precisely determined.'] : [],
    };
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
  private async readTaskMeta(
    teamName: string,
    taskId: string
  ): Promise<{
    owner?: string;
    status?: string;
    intervals?: { startedAt: string; completedAt?: string }[];
    reviewState?: 'review' | 'needsFix' | 'approved' | 'none';
    historyEvents?: unknown[];
    kanbanColumn?: 'review' | 'approved';
  } | null> {
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

  private async extractIntervalScopedChanges(
    logRefs: LogFileRef[],
    intervals: { startedAt: string; completedAt?: string }[],
    projectPath?: string,
    includeDetails = true
  ): Promise<{
    files: FileChangeSummary[];
    toolUseIds: string[];
    startTimestamp: string;
    endTimestamp: string;
  }> {
    const normalized: {
      startMs: number;
      endMs: number | null;
      startedAt: string;
      completedAt?: string;
    }[] = [];

    for (const i of intervals) {
      const startMs = Date.parse(i.startedAt);
      if (!Number.isFinite(startMs)) continue;
      const endMsRaw = typeof i.completedAt === 'string' ? Date.parse(i.completedAt) : Number.NaN;
      const endMs = Number.isFinite(endMsRaw) ? endMsRaw : null;
      normalized.push({ startMs, endMs, startedAt: i.startedAt, completedAt: i.completedAt });
    }

    normalized.sort((a, b) => a.startMs - b.startMs);
    const startTimestamp = normalized[0]?.startedAt ?? '';

    const maxEnd = normalized.reduce<{ endMs: number; endTimestamp: string } | null>((acc, it) => {
      if (it.endMs == null || typeof it.completedAt !== 'string') return acc;
      if (!acc || it.endMs > acc.endMs) return { endMs: it.endMs, endTimestamp: it.completedAt };
      return acc;
    }, null);
    const endTimestamp = maxEnd?.endTimestamp ?? '';

    const inAnyInterval = (ts: string): boolean => {
      const ms = Date.parse(ts);
      if (!Number.isFinite(ms)) return false;
      for (const it of normalized) {
        if (ms < it.startMs) continue;
        if (it.endMs == null) return true;
        if (ms <= it.endMs) return true;
      }
      return false;
    };

    const allParsed = await this.parseJSONLFilesWithConcurrency(logRefs.map((ref) => ref.filePath));
    const allowedSnippets: SnippetDiff[] = [];
    const toolUseIdsSet = new Set<string>();

    for (const { snippets } of allParsed) {
      for (const s of snippets) {
        if (s.isError) continue;
        if (!inAnyInterval(s.timestamp)) continue;
        allowedSnippets.push(s);
        if (s.toolUseId) toolUseIdsSet.add(s.toolUseId);
      }
    }

    const files = this.aggregateByFile(
      this.sortSnippetsChronologically(allowedSnippets),
      projectPath,
      includeDetails
    );
    return {
      files,
      toolUseIds: [...toolUseIdsSet],
      startTimestamp,
      endTimestamp,
    };
  }

  /**
   * Compute a context hash from old/newString for reliable hunk↔snippet matching.
   * Uses first+last 3 lines of both strings as a fingerprint.
   */
  private computeContextHash(oldString: string, newString: string): string {
    const take3 = (s: string): string => {
      const lines = s.split('\n');
      const head = lines.slice(0, 3).join('\n');
      const tail = lines.length > 3 ? lines.slice(-3).join('\n') : '';
      return `${head}|${tail}`;
    };
    const raw = `${take3(oldString)}::${take3(newString)}`;
    // Simple hash: DJB2 variant (fast, no crypto needed)
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  /** Deterministic sort: timestamp → filePath → toolUseId → originalIndex */
  private sortSnippetsChronologically(snippets: SnippetDiff[]): SnippetDiff[] {
    return snippets
      .map((snippet, originalIndex) => ({ snippet, originalIndex }))
      .sort((a, b) => {
        const aMs = Date.parse(a.snippet.timestamp);
        const bMs = Date.parse(b.snippet.timestamp);
        const safeA = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
        const safeB = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
        if (safeA !== safeB) return safeA - safeB;
        if (a.snippet.filePath !== b.snippet.filePath)
          return a.snippet.filePath.localeCompare(b.snippet.filePath);
        if (a.snippet.toolUseId !== b.snippet.toolUseId)
          return a.snippet.toolUseId.localeCompare(b.snippet.toolUseId);
        return a.originalIndex - b.originalIndex;
      })
      .map(({ snippet }) => snippet);
  }

  /** Parse multiple JSONL files with bounded concurrency (worker-pool) */
  private static readonly JSONL_PARSE_CONCURRENCY = 6;

  private async parseJSONLFilesWithConcurrency(
    paths: string[]
  ): Promise<Array<{ snippets: SnippetDiff[]; mtime: number }>> {
    if (paths.length === 0) return [];

    const results = new Array<{ snippets: SnippetDiff[]; mtime: number }>(paths.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= paths.length) return;
        results[currentIndex] = await this.parseJSONLFile(paths[currentIndex]);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(ChangeExtractorService.JSONL_PARSE_CONCURRENCY, paths.length) },
        () => worker()
      )
    );

    return results;
  }

  /** Парсить один JSONL файл и извлечь все snippets (двухпроходный подход) */
  private async parseJSONLFile(
    filePath: string
  ): Promise<{ snippets: SnippetDiff[]; mtime: number }> {
    let fileMtime = 0;
    try {
      const fileStat = await stat(filePath);
      fileMtime = fileStat.mtimeMs;
      const cached = this.parsedSnippetsCache.get(filePath);
      if (cached?.mtime === fileMtime && cached.expiresAt > Date.now()) {
        return { snippets: cached.data, mtime: fileMtime };
      }
    } catch (err) {
      logger.debug(`Не удалось stat файла ${filePath}: ${String(err)}`);
      return { snippets: [], mtime: 0 };
    }

    // Сначала считываем все записи в память для двух проходов
    const entries: Record<string, unknown>[] = [];

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Пропускаем невалидный JSON
        }
      }

      rl.close();
      stream.destroy();
    } catch (err) {
      logger.debug(`Не удалось прочитать файл ${filePath}: ${String(err)}`);
      return { snippets: [], mtime: 0 };
    }

    // Проход 1: собираем tool_use_id с ошибками
    const erroredIds = this.collectErroredToolUseIds(entries);

    // Проход 2: извлекаем snippets из tool_use блоков
    const snippets: SnippetDiff[] = [];
    // Множество уже встречавшихся файлов (для определения write-new vs write-update)
    const seenFiles = new Set<string>();

    for (const entry of entries) {
      const role = this.extractRole(entry);
      if (role !== 'assistant') continue;

      const content = this.extractContent(entry);
      if (!content) continue;

      const timestamp =
        typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();

      for (const block of content) {
        if (
          !block ||
          typeof block !== 'object' ||
          (block as Record<string, unknown>).type !== 'tool_use'
        ) {
          continue;
        }

        const toolBlock = block as Record<string, unknown>;
        const rawName = typeof toolBlock.name === 'string' ? toolBlock.name : '';
        // Убираем proxy_ префикс
        const toolName = rawName.startsWith('proxy_') ? rawName.slice(6) : rawName;
        const toolUseId = typeof toolBlock.id === 'string' ? toolBlock.id : '';
        const input = toolBlock.input as Record<string, unknown> | undefined;
        if (!input) continue;

        const isError = erroredIds.has(toolUseId);

        if (toolName === 'Edit') {
          const targetPath = typeof input.file_path === 'string' ? input.file_path : '';
          const oldString = typeof input.old_string === 'string' ? input.old_string : '';
          const newString = typeof input.new_string === 'string' ? input.new_string : '';
          const replaceAll = input.replace_all === true;

          if (targetPath) {
            seenFiles.add(this.normalizeFilePathKey(targetPath));
            snippets.push({
              toolUseId,
              filePath: targetPath,
              toolName: 'Edit',
              type: 'edit',
              oldString,
              newString,
              replaceAll,
              timestamp,
              isError,
              contextHash: this.computeContextHash(oldString, newString),
            });
          }
        } else if (toolName === 'Write') {
          const targetPath = typeof input.file_path === 'string' ? input.file_path : '';
          const writeContent = typeof input.content === 'string' ? input.content : '';

          if (targetPath) {
            const normalizedTargetPath = this.normalizeFilePathKey(targetPath);
            const isNew = !seenFiles.has(normalizedTargetPath);
            seenFiles.add(normalizedTargetPath);
            snippets.push({
              toolUseId,
              filePath: targetPath,
              toolName: 'Write',
              type: isNew ? 'write-new' : 'write-update',
              oldString: '',
              newString: writeContent,
              replaceAll: false,
              timestamp,
              isError,
              contextHash: this.computeContextHash('', writeContent),
            });
          }
        } else if (toolName === 'MultiEdit') {
          const targetPath = typeof input.file_path === 'string' ? input.file_path : '';
          const edits = Array.isArray(input.edits) ? input.edits : [];

          if (targetPath) {
            seenFiles.add(this.normalizeFilePathKey(targetPath));
            for (const edit of edits) {
              if (!edit || typeof edit !== 'object') continue;
              const editObj = edit as Record<string, unknown>;
              const oldString = typeof editObj.old_string === 'string' ? editObj.old_string : '';
              const newString = typeof editObj.new_string === 'string' ? editObj.new_string : '';
              snippets.push({
                toolUseId,
                filePath: targetPath,
                toolName: 'MultiEdit',
                type: 'multi-edit',
                oldString,
                newString,
                replaceAll: false,
                timestamp,
                isError,
                contextHash: this.computeContextHash(oldString, newString),
              });
            }
          }
        }
        // Остальные инструменты (NotebookEdit и пр.) пропускаем
      }
    }

    this.parsedSnippetsCache.set(filePath, {
      data: snippets,
      mtime: fileMtime,
      expiresAt: Date.now() + this.parsedSnippetsCacheTtl,
    });

    return { snippets, mtime: fileMtime };
  }

  /** Извлечь content array из JSONL entry (оба формата: subagent и main) */
  private extractContent(entry: Record<string, unknown>): unknown[] | null {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) return message.content as unknown[];
    if (Array.isArray(entry.content)) return entry.content as unknown[];
    return null;
  }

  /** Извлечь роль из JSONL entry */
  private extractRole(entry: Record<string, unknown>): string | null {
    if (typeof entry.role === 'string') return entry.role;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && typeof message.role === 'string') return message.role;
    return null;
  }

  /** Собрать errored tool_use_ids из tool_result блоков */
  private collectErroredToolUseIds(entries: Record<string, unknown>[]): Set<string> {
    const erroredIds = new Set<string>();

    for (const entry of entries) {
      // tool_result может находиться в entry.content (когда это массив)
      if (Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (this.isErroredToolResult(block)) {
            const toolUseId = (block as Record<string, unknown>).tool_use_id;
            if (typeof toolUseId === 'string') {
              erroredIds.add(toolUseId);
            }
          }
        }
      }

      // Также проверяем entry.message.content
      const message = entry.message as Record<string, unknown> | undefined;
      if (message && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (this.isErroredToolResult(block)) {
            const toolUseId = (block as Record<string, unknown>).tool_use_id;
            if (typeof toolUseId === 'string') {
              erroredIds.add(toolUseId);
            }
          }
        }
      }
    }

    return erroredIds;
  }

  /** Проверить, является ли блок tool_result с ошибкой */
  private isErroredToolResult(block: unknown): boolean {
    if (!block || typeof block !== 'object') return false;
    const obj = block as Record<string, unknown>;
    return obj.type === 'tool_result' && obj.is_error === true;
  }

  /** Агрегировать snippets в FileChangeSummary[] */
  private aggregateByFile(
    snippets: SnippetDiff[],
    projectPath?: string,
    includeDetails = true
  ): FileChangeSummary[] {
    const fileMap = new Map<
      string,
      { filePath: string; snippets: SnippetDiff[]; isNewFile: boolean }
    >();

    for (const snippet of snippets) {
      // Пропускаем snippets с ошибками при агрегации
      if (snippet.isError) continue;

      const normalizedFilePath = this.normalizeFilePathKey(snippet.filePath);
      const existing = fileMap.get(normalizedFilePath);
      if (existing) {
        existing.snippets.push(snippet);
        if (snippet.type === 'write-new') existing.isNewFile = true;
      } else {
        fileMap.set(normalizedFilePath, {
          filePath: snippet.filePath,
          snippets: [snippet],
          isNewFile: snippet.type === 'write-new',
        });
      }
    }

    return [...fileMap.values()].map((data) => {
      const fp = data.filePath;
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const s of data.snippets) {
        if (s.isError) continue;
        const { added, removed } = countLineChanges(s.oldString, s.newString);
        totalAdded += added;
        totalRemoved += removed;
      }
      // Normalize separators for cross-platform path stripping
      const normalizedFp = fp.replace(/\\/g, '/');
      const normalizedProject = projectPath?.replace(/\\/g, '/');
      const relative = normalizedProject
        ? normalizedFp.startsWith(normalizedProject + '/')
          ? normalizedFp.slice(normalizedProject.length + 1)
          : normalizedFp.startsWith(normalizedProject)
            ? normalizedFp.slice(normalizedProject.length)
            : normalizedFp.split('/').slice(-3).join('/')
        : normalizedFp.split('/').slice(-3).join('/');
      return {
        filePath: fp,
        relativePath: relative,
        snippets: includeDetails ? data.snippets : [],
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        isNewFile: data.isNewFile,
        timeline: includeDetails ? this.buildTimeline(fp, data.snippets) : undefined,
      };
    });
  }

  /** Build edit timeline from snippets */
  private buildTimeline(filePath: string, snippets: SnippetDiff[]): FileEditTimeline {
    const events: FileEditEvent[] = snippets
      .filter((s) => !s.isError)
      .map((s, idx) => {
        const { added, removed } = countLineChanges(s.oldString, s.newString);
        return {
          toolUseId: s.toolUseId,
          toolName: s.toolName as FileEditEvent['toolName'],
          timestamp: s.timestamp,
          summary: this.generateEditSummary(s),
          linesAdded: added,
          linesRemoved: removed,
          snippetIndex: idx,
        };
      });

    const timestamps = events.map((e) => new Date(e.timestamp).getTime()).filter((t) => !isNaN(t));
    const durationMs =
      timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

    return { filePath, events, durationMs };
  }

  private generateEditSummary(snippet: SnippetDiff): string {
    switch (snippet.type) {
      case 'write-new':
        return 'Created new file';
      case 'write-update':
        return 'Wrote full file content';
      case 'multi-edit': {
        const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
        const total = added + removed;
        return `Multi-edit (${total} line${total !== 1 ? 's' : ''})`;
      }
      case 'edit': {
        const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
        if (snippet.oldString === '') return `Added ${added} line${added !== 1 ? 's' : ''}`;
        if (snippet.newString === '') return `Removed ${removed} line${removed !== 1 ? 's' : ''}`;
        return `Changed ${removed} → ${added} lines`;
      }
      default:
        return 'File modified';
    }
  }

  /** Проверить, содержит ли путь к файлу один из sessionId */
  private pathMatchesAnySession(filePath: string, sessionIds: Set<string>): boolean {
    for (const sessionId of sessionIds) {
      if (filePath.includes(sessionId)) return true;
    }
    return false;
  }

  /** Извлечь изменения из JSONL файлов, фильтруя по tool_use IDs */
  private async extractFilteredChanges(
    logRefs: LogFileRef[],
    allowedToolUseIds: Set<string>,
    projectPath?: string,
    includeDetails = true
  ): Promise<FileChangeSummary[]> {
    const allParsed = await this.parseJSONLFilesWithConcurrency(logRefs.map((ref) => ref.filePath));
    const allSnippets: SnippetDiff[] = [];
    for (const { snippets } of allParsed) {
      if (allowedToolUseIds.size > 0) {
        for (const s of snippets) {
          if (allowedToolUseIds.has(s.toolUseId)) {
            allSnippets.push(s);
          }
        }
      } else {
        allSnippets.push(...snippets);
      }
    }
    return this.aggregateByFile(
      this.sortSnippetsChronologically(allSnippets),
      projectPath,
      includeDetails
    );
  }

  /** Извлечь все изменения из одного файла */
  private async extractAllChanges(
    filePath: string,
    _memberName: string,
    projectPath?: string,
    includeDetails = true
  ): Promise<FileChangeSummary[]> {
    const { snippets } = await this.parseJSONLFile(filePath);
    return this.aggregateByFile(snippets, projectPath, includeDetails);
  }

  /** Fallback: вернуть все изменения из лог-файлов как Tier 4 */
  private async fallbackSingleTaskScope(
    teamName: string,
    taskId: string,
    logRefs: LogFileRef[],
    projectPath?: string,
    includeDetails = true
  ): Promise<TaskChangeSetV2> {
    const allParsed = await this.parseJSONLFilesWithConcurrency(logRefs.map((ref) => ref.filePath));
    const allSnippets = this.sortSnippetsChronologically(allParsed.flatMap((r) => r.snippets));
    const allFiles = this.aggregateByFile(allSnippets, projectPath, includeDetails);

    const fallbackScope: TaskChangeScope = {
      taskId,
      memberName: logRefs[0]?.memberName ?? 'unknown',
      startLine: 1,
      endLine: 0,
      startTimestamp: '',
      endTimestamp: '',
      toolUseIds: [],
      filePaths: allFiles.map((f) => f.filePath),
      confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
    };

    return {
      teamName,
      taskId,
      files: allFiles,
      totalLinesAdded: allFiles.reduce((sum, f) => sum + f.linesAdded, 0),
      totalLinesRemoved: allFiles.reduce((sum, f) => sum + f.linesRemoved, 0),
      totalFiles: allFiles.length,
      confidence: 'fallback',
      computedAt: new Date().toISOString(),
      scope: fallbackScope,
      warnings: ['No task boundaries found — showing all changes from related sessions.'],
    };
  }

  /** Пустой TaskChangeSetV2 */
  private emptyTaskChangeSet(teamName: string, taskId: string): TaskChangeSetV2 {
    return {
      teamName,
      taskId,
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      confidence: 'fallback',
      computedAt: new Date().toISOString(),
      scope: {
        taskId,
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
      },
      warnings: ['No log files found for this task.'],
    };
  }

  private buildTaskChangeSummaryCacheKey(
    teamName: string,
    taskId: string,
    options: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
    stateBucket: TaskChangeStateBucket
  ): string {
    return `${teamName}:${taskId}:${this.buildTaskSignature(options, stateBucket)}`;
  }

  private normalizeFilePathKey(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  }

  private buildTaskSignature(
    options: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
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
    effectiveOptions: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
    stateBucket: TaskChangeStateBucket,
    taskMeta: {
      status?: string;
      reviewState?: 'review' | 'needsFix' | 'approved' | 'none';
      historyEvents?: unknown[];
      kanbanColumn?: 'review' | 'approved';
    } | null
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
    effectiveOptions: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
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
    effectiveOptions: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
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
    effectiveOptions: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    },
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
    if (!projectPath) return null;
    return createHash('sha256').update(this.normalizeFilePathKey(projectPath)).digest('hex');
  }
}
