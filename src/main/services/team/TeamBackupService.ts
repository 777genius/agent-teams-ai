import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicWriteAsync,
  atomicWriteSync,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import {
  getAppDataPath,
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { TeamPermanentDeletionCoordinator } from './permanent-deletion/TeamPermanentDeletionCoordinator';
import {
  BackupPublicationFencedError,
  type TeamPermanentDeletionIntent,
} from './permanent-deletion/TeamPermanentDeletionTypes';
import {
  type BackupFileDescriptor,
  collectRecursiveFiles,
  collectRecursiveFilesSync,
} from './TeamBackupFileCollection';
import {
  isValidConfig,
  isValidJson,
  shouldCollectTaskAttachmentBackupFile,
  shouldCollectTaskAttachmentBackupPath,
} from './TeamBackupFilePolicy';
import { TeamBackupRestoreService } from './TeamBackupRestoreService';

import type { PermanentDeletionLock } from './permanent-deletion/TeamPermanentDeletionLock';

export type {
  PermanentDeletionTarget,
  TeamPermanentDeletionIntent,
} from './permanent-deletion/TeamPermanentDeletionTypes';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERIODIC_INTERVAL_MS = 3 * 60 * 1000;
const TASK_DEBOUNCE_MS = 500;
const DELETED_RETENTION_DAYS = 30;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const TEAM_ROOT_FILES = [
  'config.json',
  'team.meta.json',
  'launch-state.json',
  'launch-summary.json',
  'kanban-state.json',
  'sentMessages.json',
  'sent-cross-team.json',
  'members.meta.json',
  'comment-notification-journal.json',
];

// Subdirs under ~/.claude/teams/{teamName}/
const TEAM_SUBDIRS = ['inboxes', 'review-decisions'];
const TEAM_RECURSIVE_SUBDIRS = ['.opencode-runtime', 'members'];
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

// ---------------------------------------------------------------------------
// TeamBackupService
// ---------------------------------------------------------------------------

export class TeamBackupService {
  private registry: BackupRegistry = { version: 1, teams: {} };
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private taskDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teamMutex = new Map<string, Promise<unknown>>();
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;
  private isShuttingDown = false;
  private backupGeneration = 0;
  private readonly permanentDeletion = new TeamPermanentDeletionCoordinator({
    awaitInitialization: () => this.awaitInitialization(),
    isInitialized: () => this.initialized,
    isShuttingDown: () => this.isShuttingDown,
    withTeamMutex: (teamName, operation) => this.withTeamMutex(teamName, operation),
    registry: () => this.registry.teams,
    loadManifest: (teamName) => this.loadManifest(teamName),
    saveManifest: (teamName, manifest, strict) => this.saveManifest(teamName, manifest, strict),
    saveRegistryEntry: (teamName, entry, strict) => this.saveRegistryEntry(teamName, entry, strict),
  });
  private readonly restoreService = new TeamBackupRestoreService({
    loadManifest: (teamName) => this.loadManifest(teamName),
    getBackupDir: (teamName) => this.getBackupDir(teamName),
    getSourcePathForRelPath: (teamName, relPath) => this.getSourcePathForRelPath(teamName, relPath),
    enumerateBackupFiles: (teamName) => this.enumerateBackupFiles(teamName),
  });

  // ── Public API ───────────────────────────────────────────────────────

  initialize(): Promise<void> {
    this.initializationPromise ??= this.initializeOnce();
    return this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    this.registry = await this.loadRegistry();
    await this.permanentDeletion.initialize();
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
    await this.awaitInitialization();
    if (this.isShuttingDown) return;
    await this.withTeamIdentityFence(teamName, () =>
      this.withTeamMutex(teamName, () => this.doBackupTeam(teamName))
    );
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
      if (this.permanentDeletion.isPermanentDeletionFencedSync(teamName, entry.identityId))
        continue;
      try {
        this.doBackupTeamSync(teamName);
      } catch (err: unknown) {
        logger.warn(`[Backup] shutdown backup failed for ${teamName}: ${String(err)}`);
      }
    }
    this.saveRegistrySync();
  }

  beginPermanentDeletion(
    teamName: string,
    options: { draft?: boolean } = {}
  ): Promise<TeamPermanentDeletionIntent> {
    return this.permanentDeletion.beginPermanentDeletion(teamName, options);
  }

  commitPermanentDeletionBoundary(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    return this.permanentDeletion.commitPermanentDeletionBoundary(intent);
  }

  abortPreparedPermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    return this.permanentDeletion.abortPreparedPermanentDeletion(intent);
  }

  listPendingPermanentDeletions(): Promise<TeamPermanentDeletionIntent[]> {
    return this.permanentDeletion.listPendingPermanentDeletions();
  }

  isPermanentDeletionTargetCurrent(intent: TeamPermanentDeletionIntent): Promise<boolean> {
    return this.permanentDeletion.isPermanentDeletionTargetCurrent(intent);
  }

  reconcilePermanentDeletionProgress(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    return this.permanentDeletion.reconcilePermanentDeletionProgress(intent);
  }

  completePermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    return this.permanentDeletion.completePermanentDeletion(intent);
  }

  withTeamIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.permanentDeletion.withTeamIdentityFence(teamName, operation);
  }

  withPermanentDeletionTargetFence(
    intent: TeamPermanentDeletionIntent,
    operation: Parameters<TeamPermanentDeletionCoordinator['withPermanentDeletionTargetFence']>[1]
  ): Promise<boolean> {
    return this.permanentDeletion.withPermanentDeletionTargetFence(intent, operation);
  }

  private acquirePermanentDeletionLock(scope: string): Promise<PermanentDeletionLock> {
    return this.permanentDeletion.lock.acquirePermanentDeletionLock(scope);
  }

  private releasePermanentDeletionLock(lock: PermanentDeletionLock): Promise<void> {
    return this.permanentDeletion.lock.releasePermanentDeletionLock(lock);
  }

  private removeStalePermanentDeletionLock(lockPath: string): Promise<boolean> {
    return this.permanentDeletion.lock.removeStalePermanentDeletionLock(lockPath);
  }

  async restoreIfNeeded(): Promise<string[]> {
    const restored: string[] = [];
    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'active') continue;
      const restoreIdentity = (await this.loadManifest(teamName))?.identityId ?? entry.identityId;
      if (this.permanentDeletion.isReplacementForPendingDeletion(teamName, restoreIdentity)) {
        logger.info(`[Backup] Skip restore of superseded deletion identity for ${teamName}`);
        continue;
      }
      if (await this.permanentDeletion.isPermanentDeletionFenced(teamName, restoreIdentity)) {
        logger.info(`[Backup] Restore fenced by permanent deletion intent for ${teamName}`);
        continue;
      }
      try {
        const didRestore = await this.withTeamIdentityFence(teamName, () =>
          this.restoreTeam(teamName)
        );
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
      const didPrune = await this.withTeamIdentityFence(teamName, async () => {
        const currentEntry = this.registry.teams[teamName];
        if (
          currentEntry?.status !== 'deleted_by_user' ||
          currentEntry.identityId !== entry.identityId ||
          currentEntry.deletedByUserAt !== entry.deletedByUserAt
        ) {
          return false;
        }
        const currentManifest = await this.loadManifest(teamName);
        if (currentManifest && currentManifest.identityId !== entry.identityId) return false;

        const backupDir = this.getBackupDir(teamName);
        const removal = await removePathWithIdentityFenceAsync(backupDir, {
          recursive: true,
          force: true,
          durability: 'strict',
          validateDetached: async (detachedPath) => {
            try {
              const manifest = JSON.parse(
                await fs.promises.readFile(path.join(detachedPath, 'manifest.json'), 'utf8')
              ) as BackupManifest;
              return (
                manifest.teamName === teamName &&
                manifest.identityId === entry.identityId &&
                manifest.status === 'deleted_by_user'
              );
            } catch {
              return false;
            }
          },
        });
        if (removal === 'changed') return false;
        if (this.registry.teams[teamName]?.identityId === entry.identityId) {
          delete this.registry.teams[teamName];
        }
        logger.info(`[Backup] Pruned stale backup for ${teamName}`);
        return true;
      });
      if (didPrune) changed = true;
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

  private async awaitInitialization(): Promise<void> {
    if (this.initialized) return;
    await this.initialize();
  }

  private withTeamMutex<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
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
      await this.withTeamIdentityFence(teamName, () =>
        this.withTeamMutex(teamName, () => this.doBackupTeam(teamName))
      );
    }
  }

  private async doBackupTeam(teamName: string): Promise<void> {
    const gen = this.backupGeneration;
    if (!(await this.isConfigReady(teamName))) return;
    if (await this.permanentDeletion.isPermanentDeletionFenced(teamName)) return;

    const { files: sourceFiles, hasErrors } = await this.enumerateTeamFilesWithErrors(teamName);
    if (sourceFiles.length === 0) return;

    const backupDir = this.getBackupDir(teamName);
    let manifest = await this.loadManifest(teamName);
    // Reset stale manifest from a previously deleted team with the same name.
    // The backup dir may already contain the new team's files (copied by FileWatcher),
    // but the manifest was never updated because the deletion guard blocked it.
    if (
      manifest?.status === 'deleted_by_user' ||
      (manifest &&
        this.permanentDeletion.isReplacementForPendingDeletion(teamName, manifest.identityId))
    ) {
      manifest = null;
    }
    let isNew = !manifest;

    if (!manifest) {
      const ownership = await this.permanentDeletion.ensureIdentityMarker(
        teamName,
        crypto.randomUUID()
      );
      if (ownership.status === 'unavailable') return;
      manifest = {
        teamName,
        identityId: ownership.identityId,
        status: 'active',
        firstBackupAt: nowIso(),
        lastBackupAt: nowIso(),
        fileStats: {},
      };
    } else {
      // Ensure identity marker is present — may have been lost during full restore
      // (reconcile creates new identity in manifest, but restored config.json
      // from backup doesn't have the marker yet)
      const ownership = await this.permanentDeletion.ensureIdentityMarker(
        teamName,
        manifest.identityId
      );
      if (ownership.status === 'unavailable') return;
      if (ownership.status === 'different') {
        if (this.permanentDeletion.isIdentityClaimedForDeletion(teamName, manifest.identityId))
          return;
        manifest = {
          teamName,
          identityId: ownership.identityId,
          status: 'active',
          firstBackupAt: nowIso(),
          lastBackupAt: nowIso(),
          fileStats: {},
        };
        isNew = true;
      }
    }

    const assertPublicationCurrent = (): Promise<void> =>
      this.permanentDeletion.assertBackupPublicationCurrent(teamName, manifest.identityId);

    // Prune stale backup files (only if source enumeration was error-free)
    if (!hasErrors) {
      await this.pruneStaleBackupFiles(
        teamName,
        sourceFiles,
        backupDir,
        manifest,
        assertPublicationCurrent
      );
    }

    let anyChanged = false;
    for (const descriptor of sourceFiles) {
      if (this.backupGeneration !== gen) return;
      const changed = await this.backupSingleFile(
        descriptor,
        backupDir,
        manifest,
        assertPublicationCurrent
      );
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
      await this.saveManifest(teamName, manifest, false, assertPublicationCurrent);

      // Update thin registry
      const registryEntry: BackupRegistryEntry = {
        teamName,
        identityId: manifest.identityId,
        status: manifest.status,
        deletedByUserAt: manifest.deletedByUserAt,
        lastBackupAt: manifest.lastBackupAt,
      };
      if (this.backupGeneration !== gen) return;
      await this.saveRegistryEntry(teamName, registryEntry, false, assertPublicationCurrent);
    }
  }

  private doBackupTeamSync(teamName: string): void {
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const configPath = path.join(teamDir, 'config.json');
    if (this.permanentDeletion.isPermanentDeletionFencedSync(teamName)) return;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      if (!isValidConfig(raw)) return;
    } catch {
      return;
    }

    const sourceFiles = this.enumerateTeamFilesSync(teamName);
    if (sourceFiles.length === 0) return;

    const backupDir = this.getBackupDir(teamName);
    let manifest: BackupManifest | null = null;
    try {
      const raw = fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      // A missing manifest is initialized below after source identity ownership is known.
    }

    if (
      manifest?.status === 'deleted_by_user' ||
      (manifest &&
        this.permanentDeletion.isReplacementForPendingDeletion(teamName, manifest.identityId))
    ) {
      manifest = null;
    }

    if (!manifest) {
      const ownership = this.permanentDeletion.claimIdentityMarkerSync(
        teamName,
        crypto.randomUUID()
      );
      if (ownership.status === 'unavailable') return;
      manifest = {
        teamName,
        identityId: ownership.identityId,
        status: 'active',
        firstBackupAt: nowIso(),
        lastBackupAt: nowIso(),
        fileStats: {},
      };
    } else {
      const ownership = this.permanentDeletion.claimIdentityMarkerSync(
        teamName,
        manifest.identityId
      );
      if (ownership.status === 'unavailable') return;
      if (ownership.status === 'different') {
        if (this.permanentDeletion.isIdentityClaimedForDeletion(teamName, manifest.identityId))
          return;
        manifest = {
          teamName,
          identityId: ownership.identityId,
          status: 'active',
          firstBackupAt: nowIso(),
          lastBackupAt: nowIso(),
          fileStats: {},
        };
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
    manifest: BackupManifest,
    assertPublicationCurrent: () => Promise<void>
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
        await assertPublicationCurrent();
        await atomicWriteAsync(destPath, content, {
          beforeCommit: assertPublicationCurrent,
        });
      } else {
        const content = await fs.promises.readFile(descriptor.sourcePath);
        await assertPublicationCurrent();
        await atomicWriteAsync(destPath, content, {
          beforeCommit: assertPublicationCurrent,
        });
      }

      manifest.fileStats[descriptor.relPath] = { mtime: stat.mtimeMs, size: stat.size };
      return true;
    } catch (err: unknown) {
      if (err instanceof BackupPublicationFencedError) throw err;
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
        atomicWriteSync(destPath, content);
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
    manifest: BackupManifest,
    assertPublicationCurrent: () => Promise<void>
  ): Promise<void> {
    const backupFiles = await this.enumerateBackupFiles(teamName);
    const sourceRelPaths = new Set(sourceFiles.map((f) => f.relPath));

    for (const backupRelPath of backupFiles) {
      if (backupRelPath === 'manifest.json') continue;
      if (!sourceRelPaths.has(backupRelPath)) {
        const backupPath = path.join(backupDir, backupRelPath);
        try {
          await assertPublicationCurrent();
          const observed = getDurablePathIdentity(await fs.promises.lstat(backupPath));
          const removal = await removePathWithIdentityFenceAsync(backupPath, {
            force: true,
            validateDetached: async (_detachedPath, identity) => {
              await assertPublicationCurrent();
              return isSameDurablePathIdentity(identity, observed);
            },
          });
          if (removal !== 'changed') delete manifest.fileStats[backupRelPath];
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
    }
  }

  // ── Internal: restore ────────────────────────────────────────────────

  private restoreTeam(teamName: string): Promise<boolean> {
    return this.restoreService.restoreTeam(teamName);
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

    for (const subdir of TEAM_RECURSIVE_SUBDIRS) {
      const dirPath = path.join(teamDir, subdir);
      try {
        files.push(...(await collectRecursiveFiles(dirPath, subdir)));
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
              if (att.isFile() && shouldCollectTaskAttachmentBackupFile(att.name)) {
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

    for (const subdir of TEAM_RECURSIVE_SUBDIRS) {
      try {
        files.push(...collectRecursiveFilesSync(path.join(teamDir, subdir), subdir));
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
              if (att.isFile() && shouldCollectTaskAttachmentBackupFile(att.name)) {
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
            if (!shouldCollectTaskAttachmentBackupPath(relPath)) continue;
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

  private async saveRegistry(strict = false): Promise<void> {
    if (this.isShuttingDown) return;
    await this.permanentDeletion.withSharedLock('backup-registry', () =>
      atomicWriteAsync(
        this.getRegistryPath(),
        JSON.stringify(this.registry, null, 2),
        strict ? { durability: 'strict', syncDirectory: true } : undefined
      )
    );
  }

  private async saveRegistryEntry(
    teamName: string,
    entry: BackupRegistryEntry,
    strict = false,
    beforeCommit?: () => Promise<void>
  ): Promise<void> {
    if (this.isShuttingDown) return;
    await this.permanentDeletion.withSharedLock('backup-registry', async () => {
      await beforeCommit?.();
      const latestRegistry = await this.loadRegistry();
      latestRegistry.teams[teamName] = entry;
      await atomicWriteAsync(this.getRegistryPath(), JSON.stringify(latestRegistry, null, 2), {
        ...(strict ? { durability: 'strict' as const, syncDirectory: true } : {}),
        ...(beforeCommit ? { beforeCommit } : {}),
      });
      this.registry = latestRegistry;
    });
  }

  private saveRegistrySync(): void {
    try {
      atomicWriteSync(this.getRegistryPath(), JSON.stringify(this.registry, null, 2));
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

  private async saveManifest(
    teamName: string,
    manifest: BackupManifest,
    strict = false,
    beforeCommit?: () => Promise<void>
  ): Promise<void> {
    if (this.isShuttingDown) return;
    await beforeCommit?.();
    await atomicWriteAsync(
      path.join(this.getBackupDir(teamName), 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      {
        ...(strict ? { durability: 'strict' as const, syncDirectory: true } : {}),
        ...(beforeCommit ? { beforeCommit } : {}),
      }
    );
  }

  private saveManifestSync(teamName: string, manifest: BackupManifest): void {
    try {
      const manifestPath = path.join(this.getBackupDir(teamName), 'manifest.json');
      atomicWriteSync(manifestPath, JSON.stringify(manifest, null, 2));
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
