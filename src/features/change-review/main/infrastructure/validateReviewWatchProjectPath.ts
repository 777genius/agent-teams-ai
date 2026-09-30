import * as fs from 'fs/promises';
import * as path from 'path';

export async function validateReviewWatchProjectPath(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Invalid project path');
  }

  if (!path.isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute');
  }

  const normalized = path.resolve(path.normalize(projectPath));
  const stat = await fs.stat(normalized);
  if (!stat.isDirectory()) {
    throw new Error('Project path is not a directory');
  }
  return normalized;
}
