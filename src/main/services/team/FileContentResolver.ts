import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { diffLines } from 'diff';
import { createReadStream } from 'fs';
import { access, readFile } from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import type { GitDiffFallback } from './GitDiffFallback';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { FileChangeWithContent, SnippetDiff } from '@shared/types';

const logger = createLogger('Service:FileContentResolver');

/** Кеш-запись для resolved content */
interface ContentCacheEntry {
  original: string | null;
  modified: string | null;
  source: FileChangeWithContent['contentSource'];
  expiresAt: number;
}

/**
 * Resolves full file contents (original + modified) for CodeMirror diff view.
 *
 * Uses three-level resolution strategy:
 * 1. File-history backup (most accurate)
 * 2. Snippet reconstruction (reverse-apply edits from current disk state)
 * 3. Fallback to current file on disk
 */
export class FileContentResolver {
  private cache = new Map<string, ContentCacheEntry>();
  private readonly cacheTtl = 30 * 1000; // 30 сек — shorter TTL to reduce stale data risk

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly gitFallback?: GitDiffFallback
  ) {}

  /** Invalidate cached content for a file (e.g. after user saves edits) */
  invalidateFile(filePath: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${filePath}`)) {
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
    const cacheKey = `${teamName}:${memberName}:${filePath}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { original: cached.original, modified: cached.modified, source: cached.source };
    }

    // Read current file from disk (= modified state after agent's changes)
    let currentContent: string | null = null;
    try {
      currentContent = await readFile(filePath, 'utf8');
    } catch {
      logger.debug(`Файл недоступен на диске: ${filePath}`);
    }

    // Strategy 1: Try file-history backup
    const historyResult = await this.tryFileHistoryBackup(teamName, memberName, filePath);
    if (historyResult) {
      const result = {
        original: historyResult,
        modified: currentContent,
        source: 'file-history' as const,
      };
      this.cacheResult(cacheKey, result);
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
      this.cacheResult(cacheKey, result);
      return result;
    }

    // Strategy 3 (Phase 4): Git fallback
    if (this.gitFallback) {
      const gitResult = await this.tryGitFallback(filePath, currentContent, snippets);
      if (gitResult) {
        const result = {
          original: gitResult,
          modified: currentContent,
          source: 'git-fallback' as const,
        };
        this.cacheResult(cacheKey, result);
        return result;
      }
    }

    // Strategy 4: Fallback — only current file on disk
    if (currentContent !== null) {
      const result = {
        original: null,
        modified: currentContent,
        source: 'disk-current' as const,
      };
      this.cacheResult(cacheKey, result);
      return result;
    }

    // Nothing available
    return { original: null, modified: null, source: 'unavailable' };
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

    const isNewFile = snippets.some((s) => s.type === 'write-new');

    return {
      filePath,
      relativePath: filePath.split('/').slice(-3).join('/'),
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
        isNewFile: file.isNewFile,
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
    const parts = logPath.split(path.sep);

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
      const stream = createReadStream(logPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
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
            rl.close();
            stream.destroy();
            return backupFileName;
          }
        } catch {
          // Skip malformed JSON
        }
      }

      rl.close();
      stream.destroy();
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
    if (!currentContent) return null;
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
          // File was created by agent -> original was empty
          return '';
        }

        case 'write-update': {
          // Full file overwrite — can't reconstruct previous content from snippets alone
          return null;
        }

        case 'edit':
        case 'multi-edit': {
          // Guard: empty newString means deletion — can't find position to reverse
          if (!snippet.newString) return null;

          if (snippet.replaceAll) {
            // Reverse replaceAll: replace all occurrences of newString -> oldString
            if (!content.includes(snippet.newString)) {
              // Chain broken — newString not in current content
              return null;
            }
            content = content.split(snippet.newString).join(snippet.oldString);
          } else {
            // Reverse single edit: replace first occurrence of newString -> oldString
            const idx = content.indexOf(snippet.newString);
            if (idx === -1) {
              // Chain broken — can't find the new string to reverse
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

  // ── Private: Git fallback (Phase 4) ──

  /**
   * Strategy 3 (Phase 4): Git fallback — find original content from git history.
   * Uses the timestamp of the first snippet to locate a commit before changes.
   */
  private async tryGitFallback(
    filePath: string,
    _currentContent: string | null,
    snippets: SnippetDiff[]
  ): Promise<string | null> {
    if (!this.gitFallback) return null;

    // Determine project path from file path (heuristic: find .git parent)
    const projectPath = this.guessProjectPath(filePath);
    if (!projectPath) return null;

    const isGit = await this.gitFallback.isGitRepo(projectPath);
    if (!isGit) return null;

    // Use earliest snippet timestamp to find the "before" state
    const timestamps = snippets
      .filter((s) => !s.isError && s.timestamp)
      .map((s) => s.timestamp)
      .sort((a, b) => a.localeCompare(b));
    const firstTimestamp = timestamps[0];
    if (!firstTimestamp) return null;

    const commitHash = await this.gitFallback.findCommitNearTimestamp(
      projectPath,
      filePath,
      firstTimestamp
    );
    if (!commitHash) return null;

    const original = await this.gitFallback.getFileAtCommit(projectPath, filePath, commitHash);
    return original;
  }

  /**
   * Guess the project root path from a file path.
   * Simple heuristic: look for common markers (package.json, .git directory).
   */
  private guessProjectPath(filePath: string): string | null {
    const parts = filePath.split('/');
    // Walk up from file, looking for typical project root indicators
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('/');
      // Simple heuristic: paths with these patterns are likely project roots
      if (candidate.endsWith('/src') || candidate.endsWith('/lib')) {
        return parts.slice(0, i - 1).join('/') || null;
      }
    }
    // Fallback: take the first 4-5 components as project path
    if (parts.length > 4) {
      return parts.slice(0, Math.min(parts.length - 2, 5)).join('/');
    }
    return null;
  }

  // ── Private: Cache helpers ──

  private cacheResult(
    key: string,
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
      expiresAt: Date.now() + this.cacheTtl,
    });
  }
}
