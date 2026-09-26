import { isDefinitiveMissingPathError } from '@main/utils/directoryPresence';

import type { RecentProjectFilesystemState } from '../../../core/domain/models/RecentProjectFilesystemState';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

export async function resolveProjectFilesystemState(
  projectPath: string,
  fsProvider?: Pick<FileSystemProvider, 'exists' | 'stat'>
): Promise<RecentProjectFilesystemState> {
  if (!projectPath.trim()) {
    return 'deleted';
  }

  if (!fsProvider) {
    return 'available';
  }

  try {
    if (typeof fsProvider.stat === 'function') {
      await fsProvider.stat(projectPath);
      return 'available';
    }
    return (await fsProvider.exists(projectPath)) ? 'available' : 'deleted';
  } catch (error) {
    return isDefinitiveMissingPathError(error) ? 'deleted' : 'available';
  }
}
