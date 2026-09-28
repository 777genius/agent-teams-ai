import { createLogger } from '@shared/utils/logger';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { createHash } from 'crypto';
import { diffLines } from 'diff';
import { readFile } from 'fs/promises';
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
 * 1. Exact ledger content
 * 2. Current disk content with an unavailable baseline
 */
export class FileContentResolver {
  private cache = new Map<string, ContentCacheEntry>();
  private readonly provisionalCacheTtl = 5 * 1000;

  constructor(
    // Retained for existing callers. Historical backups lack a task-bound
    // postimage and cannot safely drive rejection.
    _logsFinder: TeamMemberLogsFinder,
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

    // A native add and today's file bytes do not prove the path's identity at
    // task time. A symlink can change after the transcript was written.
    // Keep the snippet diff for preview, but require exact ledger evidence for rejection.
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

  // ── Private: Lifecycle evidence ──

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
    const successful = snippets.filter((snippet) => !snippet.isError);
    const timestamps = successful.map((snippet) => Date.parse(snippet.timestamp));
    if (timestamps.length === 0 || timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
      return false;
    }
    const earliest = timestamps.reduce(
      (minimum, timestamp) => Math.min(minimum, timestamp),
      Infinity
    );
    // Identical timestamps across transcripts cannot establish which event came
    // first. A pre-existing path may have been deleted before a later add.
    return successful.every(
      (snippet, index) => timestamps[index] !== earliest || this.isProvenCreationSnippet(snippet)
    );
  }

  private isProvenCreationSnippet(snippet: SnippetDiff): boolean {
    if (snippet.ledger?.operation === 'create') return true;

    // TaskChangeComputer emits write-new for explicit metadata `kind: add` using
    // the Edit tool name. A bare legacy Write has no pre-task existence evidence.
    return snippet.type === 'write-new' && snippet.toolName === 'Edit';
  }

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
      hash.update(snippet.toolName);
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
