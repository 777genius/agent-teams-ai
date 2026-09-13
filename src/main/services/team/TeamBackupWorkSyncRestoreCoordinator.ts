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

  async restoreIfNeeded(): Promise<string[]> {
    const restored: string[] = [];
    for (const [teamName, entry] of Object.entries(this.ports.registry())) {
      if (entry.status !== 'active') continue;
      try {
        if (this.binding) {
          if (await this.restoreConfigured(teamName, entry.identityId, this.binding))
            restored.push(teamName);
        } else {
          const manifest = await readBackupManifestStrict(
            path.join(this.ports.getBackupDir(teamName), 'manifest.json'),
            teamName
          );
          if (await this.isFenced(teamName, manifest?.identityId ?? entry.identityId)) continue;
          if (
            await this.ports.withIdentityFence(teamName, () => this.ports.restoreLegacy(teamName))
          ) {
            restored.push(teamName);
          }
        }
      } catch (error) {
        logger.warn(`[Backup] restore failed for ${teamName}: ${String(error)}`);
      }
    }
    return restored;
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
          const identityMatches = await this.verifyConfigIdentity(
            teamName,
            expectedIdentity,
            false
          );
          if (!identityMatches) {
            if (manifest.workSyncRestorePending)
              throw new Error('Stale backup has protected work-sync restore pending');
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
              await this.verifyConfigIdentity(teamName, expectedIdentity, true);
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

  private async verifyConfigIdentity(
    teamName: string,
    identityId: string,
    required: boolean
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(getTeamsBasePath(), teamName, 'config.json'), 'utf8');
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (!isValidConfig(raw)) {
      if (!required) return true; // Generic restore may repair a corrupt config.
      throw new Error('Work-sync restore config publication was not verified');
    }
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config._backupIdentityId !== identityId) {
      if (
        !required &&
        typeof config._backupIdentityId === 'string' &&
        config._backupIdentityId.length > 0 &&
        config._backupIdentityId === config._backupIdentityId.trim()
      )
        return false;
      throw new Error('Work-sync restore source config identity mismatch');
    }
    return true;
  }
}
