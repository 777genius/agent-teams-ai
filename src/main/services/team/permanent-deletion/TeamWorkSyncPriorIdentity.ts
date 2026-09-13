import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getBackupsBasePath } from '@main/utils/pathDecoder';

import { assertSafeTeamName } from './TeamPermanentDeletionTypes';

export type TeamWorkSyncPriorIdentity = 'known' | 'absent' | 'unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.identityId === 'string' &&
    value.identityId.length > 0 &&
    value.identityId.trim() === value.identityId
  );
}

async function readOptional(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Absence must be proven independently of the backup owner's tolerant readers. */
export async function observeTeamWorkSyncPriorIdentity(
  teamName: string,
  owner: {
    isInitialized(): boolean;
    isShuttingDown(): boolean;
    registry(): Record<string, unknown>;
  }
): Promise<TeamWorkSyncPriorIdentity> {
  assertSafeTeamName(teamName);
  if (!owner.isInitialized() || owner.isShuttingDown()) return 'unavailable';
  const registryEntry = owner.registry()[teamName];
  if (registryEntry !== undefined) return hasIdentity(registryEntry) ? 'known' : 'unavailable';
  try {
    const root = getBackupsBasePath();
    const registry = await readOptional(join(root, 'registry.json'));
    if (registry !== undefined) {
      if (!isRecord(registry) || registry.version !== 1 || !isRecord(registry.teams)) {
        return 'unavailable';
      }
      if (Object.hasOwn(registry.teams, teamName)) {
        return hasIdentity(registry.teams[teamName]) ? 'known' : 'unavailable';
      }
    }
    const manifest = await readOptional(join(root, 'teams', teamName, 'manifest.json'));
    if (manifest === undefined) return 'absent';
    return hasIdentity(manifest) ? 'known' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
