import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getLegacyElectronUserDataCandidates } from './electronUserDataMigration';
import { setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

export const AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV = 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR';
export const AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV = 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT';

export interface ElectronDevPathOverrideApp {
  setPath?(name: string, value: string): void;
  getPath?(name: string): string;
  getName?(): string;
  commandLine?: { hasSwitch(name: string): boolean };
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
    // The write probe itself must never follow a symlink into another profile.
    try {
      if (fs.lstatSync(dirPath).isSymbolicLink()) {
        throw new Error(`${envName} must be a real directory, not a symlink or junction`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(dirPath, { recursive: true });
    // Existing folders can be read-only; verify real file creation before startup.
    const probe = path.join(dirPath, `.agent-teams-write-probe-${randomUUID()}`);
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
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
  // Missing path suffixes cannot be realpathed. On case-insensitive macOS
  // volumes they can still alias a profile that normal startup later reuses.
  const left = process.platform === 'darwin' ? first.toLowerCase() : first;
  const right = process.platform === 'darwin' ? second.toLowerCase() : second;
  return isWithin(left, right) || isWithin(right, left);
}

function regularAppDataPath(getPath: (name: string) => string): string {
  try {
    return getPath('appData');
  } catch (error) {
    // Electron can report appData unavailable before ready on packaged Windows,
    // even though the OS-defined APPDATA environment variable is already set.
    const appData = process.env.APPDATA?.trim();
    if (process.platform !== 'win32' || !appData || !path.isAbsolute(appData)) throw error;
    return path.resolve(appData);
  }
}

function regularElectronProfilePaths(app: ElectronDevPathOverrideApp): [string, string][] {
  if (!app.getPath) return [];
  const getPath = app.getPath.bind(app);
  // Chromium applies --user-data-dir before any JavaScript, so getPath('userData')
  // can already be the isolated test root. Do not mistake it for the regular profile.
  const cliSelected =
    app.commandLine?.hasSwitch('user-data-dir') === true ||
    process.argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
  let earlyUserDataUnavailable = false;
  const userDataPath = (() => {
    if (cliSelected && app.getName) return path.join(regularAppDataPath(getPath), app.getName());
    try {
      return getPath('userData');
    } catch (error) {
      // Electron may reject userData before ready on Windows. Resolve the
      // ordinary profile from appData/name, never from the requested test root.
      if (process.platform !== 'win32' || !app.getName) throw error;
      earlyUserDataUnavailable = true;
      return path.join(regularAppDataPath(getPath), app.getName());
    }
  })();
  const otherPaths: [string, string][] = cliSelected || earlyUserDataUnavailable
    ? [
        ['sessionData', userDataPath],
        ['logs', path.join(userDataPath, 'logs')],
        ['crashDumps', path.join(userDataPath, 'crashes')],
      ]
    : ['sessionData', 'logs', 'crashDumps'].map(
        (name): [string, string] => [name, getPath(name)]
      );
  return [
    ['userData', userDataPath],
    ...otherPaths,
    ...getLegacyElectronUserDataCandidates(userDataPath).map(
      (candidate): [string, string] => ['legacy userData', candidate]
    ),
  ];
}

function assertSeparateFromRegularProfile(
  requested: string,
  kind: string,
  regularPaths: readonly (readonly [string, string])[]
): void {
  const realRequested = resolveExistingAncestor(requested);
  for (const [name, candidate] of regularPaths) {
    if (pathsOverlap(realRequested, resolveExistingAncestor(candidate))) {
      throw new Error(`Electron isolated ${kind} overlaps regular ${name}`);
    }
  }
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
  const userDataDir = normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]);
  if (env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV] !== undefined && !userDataDir) {
    throw new Error(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
  }

  const regularPaths = claudeRoot || userDataDir ? regularElectronProfilePaths(app) : [];
  if (claudeRoot) {
    // Validate before creating: an explicit test root must not touch a normal
    // Electron profile or a legacy profile eligible for migration.
    assertSeparateFromRegularProfile(claudeRoot, 'Claude root', regularPaths);
    if (!ensureDirectory(claudeRoot, warnings, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV)) {
      throw new Error(warnings[warnings.length - 1]);
    }
  }

  if (userDataDir) {
    if (typeof app.setPath !== 'function') {
      throw new Error('Electron path overrides require app.setPath');
    }

    // Resolve existing ancestors before creating anything: a junction in an
    // ancestor must not redirect an explicit dev profile into the regular one.
    assertSeparateFromRegularProfile(userDataDir, 'userData', regularPaths);
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
