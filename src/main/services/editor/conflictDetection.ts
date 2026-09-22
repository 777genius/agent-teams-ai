/**
 * Conflict detection utility for the project editor.
 *
 * Checks if a file has been modified externally since the last known mtime.
 * Used before saving to prevent silently overwriting external changes.
 */

import * as fs from 'fs/promises';

// =============================================================================
// Types
// =============================================================================

export interface ConflictCheckResult {
  /** True if the file was modified externally */
  hasConflict: boolean;
  /** Current mtime on disk */
  currentMtimeMs: number;
  /** True if the file no longer exists on disk */
  deleted: boolean;
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Check if a file has been modified since the given baseline mtime.
 *
 * @param filePath - Absolute path to the file
 * @param baselineMtimeMs - Last known mtime (from readFile result)
 * @returns Conflict check result
 */
export async function checkFileConflict(
  filePath: string,
  baselineMtimeMs: number
): Promise<ConflictCheckResult> {
  try {
    const stats = await fs.stat(filePath);
    const currentMtimeMs = stats.mtimeMs;

    // Allow 1ms tolerance for filesystem rounding
    const hasConflict = Math.abs(currentMtimeMs - baselineMtimeMs) > 1;

    return { hasConflict, currentMtimeMs, deleted: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hasConflict: true, currentMtimeMs: 0, deleted: true };
    }
    throw error;
  }
}
