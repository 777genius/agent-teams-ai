import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { join } from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { TeamConfigReader } from './TeamConfigReader';

import type { TeamMetaStore } from './TeamMetaStore';
import type { TeamConfig } from '@shared/types';

export interface TeamConfigurationMutationStores {
  configReader: TeamConfigReader;
  teamMetaStore: TeamMetaStore;
  invalidate(teamName: string): void;
}
/** Canonical manual and external writes share metadata preservation, without inventing saved requests. */
export async function updateTeamConfiguration(
  teamName: string,
  updates: { name?: string; description?: string; color?: string },
  stores: TeamConfigurationMutationStores
): Promise<TeamConfig | null> {
  const config = await stores.configReader.getConfig(teamName);
  if (!config) throw new Error(`Team not found: ${teamName}`);
  if (config.deletedAt) throw new Error('TEAM_TRASHED: Restore the team before editing');
  const updated = await stores.configReader.updateConfig(teamName, updates);
  const meta = await stores.teamMetaStore.getMeta(teamName);
  if (meta)
    await stores.teamMetaStore.updateMeta(teamName, (current) => {
      if (!current) throw new Error('Saved team configuration disappeared');
      return {
        ...current,
        ...(updates.name !== undefined ? { displayName: updates.name } : {}),
        ...(updates.description !== undefined ? { description: updates.description } : {}),
        ...(updates.color !== undefined ? { color: updates.color } : {}),
      };
    });
  stores.invalidate(teamName);
  return updated;
}
export async function setTeamDeleted(
  teamName: string,
  deleted: boolean,
  stores: TeamConfigurationMutationStores
): Promise<void> {
  const config = await stores.configReader.getConfig(teamName);
  if (config) {
    if (Boolean(config.deletedAt) === deleted) return;
    const next = { ...config };
    if (deleted) next.deletedAt = new Date().toISOString();
    else delete next.deletedAt;
    await atomicWriteAsync(
      join(getTeamsBasePath(), teamName, 'config.json'),
      JSON.stringify(next, null, 2)
    );
    await TeamConfigReader.primeConfig(teamName, next);
  } else {
    await stores.teamMetaStore.updateMeta(teamName, (meta) => {
      if (!meta) throw new Error(`Team not found: ${teamName}`);
      return {
        ...meta,
        deletedAt: deleted ? (meta.deletedAt ?? new Date().toISOString()) : undefined,
      };
    });
    TeamConfigReader.invalidateListTeamsCache();
  }
  stores.invalidate(teamName);
}
