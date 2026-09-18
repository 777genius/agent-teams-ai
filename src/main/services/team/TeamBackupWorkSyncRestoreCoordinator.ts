import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { readBackupManifestStrict } from './teamBackupManifest';
import { isValidConfig } from './TeamBackupRestoreService';
import { TeamConfigReader } from './TeamConfigReader';
import { restoreTeamWorkSyncBackup } from './TeamWorkSyncBackupRestore';
import { TeamWorkSyncRestoreAttemptOwner } from './TeamWorkSyncRestoreAttemptOwner';
import { TeamWorkSyncRestorePending } from './TeamWorkSyncRestorePending';

import type { TeamWorkSyncRestoreAttemptPorts } from './TeamWorkSyncRestoreAttemptOwner';
import type { MemberWorkSyncRestoreParticipant } from '@features/member-work-sync/main';

const logger = createLogger('TeamBackupService');
interface RegistryEntry {
  identityId: string;
  status: 'active' | 'deleted_by_user';
}

type LiveConfigState = 'ready' | 'needs_restore' | 'foreign';
export interface TeamBackupRestoreProgress {
  current: number;
  total: number;
}
const RESTORE_CONCURRENCY = 8;

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await run(items[index]);
      }
    })
  );
}

interface RestorePorts {
  registry(): Record<string, RegistryEntry>;
  getBackupDir(teamName: string): string;
  isShuttingDown(): boolean;
  isReplacementForPendingDeletion(teamName: string, identityId: string): boolean;
  isPermanentDeletionFenced(teamName: string, identityId: string): Promise<boolean>;
  withIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  withTeamMutex(teamName: string, operation: () => Promise<void>): Promise<void>;
  restoreLegacy(teamName: string): Promise<boolean>;
  restoreGeneric(teamName: string): Promise<boolean>;
  restoreGenericHoles(teamName: string): Promise<boolean>;
}

/** Backup-owner orchestration; no feature facade or admission re-entry under locks. */
export class TeamBackupWorkSyncRestoreCoordinator {
  private binding: {
    attempts: TeamWorkSyncRestoreAttemptOwner;
    participant: MemberWorkSyncRestoreParticipant;
    operationGate: TeamWorkSyncRestoreAttemptPorts['operationGate'];
  } | null = null;
  private readonly pending: TeamWorkSyncRestorePending;

  constructor(private readonly ports: RestorePorts) {
    this.pending = new TeamWorkSyncRestorePending({
      getManifestPath: (name) => path.join(ports.getBackupDir(name), 'manifest.json'),
      isShuttingDown: () => ports.isShuttingDown(),
    });
  }

  configure(
    operationGate: TeamWorkSyncRestoreAttemptPorts['operationGate'],
    participant: MemberWorkSyncRestoreParticipant
  ): void {
    if (this.binding) throw new Error('Work-sync restore is already configured');
    this.binding = {
      attempts: new TeamWorkSyncRestoreAttemptOwner({
        operationGate,
        withIdentityFence: (name, operation) => this.ports.withIdentityFence(name, operation),
      }),
      participant,
      operationGate,
    };
  }

  isRestoreActive(teamName: string): boolean {
    return this.binding?.attempts.isActive(teamName) ?? false;
  }

