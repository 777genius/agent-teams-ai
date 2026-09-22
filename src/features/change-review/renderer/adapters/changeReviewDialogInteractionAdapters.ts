import type {
  ChangeReviewCollapsedFilesStoragePort,
  ChangeReviewExternalFileWatcherPort,
} from '../ports/changeReviewDialogInteractionPorts';
import type { ReviewAPI } from '@shared/types/api';

type ExternalFileReviewApi = Pick<
  ReviewAPI,
  'checkConflict' | 'onExternalFileChange' | 'unwatchFiles' | 'watchFiles'
>;

export function createChangeReviewExternalFileWatcherPort(
  getReviewApi: () => ExternalFileReviewApi
): ChangeReviewExternalFileWatcherPort {
  return {
    checkConflict: (scope, filePath, expectedModified) =>
      getReviewApi().checkConflict(scope, filePath, expectedModified),
    subscribe: (callback) => getReviewApi().onExternalFileChange(callback),
    watchFiles: (projectPath, filePaths) => getReviewApi().watchFiles(projectPath, filePaths),
    unwatchFiles: () => getReviewApi().unwatchFiles(),
  };
}

export const browserChangeReviewCollapsedFilesStorage: ChangeReviewCollapsedFilesStoragePort = {
  read: (storageKey) => {
    if (typeof window === 'undefined') return new Set<string>();
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(parsed)
        ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
        : new Set<string>();
    } catch {
      return new Set<string>();
    }
  },
  write: (storageKey, filePaths) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...filePaths]));
    } catch {
      // Collapsed state is best-effort presentation state.
    }
  },
};
