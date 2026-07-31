import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicReplaceFileIfUnchangedAsync,
  atomicWriteSync,
  type DurablePathIdentity,
  getDurablePathIdentity,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';
import { getAppDataPath, getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';

import { TeamConfigReader } from '../TeamConfigReader';

import {
  PERMANENT_DELETION_TARGETS,
  type PermanentDeletionTarget,
  type PermanentDeletionTargetObservation,
  type TeamPermanentDeletionIntent,
} from './TeamPermanentDeletionTypes';

const DRAFT_DELETION_IDENTITY_FILE = '.permanent-deletion-identity.json';

type PermanentDeletionSourceIdentity =
  | { status: 'identified'; identityId: string }
  | { status: 'absent' }
  | { status: 'unidentified' };

export type IdentityMarkerOwnership =
  | { status: 'owned'; identityId: string }
  | { status: 'different'; identityId: string }
  | { status: 'unavailable' };

type SourceConfigObservation =
  | {
      status: 'valid';
      raw: string;
      parsed: Record<string, unknown>;
      identity: ReturnType<typeof getDurablePathIdentity>;
    }
  | { status: 'missing' }
  | {
      status: 'corrupted';
      raw: string | null;
      identity: ReturnType<typeof getDurablePathIdentity> | null;
    };

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isValidConfig(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.name === 'string' && parsed.name.trim() !== '';
  } catch {
    return false;
  }
}

export class TeamPermanentDeletionIdentity {
  constructor(
    private readonly isIdentityClaimedForDeletion: (teamName: string, identityId: string) => boolean
  ) {}

  getDraftDeletionIdentityPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, DRAFT_DELETION_IDENTITY_FILE);
  }

  async claimIdentityMarker(
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

  getPermanentDeletionTargetPath(teamName: string, target: PermanentDeletionTarget): string {
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

  getPermanentDeletionDetachedTargetPath(
    intent: TeamPermanentDeletionIntent,
    target: PermanentDeletionTarget
  ): string {
    const targetPath = this.getPermanentDeletionTargetPath(intent.teamName, target);
    return path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.permanent-deletion.${intent.transactionId}.${target}`
    );
  }

  async observePermanentDeletionTarget(
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

  async observePermanentDeletionTargets(
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

  async readPermanentDeletionSourceIdentity(
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

  async isPermanentDeletionSourceGenerationCurrent(
    intent: TeamPermanentDeletionIntent
  ): Promise<boolean> {
    const source = await this.readPermanentDeletionSourceIdentity(intent.teamName);
    return (
      source.status === 'absent' ||
      (source.status === 'identified' && source.identityId === intent.identityId)
    );
  }

  readPermanentDeletionSourceIdentitySync(teamName: string): PermanentDeletionSourceIdentity {
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

  async readSourceConfig(configPath: string): Promise<SourceConfigObservation> {
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

  claimIdentityMarkerSync(teamName: string, identityId: string): IdentityMarkerOwnership {
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
}
