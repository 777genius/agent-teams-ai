import { resolvePathAvailability } from '@main/utils/directoryPresence';

import type { RecentProjectFilesystemState } from '../../../core/domain/models/RecentProjectFilesystemState';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

export async function resolveProjectFilesystemState(
  projectPath: string,
  fsProvider?: Pick<FileSystemProvider, 'exists' | 'stat'>
): Promise<RecentProjectFilesystemState> {
  if (!fsProvider) {
    return projectPath.trim() ? 'available' : 'deleted';
  }

  return resolvePathAvailability(projectPath, async () => {
    if (typeof fsProvider.stat === 'function') {
      await fsProvider.stat(projectPath);
      return;
    }
    if (!(await fsProvider.exists(projectPath))) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
  });
}
