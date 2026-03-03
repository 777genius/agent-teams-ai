/**
 * ProjectPathResolver - Resolves encoded project IDs to canonical filesystem paths.
 *
 * Resolution order:
 * 1) cwd hint (if provided and absolute)
 * 2) cwd extracted from session JSONL files (authoritative)
 * 3) decodePath(projectId) fallback (lossy, best-effort)
 *
 * Results are memoized per projectId and can be invalidated by file watcher events.
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { extractCwd } from '@main/utils/jsonl';
import { decodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { subprojectRegistry } from './SubprojectRegistry';

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Discovery:ProjectPathResolver');

interface ResolveProjectPathOptions {
  cwdHint?: string;
  sessionPaths?: string[];
  forceRefresh?: boolean;
}

export class ProjectPathResolver {
  private readonly projectsDir: string;
  private readonly fsProvider: FileSystemProvider;
  private readonly projectPathCache = new Map<string, string>();

  constructor(projectsDir?: string, fsProvider?: FileSystemProvider) {
    this.projectsDir = projectsDir ?? getProjectsBasePath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }

  /**
   * Resolve a project ID to a canonical path.
   */
  async resolveProjectPath(
    projectId: string,
    options?: ResolveProjectPathOptions
  ): Promise<string> {
    const opts = options ?? {};

    // Short-circuit for composite IDs: use the registry's cwd directly
    const registryCwd = subprojectRegistry.getCwd(projectId);
    if (registryCwd) {
      this.projectPathCache.set(projectId, registryCwd);
      return registryCwd;
    }

    if (!opts.forceRefresh) {
      const cached = this.projectPathCache.get(projectId);
      if (cached) {
        return cached;
      }
    }

    const cwdHint = opts.cwdHint?.trim();
    if (cwdHint && path.isAbsolute(cwdHint)) {
      this.projectPathCache.set(projectId, cwdHint);
      return cwdHint;
    }

    const sessionPaths = opts.sessionPaths?.length
      ? opts.sessionPaths
      : await this.listSessionPaths(projectId);

    // In SSH mode, avoid scanning every remote session file just to resolve display path.
    // One successful cwd extraction is sufficient.
    const MAX_LOCAL_PATHS_TO_INSPECT = 5;
    const maxPathsToInspect =
      this.fsProvider.type === 'ssh'
        ? 1
        : Math.min(sessionPaths.length, MAX_LOCAL_PATHS_TO_INSPECT);
    for (const sessionPath of sessionPaths.slice(0, maxPathsToInspect)) {
      try {
        const cwd = await extractCwd(sessionPath, this.fsProvider);
        if (cwd && path.isAbsolute(cwd)) {
          this.projectPathCache.set(projectId, cwd);
          return cwd;
        }
      } catch {
        // Ignore unreadable or malformed files and continue to next candidate.
      }
    }

    const decoded = decodePath(extractBaseDir(projectId));
    this.projectPathCache.set(projectId, decoded);
    return decoded;
  }

  /**
   * Invalidate a single project's cached path.
   */
  invalidateProject(projectId: string): void {
    this.projectPathCache.delete(projectId);
  }

  /**
   * Clear all cached project paths.
   */
  clear(): void {
    this.projectPathCache.clear();
  }

  private async listSessionPaths(projectId: string): Promise<string[]> {
    const projectDir = path.join(this.projectsDir, extractBaseDir(projectId));
    if (!(await this.fsProvider.exists(projectDir))) {
      return [];
    }

    try {
      const entries = await this.fsProvider.readdir(projectDir);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => path.join(projectDir, entry.name));
    } catch (error) {
      logger.error(`Failed to read session files for ${projectId}:`, error);
      return [];
    }
  }
}

export const projectPathResolver = new ProjectPathResolver();
