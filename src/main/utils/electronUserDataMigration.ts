import * as fs from 'fs';
import * as path from 'path';

import { renamePathWithRetrySync } from './atomicWrite';

const LEGACY_USER_DATA_DIR_NAMES = [
  'agent-teams-ai',
  'Agent Teams AI',
  'Agent Teams UI',
  'Claude Agent Teams UI',
  'claude-agent-teams-ui',
  'claude-devtools',
  'claude-code-context',
] as const;

export interface ElectronUserDataMigrationApp {
  getPath(name: string): string;
  setPath?(name: string, value: string): void;
}

export interface ElectronUserDataMigrationResult {
  currentPath: string | null;
  legacyPath: string | null;
  migrated: boolean;
  fallbackToLegacy: boolean;
  reason:
    | 'migrated'
    | 'legacy-reused'
    | 'current-populated'
    | 'current-path-exists'
    | 'legacy-missing'
    | 'legacy-fallback'
    | 'error';
}

interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
}

interface ElectronUserDataMigrationOptions {
  logger?: LoggerLike;
  copyDirectory?: (sourcePath: string, targetPath: string) => void;
  strategy?: 'reuse-legacy' | 'copy';
}

const TRANSIENT_CHROMIUM_DIRECTORY_NAMES = new Set([
  'Cache',
  'Code Cache',
  'Crashpad',
  'Crash Reports',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Session Storage',
  'Shared Dictionary',
  'Service Worker',
  'VideoDecodeStats',
  'blob_storage',
]);

const TRANSIENT_CHROMIUM_FILE_NAMES = new Set([
  'DIPS',
  'DIPS-journal',
  'DIPS-wal',
  'LOCK',
  'Network Persistent State',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
]);

const DURABLE_USER_DATA_ROOT_NAMES = new Set(['data', 'backups']);
const PREFERRED_USER_DATA_DIR_NAME = 'agent-teams-ai';

const STALE_MIGRATION_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export function getLegacyElectronUserDataCandidates(currentPath: string): string[] {
  const parent = path.dirname(currentPath);
  const normalizedCurrent = path.resolve(currentPath);

  return LEGACY_USER_DATA_DIR_NAMES.map((dirName) => path.join(parent, dirName)).filter(
    (legacyPath) => path.resolve(legacyPath) !== normalizedCurrent
  );
}

export function migrateElectronUserDataDirectory(
  app: ElectronUserDataMigrationApp,
  options: ElectronUserDataMigrationOptions = {}
): ElectronUserDataMigrationResult {
  const logger = options.logger;
  let currentPath: string;

  try {
    currentPath = app.getPath('userData');
    scheduleStaleMigrationTempCleanup(currentPath, logger);
  } catch (error) {
    logger?.warn(`Electron userData migration skipped: ${stringifyError(error)}`);
    return {
      currentPath: null,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'error',
    };
  }

  const preferredExistingPath = selectPreferredElectronUserDataPath(currentPath);
  if (preferredExistingPath) {
    try {
      setLegacyElectronPaths(app, preferredExistingPath, logger);
      logger?.info(`Reusing preferred Electron userData at ${preferredExistingPath}`);
      return {
        currentPath,
        legacyPath: preferredExistingPath,
        migrated: false,
        fallbackToLegacy: false,
        reason: 'legacy-reused',
      };
    } catch (error) {
      logger?.warn(`Electron userData preferred reuse failed: ${stringifyError(error)}`);
      return {
        currentPath,
        legacyPath: preferredExistingPath,
        migrated: false,
        fallbackToLegacy: false,
        reason: 'error',
      };
    }
  }

  if (directoryExists(currentPath) && directoryHasDurableUserDataEntries(currentPath)) {
    return {
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-populated',
    };
  }

  if (pathExists(currentPath) && !directoryExists(currentPath)) {
    logger?.warn(`Electron userData migration skipped: current path is not a directory`);
    return {
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-path-exists',
    };
  }

  const legacyPath = selectLegacyElectronUserDataPath(currentPath);
  if (!legacyPath) {
    return {
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-missing',
    };
  }

  if ((options.strategy ?? 'reuse-legacy') === 'reuse-legacy') {
    try {
      setLegacyElectronPaths(app, legacyPath, logger);
      logger?.info(`Reusing legacy Electron userData at ${legacyPath}`);
      return {
        currentPath,
        legacyPath,
        migrated: false,
        fallbackToLegacy: false,
        reason: 'legacy-reused',
      };
    } catch (error) {
      logger?.warn(`Electron userData legacy reuse failed: ${stringifyError(error)}`);
      return {
        currentPath,
        legacyPath,
        migrated: false,
        fallbackToLegacy: false,
        reason: 'error',
      };
    }
  }

  const migrated = copyLegacyUserDataDirectory(
    legacyPath,
    currentPath,
    logger,
    options.copyDirectory
  );
  if (migrated) {
    logger?.info(`Migrated Electron userData from ${legacyPath} to ${currentPath}`);
    return {
      currentPath,
      legacyPath,
      migrated: true,
      fallbackToLegacy: false,
      reason: 'migrated',
    };
  }

  if (directoryExists(currentPath) && directoryHasDurableUserDataEntries(currentPath)) {
    return {
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-populated',
    };
  }

  try {
    setLegacyElectronPaths(app, legacyPath, logger);
    logger?.warn(`Electron userData migration failed, using legacy path for this run`);
    return {
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: true,
      reason: 'legacy-fallback',
    };
  } catch (error) {
    logger?.warn(`Electron userData legacy fallback failed: ${stringifyError(error)}`);
    return {
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'error',
    };
  }
}

