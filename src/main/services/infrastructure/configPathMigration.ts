import * as fs from 'fs';
import * as path from 'path';

export function migrateLegacyConfigPath(currentPath: string, legacyPaths: string[]): string {
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }

  const legacyPath = selectLegacyConfigPath(legacyPaths);
  if (!legacyPath) {
    return currentPath;
  }

  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.copyFileSync(legacyPath, currentPath, fs.constants.COPYFILE_EXCL);
    return currentPath;
  } catch {
    return fs.existsSync(currentPath) ? currentPath : legacyPath;
  }
}

function selectLegacyConfigPath(legacyPaths: string[]): string | null {
  const existingPaths = legacyPaths.filter((candidatePath) => fs.existsSync(candidatePath));
  return existingPaths.find(isReadableJsonObjectFile) ?? existingPaths[0] ?? null;
}

function isReadableJsonObjectFile(filePath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
