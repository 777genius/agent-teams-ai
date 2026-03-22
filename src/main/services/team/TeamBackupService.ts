import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  getAppDataPath,
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('TeamBackupService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackupManifest {
  teamName: string;
  identityId: string;
  projectPath?: string;
  displayName?: string;
  status: 'active' | 'deleted_by_user';
  deletedByUserAt?: string;
  firstBackupAt: string;
  lastBackupAt: string;
  fileStats: Record<string, { mtime: number; size: number }>;
}

interface BackupRegistry {
  version: 1;
  teams: Record<string, BackupRegistryEntry>;
}

interface BackupRegistryEntry {
  teamName: string;
  identityId: string;
  status: 'active' | 'deleted_by_user';
  deletedByUserAt?: string;
  lastBackupAt: string;
}

interface BackupFileDescriptor {
  sourcePath: string;
  relPath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERIODIC_INTERVAL_MS = 3 * 60 * 1000;
const TASK_DEBOUNCE_MS = 500;
const DELETED_RETENTION_DAYS = 30;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const TEAM_ROOT_FILES = [
  'config.json',
  'kanban-state.json',
  'sentMessages.json',
  'sent-cross-team.json',
  'members.meta.json',
  'comment-notification-journal.json',
];

// Subdirs under ~/.claude/teams/{teamName}/
const TEAM_SUBDIRS = ['inboxes', 'review-decisions'];
// Subdirs under getAppDataPath() (our own storage, not in ~/.claude/)
const APP_DATA_SUBDIRS = ['attachments'];
const APP_DATA_DEEP_SUBDIRS = ['task-attachments'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function nowIso(): string {
  return new Date().toISOString();
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

// ---------------------------------------------------------------------------
// TeamBackupService
// ---------------------------------------------------------------------------

export class TeamBackupService {
  private registry: BackupRegistry = { version: 1, teams: {} };
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private taskDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teamMutex = new Map<string, Promise<void>>();
  private initialized = false;
  private isShuttingDown = false;
  private backupGeneration = 0;

  // ── Public API ───────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.registry = await this.loadRegistry();
    await this.reconcileResurrectedTeams();
    await this.restoreIfNeeded();
    void this.pruneStaleBackups().catch((err: unknown) =>
      logger.warn(`[Backup] prune failed: ${String(err)}`)
    );
    this.initialized = true;
    this.periodicTimer = setInterval(() => {
      void this.runPeriodicBackup().catch((err: unknown) =>
        logger.warn(`[Backup] periodic failed: ${String(err)}`)
      );
    }, PERIODIC_INTERVAL_MS);
    this.periodicTimer.unref();
    logger.info('[Backup] TeamBackupService initialized');
  }

  async backupTeam(teamName: string): Promise<void> {
    if (this.isShuttingDown || !this.initialized) return;
    await this.withTeamMutex(teamName, () => this.doBackupTeam(teamName));
  }

  scheduleTaskBackup(teamName: string, taskFile: string): void {
    if (this.isShuttingDown || !this.initialized) return;
    const key = `${teamName}/${taskFile}`;
    const existing = this.taskDebounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.taskDebounceTimers.delete(key);
      void this.backupTeam(teamName).catch(() => undefined);
    }, TASK_DEBOUNCE_MS);
    this.taskDebounceTimers.set(key, timer);
  }

