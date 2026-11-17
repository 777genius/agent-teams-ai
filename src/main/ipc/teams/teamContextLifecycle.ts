import { TeamProjectContextRegistry, TeamProjectContextRuntimeResolver } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

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
