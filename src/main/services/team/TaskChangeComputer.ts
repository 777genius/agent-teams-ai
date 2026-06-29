import { createLogger } from '@shared/utils/logger';
import { getTaskChangeStateBucket } from '@shared/utils/taskChangeState';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as readline from 'readline';

import { estimateCachedValueBytes } from './cacheMemoryEstimate';
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
const NO_LOG_FILES_FOUND_WARNING = 'No log files found for this task.';

interface ParsedSnippetsCacheEntry {
  data: ParsedSnippetRecord[];
  mtime: number;
  expiresAt: number;
  bytes: number;
}

interface ParsedSnippetsResult {
  snippets: ParsedSnippetRecord[];
  mtime: number;
}

interface ParsedSnippetRecord {
  snippet: SnippetDiff;
  sourceLine: number;
  linesAdded: number;
  linesRemoved: number;
}

interface LogFileRef {
  filePath: string;
  memberName: string;
}

interface MetadataChangePath {
  filePath: string;
  kind?: string;
}

function shouldWarnAboutUnavailableTaskChangeEvidence(
  input: ResolvedTaskChangeComputeInput
): boolean {
  const status = input.taskMeta?.status?.trim() || input.effectiveOptions.status?.trim();
  const stateBucket = getTaskChangeStateBucket({
    status,
    reviewState: input.taskMeta?.reviewState,
    historyEvents: input.taskMeta?.historyEvents,
    kanbanColumn: input.taskMeta?.kanbanColumn,
  });
  return stateBucket === 'completed' || stateBucket === 'review' || stateBucket === 'approved';
}

const DEFAULT_MAX_SUMMARY_JSONL_PARSE_BYTES = 2 * 1024 * 1024;

