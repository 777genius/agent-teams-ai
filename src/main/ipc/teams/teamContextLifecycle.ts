import { TeamProjectContextRegistry, TeamProjectContextRuntimeResolver } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { IpcResult, TeamSummary } from '@shared/types';

interface LifecycleReader {
  getMeta(teamName: string): Promise<Awaited<ReturnType<TeamMetaStore['getMeta']>>>;
  metadataFileExists(teamName: string): Promise<boolean>;
}

type Registry = Pick<TeamProjectContextRegistry, 'list'>;

function contextReader(
  meta: LifecycleReader,
  registry: TeamProjectContextRegistry
): TeamProjectContextRuntimeResolver {
  return new TeamProjectContextRuntimeResolver(meta, registry);
}

/**
 * Stop only verified owned native contexts. Do not kill unknown/foreign aliases
 * merely because their name resembles an internal identifier.
 */
export async function stopLogicalTeam(
  logicalTeamName: string,
  stopNative: (teamName: string) => Promise<IpcResult<void>>,
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp()
): Promise<IpcResult<void>> {
  try {
    const mode = await contextReader(meta, registry).getMode(logicalTeamName);
    if (mode === 'shared') return stopNative(logicalTeamName);
    const contexts = await registry.list(logicalTeamName);
    if (contexts.some((row) => row.state !== 'ready')) {
      throw new Error('Project context is still preparing or requires recovery');
    }
    for (const row of contexts) {
      const result = await stopNative(row.executionTeamName);
      if (!result.success) return result;
    }
    return stopNative(logicalTeamName);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Soft-deleting the logical team must first stop each owned project runtime.
 * The existing deletion transaction then marks only the logical definition
 * deleted; project histories are retained for a later restore.
 */
export async function deleteLogicalTeamWithContexts(
  teamName: unknown,
  stopPhysical: (teamName: string) => Promise<IpcResult<void>>,
  deleteLogical: () => Promise<IpcResult<void>>,
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp()
): Promise<IpcResult<void>> {
  if (typeof teamName !== 'string' || !teamName.trim()) return deleteLogical();
  try {
    const mode = await contextReader(meta, registry).getMode(teamName);
    if (mode === 'shared') return deleteLogical();
    const contexts = await registry.list(teamName);
    if (contexts.some((row) => row.state !== 'ready')) {
      throw new Error('Cannot delete a team with an unreconciled project context');
    }
    for (const context of contexts) {
      const stopped = await stopPhysical(context.executionTeamName);
      if (!stopped.success) return stopped;
    }
    return deleteLogical();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface PermanentDeleteRegistry extends Pick<
  TeamProjectContextRegistry,
  'listForPermanentDeletion' | 'forgetPermanentlyDeletedContext'
> {}

export async function permanentlyDeleteLogicalTeam(
  logicalTeamName: unknown,
  ports: {
    stopNative(name: string): Promise<IpcResult<void>>;
    deleteNative(name: string, draft: boolean): Promise<void>;
    deleteLogical(): Promise<IpcResult<void>>;
    meta?: LifecycleReader;
    registry?: PermanentDeleteRegistry;
    isNativePresent?(name: string): Promise<boolean>;
  }
): Promise<IpcResult<void>> {
  if (typeof logicalTeamName !== 'string' || !logicalTeamName.trim()) {
    return ports.deleteLogical();
  }
  const meta = ports.meta ?? new TeamMetaStore();
  const registry = ports.registry ?? TeamProjectContextRegistry.fromCurrentApp();
  try {
    const mode = await contextReader(
      meta, (registry as TeamProjectContextRegistry)
    ).getMode(logicalTeamName);
    if (mode === 'shared') return ports.deleteLogical();

    // The logical team remains present until all physical contexts are fully
    // removed, enabling idempotent retries after an interrupted deletion.
    const rows = await registry.listForPermanentDeletion(logicalTeamName);
    for (const row of rows) {
      const exists = ports.isNativePresent
        ? await ports.isNativePresent(row.executionTeamName)
        : await fs.lstat(path.join(getTeamsBasePath(), row.executionTeamName)).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            }
          );
      if (exists) {
        // Recheck ownership immediately before native stop/backup deletion.
        await registry.listForPermanentDeletion(logicalTeamName);
        const stopped = await ports.stopNative(row.executionTeamName);
        if (!stopped.success) return stopped;
        await ports.deleteNative(row.executionTeamName, row.state === 'reserved');
      }
      const forgotten = await registry.forgetPermanentlyDeletedContext(
        logicalTeamName, row.executionTeamName, row.id
      );
      if (!forgotten) throw new Error('Context mapping changed during permanent deletion');
    }
    return ports.deleteLogical();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** UI-only aggregation: runtime/services still see exact physical team names. */
export async function projectAliveTeamNames(
  physicalAlive: readonly string[],
  visibleTeams: readonly TeamSummary[],
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp()
): Promise<string[]> {
  const projected = new Set(physicalAlive);
  for (const team of visibleTeams) {
    if (await contextReader(meta, registry).getMode(team.teamName) !== 'per_project') continue;
    const entries = await registry.list(team.teamName);
    for (const row of entries) {
      if (row.state !== 'ready') continue;
      if (!projected.delete(row.executionTeamName)) continue;
      projected.add(team.teamName);
    }
  }
  return Array.from(projected);
}
