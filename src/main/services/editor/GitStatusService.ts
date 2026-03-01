/**
 * Git status service for the project editor.
 *
 * Uses `simple-git` with --no-optional-locks (GIT_OPTIONAL_LOCKS=0) to prevent
 * .git/index.lock conflicts during background queries.
 * Results are cached for 5 seconds; invalidated on file watcher events.
 */

import { createLogger } from '@shared/utils/logger';
import { simpleGit } from 'simple-git';

import type { GitFileStatus, GitStatusResult } from '@shared/types/editor';
import type { SimpleGit, StatusResult } from 'simple-git';

const log = createLogger('GitStatusService');

// =============================================================================
// Constants
// =============================================================================

const GIT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5_000;

// =============================================================================
// Service
// =============================================================================

export class GitStatusService {
  private git: SimpleGit | null = null;
  private projectRoot: string | null = null;

  // Cache
  private cachedResult: GitStatusResult | null = null;
  private cacheTimestamp = 0;

  /**
   * Initialize service for a project root.
   * Creates a simple-git instance with --no-optional-locks and timeout.
   */
  init(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.git = simpleGit({
      baseDir: projectRoot,
      timeout: { block: GIT_TIMEOUT_MS },
    }).env('GIT_OPTIONAL_LOCKS', '0');
    this.invalidateCache();
  }

  /**
   * Reset service state.
   */
  destroy(): void {
    this.git = null;
    this.projectRoot = null;
    this.cachedResult = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Invalidate cached status (e.g. on file watcher event).
   */
  invalidateCache(): void {
    this.cachedResult = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Get git status for the current project.
   * Returns cached result if within TTL.
   */
  async getStatus(): Promise<GitStatusResult> {
    if (!this.git || !this.projectRoot) {
      return { files: [], isGitRepo: false, branch: null };
    }

    // Return cached if fresh
    if (this.cachedResult && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
      return this.cachedResult;
    }

    try {
      // Check if it's a git repo first
      const isRepo = await this.isGitRepo();
      if (!isRepo) {
        const result: GitStatusResult = { files: [], isGitRepo: false, branch: null };
        this.setCacheResult(result);
        return result;
      }

      const statusResult = await this.git.status();
      const files = mapStatusResult(statusResult);
      const branch = statusResult.current ?? null;

      const result: GitStatusResult = { files, isGitRepo: true, branch };
      this.setCacheResult(result);
      return result;
    } catch (error) {
      log.error('Failed to get git status:', error);
      // Graceful degradation: return empty non-repo result
      return { files: [], isGitRepo: false, branch: null };
    }
  }

  private async isGitRepo(): Promise<boolean> {
    if (!this.git) return false;
    try {
      await this.git.revparse(['--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  private setCacheResult(result: GitStatusResult): void {
    this.cachedResult = result;
    this.cacheTimestamp = Date.now();
  }
}

// =============================================================================
// Mapping
// =============================================================================

/**
 * Map simple-git StatusResult to our GitFileStatus[] format.
 */
export function mapStatusResult(result: StatusResult): GitFileStatus[] {
  const files: GitFileStatus[] = [];
  for (const p of result.modified) files.push({ path: p, status: 'modified' });
  for (const p of result.not_added) files.push({ path: p, status: 'untracked' });
  for (const p of result.staged) files.push({ path: p, status: 'staged' });
  for (const p of result.deleted) files.push({ path: p, status: 'deleted' });
  for (const p of result.conflicted) files.push({ path: p, status: 'conflict' });
  for (const r of result.renamed) {
    files.push({ path: r.to, status: 'renamed', renamedFrom: r.from });
  }
  return files;
}
