import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  atomicCreateAsync,
  atomicReplaceFileIfUnchangedAsync,
  atomicWriteAsync,
  atomicWriteSync,
  type DurablePathIdentity,
  type DurablePathRemovalProofHooks,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';
import {
  getAppDataPath,
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { TeamConfigReader } from './TeamConfigReader';

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

type PermanentDeletionSourceIdentity =
  | { status: 'identified'; identityId: string }
  | { status: 'absent' }
  | { status: 'unidentified' };

type IdentityMarkerOwnership =
  | { status: 'owned'; identityId: string }
  | { status: 'different'; identityId: string }
  | { status: 'unavailable' };

interface PermanentDeletionLockOwner {
  version: 2;
  token: string;
  pid: number;
  processInstanceId: string;
  createdAt: string;
  targetPath: string;
}

interface PermanentDeletionLock {
  lockPath: string;
  owner: PermanentDeletionLockOwner;
  identity: DurablePathIdentity;
  ownerEntryName: string;
}

interface PermanentDeletionLockObservation {
  owner: PermanentDeletionLockOwner | null;
  stats: fs.Stats;
  lockStats: fs.Stats;
  representation: 'directory' | 'legacy-file';
  ownerEntryName: string | null;
}

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

export interface TeamPermanentDeletionIntent {
  version: 2;
  teamName: string;
  identityId: string;
  transactionId: string;
  identityKind: 'team' | 'draft';
  targets: Record<PermanentDeletionTarget, PermanentDeletionTargetObservation>;
  targetRemovalProofs: Partial<
    Record<PermanentDeletionTarget, PermanentDeletionTargetRemovalProof>
  >;
  completedTargets: PermanentDeletionTarget[];
  cleanupCompleted: boolean;
  phase: 'prepared' | 'deleting' | 'deleted';
  requestedAt: string;
  updatedAt: string;
}

export type PermanentDeletionTarget =
  | 'team-data'
  | 'task-data'
  | 'message-attachments'
  | 'task-attachments';

const PERMANENT_DELETION_TARGETS: readonly PermanentDeletionTarget[] = [
  'team-data',
  'task-data',
  'message-attachments',
  'task-attachments',
];

type PermanentDeletionTargetObservation =
  | { status: 'absent' }
  | { status: 'present'; identity: DurablePathIdentity };

interface PermanentDeletionTargetRemovalProof {
  version: 1;
  transactionId: string;
  target: PermanentDeletionTarget;
  targetIdentity: DurablePathIdentity;
  state: 'detached' | 'removed';
  detachedAt: string;
  removedAt?: string;
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
const ATOMIC_WRITE_TEMP_FILE_PREFIX = '.tmp.';
const FILE_LOCK_SUFFIX = '.lock';
const QUARANTINED_OPENCODE_LANE_INDEX_RE = /^lanes\.invalid\.\d+\.json$/;
const MEMBER_WORK_SYNC_DIR = '.member-work-sync';
const MEMBER_WORK_SYNC_JOURNAL_FILE = 'journal.jsonl';
const PERMANENT_DELETION_INTENTS_DIR = 'permanent-deletion-intents';
const DRAFT_DELETION_IDENTITY_FILE = '.permanent-deletion-identity.json';
const PERMANENT_DELETION_LOCK_RETRY_MS = 10;
const PERMANENT_DELETION_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const PERMANENT_DELETION_LOCK_LEASE_MS = 30_000;
const PERMANENT_DELETION_LOCK_HEARTBEAT_MS = 5_000;
const PERMANENT_DELETION_LOCK_OWNER_PREFIX = 'owner-';
const PERMANENT_DELETION_LOCK_DETACHED_PREFIX = 'detached-';
const PERMANENT_DELETION_LOCK_ENTRY_SUFFIX = '.json';
const PROCESS_INSTANCE_ID = crypto.randomUUID();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BackupPublicationFencedError extends Error {}

function isPermanentDeletionLockOwner(value: unknown): value is PermanentDeletionLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<PermanentDeletionLockOwner>;
  return (
    owner.version === 2 &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.processInstanceId === 'string' &&
    owner.processInstanceId.length > 0 &&
    typeof owner.createdAt === 'string' &&
    Number.isFinite(Date.parse(owner.createdAt)) &&
    typeof owner.targetPath === 'string' &&
    path.isAbsolute(owner.targetPath)
  );
}

function isDurablePathIdentity(value: unknown): value is DurablePathIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<DurablePathIdentity>;
  return (
    typeof identity.dev === 'number' &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === 'number' &&
    Number.isFinite(identity.ino) &&
    typeof identity.birthtimeMs === 'number' &&
    Number.isFinite(identity.birthtimeMs)
  );
}

function isPermanentDeletionTargetObservation(
  value: unknown
): value is PermanentDeletionTargetObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const observation = value as Partial<PermanentDeletionTargetObservation>;
  return (
    observation.status === 'absent' ||
    (observation.status === 'present' && isDurablePathIdentity(observation.identity))
  );
}

function isPermanentDeletionTargetRemovalProof(
  value: unknown
): value is PermanentDeletionTargetRemovalProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Partial<PermanentDeletionTargetRemovalProof>;
  return (
    proof.version === 1 &&
    typeof proof.transactionId === 'string' &&
    proof.transactionId.length > 0 &&
    typeof proof.target === 'string' &&
    PERMANENT_DELETION_TARGETS.includes(proof.target) &&
    isDurablePathIdentity(proof.targetIdentity) &&
    (proof.state === 'detached' || proof.state === 'removed') &&
    typeof proof.detachedAt === 'string' &&
    Number.isFinite(Date.parse(proof.detachedAt)) &&
    (proof.state === 'removed'
      ? typeof proof.removedAt === 'string' && Number.isFinite(Date.parse(proof.removedAt))
      : proof.removedAt === undefined)
  );
}

function isExactDurablePathIdentity(
  left: DurablePathIdentity,
  right: DurablePathIdentity
): boolean {
  return isSameDurablePathIdentity(left, right) && left.birthtimeMs === right.birthtimeMs;
}

function shouldCollectRecursiveBackupFile(relPath: string): boolean {
  const fileName = path.basename(relPath);
  if (fileName.startsWith(ATOMIC_WRITE_TEMP_FILE_PREFIX)) {
    return false;
  }
  if (fileName.endsWith(FILE_LOCK_SUFFIX)) {
    return false;
  }
  // Runtime quarantine files are diagnostic snapshots of invalid JSON.
  if (QUARANTINED_OPENCODE_LANE_INDEX_RE.test(fileName)) {
    return false;
  }
  const segments = relPath.split('/');
  const workSyncIndex = segments.lastIndexOf(MEMBER_WORK_SYNC_DIR);
  if (
    segments[0] === 'members' &&
    workSyncIndex >= 2 &&
    segments[workSyncIndex + 1] === MEMBER_WORK_SYNC_JOURNAL_FILE
  ) {
    return false;
  }
  return true;
}

async function collectRecursiveFiles(
  rootDir: string,
  relPrefix: string
): Promise<BackupFileDescriptor[]> {
  const files: BackupFileDescriptor[] = [];
  const walk = async (dirPath: string, relDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(dirPath, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(sourcePath, relPath);
        continue;
      }
      if (entry.isFile()) {
        const descriptorRelPath = relPrefix ? `${relPrefix}/${relPath}` : relPath;
        if (!shouldCollectRecursiveBackupFile(descriptorRelPath)) {
          continue;
        }
        files.push({
          sourcePath,
          relPath: descriptorRelPath,
        });
      }
    }
  };

  await walk(rootDir, '');
  return files;
}

function collectRecursiveFilesSync(rootDir: string, relPrefix: string): BackupFileDescriptor[] {
  const files: BackupFileDescriptor[] = [];
  const walk = (dirPath: string, relDir: string): void => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(dirPath, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(sourcePath, relPath);
        continue;
      }
      if (entry.isFile()) {
        const descriptorRelPath = relPrefix ? `${relPrefix}/${relPath}` : relPath;
        if (!shouldCollectRecursiveBackupFile(descriptorRelPath)) {
          continue;
        }
        files.push({
          sourcePath,
          relPath: descriptorRelPath,
        });
      }
    }
  };

  walk(rootDir, '');
  return files;
}

