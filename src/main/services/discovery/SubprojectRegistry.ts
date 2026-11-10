/**
 * SubprojectRegistry - Maps composite project IDs to their split data.
 *
 * When multiple sessions in the same encoded directory have different `cwd` values,
 * they are split into separate "subprojects". Each subproject gets a composite ID
 * of the form `{encodedDir}::{sha256(cwd).slice(0,8)}`.
 *
 * This singleton registry tracks:
 * - Which base directory a composite ID maps to
 * - Which cwd each subproject represents
 * - Which session IDs belong to each subproject
 */

import * as crypto from 'crypto';

interface SubprojectEntry {
  baseDir: string;
  cwd: string;
  sessionIds: Set<string>;
}

export interface SubprojectRegistrySnapshotEntry {
  id: string;
  baseDir: string;
  cwd: string;
  sessionIds: string[];
}

class SubprojectRegistryImpl {
  private readonly entries = new Map<string, SubprojectEntry>();

  /**
   * Register a subproject and return its composite ID.
   *
   * @param baseDir - The encoded directory name (e.g., "-Users-name-project")
   * @param cwd - The actual working directory for this subproject
   * @param sessionIds - Session IDs belonging to this subproject
   * @returns Composite ID in the form `{baseDir}::{hash}`
   */
  register(baseDir: string, cwd: string, sessionIds: string[]): string {
    const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    const compositeId = `${baseDir}::${hash}`;
    this.entries.set(compositeId, {
      baseDir,
      cwd,
      sessionIds: new Set(sessionIds),
    });
    return compositeId;
  }

  /**
   * Extract the base directory from any project ID (composite or plain).
   * For composite IDs (`{encoded}::{hash}`), returns the encoded part.
   * For plain IDs, returns the ID as-is.
   */
  getBaseDir(projectId: string): string {
    const sep = projectId.indexOf('::');
    if (sep !== -1) {
      return projectId.slice(0, sep);
    }
    return projectId;
  }

  /**
   * Check if a project ID is a composite (split) ID.
   */
  isComposite(projectId: string): boolean {
    return projectId.includes('::');
  }

  /**
   * Get the session ID filter set for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getSessionFilter(projectId: string): Set<string> | null {
    const entry = this.entries.get(projectId);
    return entry?.sessionIds ?? null;
  }

  /**
   * Get the cwd for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getCwd(projectId: string): string | null {
    const entry = this.entries.get(projectId);
    return entry?.cwd ?? null;
  }

  /**
   * Get the full entry for a composite project ID.
   */
  getEntry(projectId: string): SubprojectEntry | undefined {
    return this.entries.get(projectId);
  }

  /**
   * Clear all registered subprojects. Called at the start of a full re-scan.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Capture a deep copy of the current registry so an interrupted scan can
   * restore the previous complete project view.
   */
  snapshot(): SubprojectRegistrySnapshotEntry[] {
    return [...this.entries.entries()].map(([id, entry]) => ({
      id,
      baseDir: entry.baseDir,
      cwd: entry.cwd,
      sessionIds: [...entry.sessionIds],
    }));
  }

  /**
   * Replace the registry contents with a previously captured snapshot.
   */
  restore(snapshot: readonly SubprojectRegistrySnapshotEntry[]): void {
    this.entries.clear();
    for (const entry of snapshot) {
      this.entries.set(entry.id, {
        baseDir: entry.baseDir,
        cwd: entry.cwd,
        sessionIds: new Set(entry.sessionIds),
      });
    }
  }
}

/** Module-level singleton */
export const subprojectRegistry = new SubprojectRegistryImpl();
