import { getAppliedElectronDevClaudeRootOverride } from '@main/utils/electronDevPathOverrides';
import { getClaudeBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_FILENAME = 'agent-teams-config.json';
const LEGACY_CONFIG_FILENAMES = [
  'claude-devtools-config.json',
  'claude-code-context-config.json',
] as const;

export function getDefaultConfigPath(): string {
  const basePath = getClaudeBasePath();
  return migrateLegacyConfigPath(
    path.join(basePath, CONFIG_FILENAME),
    LEGACY_CONFIG_FILENAMES.map((filename) => path.join(basePath, filename))
  );
}

export function applyConfiguredClaudeRootPath(claudeRootPath: string | null): void {
  setClaudeBasePathOverride(getAppliedElectronDevClaudeRootOverride() ?? claudeRootPath);
}

function migrateLegacyConfigPath(currentPath: string, legacyPaths: string[]): string {
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
