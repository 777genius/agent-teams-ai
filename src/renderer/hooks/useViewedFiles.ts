import { useCallback, useMemo, useState } from 'react';

import * as storage from '@renderer/utils/diffViewedStorage';

interface UseViewedFilesResult {
  viewedSet: Set<string>;
  isViewed: (filePath: string) => boolean;
  markViewed: (filePath: string) => void;
  unmarkViewed: (filePath: string) => void;
  markAllViewed: (filePaths: string[]) => void;
  clearAll: () => void;
  viewedCount: number;
  totalCount: number;
  /** Progress 0-100 */
  progress: number;
}

export function useViewedFiles(
  teamName: string,
  scopeKey: string,
  totalFiles: string[]
): UseViewedFilesResult {
  // version bump pattern for re-reading localStorage
  const [version, setVersion] = useState(0);

  const viewedSet = useMemo(() => {
    // version is used to trigger re-read
    if (version < 0) return new Set<string>();
    return storage.getViewedFiles(teamName, scopeKey);
  }, [teamName, scopeKey, version]);

  const markViewed = useCallback(
    (filePath: string) => {
      storage.markFileViewed(teamName, scopeKey, filePath);
      setVersion((v) => v + 1);
    },
    [teamName, scopeKey]
  );

  const unmarkViewed = useCallback(
    (filePath: string) => {
      storage.unmarkFileViewed(teamName, scopeKey, filePath);
      setVersion((v) => v + 1);
    },
    [teamName, scopeKey]
  );

  const markAllViewedFn = useCallback(
    (filePaths: string[]) => {
      storage.markAllViewed(teamName, scopeKey, filePaths);
      setVersion((v) => v + 1);
    },
    [teamName, scopeKey]
  );

  const clearAll = useCallback(() => {
    storage.clearViewed(teamName, scopeKey);
    setVersion((v) => v + 1);
  }, [teamName, scopeKey]);

  const viewedCount = totalFiles.filter((f) => viewedSet.has(f)).length;

  return {
    viewedSet,
    isViewed: (fp: string) => viewedSet.has(fp),
    markViewed,
    unmarkViewed,
    markAllViewed: markAllViewedFn,
    clearAll,
    viewedCount,
    totalCount: totalFiles.length,
    progress: totalFiles.length > 0 ? Math.round((viewedCount / totalFiles.length) * 100) : 0,
  };
}
