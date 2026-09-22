import path from 'path';

export function normalizeIdentityPath(projectPath: string): string {
  let normalized = path.normalize(projectPath);
  while (normalized.length > 1 && (normalized.endsWith('/') || normalized.endsWith('\\'))) {
    normalized = normalized.slice(0, -1);
  }

  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