  runShutdownBackupSync(): void {
    this.isShuttingDown = true;
    this.backupGeneration++;
    this.dispose();

    // Re-activate any resurrected teams before the backup loop.
    // At shutdown, source files are still on disk (SIGKILL ran before stdin EOF).
    this.reconcileResurrectedTeamsSync();

    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'active') continue;
      try {
        this.doBackupTeamSync(teamName);
      } catch (err: unknown) {
        logger.warn(`[Backup] shutdown backup failed for ${teamName}: ${String(err)}`);
      }
    }
    this.saveRegistrySync();
  }

  async markDeletedByUser(teamName: string): Promise<void> {
    const entry = this.registry.teams[teamName];
    if (entry) {
      entry.status = 'deleted_by_user';
      entry.deletedByUserAt = nowIso();
    }
    try {
      const manifest = await this.loadManifest(teamName);
      if (manifest) {
        manifest.status = 'deleted_by_user';
        manifest.deletedByUserAt = nowIso();
        await this.saveManifest(teamName, manifest);
      }
    } catch (err: unknown) {
      logger.warn(`[Backup] Failed to update manifest for ${teamName}: ${String(err)}`);
    }
    await this.saveRegistry();
  }

  async restoreIfNeeded(): Promise<string[]> {
    const restored: string[] = [];
    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'active') continue;
      try {
        const didRestore = await this.restoreTeam(teamName);
        if (didRestore) restored.push(teamName);
      } catch (err: unknown) {
        logger.warn(`[Backup] restore failed for ${teamName}: ${String(err)}`);
      }
    }
    return restored;
  }

  async pruneStaleBackups(): Promise<void> {
    const cutoff = Date.now() - DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'deleted_by_user' || !entry.deletedByUserAt) continue;
      const deletedAt = new Date(entry.deletedByUserAt).getTime();
      if (deletedAt > cutoff) continue;
      const backupDir = this.getBackupDir(teamName);
      await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      delete this.registry.teams[teamName];
      changed = true;
      logger.info(`[Backup] Pruned stale backup for ${teamName}`);
    }
    if (changed) await this.saveRegistry();
  }

  dispose(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    for (const timer of this.taskDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.taskDebounceTimers.clear();
  }

  // ── Internal: backup ─────────────────────────────────────────────────

  private withTeamMutex(teamName: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.teamMutex.get(teamName) ?? Promise.resolve();
    const next = prev.then(fn, () => fn());
    this.teamMutex.set(teamName, next);
    next.then(
      () => {
        if (this.teamMutex.get(teamName) === next) this.teamMutex.delete(teamName);
      },
      () => {
        if (this.teamMutex.get(teamName) === next) this.teamMutex.delete(teamName);
      }
    );
    return next;
  }

  private async runPeriodicBackup(): Promise<void> {
    if (this.isShuttingDown || !this.initialized) return;
    const teamNames = await this.discoverActiveTeams();
    for (const teamName of teamNames) {
      if (this.isShuttingDown) return;
      await this.withTeamMutex(teamName, () => this.doBackupTeam(teamName));
    }
  }

  private async doBackupTeam(teamName: string): Promise<void> {
    const gen = this.backupGeneration;
    if (!(await this.isConfigReady(teamName))) return;

    const { files: sourceFiles, hasErrors } = await this.enumerateTeamFilesWithErrors(teamName);
    if (sourceFiles.length === 0) return;

    const backupDir = this.getBackupDir(teamName);
    let manifest = await this.loadManifest(teamName);
    // Reset stale manifest from a previously deleted team with the same name.
    // The backup dir may already contain the new team's files (copied by FileWatcher),
    // but the manifest was never updated because the deletion guard blocked it.
    if (manifest?.status === 'deleted_by_user') {
      manifest = null;
    }
    const isNew = !manifest;

    if (!manifest) {
      const identityId = crypto.randomUUID();
      manifest = {
        teamName,
        identityId,
        status: 'active',
        firstBackupAt: nowIso(),
        lastBackupAt: nowIso(),
        fileStats: {},
      };
      await this.ensureIdentityMarker(teamName, identityId);
    } else {
      // Ensure identity marker is present — may have been lost during full restore
      // (reconcile creates new identity in manifest, but restored config.json
      // from backup doesn't have the marker yet)
      await this.ensureIdentityMarker(teamName, manifest.identityId);
    }

    // Prune stale backup files (only if source enumeration was error-free)
    if (!hasErrors) {
      await this.pruneStaleBackupFiles(teamName, sourceFiles, backupDir, manifest);
    }

    let anyChanged = false;
    for (const descriptor of sourceFiles) {
      if (this.backupGeneration !== gen) return;
      const changed = await this.backupSingleFile(descriptor, backupDir, manifest);
      if (changed) anyChanged = true;
    }

    if (anyChanged || isNew) {
      // Guard: if team was deleted while we were backing up, don't overwrite.
      // For resurrected teams (isNew after manifest reset), allow only if
      // the source config still exists — if it was rm -rf'd mid-backup,
      // the user genuinely deleted the team and we must not re-activate it.
      const currentEntry = this.registry.teams[teamName];
      if (currentEntry?.status === 'deleted_by_user') {
        if (!isNew || !(await this.isConfigReady(teamName))) return;
      }

      manifest.lastBackupAt = nowIso();
      // Update informational fields from config
      try {
        const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
        const raw = await fs.promises.readFile(configPath, 'utf8').catch(() => '');
        if (raw && isValidConfig(raw)) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          manifest.displayName = typeof parsed.name === 'string' ? parsed.name : undefined;
          manifest.projectPath =
            typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined;
        }
      } catch {
        // best-effort
      }

      if (this.backupGeneration !== gen) return;
      await this.saveManifest(teamName, manifest);

      // Update thin registry
      this.registry.teams[teamName] = {
        teamName,
        identityId: manifest.identityId,
        status: manifest.status,
        deletedByUserAt: manifest.deletedByUserAt,
        lastBackupAt: manifest.lastBackupAt,
      };
      if (this.backupGeneration !== gen) return;
      await this.saveRegistry();
    }
  }

  private doBackupTeamSync(teamName: string): void {
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const configPath = path.join(teamDir, 'config.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      if (!isValidConfig(raw)) return;
    } catch {
      return;
    }

    const sourceFiles = this.enumerateTeamFilesSync(teamName);
    if (sourceFiles.length === 0) return;

    const backupDir = this.getBackupDir(teamName);
    let manifest: BackupManifest;
    try {
      const raw = fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      const identityId = crypto.randomUUID();
      manifest = {
        teamName,
        identityId,
        status: 'active',
        firstBackupAt: nowIso(),
        lastBackupAt: nowIso(),
        fileStats: {},
      };
      // Write identity marker to source config (sync, best-effort)
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        config._backupIdentityId = identityId;
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      } catch {
        // best-effort
      }
    }

    // Reset stale manifest from a previously deleted team with the same name.
    // Without this, manifest.status ('deleted_by_user') would be written back
    // to the registry (line below), blocking future backups and restores.
    if (manifest.status === 'deleted_by_user') {
      const identityId = crypto.randomUUID();
      manifest = {
        teamName,
        identityId,
        status: 'active',
        firstBackupAt: nowIso(),
        lastBackupAt: nowIso(),
        fileStats: {},
      };
      // Write identity marker (sync, best-effort)
      try {
        const configRaw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configRaw) as Record<string, unknown>;
        config._backupIdentityId = identityId;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      } catch {
        // best-effort
      }
    }

    for (const descriptor of sourceFiles) {
      this.backupSingleFileSync(descriptor, backupDir, manifest);
    }

    manifest.lastBackupAt = nowIso();
    this.saveManifestSync(teamName, manifest);

    this.registry.teams[teamName] = {
      teamName,
      identityId: manifest.identityId,
      status: manifest.status,
      deletedByUserAt: manifest.deletedByUserAt,
      lastBackupAt: manifest.lastBackupAt,
    };
  }

  private async backupSingleFile(
    descriptor: BackupFileDescriptor,
    backupDir: string,
    manifest: BackupManifest
  ): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(descriptor.sourcePath);
      if (!stat.isFile()) return false;
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        logger.info(`[Backup] Skipping oversized file (${stat.size} bytes): ${descriptor.relPath}`);
        return false;
      }

      const cached = manifest.fileStats[descriptor.relPath];
      if (cached?.mtime === stat.mtimeMs && cached.size === stat.size) {
        return false; // not dirty
      }

      const destPath = path.join(backupDir, descriptor.relPath);

      if (descriptor.sourcePath.endsWith('.json')) {
        const content = await fs.promises.readFile(descriptor.sourcePath, 'utf8');
        if (!isValidJson(content)) {
          logger.warn(`[Backup] Skipping invalid JSON: ${descriptor.sourcePath}`);
          return false;
        }
        await atomicWriteAsync(destPath, content);
      } else {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(descriptor.sourcePath, destPath);
      }

      manifest.fileStats[descriptor.relPath] = { mtime: stat.mtimeMs, size: stat.size };
      return true;
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        logger.warn(`[Backup] Failed to backup ${descriptor.relPath}: ${String(err)}`);
      }
      return false;
    }
  }

  private backupSingleFileSync(
    descriptor: BackupFileDescriptor,
    backupDir: string,
    manifest: BackupManifest
  ): void {
    try {
      const stat = fs.statSync(descriptor.sourcePath);
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_SIZE_BYTES) return; // skip oversized silently during shutdown

      const cached = manifest.fileStats[descriptor.relPath];
      if (cached?.mtime === stat.mtimeMs && cached.size === stat.size) return;

      const destPath = path.join(backupDir, descriptor.relPath);

      if (descriptor.sourcePath.endsWith('.json')) {
        const content = fs.readFileSync(descriptor.sourcePath, 'utf8');
        if (!isValidJson(content)) return;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content, 'utf8');
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(descriptor.sourcePath, destPath);
      }

      manifest.fileStats[descriptor.relPath] = { mtime: stat.mtimeMs, size: stat.size };
    } catch {
      // best-effort during shutdown
    }
  }

  private async pruneStaleBackupFiles(
    teamName: string,
    sourceFiles: BackupFileDescriptor[],
    backupDir: string,
    manifest: BackupManifest
  ): Promise<void> {
    const backupFiles = await this.enumerateBackupFiles(teamName);
    const sourceRelPaths = new Set(sourceFiles.map((f) => f.relPath));

    for (const backupRelPath of backupFiles) {
      if (backupRelPath === 'manifest.json') continue;
      if (!sourceRelPaths.has(backupRelPath)) {
        await fs.promises.unlink(path.join(backupDir, backupRelPath)).catch(() => undefined);
        delete manifest.fileStats[backupRelPath];
      }
    }
  }

  private async ensureIdentityMarker(teamName: string, identityId: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (config._backupIdentityId === identityId) return;
      config._backupIdentityId = identityId;
      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    } catch {
      // best-effort — config may not exist yet
    }
  }

  // ── Internal: restore ────────────────────────────────────────────────

  private async restoreTeam(teamName: string): Promise<boolean> {
    const manifest = await this.loadManifest(teamName);
    if (!manifest) return false;

    const backupConfigPath = path.join(this.getBackupDir(teamName), 'config.json');
    try {
      const raw = await fs.promises.readFile(backupConfigPath, 'utf8');
      if (!isValidConfig(raw)) {
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
      const restoredCount = await this.restoreGenericPartial(teamName, manifest);
      if (restoredCount > 0) {
        logger.info(`[Backup] Partial restored ${teamName}: ${restoredCount} files`);
        return true;
      }
      return false;
    }

    // Config missing or corrupted — full restore
    logger.info(`[Backup] Full restoring team ${teamName} (config ${sourceConfigResult.status})`);
    const backupDir = this.getBackupDir(teamName);
    const backupFiles = await this.enumerateBackupFiles(teamName);
    let count = 0;

    // Restore config.json first
    const configBackup = path.join(backupDir, 'config.json');
    const configDest = sourceConfigPath;
    try {
      await fs.promises.mkdir(path.dirname(configDest), { recursive: true });
      const content = await fs.promises.readFile(configBackup, 'utf8');
      await atomicWriteAsync(configDest, content);
      count++;
    } catch (err: unknown) {
      logger.warn(`[Backup] Failed to restore config.json for ${teamName}: ${String(err)}`);
      return false;
    }

    // Restore remaining files
    for (const relPath of backupFiles) {
      if (relPath === 'config.json' || relPath === 'manifest.json') continue;
      try {
        const src = path.join(backupDir, relPath);
        const dest = this.getSourcePathForRelPath(teamName, relPath);
        // Don't overwrite newer files
        try {
          const destStat = await fs.promises.stat(dest);
          const srcStat = await fs.promises.stat(src);
          if (destStat.mtimeMs > srcStat.mtimeMs) {
            logger.info(`[Backup] Skip restore ${teamName}/${relPath}: source file is newer`);
            continue;
          }
        } catch {
          // dest doesn't exist — ok to restore
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const content = await fs.promises.readFile(src);
        await fs.promises.writeFile(dest, content);
        count++;
      } catch {
        // skip individual file errors
      }
    }

    logger.info(`[Backup] Restored team ${teamName} (${count} files)`);
    return count > 0;
  }

  private async restoreGenericPartial(teamName: string, manifest: BackupManifest): Promise<number> {
    const backupDir = this.getBackupDir(teamName);
    const backupFiles = await this.enumerateBackupFiles(teamName);
    let count = 0;

    for (const relPath of backupFiles) {
      if (relPath === 'manifest.json') continue;
      const dest = this.getSourcePathForRelPath(teamName, relPath);

      try {
        // Check if source file is missing or corrupted
        let needsRestore = false;
        let skipReason = '';
        try {
          if (dest.endsWith('.json')) {
            const raw = await fs.promises.readFile(dest, 'utf8');
            if (!isValidJson(raw)) {
              needsRestore = true; // corrupted JSON
            } else {
              skipReason = 'valid existing file';
            }
          } else {
            // Binary file — just check existence
            await fs.promises.stat(dest);
            skipReason = 'existing binary file';
          }
        } catch {
          needsRestore = true; // missing
        }

        if (!needsRestore) {
          logger.info(`[Backup] Skip restore ${teamName}/${relPath}: ${skipReason}`);
          continue;
        }

        const src = path.join(backupDir, relPath);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const content = await fs.promises.readFile(src);
        await fs.promises.writeFile(dest, content);
        count++;
        logger.info(`[Backup] Partial restored ${teamName}/${relPath}`);
      } catch {
        // skip individual file errors
      }
    }

    void manifest; // fileStats not checked during restore — mtime comparison happens in full restore
    return count;
  }

  private checkIdentityFromConfig(
    config: Record<string, unknown>,
    manifest: BackupManifest
  ): 'match' | 'mismatch' | 'no_marker' {
    const sourceId = config._backupIdentityId;
    if (typeof sourceId !== 'string') return 'no_marker';
    return sourceId === manifest.identityId ? 'match' : 'mismatch';
  }

  private async readSourceConfig(
    configPath: string
  ): Promise<
    | { status: 'valid'; parsed: Record<string, unknown> }
    | { status: 'missing' }
    | { status: 'corrupted' }
  > {
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      if (!isValidConfig(raw)) return { status: 'corrupted' };
      return { status: 'valid', parsed: JSON.parse(raw) as Record<string, unknown> };
    } catch (err: unknown) {
      if (isEnoent(err)) return { status: 'missing' };
      return { status: 'corrupted' };
    }
  }

  // ── Internal: enumeration ────────────────────────────────────────────

  private async enumerateTeamFilesWithErrors(
    teamName: string
  ): Promise<{ files: BackupFileDescriptor[]; hasErrors: boolean }> {
    const files: BackupFileDescriptor[] = [];
    let hasErrors = false;
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const tasksDir = path.join(getTasksBasePath(), teamName);

    // Root files
    for (const fileName of TEAM_ROOT_FILES) {
      const sourcePath = path.join(teamDir, fileName);
      try {
        const stat = await fs.promises.stat(sourcePath);
        if (stat.isFile()) files.push({ sourcePath, relPath: fileName });
      } catch (err: unknown) {
        if (!isEnoent(err)) hasErrors = true;
      }
    }

    // Flat subdirs under team dir (inboxes/, review-decisions/)
    for (const subdir of TEAM_SUBDIRS) {
      const dirPath = path.join(teamDir, subdir);
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            files.push({
              sourcePath: path.join(dirPath, entry.name),
              relPath: `${subdir}/${entry.name}`,
            });
          }
        }
      } catch (err: unknown) {
        if (!isEnoent(err)) hasErrors = true;
      }
    }

    // Flat subdirs under app data dir (attachments/)
    const appDataDir = getAppDataPath();
    for (const subdir of APP_DATA_SUBDIRS) {
      const dirPath = path.join(appDataDir, subdir, teamName);
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            files.push({
              sourcePath: path.join(dirPath, entry.name),
              relPath: `${subdir}/${entry.name}`,
            });
          }
        }
      } catch (err: unknown) {
        if (!isEnoent(err)) hasErrors = true;
      }
    }

    // Deep subdirs under app data dir (task-attachments/)
    for (const subdir of APP_DATA_DEEP_SUBDIRS) {
      const dirPath = path.join(appDataDir, subdir, teamName);
      try {
        const taskDirs = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const taskDir of taskDirs) {
          if (!taskDir.isDirectory()) continue;
          const taskDirPath = path.join(dirPath, taskDir.name);
          try {
            const attachments = await fs.promises.readdir(taskDirPath, { withFileTypes: true });
            for (const att of attachments) {
              if (att.isFile()) {
                files.push({
                  sourcePath: path.join(taskDirPath, att.name),
                  relPath: `${subdir}/${taskDir.name}/${att.name}`,
                });
              }
            }
          } catch (err: unknown) {
            if (!isEnoent(err)) hasErrors = true;
          }
        }
      } catch (err: unknown) {
        if (!isEnoent(err)) hasErrors = true;
      }
    }

    // Tasks (from separate dir)
    try {
      const entries = await fs.promises.readdir(tasksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push({
            sourcePath: path.join(tasksDir, entry.name),
            relPath: `tasks/${entry.name}`,
          });
        }
        // Skip _internal/ directory
      }
    } catch (err: unknown) {
      if (!isEnoent(err)) hasErrors = true;
    }

    return { files, hasErrors };
  }

  private enumerateTeamFilesSync(teamName: string): BackupFileDescriptor[] {
    const files: BackupFileDescriptor[] = [];
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const tasksDir = path.join(getTasksBasePath(), teamName);

    for (const fileName of TEAM_ROOT_FILES) {
      const sourcePath = path.join(teamDir, fileName);
      try {
        const stat = fs.statSync(sourcePath);
        if (stat.isFile()) files.push({ sourcePath, relPath: fileName });
      } catch {
        // skip
      }
    }

    for (const subdir of TEAM_SUBDIRS) {
      try {
        const entries = fs.readdirSync(path.join(teamDir, subdir), { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            files.push({
              sourcePath: path.join(teamDir, subdir, entry.name),
              relPath: `${subdir}/${entry.name}`,
            });
          }
        }
      } catch {
        // skip
      }
    }

    // Flat subdirs under app data dir (attachments/)
    const appDataDir = getAppDataPath();
    for (const subdir of APP_DATA_SUBDIRS) {
      try {
        const entries = fs.readdirSync(path.join(appDataDir, subdir, teamName), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (entry.isFile()) {
            files.push({
              sourcePath: path.join(appDataDir, subdir, teamName, entry.name),
              relPath: `${subdir}/${entry.name}`,
            });
          }
        }
      } catch {
        // skip
      }
    }

    // Deep subdirs under app data dir (task-attachments/)
    for (const subdir of APP_DATA_DEEP_SUBDIRS) {
      try {
        const taskDirs = fs.readdirSync(path.join(appDataDir, subdir, teamName), {
          withFileTypes: true,
        });
        for (const taskDir of taskDirs) {
          if (!taskDir.isDirectory()) continue;
          try {
            const attachments = fs.readdirSync(
              path.join(appDataDir, subdir, teamName, taskDir.name),
              { withFileTypes: true }
            );
            for (const att of attachments) {
              if (att.isFile()) {
                files.push({
                  sourcePath: path.join(appDataDir, subdir, teamName, taskDir.name, att.name),
                  relPath: `${subdir}/${taskDir.name}/${att.name}`,
                });
              }
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
    }

    try {
      const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push({
            sourcePath: path.join(tasksDir, entry.name),
            relPath: `tasks/${entry.name}`,
          });
        }
      }
    } catch {
      // skip
    }

    return files;
  }

  private async enumerateBackupFiles(teamName: string): Promise<string[]> {
    const backupDir = this.getBackupDir(teamName);
    const results: string[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isFile()) {
            results.push(relPath);
          } else if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), relPath);
          }
        }
      } catch {
        // skip
      }
    };

    await walk(backupDir, '');
    return results;
  }

  // ── Internal: registry + manifest ────────────────────────────────────

  private getRegistryPath(): string {
    return path.join(getBackupsBasePath(), 'registry.json');
  }

  private getBackupDir(teamName: string): string {
    return path.join(getBackupsBasePath(), 'teams', teamName);
  }

  private getSourcePathForRelPath(teamName: string, relPath: string): string {
    if (relPath.startsWith('tasks/')) {
      return path.join(getTasksBasePath(), teamName, relPath.slice('tasks/'.length));
    }
    if (relPath.startsWith('attachments/')) {
      return path.join(
        getAppDataPath(),
        'attachments',
        teamName,
        relPath.slice('attachments/'.length)
      );
    }
    if (relPath.startsWith('task-attachments/')) {
      return path.join(
        getAppDataPath(),
        'task-attachments',
        teamName,
        relPath.slice('task-attachments/'.length)
      );
    }
    return path.join(getTeamsBasePath(), teamName, relPath);
  }

  private async loadRegistry(): Promise<BackupRegistry> {
    try {
      const raw = await fs.promises.readFile(this.getRegistryPath(), 'utf8');
      const parsed = JSON.parse(raw) as BackupRegistry;
      if (parsed.version === 1 && typeof parsed.teams === 'object') {
        return parsed;
      }
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        logger.warn(`[Backup] Registry corrupted, rebuilding from disk`);
        return this.rebuildRegistryFromDisk();
      }
    }
    return { version: 1, teams: {} };
  }

  private async saveRegistry(): Promise<void> {
    if (this.isShuttingDown) return;
    await atomicWriteAsync(this.getRegistryPath(), JSON.stringify(this.registry, null, 2));
  }

  private saveRegistrySync(): void {
    try {
      const dir = path.dirname(this.getRegistryPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.getRegistryPath(), JSON.stringify(this.registry, null, 2), 'utf8');
    } catch (err: unknown) {
      logger.warn(`[Backup] Failed to save registry sync: ${String(err)}`);
    }
  }

  private async rebuildRegistryFromDisk(): Promise<BackupRegistry> {
    const registry: BackupRegistry = { version: 1, teams: {} };
    const teamsDir = path.join(getBackupsBasePath(), 'teams');
    try {
      const entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifest = await this.loadManifest(entry.name);
        if (manifest) {
          registry.teams[entry.name] = {
            teamName: manifest.teamName,
            identityId: manifest.identityId,
            status: manifest.status,
            deletedByUserAt: manifest.deletedByUserAt,
            lastBackupAt: manifest.lastBackupAt,
          };
        }
      }
    } catch {
      // empty registry if backup dir doesn't exist
    }
    return registry;
  }

  private async loadManifest(teamName: string): Promise<BackupManifest | null> {
    try {
      const raw = await fs.promises.readFile(
        path.join(this.getBackupDir(teamName), 'manifest.json'),
        'utf8'
      );
      return JSON.parse(raw) as BackupManifest;
    } catch {
      return null;
    }
  }

  private async saveManifest(teamName: string, manifest: BackupManifest): Promise<void> {
    if (this.isShuttingDown) return;
    await atomicWriteAsync(
      path.join(this.getBackupDir(teamName), 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
  }

  private saveManifestSync(teamName: string, manifest: BackupManifest): void {
    try {
      const manifestPath = path.join(this.getBackupDir(teamName), 'manifest.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {
      // best-effort
    }
  }

  // ── Internal: validation ─────────────────────────────────────────────

  private async isConfigReady(teamName: string): Promise<boolean> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      return isValidConfig(raw);
    } catch {
      return false;
    }
  }

  private reconcileResurrectedTeamsSync(): void {
    const teamsDir = getTeamsBasePath();
    try {
      const entries = fs.readdirSync(teamsDir, { withFileTypes: true });
      for (const dirEntry of entries) {
        if (!dirEntry.isDirectory()) continue;
        const entry = this.registry.teams[dirEntry.name];
        if (entry?.status !== 'deleted_by_user') continue;
        const configPath = path.join(teamsDir, dirEntry.name, 'config.json');
        try {
          const raw = fs.readFileSync(configPath, 'utf8');
          if (isValidConfig(raw)) {
            logger.info(`[Backup] Shutdown reconcile: ${dirEntry.name} resurrected`);
            entry.status = 'active';
            delete entry.deletedByUserAt;
          }
        } catch {
          // no config — truly deleted
        }
      }
    } catch {
      // no teams dir
    }
    // Registry will be saved by saveRegistrySync() at end of runShutdownBackupSync()
  }

  private async reconcileResurrectedTeams(): Promise<void> {
    let changed = false;
    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'deleted_by_user') continue;

      // Level 1: source config exists on disk — team is alive right now
      if (await this.isConfigReady(teamName)) {
        logger.info(`[Backup] Reconcile: team ${teamName} alive on disk`);
        entry.status = 'active';
        delete entry.deletedByUserAt;
        changed = true;
        continue;
      }

      // Level 2: source config gone, but backup data is NEWER than deletion.
      // Catches: new team created → FileWatcher copied files to backup →
      // force-kill → CLI cleaned up source → backup has the new team's data.
      if (!entry.deletedByUserAt) continue;
      const deletedAtMs = new Date(entry.deletedByUserAt).getTime();
      const backupConfigPath = path.join(this.getBackupDir(teamName), 'config.json');
      try {
        const stat = await fs.promises.stat(backupConfigPath);
        if (stat.mtimeMs > deletedAtMs + 60_000) {
          logger.info(
            `[Backup] Reconcile: team ${teamName} has post-deletion backup data, re-activating`
          );
          entry.status = 'active';
          delete entry.deletedByUserAt;
          // Reset stale manifest so restoreTeam() does full restore with new identity
          const manifest = await this.loadManifest(teamName);
          if (manifest?.status === 'deleted_by_user') {
            manifest.identityId = crypto.randomUUID();
            manifest.status = 'active';
            delete manifest.deletedByUserAt;
            manifest.fileStats = {};
            await this.saveManifest(teamName, manifest);
          }
          changed = true;
        }
      } catch {
        // no backup config — truly deleted, leave as is
      }
    }
    if (changed) await this.saveRegistry();
  }

  private async discoverActiveTeams(): Promise<string[]> {
    const teamsDir = getTeamsBasePath();
    try {
      const entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
      const teams: string[] = [];
      let registryChanged = false;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const registryEntry = this.registry.teams[entry.name];
        if (registryEntry?.status === 'deleted_by_user') {
          // A valid config on disk means a new team was created with the same name.
          // permanentlyDeleteTeam() removes files BEFORE markDeletedByUser(), so
          // if config exists after marking deleted, it must be a new team.
          if (await this.isConfigReady(entry.name)) {
            logger.info(`[Backup] Team ${entry.name} resurrected (valid config on disk)`);
            registryEntry.status = 'active';
            delete registryEntry.deletedByUserAt;
            registryChanged = true;
          } else {
            continue;
          }
        }
        teams.push(entry.name);
      }
      if (registryChanged) await this.saveRegistry();
      return teams;
    } catch {
      return [];
    }
  }
}
