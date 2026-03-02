/**
 * Hook for loading and filtering project files as @-mention suggestions.
 *
 * Uses the Quick Open file list API with a 10s TTL cache.
 * Returns up to 8 matching files filtered by name or relative path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getQuickOpenCache,
  onQuickOpenCacheInvalidated,
  setQuickOpenCache,
} from '@renderer/utils/quickOpenCache';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { QuickOpenFile } from '@shared/types/editor';

const MAX_FILE_SUGGESTIONS = 8;

/**
 * Filters files by query (name or relative path) and converts to MentionSuggestion[].
 * Exported for testing.
 */
export function filterFileSuggestions(files: QuickOpenFile[], query: string): MentionSuggestion[] {
  if (!query || files.length === 0) return [];

  const lower = query.toLowerCase();
  const results: MentionSuggestion[] = [];

  for (const f of files) {
    if (results.length >= MAX_FILE_SUGGESTIONS) break;

    if (f.name.toLowerCase().includes(lower) || f.relativePath.toLowerCase().includes(lower)) {
      results.push({
        id: `file:${f.path}`,
        name: f.name,
        subtitle: f.relativePath,
        type: 'file',
        filePath: f.path,
        relativePath: f.relativePath,
      });
    }
  }

  return results;
}

/**
 * Loads project files and returns filtered MentionSuggestion[] with type: 'file'.
 *
 * @param projectPath - Project root path (null disables)
 * @param query - Current @-mention query string
 * @param enabled - Whether file suggestions are active (isOpen && enableFiles)
 */
export function useFileSuggestions(
  projectPath: string | null,
  query: string,
  enabled: boolean
): MentionSuggestion[] {
  const [allFiles, setAllFiles] = useState<QuickOpenFile[]>([]);
  // Bumped on cache invalidation (file create/delete) to trigger refetch
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Seed from cache immediately when projectPath changes (setState-during-render pattern)
  const [prevPath, setPrevPath] = useState(projectPath);
  if (prevPath !== projectPath) {
    setPrevPath(projectPath);
    const cached = projectPath ? getQuickOpenCache(projectPath) : null;
    if (cached) {
      setAllFiles(cached.files);
    } else {
      setAllFiles([]);
    }
  }

  // React to cache invalidation from EditorFileWatcher (create/delete events)
  useEffect(() => {
    return onQuickOpenCacheInvalidated(() => setFetchTrigger((n) => n + 1));
  }, []);

  // Lazy refetch: when dropdown opens and cache is stale, trigger a reload
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (enabled && !prevEnabled && projectPath && !getQuickOpenCache(projectPath)) {
    setFetchTrigger((n) => n + 1);
  }
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
  }

  // Load files from API when cache is empty.
  // Uses project:listFiles (not editor:listFiles) — works without editor being open.
  const fetchFiles = useCallback(
    (projectRoot: string) => {
      let cancelled = false;
      window.electronAPI.project
        .listFiles(projectRoot)
        .then((files) => {
          if (cancelled) return;
          setQuickOpenCache(projectRoot, files);
          setAllFiles(files);
        })
        .catch(() => {
          // Project path may be invalid — will retry on next trigger
        });
      return () => {
        cancelled = true;
      };
    },
    [] // listFiles API is stable
  );

  useEffect(() => {
    if (!projectPath) return;

    // Cache already seeded during render — only fetch if missing
    const cached = getQuickOpenCache(projectPath);
    if (cached) return;

    return fetchFiles(projectPath);
  }, [projectPath, fetchTrigger, fetchFiles]);

  // Filter by query and convert to MentionSuggestion[]
  return useMemo(
    () => (enabled ? filterFileSuggestions(allFiles, query) : []),
    [enabled, query, allFiles]
  );
}
