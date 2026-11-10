/**
 * Pre-warms the Quick Open file list cache when a project path is available.
 * Use in dialogs (CreateTeam, EditTeam) so that @file mentions work immediately
 * when the user expands the workflow field, without waiting for the first fetch.
 */

import { useEffect } from 'react';

import { api } from '@renderer/api';
import { getQuickOpenCache, setQuickOpenCache } from '@renderer/utils/quickOpenCache';

/**
 * Triggers a file list fetch when projectPath is set and cache is empty.
 * Safe to call from any component; no-op in browser mode (project API unavailable).
 */
export function useFileListCacheWarmer(projectPath: string | null): void {
  useEffect(() => {
    if (!projectPath?.trim()) return;

    const cached = getQuickOpenCache(projectPath);
    if (cached) return;

    let cancelled = false;
    api.project
      .listFiles(projectPath)
      .then((files) => {
        if (cancelled) return;
        setQuickOpenCache(projectPath, files);
      })
      .catch(() => {
        // Project path may be invalid or API unavailable (browser mode)
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);
}