function selectLegacyElectronUserDataPath(currentPath: string): string | null {
  return (
    getLegacyElectronUserDataCandidates(currentPath)
      .filter(directoryExists)
      .find((candidatePath) => directoryHasDurableUserDataEntries(candidatePath)) ?? null
  );
}

function selectPreferredElectronUserDataPath(currentPath: string): string | null {
  const preferredPath = path.join(path.dirname(currentPath), PREFERRED_USER_DATA_DIR_NAME);
  if (path.resolve(preferredPath) === path.resolve(currentPath)) {
    return null;
  }
  return directoryExists(preferredPath) && directoryHasDurableUserDataEntries(preferredPath)
    ? preferredPath
    : null;
}

function setLegacyElectronPaths(
  app: ElectronUserDataMigrationApp,
  legacyPath: string,
  logger?: LoggerLike
): void {
  app.setPath?.('userData', legacyPath);
  try {
    app.setPath?.('sessionData', legacyPath);
  } catch (error) {
    logger?.warn(`Electron sessionData legacy fallback failed: ${stringifyError(error)}`);
  }
}

function copyLegacyUserDataDirectory(
  legacyPath: string,
  currentPath: string,
  logger?: LoggerLike,
  copyDirectory: (sourcePath: string, targetPath: string) => void = copyDirectorySync
): boolean {
  const parent = path.dirname(currentPath);
  const tempPath = path.join(
    parent,
    `${path.basename(currentPath)}.migrating-${process.pid}-${Date.now()}`
  );

  try {
    fs.mkdirSync(parent, { recursive: true });

    if (pathExists(tempPath)) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }

    copyDirectory(legacyPath, tempPath);

    if (directoryExists(currentPath) && directoryIsEmpty(currentPath)) {
      fs.rmdirSync(currentPath);
    }

    renamePathWithRetrySync(tempPath, currentPath);
    return true;
  } catch (error) {
    logger?.warn(`Electron userData migration copy failed: ${stringifyError(error)}`);
    try {
      if (pathExists(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup only.
    }
    return false;
  }
}

function copyDirectorySync(sourcePath: string, targetPath: string): void {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter: (sourceEntryPath) => shouldCopyElectronUserDataEntry(sourcePath, sourceEntryPath),
  });
}

function scheduleStaleMigrationTempCleanup(currentPath: string, logger?: LoggerLike): void {
  const parent = path.dirname(currentPath);
  const prefix = `${path.basename(currentPath)}.migrating-`;

  const timeout = setTimeout(() => {
    fs.readdir(parent, { withFileTypes: true }, (readError, entries) => {
      if (readError) {
        return;
      }

      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
          continue;
        }

        const stalePath = path.join(parent, entry.name);
        fs.stat(stalePath, (statError, stats) => {
          if (statError || now - stats.mtimeMs < STALE_MIGRATION_TEMP_MAX_AGE_MS) {
            return;
          }

          fs.rm(stalePath, { recursive: true, force: true }, (removeError) => {
            if (removeError) {
              logger?.warn(
                `Failed to remove stale Electron userData migration temp path: ${stringifyError(
                  removeError
                )}`
              );
              return;
            }
            logger?.info(`Removed stale Electron userData migration temp path: ${stalePath}`);
          });
        });
      }
    });
  }, 30_000);

  timeout.unref?.();
}

export function shouldCopyElectronUserDataEntry(
  sourceRootPath: string,
  sourceEntryPath: string
): boolean {
  const relativePath = path.relative(sourceRootPath, sourceEntryPath);
  if (!relativePath || relativePath === '.') {
    return true;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.some((segment) => TRANSIENT_CHROMIUM_DIRECTORY_NAMES.has(segment))) {
    return false;
  }

  const basename = segments[segments.length - 1];
  if (TRANSIENT_CHROMIUM_FILE_NAMES.has(basename)) {
    return false;
  }

  return true;
}

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function directoryIsEmpty(targetPath: string): boolean {
  try {
    return fs.readdirSync(targetPath).length === 0;
  } catch {
    return false;
  }
}

function directoryHasDurableUserDataEntries(targetPath: string): boolean {
  try {
    return directoryHasDurableUserDataEntriesWithin(targetPath, targetPath);
  } catch {
    return false;
  }
}

function directoryHasDurableUserDataEntriesWithin(rootPath: string, targetPath: string): boolean {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath);
    const rootSegment = relativePath.split(path.sep).find(Boolean);
    if (!rootSegment || !DURABLE_USER_DATA_ROOT_NAMES.has(rootSegment)) {
      continue;
    }

    if (!shouldCopyElectronUserDataEntry(rootPath, entryPath)) {
      continue;
    }

    if (!entry.isDirectory()) {
      return true;
    }

    if (directoryHasDurableUserDataEntriesWithin(rootPath, entryPath)) {
      return true;
    }
  }

  return false;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