  async runWhileQuiesced<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const gate = this.binding?.operationGate;
    if (!gate) {
      return operation();
    }
    const closure = gate.beginOwnedTeamQuiesce(teamName);
    try {
      await gate.awaitTeamIdle(teamName);
      return await operation();
    } finally {
      closure.release();
    }
  }

  async restoreIfNeeded(
    onProgress?: (progress: TeamBackupRestoreProgress) => void
  ): Promise<string[]> {
    const restored: string[] = [];
    const deferredHoleFill: string[] = [];
    const active = Object.entries(this.ports.registry()).filter(
      ([, entry]) => entry.status === 'active'
    );
    let completed = 0;
    const noteProgress = (): void => {
      completed += 1;
      try {
        onProgress?.({ current: completed, total: active.length });
      } catch (error) {
        logger.warn(`[Backup] restore progress callback failed: ${String(error)}`);
      }
    };
    await runBounded(active, RESTORE_CONCURRENCY, async ([teamName, entry]) => {
      try {
        if (this.binding) {
          if (await this.isFenced(teamName, entry.identityId)) return;
          if (await this.canSkipConfiguredRestore(teamName, entry.identityId)) {
            deferredHoleFill.push(teamName);
            return;
          }
          if (await this.restoreConfigured(teamName, entry.identityId, this.binding))
            restored.push(teamName);
        } else {
          const manifest = await readBackupManifestStrict(
            path.join(this.ports.getBackupDir(teamName), 'manifest.json'),
            teamName
          );
          if (await this.isFenced(teamName, manifest?.identityId ?? entry.identityId)) return;
          if (
            await this.ports.withIdentityFence(teamName, () => this.ports.restoreLegacy(teamName))
          ) {
            restored.push(teamName);
          }
        }
      } catch (error) {
        logger.warn(`[Backup] restore failed for ${teamName}: ${String(error)}`);
      } finally {
        noteProgress();
      }
    });
    void this.flushDeferredGenericHoles(deferredHoleFill);
    return restored;
  }

  private async flushDeferredGenericHoles(names: string[]): Promise<void> {
    if (names.length === 0) return;
    await runBounded(names, RESTORE_CONCURRENCY, async (teamName) => {
      try {
        if (this.ports.isShuttingDown()) return;
        const entry = this.ports.registry()[teamName];
        if (!entry || entry.status !== 'active') return;
        if (await this.isFenced(teamName, entry.identityId)) return;
        await this.ports.withIdentityFence(teamName, () =>
          this.ports.withTeamMutex(teamName, async () => {
            if (this.ports.isShuttingDown()) return;
            if (!(await this.canSkipConfiguredRestore(teamName, entry.identityId))) return;
            await this.ports.restoreGenericHoles(teamName);
          })
        );
      } catch (error) {
        logger.warn(`[Backup] deferred hole-fill failed for ${teamName}: ${String(error)}`);
      }
    });
  }

  private async canSkipConfiguredRestore(teamName: string, identityId: string): Promise<boolean> {
    let live: LiveConfigState;
    try {
      live = await this.inspectLiveConfig(teamName, identityId);
    } catch {
      return false;
    }
    if (live !== 'ready') return false;
    const manifest = await readBackupManifestStrict(
      path.join(this.ports.getBackupDir(teamName), 'manifest.json'),
      teamName
    );
    return !manifest?.workSyncRestorePending;
  }

  private async isFenced(teamName: string, identityId: string): Promise<boolean> {
    return (
      this.ports.isReplacementForPendingDeletion(teamName, identityId) ||
      (await this.ports.isPermanentDeletionFenced(teamName, identityId))
    );
  }

  private async restoreConfigured(
    teamName: string,
    expectedIdentity: string,
    binding: NonNullable<TeamBackupWorkSyncRestoreCoordinator['binding']>
  ): Promise<boolean> {
    let applicable = true;
    let reportInterrupted!: (error: unknown) => void;
    let interruptedReported = false;
    const interrupted = new Promise<never>((_resolve, reject) => {
      reportInterrupted = (error) => {
        interruptedReported = true;
        reject(error);
      };
    });
    const physical = restoreTeamWorkSyncBackup(
      {
        reportInterrupted,
        attempts: binding.attempts,
        pending: this.pending,
        withTeamMutex: (name, operation) => this.ports.withTeamMutex(name, operation),
        prepare: async () => {
          const manifest = await readBackupManifestStrict(
            path.join(this.ports.getBackupDir(teamName), 'manifest.json'),
            teamName
          );
          const entry = this.ports.registry()[teamName];
          if (
            !manifest ||
            manifest.status !== 'active' ||
            entry?.status !== 'active' ||
            manifest.identityId !== expectedIdentity ||
            entry.identityId !== expectedIdentity ||
            (await this.isFenced(teamName, expectedIdentity))
          ) {
            throw new Error('Work-sync restore identity or deletion state changed');
          }
          const backupConfigRaw = await fs.readFile(
            path.join(this.ports.getBackupDir(teamName), 'config.json'),
            'utf8'
          );
          if (
            !isValidConfig(backupConfigRaw) ||
            (JSON.parse(backupConfigRaw) as Record<string, unknown>)._backupIdentityId !==
              expectedIdentity
          ) {
            throw new Error('Work-sync backup config identity mismatch');
          }
          try {
            await fs.lstat(
              path.join(getTeamsBasePath(), teamName, '.permanent-deletion-identity.json')
            );
            throw new Error('Work-sync restore replacement identity marker exists');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          const live = await this.inspectLiveConfig(teamName, expectedIdentity);
          if (live === 'foreign') {
            if (manifest.workSyncRestorePending)
              throw new Error('Stale backup has protected work-sync restore pending');
            applicable = false;
            return { outcome: 'not_applicable' as const };
          }
          if (live === 'ready' && !manifest.workSyncRestorePending) {
            await this.ports.restoreGenericHoles(teamName);
            applicable = false;
            return { outcome: 'not_applicable' as const };
          }
          const participant = await binding.participant.prepare({
            backupTeamsRoot: path.dirname(this.ports.getBackupDir(teamName)),
            teamName,
            incarnation: expectedIdentity,
          });
          return {
            identityId: expectedIdentity,
            restoreGeneric: async () => {
              await this.ports.restoreGeneric(teamName);
              // False can mean no generic files needed restoration, or refused publication.
              await this.verifyPublishedConfig(teamName, expectedIdentity);
            },
            importAndVerify: () => participant.importAndVerify(),
            invalidate: async () => {
              TeamConfigReader.invalidateTeam(teamName);
            },
          };
        },
      },
      teamName
    );
    void physical.catch((error: unknown) => {
      if (interruptedReported)
        logger.warn(`[Backup] restore physical tail retired for ${teamName}: ${String(error)}`);
    });
    // The attempt owner keeps the physical promise and locks; race observes late rejection.
    await Promise.race([physical, interrupted]);
    return applicable;
  }

  private async inspectLiveConfig(teamName: string, identityId: string): Promise<LiveConfigState> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(getTeamsBasePath(), teamName, 'config.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'needs_restore';
      throw error;
    }
    if (!isValidConfig(raw)) return 'needs_restore';
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config._backupIdentityId === identityId) return 'ready';
    if (
      typeof config._backupIdentityId === 'string' &&
      config._backupIdentityId.length > 0 &&
      config._backupIdentityId === config._backupIdentityId.trim()
    ) {
      return 'foreign';
    }
    throw new Error('Work-sync restore source config identity mismatch');
  }

  private async verifyPublishedConfig(teamName: string, identityId: string): Promise<void> {
    const raw = await fs.readFile(path.join(getTeamsBasePath(), teamName, 'config.json'), 'utf8');
    if (!isValidConfig(raw)) {
      throw new Error('Work-sync restore config publication was not verified');
    }
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config._backupIdentityId !== identityId) {
      throw new Error('Work-sync restore source config identity mismatch');
    }
  }
}
