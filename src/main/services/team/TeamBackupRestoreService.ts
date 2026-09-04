import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicCreateAsync,
  atomicReplaceFileIfUnchangedAsync,
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { type BackupManifest } from './teamBackupManifest';
import { TeamConfigReader } from './TeamConfigReader';
import { TEAM_LAUNCH_STOPPED_MARKER_FILE } from './TeamLaunchStateStore';

const logger = createLogger('TeamBackupService');
const LAUNCH_STATE_PUBLICATION_FILES = new Set(['launch-state.json', 'launch-summary.json']);
const DRAFT_DELETION_IDENTITY_FILE = '.permanent-deletion-identity.json';

type SourceConfigObservation =
  | {
      status: 'valid';
      raw: string;
      parsed: Record<string, unknown>;
      identity: DurablePathIdentity;
    }
  | { status: 'missing' }
  | {
      status: 'corrupted';
      raw: string | null;
      identity: DurablePathIdentity | null;
    };

export interface TeamBackupRestorePorts {
  loadManifest(teamName: string): Promise<BackupManifest | null>;
  getBackupDir(teamName: string): string;
  getSourcePathForRelPath(teamName: string, relPath: string): string;
  enumerateBackupFiles(teamName: string): Promise<string[]>;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function isValidConfig(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.name === 'string' && parsed.name.trim() !== '';
  } catch {
    return false;
  }
}

export class TeamBackupRestoreService {
  constructor(private readonly ports: TeamBackupRestorePorts) {}

  private getDraftDeletionIdentityPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, DRAFT_DELETION_IDENTITY_FILE);
  }

  async restoreTeam(teamName: string): Promise<boolean> {
    const manifest = await this.ports.loadManifest(teamName);
    if (!manifest) return false;

    const backupConfigPath = path.join(this.ports.getBackupDir(teamName), 'config.json');
    let backupConfigContent: string;
    try {
      backupConfigContent = await fs.promises.readFile(backupConfigPath, 'utf8');
      if (!isValidConfig(backupConfigContent)) {
        logger.warn(`[Backup] Backup config.json invalid for ${teamName}, skipping restore`);
        return false;
      }
    } catch {
      logger.warn(`[Backup] No backup config.json for ${teamName}, skipping restore`);
      return false;
    }

    // Check source config
    const sourceConfigPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const sourceConfigResult = await this.readSourceConfig(sourceConfigPath);

    if (sourceConfigResult.status === 'valid') {
      // Config exists and is valid — do partial restore
      const identity = this.checkIdentityFromConfig(sourceConfigResult.parsed, manifest);
      if (identity === 'mismatch') {
        logger.info(`[Backup] Skip restore ${teamName}: different team with same name`);
        return false;
      }
      if (identity === 'no_marker') {
        logger.info(`[Backup] Skip restore ${teamName}: no _backupIdentityId in source config`);
        return false;
      }
      const restoredCount = await this.restoreGenericPartial(
        teamName,
        manifest,
        sourceConfigResult
      );
      if (restoredCount > 0) {
        logger.info(`[Backup] Partial restored ${teamName}: ${restoredCount} files`);
        return true;
      }
      return false;
    }

    // Config missing or corrupted — full restore
    logger.info(`[Backup] Full restoring team ${teamName} (config ${sourceConfigResult.status})`);
    const backupDir = this.ports.getBackupDir(teamName);
    const backupFiles = await this.ports.enumerateBackupFiles(teamName);
    let count = 0;

    // Restore config.json first
    const configDest = sourceConfigPath;
    let committedIdentity: DurablePathIdentity;
    try {
      const identityMarkerPath = this.getDraftDeletionIdentityPath(teamName);
      const observedIdentityMarker = await this.readOptionalTextFile(identityMarkerPath);
      if (observedIdentityMarker !== null) {
        logger.info(`[Backup] Skip full restore ${teamName}: replacement identity marker exists`);
        return false;
      }
      await fs.promises.mkdir(path.dirname(configDest), { recursive: true });
      const restoredIdentity = await this.commitRestoredConfig(
        configDest,
        identityMarkerPath,
        backupConfigContent,
        sourceConfigResult,
        observedIdentityMarker
      );
      if (!restoredIdentity) {
        logger.info(
          `[Backup] Skip full restore ${teamName}: source identity changed before commit`
        );
        return false;
      }
      committedIdentity = restoredIdentity;
      TeamConfigReader.invalidateTeam(teamName);
      count++;
    } catch (err: unknown) {
      logger.warn(`[Backup] Failed to restore config.json for ${teamName}: ${String(err)}`);
      return false;
    }

    // Restore remaining files
    const launchStateFrozen = await this.isLaunchStateFrozenByStop(teamName, backupFiles);
    for (const relPath of backupFiles) {
      if (relPath === 'config.json' || relPath === 'manifest.json') continue;
      if (launchStateFrozen && LAUNCH_STATE_PUBLICATION_FILES.has(relPath)) {
        logger.info(`[Backup] Skip restore ${teamName}/${relPath}: team is stopped`);
        continue;
      }
      try {
        const src = path.join(backupDir, relPath);
        const dest = this.ports.getSourcePathForRelPath(teamName, relPath);
        const content = await fs.promises.readFile(src);
        if (
          !(await this.isExactFileCurrent(
            configDest,
            committedIdentity,
            Buffer.from(backupConfigContent)
          ))
        ) {
          logger.info(`[Backup] Stop full restore ${teamName}: replacement config published`);
          break;
        }
        // Don't overwrite newer files
        let observedDestination:
          | { status: 'missing' }
          | {
              status: 'present';
              identity: DurablePathIdentity;
              content: Buffer;
              mtimeMs: number;
            };
        try {
          const srcStat = await fs.promises.stat(src);
          observedDestination = await this.readOptionalFileObservation(dest);
          if (
            observedDestination.status === 'present' &&
            observedDestination.mtimeMs > srcStat.mtimeMs
          ) {
            logger.info(`[Backup] Skip restore ${teamName}/${relPath}: source file is newer`);
            continue;
          }
        } catch {
          continue;
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        if (
          await this.commitRestoredFile(
            dest,
            content,
            observedDestination,
            configDest,
            committedIdentity,
            Buffer.from(backupConfigContent)
          )
        ) {
          count++;
        }
      } catch {
        // skip individual file errors
      }
    }

    logger.info(`[Backup] Restored team ${teamName} (${count} files)`);
    return count > 0;
  }

  private async restoreGenericPartial(
    teamName: string,
    manifest: BackupManifest,
    sourceConfig: Extract<SourceConfigObservation, { status: 'valid' }>
  ): Promise<number> {
    const backupDir = this.ports.getBackupDir(teamName);
    const backupFiles = await this.ports.enumerateBackupFiles(teamName);
    const launchStateFrozen = await this.isLaunchStateFrozenByStop(teamName, backupFiles);
    let count = 0;

    for (const relPath of backupFiles) {
      if (relPath === 'manifest.json') continue;
      if (launchStateFrozen && LAUNCH_STATE_PUBLICATION_FILES.has(relPath)) {
        logger.info(`[Backup] Skip restore ${teamName}/${relPath}: team is stopped`);
        continue;
      }
      const dest = this.ports.getSourcePathForRelPath(teamName, relPath);

      try {
        if (dest === path.join(getTeamsBasePath(), teamName, 'config.json')) continue;
        // Check if source file is missing or corrupted
        let needsRestore = false;
        let skipReason = '';
        let destinationObservation:
          | { status: 'missing' }
          | {
              status: 'present';
              identity: DurablePathIdentity;
              content: Buffer;
              mtimeMs: number;
            };
        try {
          destinationObservation = await this.readOptionalFileObservation(dest);
          if (dest.endsWith('.json')) {
            if (
              destinationObservation.status === 'missing' ||
              !isValidJson(destinationObservation.content.toString('utf8'))
            ) {
              needsRestore = true; // corrupted JSON
            } else {
              skipReason = 'valid existing file';
            }
          } else {
            // Binary file — just check existence
            needsRestore = destinationObservation.status === 'missing';
            if (!needsRestore) skipReason = 'existing binary file';
          }
        } catch {
          continue;
        }

        if (!needsRestore) {
          logger.info(`[Backup] Skip restore ${teamName}/${relPath}: ${skipReason}`);
          continue;
        }

        const src = path.join(backupDir, relPath);
        const content = await fs.promises.readFile(src);
        if (
          await this.commitRestoredFile(
            dest,
            content,
            destinationObservation,
            path.join(getTeamsBasePath(), teamName, 'config.json'),
            sourceConfig.identity,
            Buffer.from(sourceConfig.raw)
          )
        ) {
          count++;
          logger.info(`[Backup] Partial restored ${teamName}/${relPath}`);
        }
      } catch {
        // skip individual file errors
      }
    }

    void manifest; // fileStats not checked during restore — mtime comparison happens in full restore
    return count;
  }

  /**
   * A stopped team - the stop marker is in the live team directory, or it was
   * already backed up - must not get its last launch-state / launch-summary
   * back. The backup can still hold the snapshot from before the stop, and
   * restoring it brings the phantom "launch failed partway / teammate never
   * spawned" card back after the next app start.
   */
  private async isLaunchStateFrozenByStop(
    teamName: string,
    backupFiles: readonly string[]
  ): Promise<boolean> {
    if (backupFiles.includes(TEAM_LAUNCH_STOPPED_MARKER_FILE)) return true;
    const liveMarker = this.ports.getSourcePathForRelPath(
      teamName,
      TEAM_LAUNCH_STOPPED_MARKER_FILE
    );
    try {
      await fs.promises.access(liveMarker);
      return true;
    } catch {
      return false;
    }
  }

  private checkIdentityFromConfig(
    config: Record<string, unknown>,
    manifest: BackupManifest
  ): 'match' | 'mismatch' | 'no_marker' {
    const sourceId = config._backupIdentityId;
    if (typeof sourceId !== 'string') return 'no_marker';
    return sourceId === manifest.identityId ? 'match' : 'mismatch';
  }

  private async readSourceConfig(configPath: string): Promise<SourceConfigObservation> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(configPath, 'r');
      const [stats, raw] = await Promise.all([handle.stat(), handle.readFile('utf8')]);
      if (!isValidConfig(raw)) {
        return {
          status: 'corrupted',
          raw,
          identity: getDurablePathIdentity(stats),
        };
      }
      return {
        status: 'valid',
        raw,
        parsed: JSON.parse(raw) as Record<string, unknown>,
        identity: getDurablePathIdentity(stats),
      };
    } catch (err: unknown) {
      if (isEnoent(err)) return { status: 'missing' };
      return { status: 'corrupted', raw: null, identity: null };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readOptionalFileObservation(filePath: string): Promise<
    | { status: 'missing' }
    | {
        status: 'present';
        identity: DurablePathIdentity;
        content: Buffer;
        mtimeMs: number;
      }
  > {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const [stats, content] = await Promise.all([handle.stat(), handle.readFile()]);
      if (!stats.isFile()) throw new Error(`Restore target is not a regular file: ${filePath}`);
      return {
        status: 'present',
        identity: getDurablePathIdentity(stats),
        content,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      if (isEnoent(error)) return { status: 'missing' };
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async isExactFileCurrent(
    filePath: string,
    identity: DurablePathIdentity,
    content: Buffer
  ): Promise<boolean> {
    try {
      const observed = await this.readOptionalFileObservation(filePath);
      return (
        observed.status === 'present' &&
        isSameDurablePathIdentity(observed.identity, identity) &&
        observed.content.equals(content)
      );
    } catch {
      return false;
    }
  }

  private async commitRestoredFile(
    destinationPath: string,
    content: Buffer,
    destinationObservation:
      | { status: 'missing' }
      | {
          status: 'present';
          identity: DurablePathIdentity;
          content: Buffer;
          mtimeMs: number;
        },
    configPath: string,
    configIdentity: DurablePathIdentity,
    configContent: Buffer
  ): Promise<boolean> {
    if (!(await this.isExactFileCurrent(configPath, configIdentity, configContent))) return false;
    if (destinationObservation.status === 'missing') {
      let created: { dev: number; ino: number };
      try {
        created = await atomicCreateAsync(destinationPath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      if (await this.isExactFileCurrent(configPath, configIdentity, configContent)) return true;
      await this.removeExactRestoredConfig(destinationPath, content, created);
      return false;
    }

    const committed = await atomicReplaceFileIfUnchangedAsync(destinationPath, content, {
      identity: destinationObservation.identity,
      content: destinationObservation.content,
    });
    if (!committed) return false;
    if (await this.isExactFileCurrent(configPath, configIdentity, configContent)) return true;
    await this.removeExactRestoredConfig(destinationPath, content, committed);
    return false;
  }

  private async readOptionalTextFile(filePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private async isRestoreObservationCurrent(
    configPath: string,
    identityMarkerPath: string,
    sourceObservation: Exclude<SourceConfigObservation, { status: 'valid' }>,
    observedIdentityMarker: string | null
  ): Promise<boolean> {
    const [currentConfig, currentIdentityMarker] = await Promise.all([
      this.readSourceConfig(configPath),
      this.readOptionalTextFile(identityMarkerPath),
    ]);
    if (currentIdentityMarker !== observedIdentityMarker) return false;
    if (sourceObservation.status === 'missing') return currentConfig.status === 'missing';
    return (
      sourceObservation.raw !== null &&
      currentConfig.status === 'corrupted' &&
      currentConfig.raw === sourceObservation.raw
    );
  }

  private async removeExactRestoredConfig(
    configPath: string,
    content: string | Buffer,
    identity: { dev: number; ino: number }
  ): Promise<void> {
    await removePathWithIdentityFenceAsync(configPath, {
      force: true,
      durability: 'strict',
      validateDetached: async (detachedPath) => {
        try {
          const [stats, currentContent] = await Promise.all([
            fs.promises.lstat(detachedPath),
            fs.promises.readFile(detachedPath),
          ]);
          return (
            stats.dev === identity.dev &&
            (stats.ino === 0 || identity.ino === 0 || stats.ino === identity.ino) &&
            currentContent.equals(typeof content === 'string' ? Buffer.from(content) : content)
          );
        } catch {
          return false;
        }
      },
    });
  }

  private async commitRestoredConfig(
    configPath: string,
    identityMarkerPath: string,
    content: string,
    sourceObservation: Exclude<SourceConfigObservation, { status: 'valid' }>,
    observedIdentityMarker: string | null
  ): Promise<DurablePathIdentity | null> {
    const observationIsCurrent = (): Promise<boolean> =>
      this.isRestoreObservationCurrent(
        configPath,
        identityMarkerPath,
        sourceObservation,
        observedIdentityMarker
      );

    if (!(await observationIsCurrent())) return null;

    if (sourceObservation.status === 'missing') {
      let created: { dev: number; ino: number };
      try {
        created = await atomicCreateAsync(configPath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw error;
      }
      const [currentMarker, restoredStats, restoredContent] = await Promise.all([
        this.readOptionalTextFile(identityMarkerPath),
        fs.promises.lstat(configPath),
        fs.promises.readFile(configPath, 'utf8'),
      ]);
      if (
        currentMarker === observedIdentityMarker &&
        restoredStats.dev === created.dev &&
        (restoredStats.ino === 0 || created.ino === 0 || restoredStats.ino === created.ino) &&
        restoredContent === content
      ) {
        return getDurablePathIdentity(restoredStats);
      }
      await this.removeExactRestoredConfig(configPath, content, created);
      return null;
    }

    if (sourceObservation.raw === null || sourceObservation.identity === null) return null;
    const committed = await atomicReplaceFileIfUnchangedAsync(configPath, content, {
      identity: sourceObservation.identity,
      content: sourceObservation.raw,
    });
    if (!committed) return null;
    if ((await this.readOptionalTextFile(identityMarkerPath)) !== observedIdentityMarker) {
      await this.removeExactRestoredConfig(configPath, content, committed);
      return null;
    }
    const [stats, currentContent] = await Promise.all([
      fs.promises.lstat(configPath),
      fs.promises.readFile(configPath, 'utf8'),
    ]);
    if (
      stats.dev !== committed.dev ||
      (stats.ino !== 0 && committed.ino !== 0 && stats.ino !== committed.ino) ||
      currentContent !== content
    ) {
      return null;
    }
    return getDurablePathIdentity(stats);
  }

  // ── Internal: enumeration ────────────────────────────────────────────
}
