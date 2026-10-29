import * as path from 'node:path';

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 10_000; // 10s timeout for all git operations
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

function toRepoRelativePath(projectPath: string, filePath: string): string | null {
  const normalizedProject = path.resolve(projectPath);
  const normalizedFile = path.isAbsolute(filePath) ? path.resolve(filePath) : filePath;

  // If we have an absolute file path, require it to be under projectPath.
  if (path.isAbsolute(normalizedFile)) {
    const rel = path.relative(normalizedProject, normalizedFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    // Git pathspecs use forward slashes even on Windows.
    const gitPath = rel.replace(/\\/g, '/');
    if (gitPath.includes(':')) return null;
    return gitPath;
  }

  // Relative path: normalize separators for git.
  const gitPath = normalizedFile.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (
    !gitPath ||
    gitPath.startsWith('/') ||
    /^[a-zA-Z]:\//.test(gitPath) ||
    gitPath.includes(':')
  ) {
    return null;
  }
  return gitPath;
}

export class GitDiffFallback {
  private gitRepoCache = new Map<string, boolean>();

  /**
   * Get file contents at a specific commit.
   * Used when file-history-snapshot is unavailable.
   */
  async getFileAtCommit(
    projectPath: string,
    filePath: string,
    commitHash: string
  ): Promise<string | null> {
    try {
      const relativePath = toRepoRelativePath(projectPath, filePath);
      if (!relativePath) return null;
      const { stdout } = await execFileAsync('git', ['show', `${commitHash}:${relativePath}`], {
        cwd: projectPath,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Find the commit closest to (but before) a given timestamp for a file.
   */
  async findCommitNearTimestamp(
    projectPath: string,
    filePath: string,
    timestamp: string
  ): Promise<string | null> {
    try {
      const relativePath = toRepoRelativePath(projectPath, filePath);
      if (!relativePath) return null;
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--format=%H', '--before', timestamp, '-1', '--', relativePath],
        { cwd: projectPath, timeout: GIT_TIMEOUT, windowsHide: true }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get git diff for a file between two refs.
   */
  async getGitDiff(
    projectPath: string,
    filePath: string,
    fromCommit: string,
    toCommit: string = 'HEAD'
  ): Promise<string | null> {
    try {
      const relativePath = toRepoRelativePath(projectPath, filePath);
      if (!relativePath) return null;
      const { stdout } = await execFileAsync(
        'git',
        ['diff', fromCommit, toCommit, '--', relativePath],
        { cwd: projectPath, timeout: GIT_TIMEOUT, windowsHide: true }
      );
      return stdout || null;
    } catch {
      return null;
    }
  }

  /**
   * Get file change log (for timeline enrichment).
   */
  async getFileLog(
    projectPath: string,
    filePath: string,
    maxCount: number = 20
  ): Promise<{ hash: string; timestamp: string; message: string }[]> {
    try {
      const relativePath = toRepoRelativePath(projectPath, filePath);
      if (!relativePath) return [];
      const { stdout } = await execFileAsync(
        'git',
        ['log', `--max-count=${maxCount}`, '--format=%H|%aI|%s', '--', relativePath],
        { cwd: projectPath, timeout: GIT_TIMEOUT, windowsHide: true }
      );

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.includes('|'))
        .map((line) => {
          const [hash, timestamp, ...msgParts] = line.split('|');
          return { hash, timestamp, message: msgParts.join('|') };
        });
    } catch {
      return [];
    }
  }

  /**
   * Check if a path is inside a git repository.
   * Result is cached per projectPath for the session lifetime.
   */
  async isGitRepo(projectPath: string): Promise<boolean> {
    const cached = this.gitRepoCache.get(projectPath);
    if (cached !== undefined) return cached;

    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectPath,
        timeout: GIT_TIMEOUT,
        windowsHide: true,
      });
      this.gitRepoCache.set(projectPath, true);
      return true;
    } catch {
      this.gitRepoCache.set(projectPath, false);
      return false;
    }
  }
}
