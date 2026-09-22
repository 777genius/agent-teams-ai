/**
 * Context Storage - IndexedDB persistence layer for context snapshots.
 *
 * Provides TTL-based storage for workspace state snapshots, enabling
 * instant restoration when switching between local and SSH contexts.
 */

import { del, get, keys, set } from 'idb-keyval';

import type { DetectedError, Project, RepositoryGroup, Session } from '@renderer/types/data';
import type { PaneLayout } from '@renderer/types/panes';
import type { Tab } from '@renderer/types/tabs';

// =============================================================================
// Constants
// =============================================================================

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_KEY_PREFIX = 'context-snapshot:';
const SNAPSHOT_VERSION = 1; // Increment when ContextSnapshot structure changes

// =============================================================================
// Types
// =============================================================================

/**
 * Context snapshot - persistable state for instant workspace switching.
 * Excludes transient state (loading flags, errors, search, non-serializable Maps/Sets).
 */
export interface ContextSnapshot {
  // Data state (persistable)
  projects: Project[];
  selectedProjectId: string | null;
  repositoryGroups: RepositoryGroup[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  viewMode: 'flat' | 'grouped';
  sessions: Session[];
  selectedSessionId: string | null;
  sessionsCursor: string | null;
  sessionsHasMore: boolean;
  sessionsTotalCount: number;
  pinnedSessionIds: string[];
  notifications: DetectedError[];
  unreadCount: number;

  // Tab/pane state
  openTabs: Tab[];
  activeTabId: string | null;
  selectedTabIds: string[];
  activeProjectId: string | null;
  paneLayout: PaneLayout;

  // UI state
  sidebarCollapsed: boolean;

  // Metadata
  _metadata: {
    contextId: string;
    capturedAt: number;
    version: number;
  };
}

/**
 * Stored snapshot - wraps ContextSnapshot with timestamp and version.
 */
interface StoredSnapshot {
  snapshot: ContextSnapshot;
  timestamp: number;
  version: number;
}

// =============================================================================
// Storage Implementation
// =============================================================================

/**
 * Save a context snapshot to IndexedDB.
 */
async function saveSnapshot(contextId: string, snapshot: ContextSnapshot): Promise<void> {
  try {
    const stored: StoredSnapshot = {
      snapshot,
      timestamp: Date.now(),
      version: SNAPSHOT_VERSION,
    };
    const key = `${STORAGE_KEY_PREFIX}${contextId}`;
    await set(key, stored);
  } catch (error) {
    console.error(`[contextStorage] Failed to save snapshot for ${contextId}:`, error);
  }
}

/**
 * Load a context snapshot from IndexedDB.
 * Returns null if not found, expired, or invalid.
 */
async function loadSnapshot(contextId: string): Promise<ContextSnapshot | null> {
  try {
    const key = `${STORAGE_KEY_PREFIX}${contextId}`;
    const stored = await get<StoredSnapshot>(key);

    if (!stored) {
      return null;
    }

    // Check TTL
    const age = Date.now() - stored.timestamp;
    if (age > SNAPSHOT_TTL_MS) {
      // Expired - delete and return null
      void deleteSnapshot(contextId);
      return null;
    }

    // Check version compatibility (simple check for now)
    if (stored.version !== SNAPSHOT_VERSION) {
      console.warn(
        `[contextStorage] Snapshot version mismatch for ${contextId}: expected ${SNAPSHOT_VERSION}, got ${stored.version}`
      );
      void deleteSnapshot(contextId);
      return null;
    }

    return stored.snapshot;
  } catch (error) {
    console.error(`[contextStorage] Failed to load snapshot for ${contextId}:`, error);
    return null;
  }
}

/**
 * Delete a context snapshot from IndexedDB.
 */
async function deleteSnapshot(contextId: string): Promise<void> {
  try {
    const key = `${STORAGE_KEY_PREFIX}${contextId}`;
    await del(key);
  } catch (error) {
    console.error(`[contextStorage] Failed to delete snapshot for ${contextId}:`, error);
  }
}

/**
 * Clean up expired snapshots.
 * Iterates all context snapshots and deletes expired ones.
 */
async function cleanupExpired(): Promise<void> {
  try {
    const allKeys = await keys();
    const snapshotKeys = allKeys.filter(
      (k): k is IDBValidKey & string => typeof k === 'string' && k.startsWith(STORAGE_KEY_PREFIX)
    );

    const now = Date.now();

    for (const key of snapshotKeys) {
      try {
        const stored = await get<StoredSnapshot>(key);
        if (stored) {
          const age = now - stored.timestamp;
          if (age > SNAPSHOT_TTL_MS) {
            await del(key);
          }
        }
      } catch (error) {
        // Skip individual key errors
        console.error(`[contextStorage] Failed to check/delete key ${String(key)}:`, error);
      }
    }
  } catch (error) {
    console.error('[contextStorage] Failed to cleanup expired snapshots:', error);
  }
}

/**
 * Check if IndexedDB is available.
 * Returns true if storage is accessible, false otherwise.
 */
async function isAvailable(): Promise<boolean> {
  try {
    const testKey = '__idb_test__';
    await set(testKey, true);
    await del(testKey);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Exports
// =============================================================================

export const contextStorage = {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  cleanupExpired,
  isAvailable,
};
