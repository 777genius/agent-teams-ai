import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

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
  MemberLogSummary,
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

interface TaskChangeCacheEntry {
  data: TaskChangeSetV2;
  expiresAt: number;
}

/** Ссылка на JSONL файл с привязкой к memberName */
interface LogFileRef {
  filePath: string;
  memberName: string;
}

export class ChangeExtractorService {
  private cache = new Map<string, CacheEntry>();
  private taskChangeCache = new Map<string, TaskChangeCacheEntry>();
  private readonly cacheTtl = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk
  private readonly taskChangeCacheTtl = 20 * 1000; // 20 сек для task changes

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly boundaryParser: TaskBoundaryParser,
    private readonly configReader: TeamConfigReader = new TeamConfigReader()
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

    // Собираем все snippets из всех JSONL файлов
    const allSnippets: SnippetDiff[] = [];
    let latestMtime = 0;

    for (const filePath of paths) {
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs > latestMtime) {
          latestMtime = fileStat.mtimeMs;
        }
      } catch {
        // Файл может быть удалён между обнаружением и чтением
      }

      const snippets = await this.parseJSONLFile(filePath);
      allSnippets.push(...snippets);
    }

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
    }
  ): Promise<TaskChangeSetV2> {
    const cacheKey = `task:${teamName}:${taskId}`;
    const cached = this.taskChangeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const taskMeta = await this.readTaskMeta(teamName, taskId);
    const logs = await this.logsFinder.findLogsForTask(teamName, taskId, {
      owner: options?.owner ?? taskMeta?.owner,
      status: options?.status ?? taskMeta?.status,
      intervals: options?.intervals ?? taskMeta?.intervals,
      since: options?.since,
    });
    const logRefs = await this.resolveLogFileRefs(teamName, logs);
    if (logRefs.length === 0) {
      const empty = this.emptyTaskChangeSet(teamName, taskId);
      this.taskChangeCache.set(cacheKey, {
        data: empty,
        expiresAt: Date.now() + this.taskChangeCacheTtl,
      });
      return empty;
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
      const intervals = options?.intervals ?? taskMeta?.intervals;
      if (Array.isArray(intervals) && intervals.length > 0) {
        const { files, toolUseIds, startTimestamp, endTimestamp } =
          await this.extractIntervalScopedChanges(logRefs, intervals, projectPath);

        const intervalScope: TaskChangeScope = {
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
        };

        const intervalResult: TaskChangeSetV2 = {
          teamName,
          taskId,
          files,
          totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
          totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
          totalFiles: files.length,
          confidence: 'medium',
          computedAt: new Date().toISOString(),
          scope: intervalScope,
          warnings:
            files.length === 0
              ? ['No file edits found within persisted workIntervals.']
              : ['Task boundaries missing — scoped by workIntervals timestamps.'],
        };
        this.taskChangeCache.set(cacheKey, {
          data: intervalResult,
          expiresAt: Date.now() + this.taskChangeCacheTtl,
        });
        return intervalResult;
      }

      const fallbackResult = await this.fallbackSingleTaskScope(
        teamName,
        taskId,
        logRefs,
        projectPath
      );
      this.taskChangeCache.set(cacheKey, {
        data: fallbackResult,
        expiresAt: Date.now() + this.taskChangeCacheTtl,
      });
      return fallbackResult;
    }

    // Фильтруем snippets по tool_use IDs из scope
    const allowedToolUseIds = new Set(allScopes.flatMap((s) => s.toolUseIds));
    const files = await this.extractFilteredChanges(logRefs, allowedToolUseIds, projectPath);

    const worstTier = Math.max(...allScopes.map((s) => s.confidence.tier));
    const warnings: string[] = [];
    if (worstTier >= 3) {
      warnings.push('Some task boundaries could not be precisely determined.');
    }

    const result: TaskChangeSetV2 = {
      teamName,
      taskId,
      files,
      totalLinesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
      totalLinesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
      totalFiles: files.length,
      confidence: worstTier <= 1 ? 'high' : worstTier <= 2 ? 'medium' : 'low',
      computedAt: new Date().toISOString(),
      scope: allScopes[0],
      warnings,
    };
    this.taskChangeCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + this.taskChangeCacheTtl,
    });
    return result;
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
      };
    } catch {
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
    projectPath?: string
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

    const allowedSnippets: SnippetDiff[] = [];
    const toolUseIdsSet = new Set<string>();

    for (const ref of logRefs) {
      const snippets = await this.parseJSONLFile(ref.filePath);
      for (const s of snippets) {
        if (s.isError) continue;
        if (!inAnyInterval(s.timestamp)) continue;
        allowedSnippets.push(s);
        if (s.toolUseId) toolUseIdsSet.add(s.toolUseId);
      }
    }

    const files = this.aggregateByFile(allowedSnippets, projectPath);
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

  /** Парсить один JSONL файл и извлечь все snippets (двухпроходный подход) */
  private async parseJSONLFile(filePath: string): Promise<SnippetDiff[]> {
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
      return [];
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
            seenFiles.add(targetPath);
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
            const isNew = !seenFiles.has(targetPath);
            seenFiles.add(targetPath);
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
            seenFiles.add(targetPath);
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

    return snippets;
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
  private aggregateByFile(snippets: SnippetDiff[], projectPath?: string): FileChangeSummary[] {
    const fileMap = new Map<string, { snippets: SnippetDiff[]; isNewFile: boolean }>();

    for (const snippet of snippets) {
      // Пропускаем snippets с ошибками при агрегации
      if (snippet.isError) continue;

      const existing = fileMap.get(snippet.filePath);
      if (existing) {
        existing.snippets.push(snippet);
      } else {
        fileMap.set(snippet.filePath, {
          snippets: [snippet],
          isNewFile: snippet.type === 'write-new',
        });
      }
    }

    return [...fileMap.entries()].map(([fp, data]) => {
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
        snippets: data.snippets,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        isNewFile: data.isNewFile,
        timeline: this.buildTimeline(fp, data.snippets),
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

  /** Конвертировать MemberLogSummary[] в LogFileRef[] */
  private async resolveLogFileRefs(
    teamName: string,
    logs: MemberLogSummary[]
  ): Promise<LogFileRef[]> {
    const refs: LogFileRef[] = [];
    const logsNeedingResolve: MemberLogSummary[] = [];

    for (const log of logs) {
      const memberName = log.memberName ?? 'unknown';
      if (log.filePath) {
        refs.push({ filePath: log.filePath, memberName });
      } else {
        logsNeedingResolve.push(log);
      }
    }

    if (logsNeedingResolve.length === 0) return refs;

    const byMember = new Map<string, MemberLogSummary[]>();
    for (const log of logsNeedingResolve) {
      const name = log.memberName ?? 'unknown';
      if (!byMember.has(name)) byMember.set(name, []);
      byMember.get(name)!.push(log);
    }
    for (const [memberName, memberLogs] of byMember) {
      const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
      for (const log of memberLogs) {
        const matchedPath = paths.find((p) =>
          log.kind === 'subagent'
            ? p.includes(log.sessionId) && p.includes(log.subagentId)
            : p.includes(log.sessionId) && p.endsWith('.jsonl')
        );
        if (matchedPath) {
          refs.push({ filePath: matchedPath, memberName });
        }
      }
    }
    return refs;
  }

  /** Извлечь изменения из JSONL файлов, фильтруя по tool_use IDs */
  private async extractFilteredChanges(
    logRefs: LogFileRef[],
    allowedToolUseIds: Set<string>,
    projectPath?: string
  ): Promise<FileChangeSummary[]> {
    const allSnippets: SnippetDiff[] = [];
    for (const ref of logRefs) {
      const snippets = await this.parseJSONLFile(ref.filePath);
      if (allowedToolUseIds.size > 0) {
        // Фильтруем только по разрешённым tool_use IDs
        for (const s of snippets) {
          if (allowedToolUseIds.has(s.toolUseId)) {
            allSnippets.push(s);
          }
        }
      } else {
        allSnippets.push(...snippets);
      }
    }
    return this.aggregateByFile(allSnippets, projectPath);
  }

  /** Извлечь все изменения из одного файла */
  private async extractAllChanges(
    filePath: string,
    _memberName: string,
    projectPath?: string
  ): Promise<FileChangeSummary[]> {
    const snippets = await this.parseJSONLFile(filePath);
    return this.aggregateByFile(snippets, projectPath);
  }

  /** Fallback: вернуть все изменения из лог-файлов как Tier 4 */
  private async fallbackSingleTaskScope(
    teamName: string,
    taskId: string,
    logRefs: LogFileRef[],
    projectPath?: string
  ): Promise<TaskChangeSetV2> {
    const allFiles: FileChangeSummary[] = [];
    for (const ref of logRefs) {
      const files = await this.extractAllChanges(ref.filePath, ref.memberName, projectPath);
      allFiles.push(...files);
    }

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
}
