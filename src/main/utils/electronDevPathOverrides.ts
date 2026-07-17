import * as fs from 'fs';
import * as path from 'path';

import { setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

export const AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV = 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR';
export const AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV = 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT';

export interface ElectronDevPathOverrideApp {
  setPath?(name: string, value: string): void;
}

export interface ElectronDevPathOverrideResult {
  userDataDir: string | null;
  claudeRoot: string | null;
  warnings: string[];
}

let appliedElectronDevClaudeRootOverride: string | null = null;

function normalizeAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    return null;
  }
  return path.resolve(normalized);
}

function ensureDirectory(dirPath: string, warnings: string[], envName: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${envName} could not be created: ${message}`);
    return false;
  }
}

export function resolveElectronDevClaudeRootOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]);
}

export function getAppliedElectronDevClaudeRootOverride(): string | null {
  return appliedElectronDevClaudeRootOverride;
}

export function applyElectronDevPathOverrides(
  app: ElectronDevPathOverrideApp,
  env: NodeJS.ProcessEnv = process.env
): ElectronDevPathOverrideResult {
  const warnings: string[] = [];
  const userDataDir = normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]);
  const rawUserDataDir = env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]?.trim();
  if (rawUserDataDir && !userDataDir) {
    warnings.push(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
  }

  const appliedUserDataDir =
    userDataDir && ensureDirectory(userDataDir, warnings, AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV)
      ? userDataDir
      : null;
  if (appliedUserDataDir) {
    app.setPath?.('userData', appliedUserDataDir);
    setAppDataBasePath(appliedUserDataDir);
  }

  const claudeRoot = resolveElectronDevClaudeRootOverride(env);
  const rawClaudeRoot = env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]?.trim();
  if (rawClaudeRoot && !claudeRoot) {
    warnings.push(`${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`);
  }

  const appliedClaudeRoot =
    claudeRoot && ensureDirectory(claudeRoot, warnings, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV)
      ? claudeRoot
      : null;
  if (appliedClaudeRoot) {
    setClaudeBasePathOverride(appliedClaudeRoot);
  }
  appliedElectronDevClaudeRootOverride = appliedClaudeRoot;

  return {
    userDataDir: appliedUserDataDir,
    claudeRoot: appliedClaudeRoot,
    warnings,
  };
}
