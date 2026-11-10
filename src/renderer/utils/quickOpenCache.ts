/**
 * Module-level cache for Quick Open file list.
 * Separated from QuickOpenDialog to avoid circular dependency with editorSlice.
 */

import type { QuickOpenFile } from '@shared/types/editor';

const FILE_LIST_CACHE_TTL = 10_000; // 10 seconds

let fileListCache: { files: QuickOpenFile[]; projectPath: string; timestamp: number } | null = null;

const invalidationListeners = new Set<() => void>();

/** Subscribe to cache invalidation events. Returns unsubscribe function. */
export function onQuickOpenCacheInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/** Invalidate file list cache (call on file watcher create/delete events) */
export function invalidateQuickOpenCache(): void {
  fileListCache = null;
  invalidationListeners.forEach((fn) => fn());
}

/** Get cached file list if fresh and for the same project */
export function getQuickOpenCache(projectPath: string): { files: QuickOpenFile[] } | null {
  if (
    fileListCache?.projectPath === projectPath &&
    Date.now() - fileListCache.timestamp < FILE_LIST_CACHE_TTL
  ) {
    return { files: fileListCache.files };
  }
  return null;
}

/** Store file list in cache */
export function setQuickOpenCache(projectPath: string, files: QuickOpenFile[]): void {
  fileListCache = { files, projectPath, timestamp: Date.now() };
}
