/**
 * File search service — literal string search across project files.
 *
 * Security: path containment enforced via isPathWithinRoot. .git/ blocked.
 * Performance: max 1000 files, max 1MB/file, 5s timeout via AbortController.
 */

import { isGitInternalPath, isPathWithinRoot } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';
import * as path from 'path';

import type {
  SearchFileResult,
  SearchInFilesOptions,
  SearchInFilesResult,
  SearchMatch,
} from '@shared/types/editor';

// =============================================================================
// Constants
// =============================================================================

const MAX_FILES = 1000;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_MAX_RESULT_FILES = 100;
const DEFAULT_MAX_MATCHES = 500;
const SEARCH_TIMEOUT_MS = 5000;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  '__pycache__',
  '.cache',
  '.venv',
  '.tox',
  'vendor',
  'build',
  'coverage',
  '.turbo',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const log = createLogger('FileSearchService');

// =============================================================================
// Service
// =============================================================================

export class FileSearchService {
  /**
   * List all files in the project recursively (for Quick Open).
   * Lightweight — no content reading, no binary checks, no stat.
   * Returns relative paths for display and absolute paths for opening.
   */
  async listFiles(
    projectRoot: string,
    signal?: AbortSignal
  ): Promise<{ path: string; name: string; relativePath: string }[]> {
    const files: { path: string; name: string; relativePath: string }[] = [];
    await this.collectFilePaths(projectRoot, projectRoot, files, signal);
    return files;
  }

  /**
   * Search for a literal string across project files.
   *
   * @param projectRoot - Validated project root path
   * @param options - Search options (query, caseSensitive, limits)
   * @param signal - Optional AbortSignal for cancellation
   */
  async searchInFiles(
    projectRoot: string,
    options: SearchInFilesOptions,
    signal?: AbortSignal
  ): Promise<SearchInFilesResult> {
    const { query, caseSensitive = false } = options;
    const maxFiles = Math.min(
      options.maxFiles ?? DEFAULT_MAX_RESULT_FILES,
      DEFAULT_MAX_RESULT_FILES
    );
    const maxMatches = Math.min(options.maxMatches ?? DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES);

    if (!query || query.length === 0) {
      return { results: [], totalMatches: 0, truncated: false };
    }

    const searchQuery = caseSensitive ? query : query.toLowerCase();

    // Collect all searchable files
    const files: string[] = [];
    await this.collectFiles(projectRoot, projectRoot, files, signal);

    const results: SearchFileResult[] = [];
    let totalMatches = 0;
    let truncated = false;

    for (const filePath of files) {
      if (signal?.aborted) break;
      if (results.length >= maxFiles || totalMatches >= maxMatches) {
        truncated = true;
        break;
      }

      try {
        const matches = await this.searchFile(filePath, searchQuery, caseSensitive, signal);
        if (matches.length > 0) {
          const remaining = maxMatches - totalMatches;
          const trimmedMatches = matches.length > remaining ? matches.slice(0, remaining) : matches;

          results.push({ filePath, matches: trimmedMatches });
          totalMatches += trimmedMatches.length;

          if (totalMatches >= maxMatches) {
            truncated = true;
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return { results, totalMatches, truncated };
  }

  /**
   * Lightweight recursive file path collection (no stat, no binary check).
   * Used by listFiles() for Quick Open — needs to be fast.
   */
  private async collectFilePaths(
    projectRoot: string,
    dirPath: string,
    files: { path: string; name: string; relativePath: string }[],
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted || files.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (signal?.aborted || files.length >= MAX_FILES) break;

      const fullPath = path.join(dirPath, entry.name);

      if (!isPathWithinRoot(fullPath, projectRoot)) continue;
      if (isGitInternalPath(fullPath)) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await this.collectFilePaths(projectRoot, fullPath, files, signal);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        const relativePath = fullPath.startsWith(projectRoot)
          ? fullPath.slice(projectRoot.length + 1)
          : entry.name;
        files.push({ path: fullPath, name: entry.name, relativePath });
      }
    }
  }

  /**
   * Recursively collect all searchable files.
   */
  private async collectFiles(
    projectRoot: string,
    dirPath: string,
    files: string[],
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted || files.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Permission denied or not a directory
    }

    // Sort: files first for early results
    const sorted = [...entries].sort((a, b) => {
      if (a.isFile() && !b.isFile()) return -1;
      if (!a.isFile() && b.isFile()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      if (signal?.aborted || files.length >= MAX_FILES) break;

      const fullPath = path.join(dirPath, entry.name);

      // Security: containment check
      if (!isPathWithinRoot(fullPath, projectRoot)) continue;

      // Block .git internal paths
      if (isGitInternalPath(fullPath)) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await this.collectFiles(projectRoot, fullPath, files, signal);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;

        // Skip files > 1MB
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        // Skip binary files (quick check via first 512 bytes)
        try {
          if (await isBinaryFile(fullPath)) continue;
        } catch {
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  /**
   * Search a single file for literal string matches.
   */
  private async searchFile(
    filePath: string,
    query: string,
    caseSensitive: boolean,
    signal?: AbortSignal
  ): Promise<SearchMatch[]> {
    if (signal?.aborted) return [];

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const matches: SearchMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) break;

      const line = lines[i];
      const searchLine = caseSensitive ? line : line.toLowerCase();
      let startIndex = 0;

      while (true) {
        const idx = searchLine.indexOf(query, startIndex);
        if (idx === -1) break;

        matches.push({
          line: i + 1,
          column: idx,
          lineContent: line.trim(),
        });

        startIndex = idx + query.length;
      }
    }

    return matches;
  }
}

/**
 * Create an AbortController with automatic timeout.
 */
export function createSearchAbortController(): AbortController {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    log.warn('Search timed out after', SEARCH_TIMEOUT_MS, 'ms');
  }, SEARCH_TIMEOUT_MS);

  // Clean up timeout when aborted by other means
  controller.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

  return controller;
}
