/**
 * Hook for loading and filtering project files and folders as @-mention suggestions.
 *
 * Uses the Quick Open file list API with a 10s TTL cache.
 * Returns up to 8 matching files/folders filtered by name or relative path.
 * Folders are derived from file paths (no extra IPC call needed).
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
const MAX_FOLDER_SUGGESTIONS = 5;

export interface UseFileSuggestionsResult {
  suggestions: MentionSuggestion[];
  loading: boolean;
}

/** Folder entry derived from file paths. */
interface DerivedFolder {
  /** Folder name (last segment, e.g. "ui") */
  name: string;
  /** Relative path with trailing slash, e.g. "src/renderer/components/ui/" */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
}

/**
 * Extracts unique directories from a list of file paths.
 * Returns directories sorted by depth (shallower first), then alphabetically.
 */
function extractDirectories(files: QuickOpenFile[], projectPath: string): DerivedFolder[] {
  const dirSet = new Set<string>();

  for (const f of files) {
    // Walk up the directory chain from each file's relative path
    const parts = f.relativePath.split('/');
    // Remove the file name — keep only directory segments
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }

  const folders: DerivedFolder[] = [];
  for (const relDir of dirSet) {
    const segments = relDir.split('/');
    const name = segments[segments.length - 1];
    folders.push({
      name,
      relativePath: relDir + '/',
      absolutePath: projectPath + '/' + relDir,
    });
  }

  // Sort: shallower first, then alphabetically
  folders.sort((a, b) => {
    const depthA = a.relativePath.split('/').length;
    const depthB = b.relativePath.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return folders;
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
 * Filters folders by query and converts to MentionSuggestion[].
 * Exported for testing.
 */
export function filterFolderSuggestions(
  folders: DerivedFolder[],
  query: string
): MentionSuggestion[] {
  if (!query || folders.length === 0) return [];

  // Strip trailing slash from query for matching (e.g. "ui/" -> "ui")
  const cleanQuery = query.endsWith('/') ? query.slice(0, -1) : query;
  const lower = cleanQuery.toLowerCase();
  const results: MentionSuggestion[] = [];

  for (const f of folders) {
    if (results.length >= MAX_FOLDER_SUGGESTIONS) break;

    if (f.name.toLowerCase().includes(lower) || f.relativePath.toLowerCase().includes(lower)) {
      results.push({
        id: `folder:${f.absolutePath}`,
        name: f.name + '/',
        subtitle: f.relativePath,
        type: 'folder',
        filePath: f.absolutePath,
        relativePath: f.relativePath,
      });
    }
  }

  return results;
}

/**
 * Loads project files and returns filtered MentionSuggestion[] with type: 'file' and 'folder'.
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

  // Derive folders from file list (memoized)
  const allFolders = useMemo(
    () => (projectPath ? extractDirectories(allFiles, projectPath) : []),
    [allFiles, projectPath]
  );

  // Filter by query and convert to MentionSuggestion[] — folders first, then files
  const suggestions = useMemo(() => {
    if (!enabled) return [];
    const folders = filterFolderSuggestions(allFolders, query);
    const files = filterFileSuggestions(allFiles, query);
    return [...folders, ...files];
  }, [enabled, query, allFiles, allFolders]);

  return { suggestions, loading };
}
