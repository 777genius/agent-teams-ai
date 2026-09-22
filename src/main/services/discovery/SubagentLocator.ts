/**
 * SubagentLocator - Locates and manages subagent files.
 *
 * Responsibilities:
 * - Check if sessions have subagent files
 * - List subagent files for a session
 * - Handle the canonical subagent directory structure:
 *   - {projectId}/{sessionId}/subagents/agent-{agentId}.jsonl
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { buildSubagentsPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { resolveProjectStorageDir, resolveProjectStorageDirSync } from './projectStorageDir';

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Discovery:SubagentLocator');

/**
 * SubagentLocator provides methods for locating subagent files.
 */
export class SubagentLocator {
  private readonly projectsDir: string;
  private readonly fsProvider: FileSystemProvider;

  constructor(projectsDir: string, fsProvider?: FileSystemProvider) {
    this.projectsDir = projectsDir;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }

  /**
   * Checks if a session has subagent files (async).
   * Uses the FileSystemProvider for filesystem access.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to true if subagents exist
   */
  async hasSubagents(projectId: string, sessionId: string): Promise<boolean> {
    // Check NEW structure: {projectId}/{sessionId}/subagents/
    const newSubagentsPath = await this.resolveSubagentsPath(projectId, sessionId);
    if (!newSubagentsPath) {
      return false;
    }
    try {
      const entries = await this.fsProvider.readdir(newSubagentsPath);
      // A non-empty agent-*.jsonl file is sufficient proof of subagents.
      // readdir() populates size from stat, so no extra I/O needed.
      return entries.some(
        (entry) =>
          entry.name.startsWith('agent-') &&
          entry.name.endsWith('.jsonl') &&
          typeof entry.size === 'number' &&
          entry.size > 0
      );
    } catch {
      // Directory doesn't exist or is unreadable — no subagents
      return false;
    }
  }

  /**
   * Checks if a session has subagent files (session-specific only).
   * Only checks the NEW structure: {projectId}/{sessionId}/subagents/
   * Verifies that at least one subagent file has non-empty content.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns true if subagents exist
   */
  hasSubagentsSync(projectId: string, sessionId: string): boolean {
    // Check NEW structure: {projectId}/{sessionId}/subagents/
    const newSubagentsPath = this.getSubagentsPath(projectId, sessionId);
    try {
      const entries = fs.readdirSync(newSubagentsPath);
      // A non-empty agent-*.jsonl file is sufficient proof of subagents.
      return entries.some((name) => {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) return false;
        try {
          const stats = fs.statSync(path.join(newSubagentsPath, name));
          return stats.size > 0;
        } catch {
          return false;
        }
      });
    } catch {
      // Directory doesn't exist or is unreadable — no subagents
      return false;
    }
  }

  /**
   * Lists all subagent files for a session from the canonical session-local structure.
   */
  async listSubagentFiles(projectId: string, sessionId: string): Promise<string[]> {
    try {
      const newSubagentsPath = await this.resolveSubagentsPath(projectId, sessionId);
      if (!newSubagentsPath) {
        return [];
      }
      if (await this.fsProvider.exists(newSubagentsPath)) {
        const entries = await this.fsProvider.readdir(newSubagentsPath);
        return entries
          .filter(
            (entry) =>
              entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')
          )
          .map((entry) => path.join(newSubagentsPath, entry.name));
      }
    } catch (error) {
      logger.error(`Error scanning subagent structure for session ${sessionId}:`, error);
    }

    return [];
  }

  /**
   * Gets the path to the subagents directory.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Path to the subagents directory
   */
  getSubagentsPath(projectId: string, sessionId: string): string {
    const projectPath = resolveProjectStorageDirSync(this.projectsDir, projectId);
    return projectPath
      ? path.join(projectPath, sessionId, 'subagents')
      : buildSubagentsPath(this.projectsDir, projectId, sessionId);
  }

  private async resolveSubagentsPath(projectId: string, sessionId: string): Promise<string | null> {
    const projectPath = await resolveProjectStorageDir(
      this.projectsDir,
      projectId,
      this.fsProvider
    );
    return projectPath ? path.join(projectPath, sessionId, 'subagents') : null;
  }
}
