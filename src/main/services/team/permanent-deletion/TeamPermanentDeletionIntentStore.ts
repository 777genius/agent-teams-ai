import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicWriteAsync,
  removePathWithIdentityFenceAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import {
  assertSafeTeamName,
  isExactDurablePathIdentity,
  isPermanentDeletionTargetObservation,
  isPermanentDeletionTargetRemovalProof,
  PERMANENT_DELETION_TARGETS,
  type PermanentDeletionTarget,
  type TeamPermanentDeletionIntent,
} from './TeamPermanentDeletionTypes';

import type { TeamPermanentDeletionLock } from './TeamPermanentDeletionLock';

const logger = createLogger('TeamBackupService');
const PERMANENT_DELETION_INTENTS_DIR = 'permanent-deletion-intents';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class TeamPermanentDeletionIntentStore {
  readonly intents = new Map<string, TeamPermanentDeletionIntent>();
  readonly corruptFences = new Set<string>();

  constructor(private readonly lock: TeamPermanentDeletionLock) {}

  getIntentPath(teamName: string): string {
    assertSafeTeamName(teamName);
    return path.join(this.getPermanentDeletionIntentsDir(), `${encodeURIComponent(teamName)}.json`);
  }

  getPermanentDeletionIntentsDir(): string {
    return path.join(getBackupsBasePath(), PERMANENT_DELETION_INTENTS_DIR);
  }

  private getPermanentDeletionIntentPath(teamName: string): string {
    return this.getIntentPath(teamName);
  }

  parsePermanentDeletionIntent(value: unknown): TeamPermanentDeletionIntent | null {
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
      assertSafeTeamName(candidate.teamName);
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

  async reloadPermanentDeletionIntent(teamName: string): Promise<void> {
    const intentPath = this.getPermanentDeletionIntentPath(teamName);
    try {
      const raw = await fs.promises.readFile(intentPath, 'utf8');
      const intent = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
      if (intent?.teamName !== teamName) {
        throw new Error('invalid permanent deletion intent');
      }
      this.intents.set(teamName, intent);
      this.corruptFences.delete(teamName);
    } catch (error) {
      if (isEnoent(error)) {
        this.intents.delete(teamName);
        this.corruptFences.delete(teamName);
        return;
      }
      this.intents.delete(teamName);
      this.corruptFences.add(teamName);
    }
  }

  async loadPermanentDeletionIntents(): Promise<void> {
    this.intents.clear();
    this.corruptFences.clear();
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
        assertSafeTeamName(teamNameFromFile);
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
        if (intent?.teamName !== teamNameFromFile) {
          throw new Error('invalid permanent deletion intent');
        }
        this.intents.set(intent.teamName, intent);
      } catch (error) {
        this.corruptFences.add(teamNameFromFile);
        logger.warn(
          `[Backup] Corrupt permanent deletion intent fences restore for ${teamNameFromFile}: ${String(error)}`
        );
      }
    }
  }

  async rollbackPreparedPermanentDeletionIntents(): Promise<void> {
    for (const intent of [...this.intents.values()]) {
      if (intent.phase !== 'prepared') continue;
      await this.removePermanentDeletionIntent(intent);
      logger.info(`[Backup] Rolled back prepared permanent deletion for ${intent.teamName}`);
    }
  }

  async savePermanentDeletionIntent(intent: TeamPermanentDeletionIntent): Promise<void> {
    const intentsDir = this.getPermanentDeletionIntentsDir();
    await this.lock.withLock('intent-hierarchy', async () => {
      await this.ensureDirectoryHierarchyDurably(intentsDir);
      await atomicWriteAsync(
        this.getPermanentDeletionIntentPath(intent.teamName),
        JSON.stringify(intent, null, 2),
        { durability: 'strict', syncDirectory: true }
      );
    });
  }

  async removePermanentDeletionIntent(intent: TeamPermanentDeletionIntent): Promise<void> {
    await this.lock.withLock('intent-hierarchy', async () => {
      const intentPath = this.getPermanentDeletionIntentPath(intent.teamName);
      try {
        const raw = await fs.promises.readFile(intentPath, 'utf8');
        const persisted = this.parsePermanentDeletionIntent(JSON.parse(raw) as unknown);
        if (
          persisted?.identityId !== intent.identityId ||
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
      const current = this.intents.get(intent.teamName);
      if (
        current?.identityId === intent.identityId &&
        current.transactionId === intent.transactionId
      ) {
        this.intents.delete(intent.teamName);
      }
    });
  }

  async ensureDirectoryHierarchyDurably(directoryPath: string): Promise<void> {
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
}
