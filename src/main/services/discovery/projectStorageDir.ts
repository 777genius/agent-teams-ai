import { getProjectDirNameCandidates } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type { FileSystemProvider } from '../infrastructure/FileSystemProvider';

export async function resolveProjectStorageDir(
  projectsDir: string,
  projectId: string,
  fsProvider: FileSystemProvider
): Promise<string | null> {
  for (const dirName of getProjectDirNameCandidates(projectId)) {
    const projectPath = path.join(projectsDir, dirName);
    if (await fsProvider.exists(projectPath)) {
      return projectPath;
    }
  }
  return null;
}

export function resolveProjectStorageDirSync(
  projectsDir: string,
  projectId: string
): string | null {
  for (const dirName of getProjectDirNameCandidates(projectId)) {
    const projectPath = path.join(projectsDir, dirName);
    if (fs.existsSync(projectPath)) {
      return projectPath;
    }
  }
  return null;
}
