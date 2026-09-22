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
const CHANGE_INVALIDATION_DEBOUNCE_MS = 500;
const GIT_STATUS_ARGS: string[] = ['--untracked-files=no'];

// =============================================================================
// Service
// =============================================================================

export class GitStatusService {
  private git: SimpleGit | null = null;
  private projectRoot: string | null = null;
  /** Set to true when we confirm the project is not a git repo — skip all future git calls. */
  private notAGitRepo = false;

  // Cache
  private cachedResult: GitStatusResult | null = null;
  private cacheTimestamp = 0;
  private changeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Initialize service for a project root.
   * Creates a simple-git instance with --no-optional-locks and timeout.
   */
  init(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.notAGitRepo = false;
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
    this.clearDebounceTimer();
    this.git = null;
    this.projectRoot = null;
    this.notAGitRepo = false;
    this.cachedResult = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Immediate cache invalidation for structural changes (create/delete).
   * Also cancels any pending debounced invalidation.
   */
  invalidateCache(): void {
    this.clearDebounceTimer();
    this.cachedResult = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Debounced cache invalidation for content changes.
   * Coalesces rapid file saves (typing, format-on-save, build output)
   * into a single invalidation after the burst settles.
   */
  invalidateCacheDebounced(): void {
    this.clearDebounceTimer();
    this.changeDebounceTimer = setTimeout(() => {
      this.changeDebounceTimer = null;
      this.cachedResult = null;
      this.cacheTimestamp = 0;
    }, CHANGE_INVALIDATION_DEBOUNCE_MS);
  }

  /**
   * Get git status for the current project.
   * Returns cached result if within TTL.
   */
  async getStatus(): Promise<GitStatusResult> {
    const notGitResult: GitStatusResult = { files: [], isGitRepo: false, branch: null };

    if (!this.git || !this.projectRoot || this.notAGitRepo) {
      return notGitResult;
    }

    // Flush pending debounced invalidation — when data is actually requested,
    // stale cache must not be served even if the debounce hasn't settled yet.
    if (this.changeDebounceTimer) {
      this.invalidateCache();
    }

    // Return cached if fresh
    if (this.cachedResult && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
      log.info('[perf] gitStatus: cache hit');
      return this.cachedResult;
    }

    try {
      const t0 = performance.now();
      // `--untracked-files=no` is a major performance win for large repos with many untracked files.
      // Most editors treat untracked as a separate concern; showing them can overwhelm the UI.
      const statusResult = await this.git.status(GIT_STATUS_ARGS);
      const gitMs = performance.now() - t0;
      const files = mapStatusResult(statusResult);
      const branch = statusResult.current ?? null;
      log.info(
        `[perf] gitStatus: git=${gitMs.toFixed(1)}ms, files=${files.length}, branch=${branch ?? 'detached'}, untracked=off`
      );

      const result: GitStatusResult = { files, isGitRepo: true, branch };
      this.setCacheResult(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not a git repository')) {
        // Expected condition — project is not a git repo. Stop all future git calls
        // until init() is called again with a different project.
        log.info('Project is not a git repository, disabling git status');
        this.notAGitRepo = true;
        return notGitResult;
      }

      log.error('Failed to get git status:', error);
      // Transient error — cache negative result to avoid hammering git, but allow retry after TTL
      this.setCacheResult(notGitResult);
      return notGitResult;
    }
  }

  private setCacheResult(result: GitStatusResult): void {
    this.cachedResult = result;
    this.cacheTimestamp = Date.now();
  }

  private clearDebounceTimer(): void {
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
      this.changeDebounceTimer = null;
    }
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