// ---------------------------------------------------------------------------
// TeamBackupService
// ---------------------------------------------------------------------------

export class TeamBackupService {
  private registry: BackupRegistry = { version: 1, teams: {} };
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private taskDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teamMutex = new Map<string, Promise<unknown>>();
  private permanentDeletionIntents = new Map<string, TeamPermanentDeletionIntent>();
  private corruptPermanentDeletionFences = new Set<string>();
  private preBoundaryDeletionClaims = new Map<string, Map<symbol, string>>();
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;
  private isShuttingDown = false;
  private backupGeneration = 0;

  // ── Public API ───────────────────────────────────────────────────────

  initialize(): Promise<void> {
    this.initializationPromise ??= this.initializeOnce();
    return this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    this.registry = await this.loadRegistry();
    await this.loadPermanentDeletionIntents();
    await this.rollbackPreparedPermanentDeletionIntents();
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

  async beginPermanentDeletion(
    teamName: string,
    options: { draft?: boolean } = {}
  ): Promise<TeamPermanentDeletionIntent> {
    this.assertSafeTeamName(teamName);
    let deletionOwnerIdentity = this.initialized
      ? this.getDeletionRequestIdentityOwner(teamName)
      : undefined;
    let claimToken = deletionOwnerIdentity
      ? this.addPreBoundaryDeletionClaim(teamName, deletionOwnerIdentity)
      : null;
    try {
      await this.awaitInitialization();
      if (this.isShuttingDown) {
        throw new Error('Cannot begin permanent deletion while backup service is shutting down');
      }

      deletionOwnerIdentity ??= this.getDeletionRequestIdentityOwner(teamName);
      claimToken ??= deletionOwnerIdentity
        ? this.addPreBoundaryDeletionClaim(teamName, deletionOwnerIdentity)
        : null;

      return await this.withTeamIdentityFence(teamName, () =>
        this.withTeamMutex(teamName, async () => {
          const existing = this.permanentDeletionIntents.get(teamName);
          if (existing) {
            const expected = existing.targets['team-data'];
            const observed = await this.observePermanentDeletionTarget(
              this.getPermanentDeletionTargetPath(teamName, 'team-data')
            );
            const replacementExists =
              observed.status === 'present' &&
              (expected.status === 'absent' ||
                !isExactDurablePathIdentity(observed.identity, expected.identity));
            if (!replacementExists) {
              return existing;
            }
          }

          const identityId = await this.resolveOrCreatePermanentDeletionIdentity(
            teamName,
            options.draft === true,
            deletionOwnerIdentity
          );
          const targets = await this.observePermanentDeletionTargets(teamName);
          const timestamp = nowIso();
          const intent: TeamPermanentDeletionIntent = {
            version: 2,
            teamName,
            identityId,
            transactionId: crypto.randomUUID(),
            identityKind: options.draft === true ? 'draft' : 'team',
            targets,
            targetRemovalProofs: {},
            completedTargets: [],
            cleanupCompleted: PERMANENT_DELETION_TARGETS.every(
              (target) => targets[target].status === 'absent'
            ),
            phase: 'prepared',
            requestedAt: timestamp,
            updatedAt: timestamp,
          };
          await this.savePermanentDeletionIntent(intent);
          this.permanentDeletionIntents.set(teamName, intent);
          return intent;
        })
      );
    } finally {
      this.removePreBoundaryDeletionClaim(teamName, claimToken);
    }
  }

  async commitPermanentDeletionBoundary(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    await this.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, () =>
      this.withTeamMutex(intent.teamName, async () => {
        const current = this.requireCurrentPermanentDeletionIntent(intent);
        if (current.phase === 'deleting' || current.phase === 'deleted') return current;
        const deletingIntent: TeamPermanentDeletionIntent = {
          ...current,
          phase: 'deleting',
          updatedAt: nowIso(),
        };
        await this.savePermanentDeletionIntent(deletingIntent);
        this.permanentDeletionIntents.set(intent.teamName, deletingIntent);
        return deletingIntent;
      })
    );
  }