export class TaskChangeComputer {
  private parsedSnippetsCache = new Map<string, ParsedSnippetsCacheEntry>();
  private parsedSnippetsInFlight = new Map<string, Promise<ParsedSnippetsResult>>();
  private parsedSnippetsCacheBytes = 0;
  private readonly parsedSnippetsCacheTtl = 20 * 1000;
  private readonly maxParsedSnippetsCacheEntries = 1_000;
  private readonly maxParsedSnippetsCacheBytes = 8 * 1024 * 1024;
  private readonly maxSummaryJsonlParseBytes: number;
  private static readonly JSONL_PARSE_CONCURRENCY = 6;

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly boundaryParser: TaskBoundaryParser,
    options: { maxSummaryJsonlParseBytes?: number } = {}
  ) {
    this.maxSummaryJsonlParseBytes =
      options.maxSummaryJsonlParseBytes ?? DEFAULT_MAX_SUMMARY_JSONL_PARSE_BYTES;
  }

  async computeAgentChanges(
    teamName: string,
    memberName: string,
    projectPath?: string
  ): Promise<{ result: AgentChangeSet; latestMtime: number }> {
    const paths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
    const parseResults = await this.parseJSONLFilesWithConcurrency(paths, true);
    let latestMtime = 0;
    const merged: ParsedSnippetRecord[] = [];

    for (const result of parseResults) {
      merged.push(...result.snippets);
      if (result.mtime > latestMtime) {
        latestMtime = result.mtime;
      }
    }

    const files = this.aggregateByFile(
      this.sortSnippetRecordsChronologically(merged),
      projectPath,
      true
    );
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
      return this.emptyTaskChangeSet(input);
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
      const intervalScoped = await this.buildIntervalScopedTaskChangeSet({
        teamName,
        taskId,
        taskMeta,
        logRefs,
        intervals: effectiveOptions.intervals,
        projectPath,
        includeDetails,
        warningWithFiles: 'Task boundaries missing - scoped by workIntervals timestamps.',
        warningWithoutFiles: 'No file edits found within persisted workIntervals.',
      });
      if (intervalScoped) return intervalScoped;

      return this.fallbackSingleTaskScope(input, logRefs);
    }

    const files = await this.extractScopedChanges(logRefs, allScopes, projectPath, includeDetails);

    const worstTier = Math.max(...allScopes.map((scope) => scope.confidence.tier));
    if (worstTier >= 3) {
      const intervalScoped = await this.buildIntervalScopedTaskChangeSet({
        teamName,
        taskId,
        taskMeta,
        logRefs: this.selectScopedLogRefs(logRefs, allScopes),
        intervals: effectiveOptions.intervals,
        projectPath,
        includeDetails,
        warningWithFiles:
          'Task start boundary missing - scoped by persisted workIntervals timestamps.',
        warningWithoutFiles: 'No file edits found within persisted workIntervals.',
      });
      if (intervalScoped && intervalScoped.files.length > 0) {
        return intervalScoped;
      }
    }

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

  private selectScopedLogRefs(logRefs: LogFileRef[], scopes: TaskChangeScope[]): LogFileRef[] {
    const scopedMembers = new Set(
      scopes.map((scope) => scope.memberName).filter((memberName) => memberName.length > 0)
    );
    if (scopedMembers.size === 0) {
      return logRefs;
    }

    const selected = logRefs.filter((ref) => scopedMembers.has(ref.memberName));
    return selected.length > 0 ? selected : logRefs;
  }

  private async buildIntervalScopedTaskChangeSet(input: {
    teamName: string;
    taskId: string;
    taskMeta: ResolvedTaskChangeComputeInput['taskMeta'];
    logRefs: LogFileRef[];
    intervals?: { startedAt: string; completedAt?: string }[];
    projectPath?: string;
    includeDetails: boolean;
    warningWithFiles: string;
    warningWithoutFiles: string;
  }): Promise<TaskChangeSetV2 | null> {
    const intervals = input.intervals;
    if (!Array.isArray(intervals) || intervals.length === 0) {
      return null;
    }

    const { files, toolUseIds, startTimestamp, endTimestamp } =
      await this.extractIntervalScopedChanges(
        input.logRefs,
        intervals,
        input.projectPath,
        input.includeDetails
      );

    return {
      teamName: input.teamName,
      taskId: input.taskId,
      files,
      totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
      totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
      totalFiles: files.length,
      confidence: 'medium',
      computedAt: new Date().toISOString(),
      scope: {
        taskId: input.taskId,
        memberName: input.taskMeta?.owner ?? input.logRefs[0]?.memberName ?? '',
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
      warnings: [files.length === 0 ? input.warningWithoutFiles : input.warningWithFiles],
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
      const endMs =
        interval.completedAt === undefined
          ? null
          : Number.isFinite(endMsRaw)
            ? Math.max(endMsRaw, startMs)
            : startMs;
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
        if (
          item.endMs == null ||
          typeof item.completedAt !== 'string' ||
          !Number.isFinite(Date.parse(item.completedAt))
        ) {
          return acc;
        }
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

    const allParsed = await this.parseJSONLFilesWithConcurrency(
      logRefs.map((ref) => ref.filePath),
      includeDetails
    );
    const allowedSnippets: ParsedSnippetRecord[] = [];
    const toolUseIdsSet = new Set<string>();

    for (const { snippets } of allParsed) {
      for (const record of snippets) {
        const { snippet } = record;
        if (snippet.isError) continue;
        if (!inAnyInterval(snippet.timestamp)) continue;
        allowedSnippets.push(record);
        if (snippet.toolUseId) {
          toolUseIdsSet.add(snippet.toolUseId);
        }
      }
    }

    return {
      files: this.aggregateByFile(
        this.sortSnippetRecordsChronologically(allowedSnippets),
        projectPath,
        includeDetails
      ),
      toolUseIds: [...toolUseIdsSet],
      startTimestamp,
      endTimestamp,
    };
  }

  private async extractScopedChanges(
    logRefs: LogFileRef[],
    scopes: TaskChangeScope[],
    projectPath?: string,
    includeDetails = true
  ): Promise<FileChangeSummary[]> {
    const scopesWithTools = scopes.filter((scope) => scope.toolUseIds.length > 0);
    if (scopesWithTools.length === 0) {
      return [];
    }

    const allParsed = await this.parseJSONLFilesWithConcurrency(
      logRefs.map((ref) => ref.filePath),
      includeDetails
    );
    const allSnippets: ParsedSnippetRecord[] = [];

    for (let index = 0; index < allParsed.length; index++) {
      const ref = logRefs[index];
      const parsed = allParsed[index];
      if (!ref || !parsed) continue;
      const matchingScopes = this.selectScopesForLogRef(scopesWithTools, ref);
      if (matchingScopes.length === 0) continue;

      for (const record of parsed.snippets) {
        if (this.recordMatchesAnyScope(record, matchingScopes)) allSnippets.push(record);
      }
    }

    return this.aggregateByFile(
      this.sortSnippetRecordsChronologically(allSnippets),
      projectPath,
      includeDetails
    );
  }

  private selectScopesForLogRef(scopes: TaskChangeScope[], ref: LogFileRef): TaskChangeScope[] {
    return scopes.filter((scope) => {
      if (!scope.memberName) return true;
      return scope.memberName === ref.memberName;
    });
  }

  private recordMatchesAnyScope(record: ParsedSnippetRecord, scopes: TaskChangeScope[]): boolean {
    return scopes.some((scope) => this.recordMatchesScope(record, scope));
  }

  private recordMatchesScope(record: ParsedSnippetRecord, scope: TaskChangeScope): boolean {
    const snippet = record.snippet;
    if (!scope.toolUseIds.includes(snippet.toolUseId)) return false;
    if (record.sourceLine < scope.startLine || record.sourceLine > scope.endLine) return false;
    if (!this.timestampMatchesScope(snippet.timestamp, scope)) return false;
    if (!this.filePathMatchesScope(snippet.filePath, scope.filePaths)) return false;
    return true;
  }

  private timestampMatchesScope(timestamp: string, scope: TaskChangeScope): boolean {
    const snippetMs = Date.parse(timestamp);
    if (!Number.isFinite(snippetMs)) return true;

    const startMs = scope.startTimestamp ? Date.parse(scope.startTimestamp) : Number.NaN;
    if (Number.isFinite(startMs) && snippetMs < startMs) return false;

    const endMs = scope.endTimestamp ? Date.parse(scope.endTimestamp) : Number.NaN;
    if (Number.isFinite(endMs) && snippetMs > endMs) return false;

    return true;
  }

  private filePathMatchesScope(filePath: string, scopeFilePaths: string[]): boolean {
    if (scopeFilePaths.length === 0) return true;
    const normalizedFilePath = this.normalizeFilePathKey(filePath);
    return scopeFilePaths.some((scopePath) => {
      const normalizedScopePath = this.normalizeFilePathKey(scopePath);
      return (
        normalizedFilePath === normalizedScopePath ||
        normalizedFilePath.endsWith(`/${normalizedScopePath}`) ||
        normalizedScopePath.endsWith(`/${normalizedFilePath}`)
      );
    });
  }

  private async fallbackSingleTaskScope(
    input: ResolvedTaskChangeComputeInput,
    logRefs: LogFileRef[]
  ): Promise<TaskChangeSetV2> {
    const { teamName, taskId, projectPath, includeDetails } = input;
    const allParsed = await this.parseJSONLFilesWithConcurrency(
      logRefs.map((ref) => ref.filePath),
      includeDetails
    );
    const allSnippets = this.sortSnippetRecordsChronologically(
      allParsed.flatMap((result) => result.snippets)
    );
    const aggregatedFiles = this.aggregateByFile(allSnippets, projectPath, includeDetails);
    const shouldWarn =
      aggregatedFiles.length > 0 || shouldWarnAboutUnavailableTaskChangeEvidence(input);

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
      warnings: shouldWarn
        ? ['No task boundaries found - showing all changes from related sessions.']
        : [],
    };
  }

  private emptyTaskChangeSet(input: ResolvedTaskChangeComputeInput): TaskChangeSetV2 {
    const { teamName, taskId } = input;
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
      warnings: shouldWarnAboutUnavailableTaskChangeEvidence(input)
        ? [NO_LOG_FILES_FOUND_WARNING]
        : [],
    };
  }

  private async parseJSONLFilesWithConcurrency(
    paths: string[],
    includeDetails: boolean
  ): Promise<ParsedSnippetsResult[]> {
    if (paths.length === 0) return [];

    const results = new Array<ParsedSnippetsResult>(paths.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= paths.length) return;
        results[currentIndex] = await this.parseJSONLFile(paths[currentIndex], includeDetails);
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
    filePath: string,
    includeDetails: boolean
  ): Promise<ParsedSnippetsResult> {
    const cacheKey = this.buildParsedSnippetsCacheKey(filePath, includeDetails);
    let fileMtime = 0;
    try {
      const fileStat = await stat(filePath);
      fileMtime = fileStat.mtimeMs;
      const cached = this.parsedSnippetsCache.get(cacheKey);
      if (cached?.mtime === fileMtime && cached.expiresAt > Date.now()) {
        return { snippets: cached.data, mtime: fileMtime };
      }
    } catch (error) {
      logger.debug(`Не удалось stat файла ${filePath}: ${String(error)}`);
      return { snippets: [], mtime: 0 };
    }

    const inFlightKey = `${cacheKey}:${fileMtime}`;
    const inFlight = this.parsedSnippetsInFlight.get(inFlightKey);
    if (inFlight) return inFlight;

    const promise = this.parseJSONLFileUncached(filePath, fileMtime, includeDetails).finally(() => {
      if (this.parsedSnippetsInFlight.get(inFlightKey) === promise) {
        this.parsedSnippetsInFlight.delete(inFlightKey);
      }
    });
    this.parsedSnippetsInFlight.set(inFlightKey, promise);
    return promise;
  }

  private async parseJSONLFileUncached(
    filePath: string,
    fileMtime: number,
    includeDetails: boolean
  ): Promise<ParsedSnippetsResult> {
    const snippets: ParsedSnippetRecord[] = [];
    const snippetsByToolUseId = new Map<string, ParsedSnippetRecord[]>();
    const erroredIds = new Set<string>();
    const seenFiles = new Set<string>();

    const markErroredToolUseId = (toolUseId: string): void => {
      erroredIds.add(toolUseId);
      for (const record of snippetsByToolUseId.get(toolUseId) ?? []) {
        record.snippet.isError = true;
      }
    };

    const markErroredIds = (entry: Record<string, unknown>): void => {
      for (const toolUseId of this.collectErroredToolUseIdsFromEntry(entry)) {
        markErroredToolUseId(toolUseId);
      }
    };

    const addSnippet = (
      lineNumber: number,
      snippet: SnippetDiff,
      lineCounts?: { added: number; removed: number }
    ): void => {
      const { added, removed } =
        lineCounts ?? countLineChanges(snippet.oldString, snippet.newString);
      const record: ParsedSnippetRecord = {
        snippet: includeDetails ? snippet : { ...snippet, oldString: '', newString: '' },
        sourceLine: lineNumber,
        linesAdded: added,
        linesRemoved: removed,
      };
      snippets.push(record);
      if (snippet.toolUseId) {
        const records = snippetsByToolUseId.get(snippet.toolUseId);
        if (records) {
          records.push(record);
        } else {
          snippetsByToolUseId.set(snippet.toolUseId, [record]);
        }
      }
    };

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;

      for await (const line of rl) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        if (
          !includeDetails &&
          this.maxSummaryJsonlParseBytes > 0 &&
          Buffer.byteLength(trimmed, 'utf8') > this.maxSummaryJsonlParseBytes
        ) {
          for (const toolUseId of this.collectRawErroredToolUseIds(trimmed)) {
            markErroredToolUseId(toolUseId);
          }
          const oversizedSnippets = this.extractOversizedSummarySnippets(
            lineNumber,
            trimmed,
            seenFiles,
            erroredIds
          );
          for (const oversized of oversizedSnippets) {
            addSnippet(lineNumber, oversized.snippet, oversized.lineCounts);
          }
          continue;
        }
        try {
          entry = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // Ignore invalid JSON lines.
          continue;
        }

        markErroredIds(entry);
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
            const hasTextPayload =
              typeof input.old_string === 'string' || typeof input.new_string === 'string';
            const metadataPaths = hasTextPayload ? [] : this.extractMetadataChangePaths(input);
            const targetPaths =
              metadataPaths.length > 0
                ? metadataPaths
                : targetPath
                  ? [{ filePath: targetPath }]
                  : [];

            for (const target of targetPaths) {
              seenFiles.add(this.normalizeFilePathKey(target.filePath));
              const snippetType: SnippetDiff['type'] =
                !hasTextPayload && target.kind === 'add' ? 'write-new' : 'edit';
              addSnippet(lineNumber, {
                toolUseId,
                filePath: target.filePath,
                toolName: 'Edit',
                type: snippetType,
                oldString,
                newString,
                replaceAll,
                timestamp,
                isError,
                contextHash: includeDetails
                  ? this.computeContextHash(oldString, newString)
                  : undefined,
              });
            }
          } else if (toolName === 'Write') {
            const targetPath = typeof input.file_path === 'string' ? input.file_path : '';
            const writeContent = typeof input.content === 'string' ? input.content : '';

            if (targetPath) {
              const normalizedTargetPath = this.normalizeFilePathKey(targetPath);
              const isNew = !seenFiles.has(normalizedTargetPath);
              seenFiles.add(normalizedTargetPath);
              addSnippet(lineNumber, {
                toolUseId,
                filePath: targetPath,
                toolName: 'Write',
                type: isNew ? 'write-new' : 'write-update',
                oldString: '',
                newString: writeContent,
                replaceAll: false,
                timestamp,
                isError,
                contextHash: includeDetails ? this.computeContextHash('', writeContent) : undefined,
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
                addSnippet(lineNumber, {
                  toolUseId,
                  filePath: targetPath,
                  toolName: 'MultiEdit',
                  type: 'multi-edit',
                  oldString,
                  newString,
                  replaceAll: false,
                  timestamp,
                  isError,
                  contextHash: includeDetails
                    ? this.computeContextHash(oldString, newString)
                    : undefined,
                });
              }
            }
          }
        }
      }

      rl.close();
      stream.destroy();
    } catch (error) {
      logger.debug(`Не удалось прочитать файл ${filePath}: ${String(error)}`);
      return { snippets: [], mtime: 0 };
    }

    this.setParsedSnippetsCache(filePath, includeDetails, fileMtime, snippets);

    return { snippets, mtime: fileMtime };
  }

  private extractOversizedSummarySnippets(
    lineNumber: number,
    rawLine: string,
    seenFiles: Set<string>,
    erroredIds: Set<string>
  ): Array<{ snippet: SnippetDiff; lineCounts: { added: number; removed: number } }> {
    if (!this.rawLineLooksLikeAssistantToolUse(rawLine)) {
      return [];
    }

    const timestamp =
      this.extractRawJsonStringValue(rawLine, 'timestamp')?.value ?? new Date().toISOString();
    const snippets: Array<{
      snippet: SnippetDiff;
      lineCounts: { added: number; removed: number };
    }> = [];
    let searchIndex = 0;

    while (searchIndex < rawLine.length) {
      const toolUseIndex = rawLine.indexOf('"tool_use"', searchIndex);
      if (toolUseIndex < 0) break;
      const nextToolUseIndex = rawLine.indexOf('"tool_use"', toolUseIndex + '"tool_use"'.length);
      const toolUseEndIndex = nextToolUseIndex >= 0 ? nextToolUseIndex : rawLine.length;
      const snippet = this.extractOversizedSummarySnippetInRange({
        lineNumber,
        rawLine,
        seenFiles,
        erroredIds,
        toolUseIndex,
        toolUseEndIndex,
        timestamp,
        ordinal: snippets.length,
      });
      if (snippet) {
        snippets.push(snippet);
      }
      searchIndex = toolUseEndIndex;
    }

    return snippets;
  }

  private extractOversizedSummarySnippetInRange(input: {
    lineNumber: number;
    rawLine: string;
    seenFiles: Set<string>;
    erroredIds: Set<string>;
    toolUseIndex: number;
    toolUseEndIndex: number;
    timestamp: string;
    ordinal: number;
  }): { snippet: SnippetDiff; lineCounts: { added: number; removed: number } } | null {
    const {
      lineNumber,
      rawLine,
      seenFiles,
      erroredIds,
      toolUseIndex,
      toolUseEndIndex,
      timestamp,
      ordinal,
    } = input;
    const rawToolName =
      this.extractRawJsonStringValue(rawLine, 'name', toolUseIndex, toolUseEndIndex)?.value ?? '';
    const toolName = rawToolName.startsWith('proxy_') ? rawToolName.slice(6) : rawToolName;
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') {
      return null;
    }

    const filePath =
      this.extractRawJsonStringValue(rawLine, 'file_path', toolUseIndex, toolUseEndIndex)?.value ??
      '';
    if (!filePath) {
      return null;
    }

    const toolUseId =
      this.extractRawJsonStringValue(rawLine, 'id', toolUseIndex, toolUseEndIndex)?.value ??
      `oversized-${lineNumber}-${ordinal}`;

    let added = 0;
    let removed = 0;
    let snippetType: SnippetDiff['type'] = 'edit';
    if (toolName === 'Write') {
      added =
        this.countRawJsonStringDiffLines(rawLine, 'content', toolUseIndex, toolUseEndIndex) ?? 0;
      const normalizedTargetPath = this.normalizeFilePathKey(filePath);
      snippetType = seenFiles.has(normalizedTargetPath) ? 'write-update' : 'write-new';
      seenFiles.add(normalizedTargetPath);
    } else if (toolName === 'MultiEdit') {
      added = this.countAllRawJsonStringDiffLines(
        rawLine,
        'new_string',
        toolUseIndex,
        toolUseEndIndex
      );
      removed = this.countAllRawJsonStringDiffLines(
        rawLine,
        'old_string',
        toolUseIndex,
        toolUseEndIndex
      );
      snippetType = 'multi-edit';
      seenFiles.add(this.normalizeFilePathKey(filePath));
    } else {
      added =
        this.countRawJsonStringDiffLines(rawLine, 'new_string', toolUseIndex, toolUseEndIndex) ?? 0;
      removed =
        this.countRawJsonStringDiffLines(rawLine, 'old_string', toolUseIndex, toolUseEndIndex) ?? 0;
      seenFiles.add(this.normalizeFilePathKey(filePath));
    }

    return {
      snippet: {
        toolUseId,
        filePath,
        toolName,
        type: snippetType,
        oldString: '',
        newString: '',
        replaceAll: false,
        timestamp,
        isError: erroredIds.has(toolUseId),
      },
      lineCounts: { added, removed },
    };
  }

  private collectRawErroredToolUseIds(rawLine: string): Set<string> {
    const ids = new Set<string>();
    let searchIndex = 0;
    while (searchIndex < rawLine.length) {
      const resultIndex = rawLine.indexOf('"tool_result"', searchIndex);
      if (resultIndex < 0) break;
      const nextResultIndex = rawLine.indexOf(
        '"tool_result"',
        resultIndex + '"tool_result"'.length
      );
      const resultEndIndex = nextResultIndex >= 0 ? nextResultIndex : rawLine.length;
      if (this.rawJsonBooleanValue(rawLine, 'is_error', true, resultIndex, resultEndIndex)) {
        const toolUseId = this.extractRawJsonStringValue(
          rawLine,
          'tool_use_id',
          resultIndex,
          resultEndIndex
        )?.value;
        if (toolUseId) {
          ids.add(toolUseId);
        }
      }
      searchIndex = resultEndIndex;
    }
    return ids;
  }

  private rawLineLooksLikeAssistantToolUse(rawLine: string): boolean {
    return rawLine.includes('"tool_use"') && /"role"\s*:\s*"assistant"/.test(rawLine);
  }

  private extractRawJsonStringValue(
    rawLine: string,
    key: string,
    startIndex = 0,
    endIndex = rawLine.length
  ): { value: string; nextIndex: number } | null {
    const quoteIndex = this.findRawJsonStringValueQuote(rawLine, key, startIndex, endIndex);
    if (quoteIndex == null) {
      return null;
    }
    const endQuoteIndex = this.findRawJsonStringEnd(rawLine, quoteIndex, endIndex);
    if (endQuoteIndex == null) {
      return null;
    }
    try {
      return {
        value: JSON.parse(rawLine.slice(quoteIndex, endQuoteIndex + 1)) as string,
        nextIndex: endQuoteIndex + 1,
      };
    } catch {
      return null;
    }
  }

  private countRawJsonStringDiffLines(
    rawLine: string,
    key: string,
    startIndex = 0,
    endIndex = rawLine.length
  ): number | null {
    const quoteIndex = this.findRawJsonStringValueQuote(rawLine, key, startIndex, endIndex);
    if (quoteIndex == null) {
      return null;
    }
    return this.countRawJsonStringLines(rawLine, quoteIndex, endIndex)?.lines ?? null;
  }

  private countAllRawJsonStringDiffLines(
    rawLine: string,
    key: string,
    startIndex = 0,
    endIndex = rawLine.length
  ): number {
    let total = 0;
    let index = Math.max(0, startIndex);
    while (index < endIndex) {
      const quoteIndex = this.findRawJsonStringValueQuote(rawLine, key, index, endIndex);
      if (quoteIndex == null) {
        break;
      }
      const counted = this.countRawJsonStringLines(rawLine, quoteIndex, endIndex);
      if (!counted) {
        break;
      }
      total += counted.lines;
      index = counted.nextIndex;
    }
    return total;
  }

  private findRawJsonStringValueQuote(
    rawLine: string,
    key: string,
    startIndex = 0,
    endIndex = rawLine.length
  ): number | null {
    const keyIndex = rawLine.indexOf(`"${key}"`, Math.max(0, startIndex));
    if (keyIndex < 0 || keyIndex >= endIndex) {
      return null;
    }
    let index = keyIndex + key.length + 2;
    while (index < endIndex && /\s/.test(rawLine[index] ?? '')) index += 1;
    if (rawLine[index] !== ':') {
      return null;
    }
    index += 1;
    while (index < endIndex && /\s/.test(rawLine[index] ?? '')) index += 1;
    return index < endIndex && rawLine[index] === '"' ? index : null;
  }

  private rawJsonBooleanValue(
    rawLine: string,
    key: string,
    expected: boolean,
    startIndex = 0,
    endIndex = rawLine.length
  ): boolean {
    const keyIndex = rawLine.indexOf(`"${key}"`, Math.max(0, startIndex));
    if (keyIndex < 0 || keyIndex >= endIndex) {
      return false;
    }
    let index = keyIndex + key.length + 2;
    while (index < endIndex && /\s/.test(rawLine[index] ?? '')) index += 1;
    if (rawLine[index] !== ':') {
      return false;
    }
    index += 1;
    while (index < endIndex && /\s/.test(rawLine[index] ?? '')) index += 1;
    const expectedRaw = expected ? 'true' : 'false';
    return index + expectedRaw.length <= endIndex && rawLine.startsWith(expectedRaw, index);
  }

  private findRawJsonStringEnd(
    rawLine: string,
    quoteIndex: number,
    endIndex = rawLine.length
  ): number | null {
    let index = quoteIndex + 1;
    while (index < endIndex) {
      const char = rawLine.charCodeAt(index);
      if (char === 34) {
        return index;
      }
      if (char === 92) {
        index += 2;
      } else {
        index += 1;
      }
    }
    return null;
  }

  private countRawJsonStringLines(
    rawLine: string,
    quoteIndex: number,
    endIndex = rawLine.length
  ): { lines: number; nextIndex: number } | null {
    let index = quoteIndex + 1;
    let hasContent = false;
    let lines = 1;
    let lastDecodedWasNewline = false;

    while (index < endIndex) {
      const char = rawLine.charCodeAt(index);
      if (char === 34) {
        return {
          lines: hasContent ? (lastDecodedWasNewline ? lines - 1 : lines) : 0,
          nextIndex: index + 1,
        };
      }
      hasContent = true;
      if (char === 92) {
        const escaped = rawLine[index + 1];
        if (escaped === 'n') {
          lines += 1;
          lastDecodedWasNewline = true;
          index += 2;
          continue;
        }
        if (escaped === 'u' && rawLine.slice(index + 2, index + 6).toLowerCase() === '000a') {
          lines += 1;
          lastDecodedWasNewline = true;
          index += 6;
          continue;
        }
        lastDecodedWasNewline = false;
        index += 2;
        continue;
      }
      if (char === 10) {
        lines += 1;
        lastDecodedWasNewline = true;
      } else {
        lastDecodedWasNewline = false;
      }
      index += 1;
    }

    return null;
  }

  private buildParsedSnippetsCacheKey(filePath: string, includeDetails: boolean): string {
    return `${includeDetails ? 'details' : 'summary'}\0${filePath}`;
  }

  private setParsedSnippetsCache(
    filePath: string,
    includeDetails: boolean,
    fileMtime: number,
    snippets: ParsedSnippetRecord[]
  ): void {
    const cacheKey = this.buildParsedSnippetsCacheKey(filePath, includeDetails);
    const existing = this.parsedSnippetsCache.get(cacheKey);
    if (existing) {
      this.parsedSnippetsCacheBytes -= existing.bytes;
    }
    const bytes = estimateCachedValueBytes(snippets);
    this.parsedSnippetsCache.set(cacheKey, {
      data: snippets,
      mtime: fileMtime,
      expiresAt: Date.now() + this.parsedSnippetsCacheTtl,
      bytes,
    });
    this.parsedSnippetsCacheBytes += bytes;
    this.pruneParsedSnippetsCache();
  }

  private pruneParsedSnippetsCache(): void {
    while (
      this.parsedSnippetsCache.size > this.maxParsedSnippetsCacheEntries ||
      this.parsedSnippetsCacheBytes > this.maxParsedSnippetsCacheBytes
    ) {
      const oldestKey = this.parsedSnippetsCache.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.parsedSnippetsCache.get(oldestKey);
      if (oldest) {
        this.parsedSnippetsCacheBytes -= oldest.bytes;
      }
      this.parsedSnippetsCache.delete(oldestKey);
    }
    if (this.parsedSnippetsCacheBytes < 0) {
      this.parsedSnippetsCacheBytes = 0;
    }
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

  private extractMetadataChangePaths(input: Record<string, unknown>): MetadataChangePath[] {
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const paths: MetadataChangePath[] = [];
    const seen = new Set<string>();

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const changeObj = change as Record<string, unknown>;
      const filePath = typeof changeObj.path === 'string' ? changeObj.path : '';
      if (!filePath) continue;
      const kind = typeof changeObj.kind === 'string' ? changeObj.kind : undefined;
      const normalized = this.normalizeFilePathKey(filePath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      paths.push({ filePath, ...(kind ? { kind } : {}) });
    }

    return paths;
  }

  private collectErroredToolUseIdsFromEntry(entry: Record<string, unknown>): Set<string> {
    const erroredIds = new Set<string>();

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

    return erroredIds;
  }

  private isErroredToolResult(block: unknown): boolean {
    if (!block || typeof block !== 'object') return false;
    const obj = block as Record<string, unknown>;
    return obj.type === 'tool_result' && obj.is_error === true;
  }

  private aggregateByFile(
    records: ParsedSnippetRecord[],
    projectPath?: string,
    includeDetails = true
  ): FileChangeSummary[] {
    const fileMap = new Map<
      string,
      { filePath: string; records: ParsedSnippetRecord[]; isNewFile: boolean }
    >();

    for (const record of records) {
      const { snippet } = record;
      if (snippet.isError) continue;

      const normalizedFilePath = this.normalizeFilePathKey(snippet.filePath);
      const existing = fileMap.get(normalizedFilePath);
      if (existing) {
        existing.records.push(record);
        if (snippet.type === 'write-new') existing.isNewFile = true;
      } else {
        fileMap.set(normalizedFilePath, {
          filePath: snippet.filePath,
          records: [record],
          isNewFile: snippet.type === 'write-new',
        });
      }
    }

    return [...fileMap.values()].map((data) => {
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const record of data.records) {
        const { snippet } = record;
        if (snippet.isError) continue;
        totalAdded += record.linesAdded;
        totalRemoved += record.linesRemoved;
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
        snippets: includeDetails ? data.records.map((record) => record.snippet) : [],
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        isNewFile: data.isNewFile,
        timeline: includeDetails
          ? this.buildTimeline(
              data.filePath,
              data.records.map((record) => record.snippet)
            )
          : undefined,
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
          toolName: snippet.toolName,
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
        if (snippet.oldString === '' && snippet.newString === '') return 'File change metadata';
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

  private sortSnippetRecordsChronologically(records: ParsedSnippetRecord[]): ParsedSnippetRecord[] {
    return records
      .map((record, originalIndex) => ({ record, originalIndex }))
      .sort((a, b) => {
        const aMs = Date.parse(a.record.snippet.timestamp);
        const bMs = Date.parse(b.record.snippet.timestamp);
        const safeA = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
        const safeB = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
        if (safeA !== safeB) return safeA - safeB;
        if (a.record.snippet.filePath !== b.record.snippet.filePath) {
          return a.record.snippet.filePath.localeCompare(b.record.snippet.filePath);
        }
        if (a.record.snippet.toolUseId !== b.record.snippet.toolUseId) {
          return a.record.snippet.toolUseId.localeCompare(b.record.snippet.toolUseId);
        }
        return a.originalIndex - b.originalIndex;
      })
      .map(({ record }) => record);
  }

  private normalizeFilePathKey(filePath: string): string {
    return normalizeTaskChangePresenceFilePath(filePath);
  }
}
