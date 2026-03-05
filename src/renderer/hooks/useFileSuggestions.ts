/**
 * Hook for loading and filtering project files as @-mention suggestions.
 *
 * Uses the Quick Open file list API with a 10s TTL cache.
 * Returns up to 8 matching files filtered by name or relative path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getQuickOpenCache,
  onQuickOpenCacheInvalidated,
  setQuickOpenCache,
} from '@renderer/utils/quickOpenCache';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { QuickOpenFile } from '@shared/types/editor';

const MAX_FILE_SUGGESTIONS = 8;

export interface UseFileSuggestionsResult {
  suggestions: MentionSuggestion[];
  loading: boolean;
}

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
): UseFileSuggestionsResult {
  // Seed from cache on initial mount (lazy initializer) AND on projectPath change
  const [allFiles, setAllFiles] = useState<QuickOpenFile[]>(() => {
    if (!projectPath) return [];
    return getQuickOpenCache(projectPath)?.files ?? [];
  });
  const [loading, setLoading] = useState(false);
  // Bumped on cache invalidation (file create/delete) to trigger refetch
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Re-seed from cache when projectPath changes
  useEffect(() => {
    if (!projectPath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with prop change
      setAllFiles([]);
      return;
    }
    const cached = getQuickOpenCache(projectPath);
    setAllFiles(cached?.files ?? []);
  }, [projectPath]);

  // React to cache invalidation from EditorFileWatcher (create/delete events)
  useEffect(() => {
    return onQuickOpenCacheInvalidated(() => setFetchTrigger((n) => n + 1));
  }, []);

  // Lazy refetch: when dropdown opens and cache is stale, trigger a reload
  const prevEnabledRef = useRef(enabled);
  useEffect(() => {
    if (enabled && !prevEnabledRef.current && projectPath && !getQuickOpenCache(projectPath)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional trigger on state transition
      setFetchTrigger((n) => n + 1);
    }
    prevEnabledRef.current = enabled;
  }, [enabled, projectPath]);

  // Load files from API when cache is empty.
  // Uses project:listFiles (not editor:listFiles) — works without editor being open.
  const fetchFiles = useCallback(
    (projectRoot: string) => {
      let cancelled = false;
      setLoading(true);
      window.electronAPI.project
        .listFiles(projectRoot)
        .then((files) => {
          if (cancelled) return;
          setQuickOpenCache(projectRoot, files);
          setAllFiles(files);
        })
        .catch(() => {
          // Project path may be invalid — will retry on next trigger
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [] // listFiles API is stable
  );

  // Fetch only when cache is empty. Cache seeding is handled by:
  // - lazy initializer (first mount)
  // - effect (projectPath change)
  useEffect(() => {
    if (!projectPath) return;

    const cached = getQuickOpenCache(projectPath);
    if (cached) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- setLoading before async fetch is intentional
    return fetchFiles(projectPath);
  }, [projectPath, fetchTrigger, fetchFiles]);

  // Filter by query and convert to MentionSuggestion[]
  const suggestions = useMemo(
    () => (enabled ? filterFileSuggestions(allFiles, query) : []),
    [enabled, query, allFiles]
  );

  return { suggestions, loading };
}