  async abortPreparedPermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.awaitInitialization();
    await this.withTeamIdentityFence(intent.teamName, () =>
      this.withTeamMutex(intent.teamName, async () => {
        const current = this.permanentDeletionIntents.get(intent.teamName);
        if (
          !current ||
          current.identityId !== intent.identityId ||
          current.transactionId !== intent.transactionId
        ) {
          return;
        }
        if (current.phase !== 'prepared') {
          throw new Error(
            `Cannot abort permanent deletion after destructive boundary: ${intent.teamName}`
          );
        }
        await this.removePermanentDeletionIntent(current);
      })
    );
  }

  async listPendingPermanentDeletions(): Promise<TeamPermanentDeletionIntent[]> {
    await this.awaitInitialization();
    return [...this.permanentDeletionIntents.values()]
      .filter((intent) => intent.phase === 'deleting')
      .map((intent) => ({ ...intent }));
  }

  async isPermanentDeletionTargetCurrent(intent: TeamPermanentDeletionIntent): Promise<boolean> {
    await this.awaitInitialization();
    await this.reloadPermanentDeletionIntent(intent.teamName);
    return this.isPermanentDeletionTargetCurrentInternal(intent);
  }

  async reconcilePermanentDeletionProgress(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    await this.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, () =>
      this.withTeamMutex(intent.teamName, () =>
        this.reconcilePermanentDeletionProgressInternal(intent)
      )
    );
  }

  async completePermanentDeletion(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.awaitInitialization();
    await this.withTeamIdentityFence(intent.teamName, () =>
      this.withTeamMutex(intent.teamName, () => this.completePermanentDeletionInternal(intent))
    );
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
      if (this.isPermanentDeletionFencedSync(teamName, entry.identityId)) continue;
      try {
        this.doBackupTeamSync(teamName);
      } catch (err: unknown) {
        logger.warn(`[Backup] shutdown backup failed for ${teamName}: ${String(err)}`);
      }
    }
    this.saveRegistrySync();
  }

  async restoreIfNeeded(): Promise<string[]> {
    const restored: string[] = [];
    for (const [teamName, entry] of Object.entries(this.registry.teams)) {
      if (entry.status !== 'active') continue;
      const restoreIdentity = (await this.loadManifest(teamName))?.identityId ?? entry.identityId;
      if (this.isReplacementForPendingDeletion(teamName, restoreIdentity)) {
        logger.info(`[Backup] Skip restore of superseded deletion identity for ${teamName}`);
        continue;
      }
      if (await this.isPermanentDeletionFenced(teamName, restoreIdentity)) {
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
        const deletionTombstone = this.permanentDeletionIntents.get(teamName);
        if (
          deletionTombstone?.phase === 'deleted' &&
          deletionTombstone.identityId === entry.identityId
        ) {
          await this.removePermanentDeletionIntent(deletionTombstone);
        }
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

  // ── Internal: durable permanent deletion fence ──────────────────────

  private assertSafeTeamName(teamName: string): void {
    if (
      teamName.length === 0 ||
      teamName.trim() !== teamName ||
      teamName === '.' ||
      teamName === '..' ||
      teamName.includes('/') ||
      teamName.includes('\\') ||
      teamName.includes('\0')
    ) {
      throw new Error('Invalid teamName');
    }
  }

  private getPermanentDeletionIntentsDir(): string {
    return path.join(getBackupsBasePath(), PERMANENT_DELETION_INTENTS_DIR);
  }

  private getPermanentDeletionIntentPath(teamName: string): string {
    this.assertSafeTeamName(teamName);
    return path.join(this.getPermanentDeletionIntentsDir(), `${encodeURIComponent(teamName)}.json`);
  }

  private getDraftDeletionIdentityPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, DRAFT_DELETION_IDENTITY_FILE);
  }

  private getPermanentDeletionLockPath(scope: string): string {
    const targetPath = path.resolve(getBackupsBasePath());
    const lockKey = crypto.createHash('sha256').update(`${targetPath}\0${scope}`).digest('hex');
    // The coordination file must not live below the hierarchy it protects. os.tmpdir()
    // is an existing, host-local rendezvous point shared by independently loaded
    // modules and processes, even while the app-data hierarchy is being created.
    return path.join(os.tmpdir(), `.agent-teams-permanent-deletion-${lockKey}.lock`);
  }

  private getPermanentDeletionLockOwnerEntryName(token: string): string {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return `${PERMANENT_DELETION_LOCK_OWNER_PREFIX}${tokenHash}${PERMANENT_DELETION_LOCK_ENTRY_SUFFIX}`;
  }

  private isPermanentDeletionLockEntryName(entryName: string): boolean {
    return (
      (entryName.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX) ||
        entryName.startsWith(PERMANENT_DELETION_LOCK_DETACHED_PREFIX)) &&
      entryName.endsWith(PERMANENT_DELETION_LOCK_ENTRY_SUFFIX)
    );
  }

  private async readPermanentDeletionLockEntry(
    entryPath: string
  ): Promise<{ owner: PermanentDeletionLockOwner | null; stats: fs.Stats } | null> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(entryPath, 'r');
      const stats = await handle.stat();
      if (!stats.isFile()) return { owner: null, stats };
      const raw = await handle.readFile('utf8');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        // Published owner entries are synced before their lock directory is
        // published. Invalid JSON therefore belongs to a crashed/corrupt owner.
      }
      return { owner: isPermanentDeletionLockOwner(parsed) ? parsed : null, stats };
    } catch (error) {
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readPermanentDeletionLockOwner(
    lockPath: string
  ): Promise<PermanentDeletionLockObservation | null> {
    try {
      const lockStats = await fs.promises.lstat(lockPath);
      if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
        const legacy = await this.readPermanentDeletionLockEntry(lockPath);
        if (!legacy) return null;
        return {
          ...legacy,
          lockStats,
          representation: 'legacy-file',
          ownerEntryName: null,
        };
      }

      const entryNames = (await fs.promises.readdir(lockPath))
        .filter((entryName) => this.isPermanentDeletionLockEntryName(entryName))
        .sort((left, right) => {
          const leftIsOwner = left.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX);
          const rightIsOwner = right.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX);
          if (leftIsOwner !== rightIsOwner) return leftIsOwner ? -1 : 1;
          return left.localeCompare(right);
        });
      const ownerEntryName = entryNames[0] ?? null;
      if (!ownerEntryName) {
        return {
          owner: null,
          stats: lockStats,
          lockStats,
          representation: 'directory',
          ownerEntryName: null,
        };
      }

      const entry = await this.readPermanentDeletionLockEntry(path.join(lockPath, ownerEntryName));
      if (!entry) return null;
      return {
        ...entry,
        lockStats,
        representation: 'directory',
        ownerEntryName,
      };
    } catch (error) {
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw error;
    }
  }

  private isSamePermanentDeletionLockObservation(
    current: { owner: PermanentDeletionLockOwner | null; stats: fs.Stats },
    expected: PermanentDeletionLockObservation
  ): boolean {
    const identity = getDurablePathIdentity(current.stats);
    const expectedIdentity = getDurablePathIdentity(expected.stats);
    return (
      isSameDurablePathIdentity(identity, expectedIdentity) &&
      identity.birthtimeMs === expectedIdentity.birthtimeMs &&
      current.stats.mtimeMs === expected.stats.mtimeMs &&
      current.stats.size === expected.stats.size &&
      current.owner?.token === expected.owner?.token
    );
  }

  private async restoreDetachedLockEntryNoClobber(
    detachedPath: string,
    ownerPath: string
  ): Promise<boolean> {
    try {
      await fs.promises.link(detachedPath, ownerPath);
      await fs.promises.unlink(detachedPath);
      await syncDirectoryDurably(path.dirname(ownerPath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return true;
      throw error;
    }
  }

  private async detachPermanentDeletionLockOwner(
    lockPath: string,
    expected: Pick<PermanentDeletionLockObservation, 'representation' | 'ownerEntryName'>,
    validateDetached: (detached: {
      owner: PermanentDeletionLockOwner | null;
      stats: fs.Stats;
    }) => boolean
  ): Promise<'removed' | 'missing' | 'changed'> {
    if (expected.representation === 'legacy-file') {
      const removal = await removePathWithIdentityFenceAsync(lockPath, {
        force: true,
        durability: 'strict',
        validateDetached: async (detachedPath) => {
          const detached = await this.readPermanentDeletionLockEntry(detachedPath);
          return detached !== null && validateDetached(detached);
        },
      });
      return removal === 'deleted' ? 'removed' : removal === 'missing' ? 'missing' : 'changed';
    }

    if (!expected.ownerEntryName) {
      try {
        await fs.promises.rmdir(lockPath);
        await syncDirectoryDurably(path.dirname(lockPath));
        return 'removed';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return 'missing';
        if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return 'changed';
        throw error;
      }
    }

    const ownerPath = path.join(lockPath, expected.ownerEntryName);
    const detachedEntryName = `${PERMANENT_DELETION_LOCK_DETACHED_PREFIX}${crypto.randomUUID()}-${
      expected.ownerEntryName
    }`;
    const detachedPath = path.join(lockPath, detachedEntryName);
    try {
      // The token-derived owner pathname is the ownership check and mutation
      // target in one operation. A replacement lock directory has a different
      // entry name, so it cannot be detached after replacing the observation.
      await fs.promises.rename(ownerPath, detachedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'changed';
      throw error;
    }
    await syncDirectoryDurably(lockPath);

    try {
      const detached = await this.readPermanentDeletionLockEntry(detachedPath);
      if (!detached || !validateDetached(detached)) {
        await this.restoreDetachedLockEntryNoClobber(detachedPath, ownerPath);
        return 'changed';
      }

      await fs.promises.unlink(detachedPath);
      try {
        await fs.promises.rmdir(lockPath);
        await syncDirectoryDurably(path.dirname(lockPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
      return 'removed';
    } catch (error) {
      await this.restoreDetachedLockEntryNoClobber(detachedPath, ownerPath).catch(() => undefined);
      throw error;
    }
  }

  private async removeStalePermanentDeletionLock(lockPath: string): Promise<boolean> {
    const observed = await this.readPermanentDeletionLockOwner(lockPath);
    if (!observed) return true;
    // Version-2 owners renew the lock inode itself. PID liveness is deliberately
    // not an ownership signal: a recycled PID must not retain a dead owner's lock.
    if (observed.owner && Date.now() - observed.stats.mtimeMs <= PERMANENT_DELETION_LOCK_LEASE_MS) {
      return false;
    }

    const removal = await this.detachPermanentDeletionLockOwner(lockPath, observed, (detached) =>
      this.isSamePermanentDeletionLockObservation(detached, observed)
    );
    return removal === 'removed' || removal === 'missing';
  }

  private async acquirePermanentDeletionLock(scope: string): Promise<PermanentDeletionLock> {
    const lockPath = this.getPermanentDeletionLockPath(scope);
    const targetPath = path.resolve(getBackupsBasePath());
    const owner: PermanentDeletionLockOwner = {
      version: 2,
      token: crypto.randomUUID(),
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      createdAt: nowIso(),
      targetPath,
    };
    const candidatePath = `${lockPath}.${owner.token}.candidate`;
    const ownerEntryName = this.getPermanentDeletionLockOwnerEntryName(owner.token);
    const candidateOwnerPath = path.join(candidatePath, ownerEntryName);
    let candidateHandle: fs.promises.FileHandle | null = null;
    let lockPublished = false;
    try {
      await fs.promises.mkdir(candidatePath, { mode: 0o700 });
      candidateHandle = await fs.promises.open(candidateOwnerPath, 'wx', 0o600);
      await candidateHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await candidateHandle.sync();
      await candidateHandle.close();
      candidateHandle = null;
      await syncDirectoryDurably(candidatePath);

      const deadline = Date.now() + PERMANENT_DELETION_LOCK_ACQUIRE_TIMEOUT_MS;
      while (true) {
        try {
          // A complete, synced non-empty directory is the indivisible ownership
          // unit. Renaming it publishes the owner atomically, and an existing
          // non-empty lock directory cannot be displaced by another contender.
          await fs.promises.rename(candidatePath, lockPath);
          lockPublished = true;
          await syncDirectoryDurably(path.dirname(lockPath));
          const stats = await fs.promises.lstat(path.join(lockPath, ownerEntryName));
          return {
            lockPath,
            owner,
            identity: getDurablePathIdentity(stats),
            ownerEntryName,
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== 'EEXIST' &&
            code !== 'ENOTEMPTY' &&
            code !== 'ENOTDIR' &&
            code !== 'EISDIR'
          ) {
            throw error;
          }
          await this.removeStalePermanentDeletionLock(lockPath);
          if (Date.now() >= deadline) {
            throw new Error(`Permanent deletion lock timeout: ${targetPath}`);
          }
          await sleep(PERMANENT_DELETION_LOCK_RETRY_MS);
        }
      }
    } catch (error) {
      await candidateHandle?.close().catch(() => undefined);
      await fs.promises.rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
      if (lockPublished) {
        const stats = await fs.promises
          .lstat(path.join(lockPath, ownerEntryName))
          .catch(() => null);
        if (stats) {
          await this.releasePermanentDeletionLock({
            lockPath,
            owner,
            identity: getDurablePathIdentity(stats),
            ownerEntryName,
          }).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async heartbeatPermanentDeletionLock(lock: PermanentDeletionLock): Promise<void> {
    const ownerPath = path.join(lock.lockPath, lock.ownerEntryName);
    const handle = await fs.promises.open(ownerPath, 'r+');
    try {
      const stats = await handle.stat();
      const owner = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (
        !isSameDurablePathIdentity(getDurablePathIdentity(stats), lock.identity) ||
        !isPermanentDeletionLockOwner(owner) ||
        owner.token !== lock.owner.token
      ) {
        throw new Error('Permanent deletion lock ownership changed');
      }
      const now = new Date();
      await handle.utimes(now, now);
    } finally {
      await handle.close();
    }
  }

  private async releasePermanentDeletionLock(lock: PermanentDeletionLock): Promise<void> {
    await this.detachPermanentDeletionLockOwner(
      lock.lockPath,
      {
        representation: 'directory',
        ownerEntryName: lock.ownerEntryName,
      },
      (detached) => {
        const identity = getDurablePathIdentity(detached.stats);
        return (
          detached.owner?.token === lock.owner.token &&
          isSameDurablePathIdentity(identity, lock.identity) &&
          identity.birthtimeMs === lock.identity.birthtimeMs
        );
      }
    );
  }

  private async withPermanentDeletionLock<T>(
    scope: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const lock = await this.acquirePermanentDeletionLock(scope);
    let heartbeatError: unknown;
    let heartbeatRunning = false;
    const heartbeatTasks = new Set<Promise<void>>();
    const heartbeatTimer = setInterval(() => {
      if (heartbeatRunning || heartbeatError) return;
      heartbeatRunning = true;
      const heartbeatTask = this.heartbeatPermanentDeletionLock(lock)
        .catch((error: unknown) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatRunning = false;
          heartbeatTasks.delete(heartbeatTask);
        });
      heartbeatTasks.add(heartbeatTask);
    }, PERMANENT_DELETION_LOCK_HEARTBEAT_MS);
    heartbeatTimer.unref();
    try {
      const result = await operation();
      if (heartbeatError) {
        throw heartbeatError instanceof Error
          ? heartbeatError
          : new Error(
              `Permanent deletion lock heartbeat failed: ${
                typeof heartbeatError === 'string' ? heartbeatError : 'unknown failure'
              }`
            );
      }
      await this.heartbeatPermanentDeletionLock(lock);
      return result;
    } finally {
      clearInterval(heartbeatTimer);
      await Promise.all(heartbeatTasks);
      await this.releasePermanentDeletionLock(lock);
    }
  }

  async withTeamIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    this.assertSafeTeamName(teamName);
    return this.withPermanentDeletionLock(`team:${teamName}`, async () => {
      await this.reloadPermanentDeletionIntent(teamName);
      return operation();
    });
  }

  async withPermanentDeletionTargetFence(
    intent: TeamPermanentDeletionIntent,
    operation: (
      isTargetCurrent: (
        target?: PermanentDeletionTarget,
        detachedPath?: string
      ) => Promise<boolean>,
      getTargetProofHooks: (target: PermanentDeletionTarget) => DurablePathRemovalProofHooks,
      isTargetCompleted: (target: PermanentDeletionTarget) => boolean
    ) => Promise<boolean>
  ): Promise<boolean> {
    await this.awaitInitialization();
    return this.withTeamIdentityFence(intent.teamName, async () => {
      let current = await this.reconcilePermanentDeletionProgressInternal(intent);
      const isTargetCurrent = (
        target: PermanentDeletionTarget = 'team-data',
        detachedPath?: string
      ): Promise<boolean> =>
        this.isDurablePermanentDeletionTargetCurrent(intent, target, detachedPath);
      const isTargetCompleted = (target: PermanentDeletionTarget): boolean =>
        current.targets[target].status === 'absent' ||
        current.targetRemovalProofs[target]?.state === 'removed';
      const getTargetProofHooks = (
        target: PermanentDeletionTarget
      ): DurablePathRemovalProofHooks => {
        const expected = current.targets[target];
        if (expected.status !== 'present') {
          throw new Error(`Permanent deletion target did not exist at prepare: ${target}`);
        }
        return {
          detachedPath: this.getPermanentDeletionDetachedTargetPath(current, target),
          onDetachedValidated: async (detachedPath, identity) => {
            current = await this.savePermanentDeletionTargetRemovalProof(
              current,
              target,
              identity,
              'detached',
              detachedPath
            );
          },
          onRemovalDurable: async (detachedPath, identity) => {
            current = await this.savePermanentDeletionTargetRemovalProof(
              current,
              target,
              identity,
              'removed',
              detachedPath
            );
          },
        };
      };
      return operation(isTargetCurrent, getTargetProofHooks, isTargetCompleted);
    });
  }

  private parsePermanentDeletionIntent(value: unknown): TeamPermanentDeletionIntent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<TeamPermanentDeletionIntent>;
    if (
      candidate.version !== 2 ||
      typeof candidate.teamName !== 'string' ||
      typeof candidate.identityId !== 'string' ||
      !candidate.identityId ||
      typeof candidate.transactionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.transactionId
      ) ||
      (candidate.identityKind !== 'team' && candidate.identityKind !== 'draft') ||
      !candidate.targets ||
      typeof candidate.targets !== 'object' ||
      !PERMANENT_DELETION_TARGETS.every((target) =>
        isPermanentDeletionTargetObservation(candidate.targets?.[target])
      ) ||
      !candidate.targetRemovalProofs ||
      typeof candidate.targetRemovalProofs !== 'object' ||
      Array.isArray(candidate.targetRemovalProofs) ||
      Object.keys(candidate.targetRemovalProofs).some(
        (target) => !PERMANENT_DELETION_TARGETS.includes(target as PermanentDeletionTarget)
      ) ||
      !Array.isArray(candidate.completedTargets) ||
      candidate.completedTargets.some((target) => !PERMANENT_DELETION_TARGETS.includes(target)) ||
      new Set(candidate.completedTargets).size !== candidate.completedTargets.length ||
      typeof candidate.cleanupCompleted !== 'boolean' ||
      (candidate.phase !== 'prepared' &&
        candidate.phase !== 'deleting' &&
        candidate.phase !== 'deleted') ||
      typeof candidate.requestedAt !== 'string' ||
      typeof candidate.updatedAt !== 'string'
    ) {
      return null;
    }
    try {
      this.assertSafeTeamName(candidate.teamName);
    } catch {
      return null;
    }

    const targets = candidate.targets;
    const targetRemovalProofs = candidate.targetRemovalProofs;
    for (const target of PERMANENT_DELETION_TARGETS) {
      const proof = targetRemovalProofs[target];
      if (proof === undefined) continue;
      const expected = targets[target];
      if (
        !isPermanentDeletionTargetRemovalProof(proof) ||
        expected.status !== 'present' ||
        proof.transactionId !== candidate.transactionId ||
        proof.target !== target ||
        !isExactDurablePathIdentity(proof.targetIdentity, expected.identity)
      ) {
        return null;
      }
    }

    const completedTargets = PERMANENT_DELETION_TARGETS.filter(
      (target) => targetRemovalProofs[target]?.state === 'removed'
    );
    const cleanupCompleted = PERMANENT_DELETION_TARGETS.every(
      (target) =>
        targets[target].status === 'absent' || targetRemovalProofs[target]?.state === 'removed'
    );
    if (
      candidate.completedTargets.length !== completedTargets.length ||
      candidate.completedTargets.some((target, index) => target !== completedTargets[index]) ||
      candidate.cleanupCompleted !== cleanupCompleted ||
      (candidate.phase === 'deleted' && !cleanupCompleted)
    ) {
      return null;
    }
    return candidate as TeamPermanentDeletionIntent;
  }

  private async reloadPermanentDeletionIntent(teamName: string): Promise<void> {
    const intentPath = this.getPermanentDeletionIntentPath(teamName);
    try {
      const raw = await fs.promises.readFile(intentPath, 'utf8');
      const intent = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (!intent || intent.teamName !== teamName) {
        throw new Error('invalid permanent deletion intent');
      }
      this.permanentDeletionIntents.set(teamName, intent);
      this.corruptPermanentDeletionFences.delete(teamName);
    } catch (error) {
      if (isEnoent(error)) {
        this.permanentDeletionIntents.delete(teamName);
        this.corruptPermanentDeletionFences.delete(teamName);
        return;
      }
      this.permanentDeletionIntents.delete(teamName);
      this.corruptPermanentDeletionFences.add(teamName);
    }
  }

  private async loadPermanentDeletionIntents(): Promise<void> {
    this.permanentDeletionIntents.clear();
    this.corruptPermanentDeletionFences.clear();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.getPermanentDeletionIntentsDir(), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let teamNameFromFile: string | null = null;
      try {
        teamNameFromFile = decodeURIComponent(entry.name.slice(0, -'.json'.length));
        this.assertSafeTeamName(teamNameFromFile);
      } catch {
        logger.warn(`[Backup] Ignoring permanent deletion intent with unsafe name: ${entry.name}`);
        continue;
      }

      try {
        const raw = await fs.promises.readFile(
          path.join(this.getPermanentDeletionIntentsDir(), entry.name),
          'utf8'
        );
        const intent = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
        if (!intent || intent.teamName !== teamNameFromFile) {
          throw new Error('invalid permanent deletion intent');
        }
        this.permanentDeletionIntents.set(intent.teamName, intent);
      } catch (error) {
        this.corruptPermanentDeletionFences.add(teamNameFromFile);
        logger.warn(
          `[Backup] Corrupt permanent deletion intent fences restore for ${teamNameFromFile}: ${String(error)}`
        );
      }
    }
  }

  private async rollbackPreparedPermanentDeletionIntents(): Promise<void> {
    for (const intent of [...this.permanentDeletionIntents.values()]) {
      if (intent.phase !== 'prepared') continue;
      await this.removePermanentDeletionIntent(intent);
      logger.info(`[Backup] Rolled back prepared permanent deletion for ${intent.teamName}`);
    }
  }

  private async savePermanentDeletionIntent(intent: TeamPermanentDeletionIntent): Promise<void> {
    const intentsDir = this.getPermanentDeletionIntentsDir();
    await this.withPermanentDeletionLock('intent-hierarchy', async () => {
      await this.ensureDirectoryHierarchyDurably(intentsDir);
      await atomicWriteAsync(
        this.getPermanentDeletionIntentPath(intent.teamName),
        JSON.stringify(intent, null, 2),
        { durability: 'strict', syncDirectory: true }
      );
    });
  }

  private async removePermanentDeletionIntent(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.withPermanentDeletionLock('intent-hierarchy', async () => {
      const intentPath = this.getPermanentDeletionIntentPath(intent.teamName);
      try {
        const raw = await fs.promises.readFile(intentPath, 'utf8');
        const persisted = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
        if (
          !persisted ||
          persisted.identityId !== intent.identityId ||
          persisted.transactionId !== intent.transactionId
        ) {
          return;
        }
        const removal = await removePathWithIdentityFenceAsync(intentPath, {
          force: true,
          durability: 'strict',
          validateDetached: async (detachedPath) => {
            try {
              const detachedRaw = await fs.promises.readFile(detachedPath, 'utf8');
              const detached = this.parsePermanentDeletionIntent(
                JSON.parse(detachedRaw) as unknown
              );
              return (
                detached?.identityId === intent.identityId &&
                detached.transactionId === intent.transactionId &&
                detachedRaw === raw
              );
            } catch {
              return false;
            }
          },
        });
        if (removal === 'changed') return;
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const current = this.permanentDeletionIntents.get(intent.teamName);
      if (
        current?.identityId === intent.identityId &&
        current.transactionId === intent.transactionId
      ) {
        this.permanentDeletionIntents.delete(intent.teamName);
      }
    });
  }

  private async ensureDirectoryHierarchyDurably(directoryPath: string): Promise<void> {
    const missingDirectories: string[] = [];
    let cursor = path.resolve(directoryPath);

    while (true) {
      try {
        const stats = await fs.promises.stat(cursor);
        if (!stats.isDirectory()) {
          throw new Error(`Permanent deletion intent path is not a directory: ${cursor}`);
        }
        break;
      } catch (error) {
        if (!isEnoent(error)) throw error;
        missingDirectories.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }

    missingDirectories.reverse();
    for (const missingDirectory of missingDirectories) {
      try {
        await fs.promises.mkdir(missingDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stats = await fs.promises.stat(missingDirectory);
        if (!stats.isDirectory()) throw error;
      }
      // Persist each directory entry before creating anything beneath it. The
      // cross-process hierarchy lock prevents another writer from observing mkdir
      // before this sync.
      await syncDirectoryDurably(path.dirname(missingDirectory));
    }
  }

  private getDeletionRequestIdentityOwner(teamName: string): string | undefined {
    const registryEntry = this.registry.teams[teamName];
    if (registryEntry?.status === 'active') return registryEntry.identityId;
    const intent = this.permanentDeletionIntents.get(teamName);
    return intent?.phase === 'prepared' || intent?.phase === 'deleting'
      ? intent.identityId
      : undefined;
  }

  private addPreBoundaryDeletionClaim(teamName: string, identityId: string): symbol {
    const token = Symbol(teamName);
    const claims = this.preBoundaryDeletionClaims.get(teamName) ?? new Map<symbol, string>();
    claims.set(token, identityId);
    this.preBoundaryDeletionClaims.set(teamName, claims);
    return token;
  }

  private removePreBoundaryDeletionClaim(teamName: string, token: symbol | null): void {
    if (!token) return;
    const claims = this.preBoundaryDeletionClaims.get(teamName);
    if (!claims) return;
    claims.delete(token);
    if (claims.size === 0) this.preBoundaryDeletionClaims.delete(teamName);
  }

  private isIdentityClaimedForDeletion(teamName: string, identityId: string): boolean {
    const inMemoryClaim = [...(this.preBoundaryDeletionClaims.get(teamName)?.values() ?? [])].some(
      (claimedIdentityId) => claimedIdentityId === identityId
    );
    if (inMemoryClaim) return true;
    return this.permanentDeletionIntents.get(teamName)?.identityId === identityId;
  }

  private async claimIdentityMarker(
    teamName: string,
    identityId: string,
    durable: boolean
  ): Promise<IdentityMarkerOwnership> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    let originalRaw: string;
    let originalIdentity: DurablePathIdentity;
    let config: Record<string, unknown>;
    try {
      const observation = await this.readSourceConfig(configPath);
      if (observation.status !== 'valid') return { status: 'unavailable' };
      originalRaw = observation.raw;
      originalIdentity = observation.identity;
      config = observation.parsed;
    } catch (error) {
      if (durable && !isEnoent(error)) throw error;
      return { status: 'unavailable' };
    }

    const existingIdentityId = config._backupIdentityId;
    if (typeof existingIdentityId === 'string' && existingIdentityId) {
      return existingIdentityId === identityId
        ? { status: 'owned', identityId }
        : { status: 'different', identityId: existingIdentityId };
    }
    if (this.isIdentityClaimedForDeletion(teamName, identityId)) {
      return { status: 'unavailable' };
    }

    config._backupIdentityId = identityId;
    let ownershipChanged = false;
    try {
      if (this.isIdentityClaimedForDeletion(teamName, identityId)) {
        return { status: 'unavailable' };
      }
      const committed = await atomicReplaceFileIfUnchangedAsync(
        configPath,
        JSON.stringify(config, null, 2),
        {
          identity: originalIdentity,
          content: originalRaw,
        }
      );
      if (!committed) {
        ownershipChanged = true;
        throw new Error(`Team identity ownership changed: ${teamName}`);
      }
      if (durable) {
        await syncDirectoryDurably(path.dirname(configPath));
      }
      TeamConfigReader.invalidateTeam(teamName);
      return { status: 'owned', identityId };
    } catch (error) {
      if (!ownershipChanged) {
        if (durable) throw error;
        return { status: 'unavailable' };
      }

      try {
        const currentRaw = await fs.promises.readFile(configPath, 'utf8');
        if (!isValidConfig(currentRaw)) return { status: 'unavailable' };
        const current = JSON.parse(currentRaw) as Record<string, unknown>;
        const currentIdentityId = current._backupIdentityId;
        if (typeof currentIdentityId === 'string' && currentIdentityId) {
          return currentIdentityId === identityId
            ? { status: 'owned', identityId }
            : { status: 'different', identityId: currentIdentityId };
        }
      } catch (readError) {
        if (durable && !isEnoent(readError)) throw readError;
      }
      return { status: 'unavailable' };
    }
  }

  private claimIdentityMarkerSync(teamName: string, identityId: string): IdentityMarkerOwnership {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const originalRaw = fs.readFileSync(configPath, 'utf8');
      if (!isValidConfig(originalRaw)) return { status: 'unavailable' };
      const config = JSON.parse(originalRaw) as Record<string, unknown>;
      const existingIdentityId = config._backupIdentityId;
      if (typeof existingIdentityId === 'string' && existingIdentityId) {
        return existingIdentityId === identityId
          ? { status: 'owned', identityId }
          : { status: 'different', identityId: existingIdentityId };
      }
      if (this.isIdentityClaimedForDeletion(teamName, identityId)) {
        return { status: 'unavailable' };
      }
      config._backupIdentityId = identityId;
      atomicWriteSync(configPath, JSON.stringify(config, null, 2));
      TeamConfigReader.invalidateTeam(teamName);
      return { status: 'owned', identityId };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private requireCurrentPermanentDeletionIntent(
    intent: TeamPermanentDeletionIntent
  ): TeamPermanentDeletionIntent {
    const current = this.permanentDeletionIntents.get(intent.teamName);
    if (
      !current ||
      current.identityId !== intent.identityId ||
      current.transactionId !== intent.transactionId
    ) {
      throw new Error(`Permanent deletion intent changed for ${intent.teamName}`);
    }
    return current;
  }

  private async resolveOrCreatePermanentDeletionIdentity(
    teamName: string,
    draft: boolean,
    deletionOwnerIdentity?: string
  ): Promise<string> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      if (!isValidConfig(raw)) {
        throw new Error(`Team config is not valid: ${teamName}`);
      }
      if (draft) {
        throw new Error(`Cannot delete draft with config.json: ${teamName}`);
      }
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (deletionOwnerIdentity) {
        return deletionOwnerIdentity;
      }
      if (typeof config._backupIdentityId === 'string' && config._backupIdentityId) {
        return config._backupIdentityId;
      }

      const identityId = crypto.randomUUID();
      const ownership = await this.claimIdentityMarker(teamName, identityId, true);
      if (ownership.status === 'unavailable') {
        throw new Error(`Team identity changed while preparing deletion: ${teamName}`);
      }
      return ownership.identityId;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      if (!draft) throw new Error(`Team not found: ${teamName}`);
    }

    const markerPath = this.getDraftDeletionIdentityPath(teamName);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as {
        identityId?: unknown;
      };
      if (typeof parsed.identityId === 'string' && parsed.identityId) {
        return parsed.identityId;
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    const identityId = crypto.randomUUID();
    await atomicWriteAsync(
      markerPath,
      JSON.stringify({ version: 1, teamName, identityId }, null, 2),
      { durability: 'strict', syncDirectory: true }
    );
    return identityId;
  }

  private getPermanentDeletionTargetPath(
    teamName: string,
    target: PermanentDeletionTarget
  ): string {
    switch (target) {
      case 'team-data':
        return path.join(getTeamsBasePath(), teamName);
      case 'task-data':
        return path.join(getTasksBasePath(), teamName);
      case 'message-attachments':
        return path.join(getAppDataPath(), 'attachments', teamName);
      case 'task-attachments':
        return path.join(getAppDataPath(), 'task-attachments', teamName);
    }
  }

  private getPermanentDeletionDetachedTargetPath(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget
  ): string {
    const targetPath = this.getPermanentDeletionTargetPath(intent.teamName, target);
    return path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.permanent-deletion.${intent.transactionId}.${target}`
    );
  }

  private async observePermanentDeletionTarget(
    targetPath: string
  ): Promise<PermanentDeletionTargetObservation> {
    try {
      const stats = await fs.promises.lstat(targetPath);
      return { status: 'present', identity: getDurablePathIdentity(stats) };
    } catch (error) {
      if (isEnoent(error)) return { status: 'absent' };
      throw error;
    }
  }

  private async observePermanentDeletionTargets(
    teamName: string
  ): Promise<Record<PermanentDeletionTarget, PermanentDeletionTargetObservation>> {
    const observations = await Promise.all(
      PERMANENT_DELETION_TARGETS.map((target) =>
        this.observePermanentDeletionTarget(this.getPermanentDeletionTargetPath(teamName, target))
      )
    );
    return Object.fromEntries(
      PERMANENT_DELETION_TARGETS.map((target, index) => [target, observations[index]])
    ) as Record<PermanentDeletionTarget, PermanentDeletionTargetObservation>;
  }

  private async readPermanentDeletionSourceIdentity(
    teamName: string,
    teamPath = path.join(getTeamsBasePath(), teamName)
  ): Promise<PermanentDeletionSourceIdentity> {
    const configPath = path.join(teamPath, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      if (!isValidConfig(raw)) return { status: 'unidentified' };
      const config = JSON.parse(raw) as Record<string, unknown>;
      return typeof config._backupIdentityId === 'string' && config._backupIdentityId
        ? { status: 'identified', identityId: config._backupIdentityId }
        : { status: 'unidentified' };
    } catch (error) {
      if (!isEnoent(error)) return { status: 'unidentified' };
    }

    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(path.join(teamPath, DRAFT_DELETION_IDENTITY_FILE), 'utf8')
      ) as { identityId?: unknown };
      return typeof parsed.identityId === 'string' && parsed.identityId
        ? { status: 'identified', identityId: parsed.identityId }
        : { status: 'unidentified' };
    } catch (error) {
      if (!isEnoent(error)) return { status: 'unidentified' };
    }

    try {
      await fs.promises.stat(teamPath);
      return { status: 'unidentified' };
    } catch (error) {
      return isEnoent(error) ? { status: 'absent' } : { status: 'unidentified' };
    }
  }

  private readPermanentDeletionSourceIdentitySync(
    teamName: string
  ): PermanentDeletionSourceIdentity {
    try {
      const raw = fs.readFileSync(path.join(getTeamsBasePath(), teamName, 'config.json'), 'utf8');
      if (!isValidConfig(raw)) return { status: 'unidentified' };
      const config = JSON.parse(raw) as Record<string, unknown>;
      return typeof config._backupIdentityId === 'string' && config._backupIdentityId
        ? { status: 'identified', identityId: config._backupIdentityId }
        : { status: 'unidentified' };
    } catch (error) {
      if (!isEnoent(error)) return { status: 'unidentified' };
    }

    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.getDraftDeletionIdentityPath(teamName), 'utf8')
      ) as { identityId?: unknown };
      return typeof parsed.identityId === 'string' && parsed.identityId
        ? { status: 'identified', identityId: parsed.identityId }
        : { status: 'unidentified' };
    } catch (error) {
      if (!isEnoent(error)) return { status: 'unidentified' };
    }

    try {
      fs.statSync(path.join(getTeamsBasePath(), teamName));
      return { status: 'unidentified' };
    } catch (error) {
      return isEnoent(error) ? { status: 'absent' } : { status: 'unidentified' };
    }
  }

  private async isPermanentDeletionTargetCurrentInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<boolean> {
    const current = this.requireCurrentPermanentDeletionIntent(intent);
    const expected = current.targets['team-data'];
    const publicPath = this.getPermanentDeletionTargetPath(current.teamName, 'team-data');
    const observed = await this.observePermanentDeletionTarget(publicPath);
    if (current.targetRemovalProofs['team-data']?.state === 'removed') {
      return observed.status === 'absent';
    }
    if (expected.status !== 'present') {
      return false;
    }

    let currentPath: string;
    if (
      observed.status === 'present' &&
      isExactDurablePathIdentity(observed.identity, expected.identity)
    ) {
      currentPath = publicPath;
    } else {
      // A crash can happen after the exact source tree is renamed to its
      // transaction-owned path but before the detached receipt is durable.
      // Resume only that deterministic path and exact prepared identity. Do
      // not scan siblings or infer deletion from a missing public pathname.
      if (current.phase !== 'deleting') return false;
      const detachedPath = this.getPermanentDeletionDetachedTargetPath(current, 'team-data');
      const detached = await this.observePermanentDeletionTarget(detachedPath);
      if (
        detached.status !== 'present' ||
        !isExactDurablePathIdentity(detached.identity, expected.identity)
      ) {
        return false;
      }
      currentPath = detachedPath;
    }

    const source = await this.readPermanentDeletionSourceIdentity(intent.teamName, currentPath);
    return source.status === 'identified' && source.identityId === intent.identityId;
  }

  private async savePermanentDeletionTargetRemovalProof(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget,
    identity: DurablePathIdentity,
    state: PermanentDeletionTargetRemovalProof['state'],
    detachedPath: string
  ): Promise<TeamPermanentDeletionIntent> {
    const current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase === 'deleted') return current;
    if (current.phase !== 'deleting') {
      throw new Error(
        `Permanent deletion has not crossed destructive boundary: ${intent.teamName}`
      );
    }

    const expected = current.targets[target];
    if (expected.status !== 'present' || !isExactDurablePathIdentity(identity, expected.identity)) {
      throw new Error(`Permanent deletion target identity changed: ${target}`);
    }
    const expectedDetachedPath = this.getPermanentDeletionDetachedTargetPath(current, target);
    if (path.resolve(detachedPath) !== path.resolve(expectedDetachedPath)) {
      throw new Error(`Permanent deletion detached target path changed: ${target}`);
    }

    const existing = current.targetRemovalProofs[target];
    if (existing) {
      if (
        existing.transactionId !== current.transactionId ||
        existing.target !== target ||
        !isExactDurablePathIdentity(existing.targetIdentity, expected.identity)
      ) {
        throw new Error(`Permanent deletion target proof changed: ${target}`);
      }
      if (existing.state === 'removed' || state === 'detached') return current;
    } else if (state === 'removed') {
      throw new Error(`Permanent deletion target was not durably detached: ${target}`);
    }

    if (state === 'detached') {
      if (!(await this.isDurablePermanentDeletionTargetCurrent(current, target, detachedPath))) {
        throw new Error(`Permanent deletion detached target is not current: ${target}`);
      }
    } else {
      const [publicObservation, detachedObservation] = await Promise.all([
        this.observePermanentDeletionTarget(
          this.getPermanentDeletionTargetPath(current.teamName, target)
        ),
        this.observePermanentDeletionTarget(detachedPath),
      ]);
      if (
        detachedObservation.status !== 'absent' ||
        (publicObservation.status === 'present' &&
          isExactDurablePathIdentity(publicObservation.identity, expected.identity))
      ) {
        throw new Error(`Permanent deletion exact removal is not durable: ${target}`);
      }
    }

    const timestamp = nowIso();
    const proof: PermanentDeletionTargetRemovalProof = {
      version: 1,
      transactionId: current.transactionId,
      target,
      targetIdentity: expected.identity,
      state,
      detachedAt: existing?.detachedAt ?? timestamp,
      ...(state === 'removed' ? { removedAt: timestamp } : {}),
    };
    const targetRemovalProofs = {
      ...current.targetRemovalProofs,
      [target]: proof,
    };
    const completedTargets = PERMANENT_DELETION_TARGETS.filter(
      (candidate) => targetRemovalProofs[candidate]?.state === 'removed'
    );
    const cleanupCompleted = PERMANENT_DELETION_TARGETS.every(
      (candidate) =>
        current.targets[candidate].status === 'absent' ||
        targetRemovalProofs[candidate]?.state === 'removed'
    );
    const updated: TeamPermanentDeletionIntent = {
      ...current,
      targetRemovalProofs,
      completedTargets,
      cleanupCompleted,
      updatedAt: timestamp,
    };
    await this.savePermanentDeletionIntent(updated);
    this.permanentDeletionIntents.set(updated.teamName, updated);
    return updated;
  }

  private async reconcilePermanentDeletionProgressInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<TeamPermanentDeletionIntent> {
    let current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase !== 'deleting' || current.cleanupCompleted) return current;

    for (const target of PERMANENT_DELETION_TARGETS) {
      const expected = current.targets[target];
      const proof = current.targetRemovalProofs[target];
      if (expected.status !== 'present' || !proof || proof.state !== 'detached') {
        continue;
      }

      const publicObservation = await this.observePermanentDeletionTarget(
        this.getPermanentDeletionTargetPath(current.teamName, target)
      );
      if (
        publicObservation.status === 'present' &&
        isExactDurablePathIdentity(publicObservation.identity, expected.identity)
      ) {
        continue;
      }

      const detachedObservation = await this.observePermanentDeletionTarget(
        this.getPermanentDeletionDetachedTargetPath(current, target)
      );
      if (detachedObservation.status === 'present') {
        if (!isExactDurablePathIdentity(detachedObservation.identity, expected.identity)) {
          throw new Error(`Permanent deletion detached target identity changed: ${target}`);
        }
        continue;
      }

      current = await this.savePermanentDeletionTargetRemovalProof(
        current,
        target,
        expected.identity,
        'removed',
        this.getPermanentDeletionDetachedTargetPath(current, target)
      );
    }
    return current;
  }

  private async isDurablePermanentDeletionTargetCurrent(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget,
    detachedPath?: string
  ): Promise<boolean> {
    let persisted: TeamPermanentDeletionIntent;
    try {
      const raw = await fs.promises.readFile(
        this.getPermanentDeletionIntentPath(intent.teamName),
        'utf8'
      );
      const parsed = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (
        !parsed ||
        parsed.teamName !== intent.teamName ||
        parsed.identityId !== intent.identityId ||
        parsed.transactionId !== intent.transactionId ||
        parsed.phase !== 'deleting'
      ) {
        return false;
      }
      persisted = parsed;
    } catch {
      return false;
    }

    const expectedTarget = persisted.targets[target];
    if (expectedTarget.status !== 'present') return false;
    const observedTarget = await this.observePermanentDeletionTarget(
      detachedPath ?? this.getPermanentDeletionTargetPath(intent.teamName, target)
    );
    if (
      observedTarget.status !== 'present' ||
      !isExactDurablePathIdentity(observedTarget.identity, expectedTarget.identity)
    ) {
      return false;
    }

    if (target !== 'team-data') return true;
    const source = await this.readPermanentDeletionSourceIdentity(
      intent.teamName,
      detachedPath ?? this.getPermanentDeletionTargetPath(intent.teamName, target)
    );
    return source.status === 'identified' && source.identityId === intent.identityId;
  }

  private async isPermanentDeletionFenced(
    teamName: string,
    knownIdentityId?: string
  ): Promise<boolean> {
    await this.reloadPermanentDeletionIntent(teamName);
    if (this.corruptPermanentDeletionFences.has(teamName)) return true;
    const intent = this.permanentDeletionIntents.get(teamName);
    if (!intent || (intent.phase !== 'deleting' && intent.phase !== 'deleted')) return false;
    const expectedTarget = intent.targets['team-data'];
    const observedTarget = await this.observePermanentDeletionTarget(
      this.getPermanentDeletionTargetPath(teamName, 'team-data')
    );
    if (observedTarget.status === 'present') {
      if (
        expectedTarget.status !== 'present' ||
        !isExactDurablePathIdentity(observedTarget.identity, expectedTarget.identity)
      ) {
        return false;
      }
      const source = await this.readPermanentDeletionSourceIdentity(teamName);
      return source.status !== 'identified' || source.identityId === intent.identityId;
    }
    const source = await this.readPermanentDeletionSourceIdentity(teamName);
    if (source.status === 'identified') return source.identityId === intent.identityId;
    if (source.status === 'absent') {
      return knownIdentityId === undefined || knownIdentityId === intent.identityId;
    }
    return intent.phase === 'deleting';
  }

  private async assertBackupPublicationCurrent(
    teamName: string,
    identityId: string
  ): Promise<void> {
    if (this.isShuttingDown || (await this.isPermanentDeletionFenced(teamName, identityId))) {
      throw new BackupPublicationFencedError(
        `Backup publication fenced by permanent deletion: ${teamName}`
      );
    }
    const source = await this.readPermanentDeletionSourceIdentity(teamName);
    if (source.status !== 'identified' || source.identityId !== identityId) {
      throw new BackupPublicationFencedError(`Backup identity ownership changed: ${teamName}`);
    }
  }

  private isPermanentDeletionFencedSync(teamName: string, knownIdentityId?: string): boolean {
    try {
      const raw = fs.readFileSync(this.getPermanentDeletionIntentPath(teamName), 'utf8');
      const intent = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (!intent || intent.teamName !== teamName) {
        throw new Error('invalid permanent deletion intent');
      }
      this.permanentDeletionIntents.set(teamName, intent);
      this.corruptPermanentDeletionFences.delete(teamName);
    } catch (error) {
      if (isEnoent(error)) {
        this.permanentDeletionIntents.delete(teamName);
        this.corruptPermanentDeletionFences.delete(teamName);
      } else {
        this.permanentDeletionIntents.delete(teamName);
        this.corruptPermanentDeletionFences.add(teamName);
      }
    }
    if (this.corruptPermanentDeletionFences.has(teamName)) return true;
    const intent = this.permanentDeletionIntents.get(teamName);
    if (!intent || (intent.phase !== 'deleting' && intent.phase !== 'deleted')) return false;
    const expectedTarget = intent.targets['team-data'];
    try {
      const observedIdentity = getDurablePathIdentity(
        fs.lstatSync(this.getPermanentDeletionTargetPath(teamName, 'team-data'))
      );
      if (
        expectedTarget.status !== 'present' ||
        !isExactDurablePathIdentity(observedIdentity, expectedTarget.identity)
      ) {
        return false;
      }
      const source = this.readPermanentDeletionSourceIdentitySync(teamName);
      return source.status !== 'identified' || source.identityId === intent.identityId;
    } catch (error) {
      if (!isEnoent(error)) return true;
    }
    const source = this.readPermanentDeletionSourceIdentitySync(teamName);
    if (source.status === 'identified') return source.identityId === intent.identityId;
    if (source.status === 'absent') {
      return knownIdentityId === undefined || knownIdentityId === intent.identityId;
    }
    return intent.phase === 'deleting';
  }

  private async completePermanentDeletionInternal(
    intent: TeamPermanentDeletionIntent
  ): Promise<void> {
    let current = this.requireCurrentPermanentDeletionIntent(intent);
    if (current.phase !== 'deleting' && current.phase !== 'deleted') {
      throw new Error(
        `Permanent deletion has not crossed destructive boundary: ${intent.teamName}`
      );
    }
    if (current.phase === 'deleting' && !current.cleanupCompleted) {
      current = await this.reconcilePermanentDeletionProgressInternal(current);
    }
    if (!current.cleanupCompleted) {
      throw new Error(`Permanent deletion cleanup is incomplete: ${intent.teamName}`);
    }
    const deletedAt = nowIso();
    const manifest = await this.loadManifest(intent.teamName);
    if (manifest?.identityId === intent.identityId) {
      manifest.status = 'deleted_by_user';
      manifest.deletedByUserAt = deletedAt;
      await this.saveManifest(intent.teamName, manifest, true);
    }

    const registryEntry = this.registry.teams[intent.teamName];
    if (!registryEntry || registryEntry.identityId === intent.identityId) {
      const deletedEntry: BackupRegistryEntry = {
        teamName: intent.teamName,
        identityId: intent.identityId,
        status: 'deleted_by_user',
        deletedByUserAt: deletedAt,
        lastBackupAt: registryEntry?.lastBackupAt ?? intent.requestedAt,
      };
      await this.saveRegistryEntry(intent.teamName, deletedEntry, true);
    }

    const tombstone: TeamPermanentDeletionIntent = {
      ...current,
      phase: 'deleted',
      updatedAt: deletedAt,
    };
    await this.savePermanentDeletionIntent(tombstone);
    this.permanentDeletionIntents.set(intent.teamName, tombstone);
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
    if (await this.isPermanentDeletionFenced(teamName)) return;

    const { files: sourceFiles, hasErrors } = await this.enumerateTeamFilesWithErrors(teamName);
    if (sourceFiles.length === 0) return;

    const backupDir = this.getBackupDir(teamName);
    let manifest = await this.loadManifest(teamName);
    // Reset stale manifest from a previously deleted team with the same name.
    // The backup dir may already contain the new team's files (copied by FileWatcher),
    // but the manifest was never updated because the deletion guard blocked it.
    if (
      manifest?.status === 'deleted_by_user' ||
      (manifest && this.isReplacementForPendingDeletion(teamName, manifest.identityId))
    ) {
      manifest = null;
    }
    let isNew = !manifest;

    if (!manifest) {
      const ownership = await this.ensureIdentityMarker(teamName, crypto.randomUUID());
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
      const ownership = await this.ensureIdentityMarker(teamName, manifest.identityId);
      if (ownership.status === 'unavailable') return;
      if (ownership.status === 'different') {
        if (this.isIdentityClaimedForDeletion(teamName, manifest.identityId)) return;
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
      this.assertBackupPublicationCurrent(teamName, manifest.identityId);

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
    if (this.isPermanentDeletionFencedSync(teamName)) return;
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
      (manifest && this.isReplacementForPendingDeletion(teamName, manifest.identityId))
    ) {
      manifest = null;
    }

    if (!manifest) {
      const ownership = this.claimIdentityMarkerSync(teamName, crypto.randomUUID());
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
      const ownership = this.claimIdentityMarkerSync(teamName, manifest.identityId);
      if (ownership.status === 'unavailable') return;
      if (ownership.status === 'different') {
        if (this.isIdentityClaimedForDeletion(teamName, manifest.identityId)) return;
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

  private ensureIdentityMarker(
    teamName: string,
    identityId: string
  ): Promise<IdentityMarkerOwnership> {
    return this.claimIdentityMarker(teamName, identityId, false);
  }

  private isReplacementForPendingDeletion(teamName: string, manifestIdentityId: string): boolean {
    const intent = this.permanentDeletionIntents.get(teamName);
    return (
      (intent?.phase === 'deleting' || intent?.phase === 'deleted') &&
      intent.identityId === manifestIdentityId
    );
  }

  // ── Internal: restore ────────────────────────────────────────────────

  private async restoreTeam(teamName: string): Promise<boolean> {
    const manifest = await this.loadManifest(teamName);
    if (!manifest) return false;

    const backupConfigPath = path.join(this.getBackupDir(teamName), 'config.json');
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
    const backupDir = this.getBackupDir(teamName);
    const backupFiles = await this.enumerateBackupFiles(teamName);
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
    for (const relPath of backupFiles) {
      if (relPath === 'config.json' || relPath === 'manifest.json') continue;
      try {
        const src = path.join(backupDir, relPath);
        const dest = this.getSourcePathForRelPath(teamName, relPath);
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
    const backupDir = this.getBackupDir(teamName);
    const backupFiles = await this.enumerateBackupFiles(teamName);
    let count = 0;

    for (const relPath of backupFiles) {
      if (relPath === 'manifest.json') continue;
      const dest = this.getSourcePathForRelPath(teamName, relPath);

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

  private async saveRegistry(strict = false): Promise<void> {
    if (this.isShuttingDown) return;
    await this.withPermanentDeletionLock('backup-registry', () =>
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
    await this.withPermanentDeletionLock('backup-registry', async () => {
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
        if (this.isPermanentDeletionFencedSync(dirEntry.name, entry.identityId)) continue;
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
      const backupIdentity = (await this.loadManifest(teamName))?.identityId ?? entry.identityId;
      if (await this.isPermanentDeletionFenced(teamName, backupIdentity)) continue;

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
        if (await this.isPermanentDeletionFenced(entry.name, registryEntry?.identityId)) {
          continue;
        }
        if (registryEntry?.status === 'deleted_by_user') {
          // A valid config on disk means a new team was created with the same name.
          // Identity-specific deletion fences were checked above, so a surviving
          // config here belongs to a replacement team.
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
