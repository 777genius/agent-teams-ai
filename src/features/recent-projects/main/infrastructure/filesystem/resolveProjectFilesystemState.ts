import type { RecentProjectFilesystemState } from '../../../core/domain/models/RecentProjectFilesystemState';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

export async function resolveProjectFilesystemState(
  projectPath: string,
  fsProvider?: Pick<FileSystemProvider, 'exists'>
): Promise<RecentProjectFilesystemState> {
  if (!projectPath.trim()) {
    return 'deleted';
  }

  if (!fsProvider) {
    return 'available';
  }

  try {
    return (await fsProvider.exists(projectPath)) ? 'available' : 'deleted';
  } catch {
    return 'deleted';
  }
}
