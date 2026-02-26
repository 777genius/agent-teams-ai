import { createLogger } from '@shared/utils/logger';
import { diffLines } from 'diff';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as readline from 'readline';

import { TeamConfigReader } from './TeamConfigReader';

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

/** Ссылка на JSONL файл с привязкой к memberName */
interface LogFileRef {
  filePath: string;
  memberName: string;
}

export class ChangeExtractorService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk

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
      expiresAt: Date.now() + this.CACHE_TTL,
    });

    return result;
  }

  /** Получить изменения для конкретной задачи (Phase 3: per-task scoping) */
  async getTaskChanges(teamName: string, taskId: string): Promise<TaskChangeSetV2> {
    const logs = await this.logsFinder.findLogsForTask(teamName, taskId);
    const logRefs = await this.resolveLogFileRefs(teamName, logs);
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

    // Если scope не найден — fallback на весь файл
    if (allScopes.length === 0) {
      return this.fallbackSingleTaskScope(teamName, taskId, logRefs, projectPath);
    }

    // Фильтруем snippets по tool_use IDs из scope
    const allowedToolUseIds = new Set(allScopes.flatMap((s) => s.toolUseIds));
    const files = await this.extractFilteredChanges(logRefs, allowedToolUseIds, projectPath);

    const worstTier = Math.max(...allScopes.map((s) => s.confidence.tier));
    const warnings: string[] = [];
    if (worstTier >= 3) {
      warnings.push('Some task boundaries could not be precisely determined.');
    }

    return {
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

  /** Получить projectPath из конфига команды */
  private async resolveProjectPath(teamName: string): Promise<string | undefined> {
    try {
      const config = await this.configReader.getConfig(teamName);
      return config?.projectPath?.trim() || undefined;
    } catch {
      return undefined;
    }
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
          const filePath_ = typeof input.file_path === 'string' ? input.file_path : '';
          const oldString = typeof input.old_string === 'string' ? input.old_string : '';
          const newString = typeof input.new_string === 'string' ? input.new_string : '';
          const replaceAll = input.replace_all === true;

          if (filePath_) {
            seenFiles.add(filePath_);
            snippets.push({
              toolUseId,
              filePath: filePath_,
              toolName: 'Edit',
              type: 'edit',
              oldString,
              newString,
              replaceAll,
              timestamp,
              isError,
            });
          }
        } else if (toolName === 'Write') {
          const filePath_ = typeof input.file_path === 'string' ? input.file_path : '';
          const writeContent = typeof input.content === 'string' ? input.content : '';

          if (filePath_) {
            const isNew = !seenFiles.has(filePath_);
            seenFiles.add(filePath_);
            snippets.push({
              toolUseId,
              filePath: filePath_,
              toolName: 'Write',
              type: isNew ? 'write-new' : 'write-update',
              oldString: '',
              newString: writeContent,
              replaceAll: false,
              timestamp,
              isError,
            });
          }
        } else if (toolName === 'MultiEdit') {
          const filePath_ = typeof input.file_path === 'string' ? input.file_path : '';
          const edits = Array.isArray(input.edits) ? input.edits : [];

          if (filePath_) {
            seenFiles.add(filePath_);
            for (const edit of edits) {
              if (!edit || typeof edit !== 'object') continue;
              const editObj = edit as Record<string, unknown>;
              const oldString = typeof editObj.old_string === 'string' ? editObj.old_string : '';
              const newString = typeof editObj.new_string === 'string' ? editObj.new_string : '';
              snippets.push({
                toolUseId,
                filePath: filePath_,
                toolName: 'MultiEdit',
                type: 'multi-edit',
                oldString,
                newString,
                replaceAll: false,
                timestamp,
                isError,
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
        const { added, removed } = this.countLines(s.oldString, s.newString);
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
      .map((s, idx) => ({
        toolUseId: s.toolUseId,
        toolName: s.toolName as FileEditEvent['toolName'],
        timestamp: s.timestamp,
        summary: this.generateEditSummary(s),
        linesAdded: Math.max(0, s.newString.split('\n').length - s.oldString.split('\n').length),
        linesRemoved: Math.max(0, s.oldString.split('\n').length - s.newString.split('\n').length),
        snippetIndex: idx,
      }));

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
        const lines = snippet.oldString.split('\n').length;
        return `Multi-edit (${lines} line${lines !== 1 ? 's' : ''})`;
      }
      case 'edit': {
        const added = snippet.newString.split('\n').length;
        const removed = snippet.oldString.split('\n').length;
        if (removed === 0 || snippet.oldString === '')
          return `Added ${added} line${added !== 1 ? 's' : ''}`;
        if (added === 0 || snippet.newString === '')
          return `Removed ${removed} line${removed !== 1 ? 's' : ''}`;
        return `Changed ${removed} → ${added} lines`;
      }
      default:
        return 'File modified';
    }
  }

  /** Подсчёт добавленных/удалённых строк через diff */
  private countLines(oldStr: string, newStr: string): { added: number; removed: number } {
    if (!oldStr && !newStr) return { added: 0, removed: 0 };
    const changes = diffLines(oldStr, newStr);
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      if (c.added) added += c.count ?? 0;
      if (c.removed) removed += c.count ?? 0;
    }
    return { added, removed };
  }

  /** Проверить, содержит ли путь к файлу один из sessionId */
  private pathMatchesAnySession(filePath: string, sessionIds: Set<string>): boolean {
    for (const sessionId of sessionIds) {
      if (filePath.includes(sessionId)) return true;
    }
    return false;
  }

  /** Конвертировать MemberLogSummary[] в LogFileRef[] через findMemberLogPaths */
  private async resolveLogFileRefs(
    teamName: string,
    logs: MemberLogSummary[]
  ): Promise<LogFileRef[]> {
    const refs: LogFileRef[] = [];
    const byMember = new Map<string, MemberLogSummary[]>();
    for (const log of logs) {
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
