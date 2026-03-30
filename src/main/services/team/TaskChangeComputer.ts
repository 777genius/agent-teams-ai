import { createLogger } from '@shared/utils/logger';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as readline from 'readline';

import { normalizeTaskChangePresenceFilePath } from './taskChangePresenceUtils';
import { countLineChanges } from './UnifiedLineCounter';

import type { TaskBoundaryParser } from './TaskBoundaryParser';
import type { ResolvedTaskChangeComputeInput } from './taskChangeWorkerTypes';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type {
  AgentChangeSet,
  FileChangeSummary,
  FileEditEvent,
  FileEditTimeline,
  SnippetDiff,
  TaskChangeScope,
  TaskChangeSetV2,
} from '@shared/types';

const logger = createLogger('Service:TaskChangeComputer');

interface ParsedSnippetsCacheEntry {
  data: SnippetDiff[];
  mtime: number;
  expiresAt: number;
}

interface LogFileRef {
  filePath: string;
  memberName: string;
}

export class TaskChangeComputer {
  private parsedSnippetsCache = new Map<string, ParsedSnippetsCacheEntry>();
  private readonly parsedSnippetsCacheTtl = 20 * 1000;
  private static readonly JSONL_PARSE_CONCURRENCY = 6;

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly boundaryParser: TaskBoundaryParser
  ) {}

  async computeAgentChanges(
    teamName: string,
    memberName: string,
    projectPath?: string
  ): Promise<{ result: AgentChangeSet; latestMtime: number }> {
    const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
    const parseResults = await this.parseJSONLFilesWithConcurrency(paths);
    let latestMtime = 0;
    const merged: SnippetDiff[] = [];

    for (const result of parseResults) {
      merged.push(...result.snippets);
      if (result.mtime > latestMtime) {
        latestMtime = result.mtime;
      }
    }

    const files = this.aggregateByFile(this.sortSnippetsChronologically(merged), projectPath);
    const taskChangeResult = {
      teamName,
      memberName,
      files,
      totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
      totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
      totalFiles: files.length,
      computedAt: new Date().toISOString(),
    } satisfies AgentChangeSet;

    return { result: taskChangeResult, latestMtime };
  }

  async computeTaskChanges(input: ResolvedTaskChangeComputeInput): Promise<TaskChangeSetV2> {
    const { teamName, taskId, taskMeta, effectiveOptions, projectPath, includeDetails } = input;
    const logRefs = await this.logsFinder.findLogFileRefsForTask(
      teamName,
      taskId,
      effectiveOptions
    );
    if (logRefs.length === 0) {
      return this.emptyTaskChangeSet(teamName, taskId);
    }

    const allScopes: TaskChangeScope[] = [];
    for (const ref of logRefs) {
      const boundaries = await this.boundaryParser.parseBoundaries(ref.filePath);
      const scope = boundaries.scopes.find((candidate) => candidate.taskId === taskId);
      if (scope) {
        allScopes.push({ ...scope, memberName: ref.memberName });
      }
    }

    if (allScopes.length === 0) {
      const intervals = effectiveOptions.intervals;
      if (Array.isArray(intervals) && intervals.length > 0) {
        const { files, toolUseIds, startTimestamp, endTimestamp } =
          await this.extractIntervalScopedChanges(logRefs, intervals, projectPath, includeDetails);

        return {
          teamName,
          taskId,
          files,
          totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
          totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
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
            filePaths: files.map((file) => file.filePath),
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

    for (const interval of intervals) {
      const startMs = Date.parse(interval.startedAt);
      if (!Number.isFinite(startMs)) continue;
      const endMsRaw =
        typeof interval.completedAt === 'string' ? Date.parse(interval.completedAt) : Number.NaN;
      const endMs = Number.isFinite(endMsRaw) ? endMsRaw : null;
      normalized.push({
        startMs,
        endMs,
        startedAt: interval.startedAt,
        completedAt: interval.completedAt,
      });
    }

    normalized.sort((a, b) => a.startMs - b.startMs);
    const startTimestamp = normalized[0]?.startedAt ?? '';
    const maxEnd = normalized.reduce<{ endMs: number; endTimestamp: string } | null>(
      (acc, item) => {
        if (item.endMs == null || typeof item.completedAt !== 'string') return acc;
        if (!acc || item.endMs > acc.endMs) {
          return { endMs: item.endMs, endTimestamp: item.completedAt };
        }
        return acc;
      },
      null
    );
    const endTimestamp = maxEnd?.endTimestamp ?? '';

    const inAnyInterval = (timestamp: string): boolean => {
      const ms = Date.parse(timestamp);
      if (!Number.isFinite(ms)) return false;
      for (const interval of normalized) {
        if (ms < interval.startMs) continue;
        if (interval.endMs == null) return true;
        if (ms <= interval.endMs) return true;
      }
      return false;
    };

    const allParsed = await this.parseJSONLFilesWithConcurrency(logRefs.map((ref) => ref.filePath));
    const allowedSnippets: SnippetDiff[] = [];
    const toolUseIdsSet = new Set<string>();

    for (const { snippets } of allParsed) {
      for (const snippet of snippets) {
        if (snippet.isError) continue;
        if (!inAnyInterval(snippet.timestamp)) continue;
        allowedSnippets.push(snippet);
        if (snippet.toolUseId) {
          toolUseIdsSet.add(snippet.toolUseId);
        }
      }
    }

    return {
      files: this.aggregateByFile(
        this.sortSnippetsChronologically(allowedSnippets),
        projectPath,
        includeDetails
      ),
      toolUseIds: [...toolUseIdsSet],
      startTimestamp,
      endTimestamp,
    };
  }

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
        for (const snippet of snippets) {
          if (allowedToolUseIds.has(snippet.toolUseId)) {
            allSnippets.push(snippet);
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

  private async fallbackSingleTaskScope(
    teamName: string,
    taskId: string,
    logRefs: LogFileRef[],
    projectPath?: string,
    includeDetails = true
  ): Promise<TaskChangeSetV2> {
    const allParsed = await this.parseJSONLFilesWithConcurrency(logRefs.map((ref) => ref.filePath));
    const allSnippets = this.sortSnippetsChronologically(
      allParsed.flatMap((result) => result.snippets)
    );
    const aggregatedFiles = this.aggregateByFile(allSnippets, projectPath, includeDetails);

    return {
      teamName,
      taskId,
      files: aggregatedFiles,
      totalLinesAdded: aggregatedFiles.reduce((sum, file) => sum + file.linesAdded, 0),
      totalLinesRemoved: aggregatedFiles.reduce((sum, file) => sum + file.linesRemoved, 0),
      totalFiles: aggregatedFiles.length,
      confidence: 'fallback',
      computedAt: new Date().toISOString(),
      scope: {
        taskId,
        memberName: logRefs[0]?.memberName ?? 'unknown',
        startLine: 1,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: aggregatedFiles.map((file) => file.filePath),
        confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
      },
      warnings: ['No task boundaries found — showing all changes from related sessions.'],
    };
  }

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

  private async parseJSONLFilesWithConcurrency(
    paths: string[]
  ): Promise<{ snippets: SnippetDiff[]; mtime: number }[]> {
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
        { length: Math.min(TaskChangeComputer.JSONL_PARSE_CONCURRENCY, paths.length) },
        () => worker()
      )
    );

    return results;
  }

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
    } catch (error) {
      logger.debug(`Не удалось stat файла ${filePath}: ${String(error)}`);
      return { snippets: [], mtime: 0 };
    }

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
          // Ignore invalid JSON lines.
        }
      }

      rl.close();
      stream.destroy();
    } catch (error) {
      logger.debug(`Не удалось прочитать файл ${filePath}: ${String(error)}`);
      return { snippets: [], mtime: 0 };
    }

    const erroredIds = this.collectErroredToolUseIds(entries);
    const snippets: SnippetDiff[] = [];
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
      }
    }

    this.parsedSnippetsCache.set(filePath, {
      data: snippets,
      mtime: fileMtime,
      expiresAt: Date.now() + this.parsedSnippetsCacheTtl,
    });

    return { snippets, mtime: fileMtime };
  }

  private extractContent(entry: Record<string, unknown>): unknown[] | null {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) return message.content as unknown[];
    if (Array.isArray(entry.content)) return entry.content as unknown[];
    return null;
  }

  private extractRole(entry: Record<string, unknown>): string | null {
    if (typeof entry.role === 'string') return entry.role;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && typeof message.role === 'string') return message.role;
    return null;
  }

  private collectErroredToolUseIds(entries: Record<string, unknown>[]): Set<string> {
    const erroredIds = new Set<string>();

    for (const entry of entries) {
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

  private isErroredToolResult(block: unknown): boolean {
    if (!block || typeof block !== 'object') return false;
    const obj = block as Record<string, unknown>;
    return obj.type === 'tool_result' && obj.is_error === true;
  }

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
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const snippet of data.snippets) {
        if (snippet.isError) continue;
        const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
        totalAdded += added;
        totalRemoved += removed;
      }

      const normalizedFilePath = data.filePath.replace(/\\/g, '/');
      const normalizedProjectPath = projectPath?.replace(/\\/g, '/');
      const relativePath = normalizedProjectPath
        ? normalizedFilePath.startsWith(normalizedProjectPath + '/')
          ? normalizedFilePath.slice(normalizedProjectPath.length + 1)
          : normalizedFilePath.startsWith(normalizedProjectPath)
            ? normalizedFilePath.slice(normalizedProjectPath.length)
            : normalizedFilePath.split('/').slice(-3).join('/')
        : normalizedFilePath.split('/').slice(-3).join('/');

      return {
        filePath: data.filePath,
        relativePath,
        snippets: includeDetails ? data.snippets : [],
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        isNewFile: data.isNewFile,
        timeline: includeDetails ? this.buildTimeline(data.filePath, data.snippets) : undefined,
      };
    });
  }

  private buildTimeline(filePath: string, snippets: SnippetDiff[]): FileEditTimeline {
    const events: FileEditEvent[] = snippets
      .filter((snippet) => !snippet.isError)
      .map((snippet, index) => {
        const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
        return {
          toolUseId: snippet.toolUseId,
          toolName: snippet.toolName as FileEditEvent['toolName'],
          timestamp: snippet.timestamp,
          summary: this.generateEditSummary(snippet),
          linesAdded: added,
          linesRemoved: removed,
          snippetIndex: index,
        };
      });

    const timestamps = events
      .map((event) => new Date(event.timestamp).getTime())
      .filter((timestamp) => !Number.isNaN(timestamp));
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

  private computeContextHash(oldString: string, newString: string): string {
    const take3 = (value: string): string => {
      const lines = value.split('\n');
      const head = lines.slice(0, 3).join('\n');
      const tail = lines.length > 3 ? lines.slice(-3).join('\n') : '';
      return `${head}|${tail}`;
    };

    const raw = `${take3(oldString)}::${take3(newString)}`;
    let hash = 5381;
    for (let index = 0; index < raw.length; index++) {
      hash = ((hash << 5) + hash + raw.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  private sortSnippetsChronologically(snippets: SnippetDiff[]): SnippetDiff[] {
    return snippets
      .map((snippet, originalIndex) => ({ snippet, originalIndex }))
      .sort((a, b) => {
        const aMs = Date.parse(a.snippet.timestamp);
        const bMs = Date.parse(b.snippet.timestamp);
        const safeA = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
        const safeB = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
        if (safeA !== safeB) return safeA - safeB;
        if (a.snippet.filePath !== b.snippet.filePath) {
          return a.snippet.filePath.localeCompare(b.snippet.filePath);
        }
        if (a.snippet.toolUseId !== b.snippet.toolUseId) {
          return a.snippet.toolUseId.localeCompare(b.snippet.toolUseId);
        }
        return a.originalIndex - b.originalIndex;
      })
      .map(({ snippet }) => snippet);
  }

  private normalizeFilePathKey(filePath: string): string {
    return normalizeTaskChangePresenceFilePath(filePath);
  }
}
