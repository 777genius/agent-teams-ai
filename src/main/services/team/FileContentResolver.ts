import { readJsonlLines } from '@main/utils/jsonlLineReader';
import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { createHash } from 'crypto';
import { diffLines } from 'diff';
import { access, readFile } from 'fs/promises';
import * as path from 'path';

import type { GitDiffFallback } from './GitDiffFallback';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { FileChangeWithContent, SnippetDiff } from '@shared/types';

const logger = createLogger('Service:FileContentResolver');

/** Кеш-запись для resolved content */
interface ContentCacheEntry {
  original: string | null;
  modified: string | null;
  source: FileChangeWithContent['contentSource'];
  validationFingerprint: string;
  expiresAt: number;
}

/**
 * Resolves full file contents (original + modified) for CodeMirror diff view.
 *
 * Uses these resolution strategies:
 * 1. File-history backup (most accurate)
 * 2. Snippet reconstruction (reverse-apply edits from current disk state)
 * 3. Fallback to current file on disk with an unavailable baseline
 */
export class FileContentResolver {
  private cache = new Map<string, ContentCacheEntry>();
  private readonly provisionalCacheTtl = 5 * 1000;

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    // Retained for existing callers; a commit cannot prove the task's pre-edit
    // state when the user had uncommitted changes.
    _gitFallback?: GitDiffFallback
  ) {}

  /** Invalidate cached content for a file (e.g. after user saves edits) */
  invalidateFile(filePath: string): void {
    const normalizedFilePath = this.normalizeResolverPath(filePath);
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${normalizedFilePath}`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Resolve full file contents for a single file.
   * Returns original (before changes) and modified (after changes) content.
   */
  async resolveFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[]
  ): Promise<{
    original: string | null;
    modified: string | null;
    source: FileChangeWithContent['contentSource'];
  }> {
    const ledgerResult = this.tryLedgerContent(snippets);
    if (ledgerResult) {
      return ledgerResult;
    }

    // Read current file from disk (= modified state after agent's changes)
    let currentContent: string | null = null;
    try {
      currentContent = await readFile(filePath, 'utf8');
    } catch {
      logger.debug(`Файл недоступен на диске: ${filePath}`);
    }

    const cacheKey = this.buildCacheKey(teamName, memberName, filePath);
    const validationFingerprint = this.buildValidationFingerprint(
      filePath,
      currentContent,
      snippets
    );
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.validationFingerprint === validationFingerprint
    ) {
      return { original: cached.original, modified: cached.modified, source: cached.source };
    }

    // Fast path only for creation backed by explicit lifecycle evidence. Older legacy
    // summaries may label the first observed Write as write-new even when it overwrote
    // an existing file, so that label alone must never synthesize an empty baseline.
    const hasProvenCreation = this.isNetNewFile(snippets);
    if (hasProvenCreation && currentContent !== null) {
      const result = {
        original: '',
        modified: currentContent,
        source: 'snippet-reconstruction' as const,
      };
      this.cacheResult(cacheKey, validationFingerprint, result);
      return result;
    }

    // Strategy 1: Try file-history backup
    const historyResult = await this.tryFileHistoryBackup(teamName, memberName, filePath);
    if (historyResult !== null) {
      const result = {
        original: historyResult,
        modified: currentContent,
        source: 'file-history' as const,
      };
      this.cacheResult(cacheKey, validationFingerprint, result);
      return result;
    }

    // Strategy 2: Try snippet reconstruction
    const reconstructed = this.trySnippetReconstruction(currentContent, snippets);
    if (reconstructed !== null) {
      const result = {
        original: reconstructed,
        modified: currentContent,
        source: 'snippet-reconstruction' as const,
      };
      this.cacheResult(cacheKey, validationFingerprint, result);
      return result;
    }

    // A committed Git version may omit unrelated uncommitted user edits.
    // Without a trusted task baseline, rejecting the file must fail closed.
    if (currentContent !== null) {
      const result = {
        original: null,
        modified: currentContent,
        source: 'disk-current' as const,
      };
      this.cacheResult(cacheKey, validationFingerprint, result);
      return result;
    }

    // Nothing available
    const unavailable = { original: null, modified: null, source: 'unavailable' as const };
    this.cacheResult(cacheKey, validationFingerprint, unavailable);
    return unavailable;
  }

  /**
   * Get full file content for a single file (IPC-facing method).
   * Returns a FileChangeWithContent object ready for the renderer.
   */
  async getFileContent(
    teamName: string,
    memberName: string,
    filePath: string,
    snippets: SnippetDiff[] = []
  ): Promise<FileChangeWithContent> {
    const resolved = await this.resolveFileContent(teamName, memberName, filePath, snippets);

    // Compute accurate stats from full content diff
    let linesAdded = 0;
    let linesRemoved = 0;
    if (resolved.original !== null && resolved.modified !== null) {
      const changes = diffLines(resolved.original, resolved.modified);
      for (const c of changes) {
        if (c.added) linesAdded += c.count ?? 0;
        if (c.removed) linesRemoved += c.count ?? 0;
      }
    } else if (resolved.original === null && resolved.modified !== null) {
      // Use diffLines for consistency with ChangeExtractorService.countLines()
      const changes = diffLines('', resolved.modified);
      for (const c of changes) {
        if (c.added) linesAdded += c.count ?? 0;
      }
    }

    const isNewFile = this.isNetNewFile(snippets);

    return {
      filePath,
      relativePath: this.getDisplayRelativePath(filePath, 3),
      snippets,
      linesAdded,
      linesRemoved,
      isNewFile,
      originalFullContent: resolved.original,
      modifiedFullContent: resolved.modified,
      contentSource: resolved.source,
    };
  }

  /**
   * Resolve full contents for multiple files at once.
   * Returns a map of filePath -> FileChangeWithContent.
   */
  async resolveAllFileContents(
    teamName: string,
    memberName: string,
    files: {
      filePath: string;
      relativePath: string;
      snippets: SnippetDiff[];
      linesAdded: number;
      linesRemoved: number;
      isNewFile: boolean;
    }[]
  ): Promise<Map<string, FileChangeWithContent>> {
    const results = new Map<string, FileChangeWithContent>();

    // Resolve all files in parallel
    const promises = files.map(async (file) => {
      const resolved = await this.resolveFileContent(
        teamName,
        memberName,
        file.filePath,
        file.snippets
      );
      // Compute accurate stats from full content diff
      let linesAdded = file.linesAdded;
      let linesRemoved = file.linesRemoved;
      if (resolved.original !== null && resolved.modified !== null) {
        linesAdded = 0;
        linesRemoved = 0;
        const changes = diffLines(resolved.original, resolved.modified);
        for (const c of changes) {
          if (c.added) linesAdded += c.count ?? 0;
          if (c.removed) linesRemoved += c.count ?? 0;
        }
      }

      const entry: FileChangeWithContent = {
        filePath: file.filePath,
        relativePath: file.relativePath,
        snippets: file.snippets,
        linesAdded,
        linesRemoved,
        // Re-evaluate lifecycle evidence instead of trusting persisted legacy summaries.
        isNewFile: this.isNetNewFile(file.snippets),
        originalFullContent: resolved.original,
        modifiedFullContent: resolved.modified,
        contentSource: resolved.source,
      };
      results.set(file.filePath, entry);
    });

    await Promise.all(promises);
    return results;
  }

  // ── Private: Resolution strategies ──

  private tryLedgerContent(snippets: SnippetDiff[]): {
    original: string | null;
    modified: string | null;
    source: FileChangeWithContent['contentSource'];
  } | null {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);

    if (ledgerSnippets.length === 0) {
      return null;
    }

    const first = ledgerSnippets[0]?.ledger;
    const last = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
    if (!first || !last) {
      return null;
    }
    const canUseSyntheticOriginal =
      first.originalFullContent === null &&
      first.operation === 'create' &&
      last.modifiedFullContent !== null &&
      !first.beforeState?.unavailableReason;
    const canUseSyntheticModified =
      last.modifiedFullContent === null &&
      last.operation === 'delete' &&
      first.originalFullContent !== null &&
      !last.afterState?.unavailableReason;

    const original = first.originalFullContent ?? (canUseSyntheticOriginal ? '' : null);
    const modified = last.modifiedFullContent ?? (canUseSyntheticModified ? '' : null);
    if (original === null && modified === null) {
      const hasUnavailableLedgerState = ledgerSnippets.some(
        (snippet) =>
          snippet.ledger?.beforeState?.unavailableReason ||
          snippet.ledger?.afterState?.unavailableReason ||
          snippet.ledger?.textAvailability === 'unavailable'
      );
      if (hasUnavailableLedgerState) {
        return { original: null, modified: null, source: 'unavailable' };
      }
      return null;
    }

    const hasSnapshot = ledgerSnippets.some(
      (snippet) => snippet.ledger?.source === 'ledger-snapshot'
    );
    return {
      original,
      modified,
      source: hasSnapshot ? 'ledger-snapshot' : 'ledger-exact',
    };
  }

  /**
   * Strategy 1: Read original content from Claude's file-history backup.
   *
   * Claude saves file snapshots at `~/.claude/file-history/{sessionId}/{backupFileName}`.
   * The mapping is stored as `type: "file-history-snapshot"` entries in JSONL.
   */
  private async tryFileHistoryBackup(
    teamName: string,
    memberName: string,
    filePath: string
  ): Promise<string | null> {
    let logPaths: string[];
    try {
      logPaths = await this.logsFinder.findMemberLogPaths(teamName, memberName);
    } catch {
      return null;
    }

    if (logPaths.length === 0) return null;

    for (const logPath of logPaths) {
      const sessionId = this.extractSessionId(logPath);
      if (!sessionId) continue;

      const backupFileName = await this.findFileHistoryBackup(logPath, filePath);
      if (!backupFileName) continue;

      // Construct the file-history path
      const historyPath = path.join(
        getHomeDir(),
        '.claude',
        'file-history',
        sessionId,
        backupFileName
      );

      try {
        await access(historyPath);
        const content = await readFile(historyPath, 'utf8');
        logger.debug(`File-history backup найден: ${historyPath}`);
        return content;
      } catch {
        // Backup file doesn't exist, try next log
        continue;
      }
    }

    return null;
  }

  /**
   * Extract sessionId from a JSONL log path.
   *
   * Paths can be:
   * - `~/.claude/projects/{encodedPath}/{sessionId}.jsonl` (lead session)
   * - `~/.claude/projects/{encodedPath}/{sessionId}/subagents/agent-{id}.jsonl` (subagent)
   *
   * For lead sessions, sessionId = filename without extension.
   * For subagents, sessionId = the parent directory's parent name.
   */
  private extractSessionId(logPath: string): string | null {
    const parts = path
      .normalize(logPath)
      .split(/[/\\]+/)
      .filter(Boolean);

    // Check if it's a subagent path: .../{sessionId}/subagents/agent-xxx.jsonl
    const subagentsIdx = parts.indexOf('subagents');
    if (subagentsIdx > 0) {
      return parts[subagentsIdx - 1] || null;
    }

    // Lead session: .../{sessionId}.jsonl
    const fileName = parts[parts.length - 1];
    if (fileName?.endsWith('.jsonl')) {
      return fileName.replace('.jsonl', '');
    }

    return null;
  }

  /**
   * Stream a JSONL file looking for file-history-snapshot entries that reference the target file.
   * Returns the backup file name if found.
   */
  private async findFileHistoryBackup(
    logPath: string,
    targetFilePath: string
  ): Promise<string | null> {
    try {
      for await (const line of readJsonlLines(logPath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Quick check before JSON parse
        if (!trimmed.includes('file-history-snapshot')) continue;

        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          if (entry.type !== 'file-history-snapshot') continue;

          const snapshot = entry.snapshot as Record<string, unknown> | undefined;
          if (!snapshot) continue;

          const trackedFileBackups = snapshot.trackedFileBackups as
            | Record<string, string>
            | undefined;
          if (!trackedFileBackups) continue;

          const backupFileName = trackedFileBackups[targetFilePath];
          if (backupFileName) {
            return backupFileName;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    } catch {
      logger.debug(`Не удалось прочитать JSONL для file-history: ${logPath}`);
    }

    return null;
  }

  /**
   * Strategy 2: Reconstruct original content by reverse-applying snippets.
   *
   * Algorithm:
   * 1. Start with current file content from disk (= modified state)
   * 2. Sort snippets by timestamp DESCENDING (newest first)
   * 3. For each snippet, reverse the edit operation
   * 4. Result = original content before any agent changes
   *
   * Returns null if reconstruction is not possible (chain broken).
   */
  private trySnippetReconstruction(
    currentContent: string | null,
    snippets: SnippetDiff[]
  ): string | null {
    // `readFile()` can legitimately return an empty string for empty files.
    // Only treat `null` as "missing on disk".
    if (currentContent === null) return null;
    if (snippets.length === 0) return null;

    // Filter out errored snippets
    const validSnippets = snippets.filter((s) => !s.isError);
    if (validSnippets.length === 0) return null;

    // Sort by timestamp descending (reverse order to undo newest first)
    const sorted = [...validSnippets].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    let content = currentContent;

    for (const snippet of sorted) {
      switch (snippet.type) {
        case 'write-new': {
          // Legacy caches may contain first-seen Write events misclassified as creation.
          // Only explicit lifecycle evidence makes an empty baseline safe.
          if (this.isProvenCreationSnippet(snippet)) return '';
          return null;
        }

        case 'write-update': {
          // Full file overwrite — can't reconstruct previous content from snippets alone
          return null;
        }

        case 'notebook-edit':
        case 'shell-snapshot':
        case 'hook-snapshot': {
          // Snapshot/full-file changes are only safe when ledger content is available.
          return null;
        }

        case 'edit':
        case 'multi-edit': {
          // Guard: empty newString means deletion — can't find position to reverse
          if (!snippet.newString) return null;

          if (snippet.replaceAll) {
            // Existing occurrences of newString are indistinguishable from replacements.
            return null;
          } else {
            // A repeated postimage has no known edit position in legacy snippets.
            const idx = content.indexOf(snippet.newString);
            if (idx === -1 || content.includes(snippet.newString, idx + 1)) {
              return null;
            }
            content =
              content.substring(0, idx) +
              snippet.oldString +
              content.substring(idx + snippet.newString.length);
          }
          break;
        }
      }
    }

    return content;
  }

  // ── Private: Lifecycle evidence ──

  private hasProvenCreationEvidence(snippets: SnippetDiff[]): boolean {
    return snippets.some((snippet) => !snippet.isError && this.isProvenCreationSnippet(snippet));
  }

  /**
   * Whether the reviewed path is absent before the first ledger event and present
   * after the last one. Looking for any intermediate create is insufficient:
   * delete-existing -> recreate-same-path is a modification, not a new file.
   */
  private isNetNewFile(snippets: SnippetDiff[]): boolean {
    const ledgerSnippets = snippets.filter((snippet) => !snippet.isError && snippet.ledger);
    if (ledgerSnippets.length > 0) {
      const first = ledgerSnippets[0]?.ledger;
      const last = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
      if (
        typeof first?.beforeState?.exists === 'boolean' &&
        typeof last?.afterState?.exists === 'boolean'
      ) {
        return first.beforeState.exists === false && last.afterState.exists === true;
      }
    }
    return this.hasProvenCreationEvidence(snippets);
  }

  private isProvenCreationSnippet(snippet: SnippetDiff): boolean {
    if (snippet.ledger?.operation === 'create') return true;

    // TaskChangeComputer emits write-new for explicit metadata `kind: add` using
    // the Edit tool name. A bare legacy Write has no pre-task existence evidence.
    return snippet.type === 'write-new' && snippet.toolName === 'Edit';
  }

  // ── Private: Git fallback (Phase 4) ──

  private getDisplayRelativePath(filePath: string, segmentCount: number): string {
    const normalized = path.normalize(filePath);
    const parts = normalized.split(/[/\\]+/).filter(Boolean);
    return parts.slice(-segmentCount).join('/');
  }

  // ── Private: Cache helpers ──

  private normalizeResolverPath(filePath: string): string {
    return normalizePathForComparison(filePath);
  }

  private buildCacheKey(teamName: string, memberName: string, filePath: string): string {
    return `${teamName}:${memberName}:${this.normalizeResolverPath(filePath)}`;
  }

  private hashString(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private buildDiskFingerprint(currentContent: string | null): string {
    if (currentContent === null) return 'missing';
    return this.hashString(`present:${currentContent}`);
  }

  private buildSnippetFingerprint(snippets: SnippetDiff[]): string {
    const hash = createHash('sha256');
    for (const snippet of snippets) {
      hash.update('\u0000snippet\u0000');
      hash.update(this.normalizeResolverPath(snippet.filePath));
      hash.update('\u0000');
      hash.update(snippet.toolUseId);
      hash.update('\u0000');
      hash.update(snippet.type);
      hash.update('\u0000');
      hash.update(snippet.oldString);
      hash.update('\u0000');
      hash.update(snippet.newString);
      hash.update('\u0000');
      hash.update(snippet.replaceAll ? '1' : '0');
      hash.update('\u0000');
      hash.update(snippet.timestamp);
      hash.update('\u0000');
      hash.update(snippet.isError ? '1' : '0');
      hash.update('\u0000');
      hash.update(snippet.contextHash ?? '');
    }
    return hash.digest('hex');
  }

  private buildValidationFingerprint(
    filePath: string,
    currentContent: string | null,
    snippets: SnippetDiff[]
  ): string {
    const normalizedPath = this.normalizeResolverPath(filePath);
    const diskFingerprint = this.buildDiskFingerprint(currentContent);
    const snippetFingerprint = this.buildSnippetFingerprint(snippets);
    return this.hashString(`${normalizedPath}|${diskFingerprint}|${snippetFingerprint}`);
  }

  private getCacheTtlForSource(_source: FileChangeWithContent['contentSource']): number {
    return this.provisionalCacheTtl;
  }

  private cacheResult(
    key: string,
    validationFingerprint: string,
    result: {
      original: string | null;
      modified: string | null;
      source: FileChangeWithContent['contentSource'];
    }
  ): void {
    this.cache.set(key, {
      original: result.original,
      modified: result.modified,
      source: result.source,
      validationFingerprint,
      expiresAt: Date.now() + this.getCacheTtlForSource(result.source),
    });
  }
}
