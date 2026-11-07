import * as fs from 'fs';
import * as path from 'path';

import { getLegacyElectronUserDataCandidates } from './electronUserDataMigration';
import { setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

export const AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV = 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR';
export const AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV = 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT';

export interface ElectronDevPathOverrideApp {
  setPath?(name: string, value: string): void;
  getPath?(name: string): string;
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

function resolveExistingAncestor(dirPath: string): string {
  let current = path.resolve(dirPath);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const isWithin = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      !relative ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return isWithin(first, second) || isWithin(second, first);
}

export function resolveElectronDevClaudeRootOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]);
}

function requireValidClaudeRoot(env: NodeJS.ProcessEnv): string | null {
  const root = resolveElectronDevClaudeRootOverride(env);
  if (env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV] !== undefined && !root) {
    throw new Error(`${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`);
  }
  return root;
}

export function getAppliedElectronDevClaudeRootOverride(): string | null {
  return appliedElectronDevClaudeRootOverride;
}

/**
 * Worker threads skip Electron startup, so they need to mirror the explicit
 * dev-only Claude root before constructing path-dependent services.
 */
export function applyElectronDevClaudeRootOverrideForWorker(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const claudeRoot = requireValidClaudeRoot(env);
  if (claudeRoot) {
    const warnings: string[] = [];
    if (!ensureDirectory(claudeRoot, warnings, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV)) {
      throw new Error(warnings[warnings.length - 1]);
    }
    setClaudeBasePathOverride(claudeRoot);
  }
  return claudeRoot;
}

export function applyElectronDevPathOverrides(
  app: ElectronDevPathOverrideApp,
  env: NodeJS.ProcessEnv = process.env
): ElectronDevPathOverrideResult {
  const warnings: string[] = [];
  const claudeRoot = requireValidClaudeRoot(env);
  if (claudeRoot && !ensureDirectory(claudeRoot, warnings, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV)) {
    throw new Error(warnings[warnings.length - 1]);
  }
  const userDataDir = normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]);
  const rawUserDataDir = env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV];
  if (rawUserDataDir !== undefined && !userDataDir) {
    throw new Error(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
  }

  if (userDataDir) {
    if (typeof app.setPath !== 'function') {
      throw new Error('Electron path overrides require app.setPath');
    }

    // Resolve existing ancestors before creating anything: a junction in an
    // ancestor must not redirect an explicit dev profile into the regular one.
    const requestedRealPath = resolveExistingAncestor(userDataDir);
    if (app.getPath) {
      const getPath = app.getPath.bind(app);
      const userDataPath = getPath('userData');
      const regularPaths: [string, string][] = [
        ['userData', userDataPath],
        ...['sessionData', 'logs', 'crashDumps'].map((name): [string, string] => [
          name,
          getPath(name),
        ]),
        ...getLegacyElectronUserDataCandidates(userDataPath).map((candidate): [string, string] => [
          'legacy userData',
          candidate,
        ]),
      ];
      for (const [name, candidate] of regularPaths) {
        const regularPath = resolveExistingAncestor(candidate);
        if (pathsOverlap(requestedRealPath, regularPath)) {
          throw new Error(`Electron isolated userData overlaps regular ${name}`);
        }
      }
    }
    try {
      if (fs.lstatSync(userDataDir).isSymbolicLink()) {
        throw new Error('Electron isolated userData must not be a symlink or junction');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const isolatedPaths = [
      ['userData', userDataDir],
      // Chromium used userData for sessions before this override set sessionData.
      // Keep the existing profile readable while still isolating it from normal runs.
      ['sessionData', userDataDir],
      ['logs', path.join(userDataDir, 'logs')],
      ['crashDumps', path.join(userDataDir, 'crashes')],
    ] as const;

    // Prepare every path before changing any Electron path. A failed explicit
    // override must never continue with part of the regular user's profile.
    for (const [name, directory] of isolatedPaths) {
      if (
        !ensureDirectory(directory, warnings, `${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV}/${name}`)
      ) {
        throw new Error(warnings[warnings.length - 1]);
      }
    }
    const realUserDataDir = fs.realpathSync.native(userDataDir);
    for (const [name, directory] of isolatedPaths.slice(2)) {
      const relative = path.relative(realUserDataDir, fs.realpathSync.native(directory));
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Electron ${name} must be a real directory within the isolated userData`);
      }
    }
    for (const [name, directory] of isolatedPaths) {
      app.setPath(name, directory);
    }
    setAppDataBasePath(userDataDir);
  }

  const appliedClaudeRoot = claudeRoot;
  if (appliedClaudeRoot) {
    setClaudeBasePathOverride(appliedClaudeRoot);
  }
  appliedElectronDevClaudeRootOverride = appliedClaudeRoot;

  return {
    userDataDir,
    claudeRoot: appliedClaudeRoot,
    warnings,
  };
}
