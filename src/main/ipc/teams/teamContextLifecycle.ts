import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { TeamProjectContextRegistry, TeamProjectContextRuntimeResolver } from '@features/team-project-context/main';
import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { IpcResult, TeamSummary } from '@shared/types';

interface LifecycleReader {
  getMeta(teamName: string): Promise<Awaited<ReturnType<TeamMetaStore['getMeta']>>>;
  metadataFileExists(teamName: string): Promise<boolean>;
}

const logger = createLogger('TeamProjectContextLifecycle');

function contextReader(
  meta: LifecycleReader,
  registry: TeamProjectContextRegistry
): TeamProjectContextRuntimeResolver {
  return new TeamProjectContextRuntimeResolver(meta, registry);
}

async function ownedHistoryContexts(
  teamName: string,
  meta: LifecycleReader,
  registry: TeamProjectContextRegistry
): Promise<readonly { executionTeamName: string; state: 'ready' | 'reserved' }[]> {
  const mode = await contextReader(meta, registry).getMode(teamName);
  return mode === 'per_project'
    ? registry.list(teamName)
    : registry.listRetained(teamName);
}


/**
 * The renderer re-probes this after a stop transport error. A logical team
 * may have no native process of its own, so false is authoritative only after
 * checking all owned project runtimes (including retained shared histories).
 * Unknown/pending ownership fails closed rather than reporting "stopped".
 */
export async function isLogicalTeamProcessAlive(
  logicalTeamName: string,
  isNativeAlive: (teamName: string) => boolean | Promise<boolean>,
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp()
): Promise<boolean> {
  if (await isNativeAlive(logicalTeamName)) return true;
  const contexts = await ownedHistoryContexts(logicalTeamName, meta, registry);
  for (const context of contexts) {
    if (context.state !== 'ready') {
      // A reserved alias can already have spawned a native process. Only an
      // owner-verified alias can be probed; lack of liveness is still unknown.
      await registry.assertReservedStopOwnership(logicalTeamName, context.executionTeamName);
      if (await isNativeAlive(context.executionTeamName)) return true;
      throw new Error('Project runtime stop cannot be confirmed while a context is pending');
    }
    if (await isNativeAlive(context.executionTeamName)) return true;
  }
  return false;
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
    const contexts = await ownedHistoryContexts(logicalTeamName, meta, registry);
    if (contexts.length === 0) return stopNative(logicalTeamName);
    for (const row of contexts) {
      if (row.state !== 'ready') {
        // Before native ready, an owned process may already be alive. An
        // unmarked/missing alias cannot be stopped safely.
        await registry.assertReservedStopOwnership(logicalTeamName, row.executionTeamName);
      }
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
  softDeletePhysical: (teamName: string) => Promise<void>,
  deleteLogical: () => Promise<IpcResult<void>>,
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp(),
  hasActiveSchedules: (names: readonly string[]) => Promise<boolean> = (names) =>
    hasTeamSchedules(names, false),
  restore?: {
    physical(name: string): Promise<void>;
    logical(): Promise<IpcResult<void>>;
  }
): Promise<IpcResult<void>> {
  if (typeof teamName !== 'string' || !teamName.trim()) return deleteLogical();
  try {
    const mode = await contextReader(meta, registry).getMode(teamName);
    if (mode === 'shared' && !(await registry.hasRetainedIndex(teamName))) {
      return deleteLogical();
    }
    await registry.beginSoftDelete(teamName);
    let contexts: Awaited<ReturnType<typeof ownedHistoryContexts>>;
    try {
      contexts = await ownedHistoryContexts(teamName, meta, registry);
      if (contexts.some((row) => row.state !== 'ready')) {
        throw new Error('Cannot delete a team with an unreconciled project context');
      }
      if (await hasActiveSchedules([teamName, ...contexts.map((c) => c.executionTeamName)])) {
        throw new Error('Pause active schedules before moving the team to trash');
      }
    } catch (error) {
      await registry.cancelSoftDelete(teamName);
      throw error;
    }
    const attempted: string[] = [];
    let logicalAttempted = false;
    try {
      for (const context of contexts) {
        const stopped = await stopPhysical(context.executionTeamName);
        if (!stopped.success) throw new Error(stopped.error ?? 'Project stop failed');
        // A failed native metadata write might still have taken effect.
        attempted.push(context.executionTeamName);
        await softDeletePhysical(context.executionTeamName);
      }
      logicalAttempted = true;
      const deleted = await deleteLogical();
      if (!deleted.success) throw new Error(deleted.error ?? 'Logical trash failed');
      return deleted;
    } catch (error) {
      const rollbackFailures: string[] = [];
      if (logicalAttempted) {
        try {
          if (!restore) throw new Error('Logical restore is unavailable');
          const result = await restore.logical();
          if (!result.success) throw new Error(result.error ?? 'Logical restore failed');
        } catch (reason) {
          rollbackFailures.push('logical: ' + String(reason));
        }
      }
      for (const alias of attempted.reverse()) {
        try {
          if (!restore) throw new Error('Project restore is unavailable');
          await restore.physical(alias);
        } catch (reason) {
          rollbackFailures.push(alias + ': ' + String(reason));
        }
      }
      if (rollbackFailures.length === 0) {
        try {
          await registry.cancelSoftDelete(teamName);
        } catch (reason) {
          rollbackFailures.push('fence: ' + String(reason));
        }
      }
      return {
        success: false,
        error: String(error) + (rollbackFailures.length
          ? '; rollback incomplete, team remains fenced: ' + rollbackFailures.join(', ')
          : ''),
      };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type PermanentDeleteRegistry = Pick<
  TeamProjectContextRegistry,
  'hasRetainedIndex' | 'beginPermanentDeletion' | 'cancelPermanentDeletion' |
  'listForPermanentDeletion' | 'forgetPermanentlyDeletedContext'
>;

export async function permanentlyDeleteLogicalTeam(
  logicalTeamName: unknown,
  ports: {
    stopNative(name: string): Promise<IpcResult<void>>;
    deleteNative(name: string, draft: boolean): Promise<void>;
    deleteLogical(draft: boolean): Promise<IpcResult<void>>;
    meta?: LifecycleReader;
    registry?: PermanentDeleteRegistry;
    isNativePresent?(name: string): Promise<boolean>;
    hasAnySchedules?(names: readonly string[]): Promise<boolean>;
    isLogicalConfigPresent?(name: string): Promise<boolean>;
  }
): Promise<IpcResult<void>> {
  if (typeof logicalTeamName !== 'string' || !logicalTeamName.trim()) {
    return ports.deleteLogical(false);
  }
  const meta = ports.meta ?? new TeamMetaStore();
  const registry = ports.registry ?? TeamProjectContextRegistry.fromCurrentApp();
  try {
    const mode = await contextReader(
      meta, (registry as TeamProjectContextRegistry)
    ).getMode(logicalTeamName);
    if (mode === 'shared' && !(await registry.hasRetainedIndex(logicalTeamName))) {
      return ports.deleteLogical(false);
    }

    // Serialize reservation against the deletion snapshot. A crash leaves
    // this durable fence in place so retry can resume without a new alias.
    await registry.beginPermanentDeletion(logicalTeamName);
    let rows: Awaited<ReturnType<PermanentDeleteRegistry['listForPermanentDeletion']>>;
    try {
      rows = await registry.listForPermanentDeletion(logicalTeamName);
      const names = [logicalTeamName, ...rows.map((row) => row.executionTeamName)];
      const anySchedules =
        ports.hasAnySchedules ?? ((ids: readonly string[]) => hasTeamSchedules(ids, true));
      if (await anySchedules(names)) {
        throw new Error('Remove team schedules before permanent deletion');
      }
    } catch (error) {
      // No physical deletion has started. Reopen admission if preflight fails.
      await registry.cancelPermanentDeletion(logicalTeamName);
      throw error;
    }
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
        // A reserved row may already contain a complete native config if the
        // process failed before readiness. The native deletion transaction
        // distinguishes draft vs runtime by actual config, not manifest state.
        const configPresent = await fs.lstat(
          path.join(getTeamsBasePath(), row.executionTeamName, 'config.json')
        ).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        );
        await ports.deleteNative(row.executionTeamName, !configPresent);
      }
      const forgotten = await registry.forgetPermanentlyDeletedContext(
        logicalTeamName, row.executionTeamName, row.id
      );
      if (!forgotten) throw new Error('Context mapping changed during permanent deletion');
    }
    const configExists = ports.isLogicalConfigPresent
      ? await ports.isLogicalConfigPresent(logicalTeamName)
      : await fs.lstat(path.join(getTeamsBasePath(), logicalTeamName, 'config.json')).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        );
    return ports.deleteLogical(!configExists);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function hasTeamSchedules(names: readonly string[], includeInactive: boolean): Promise<boolean> {
  const schedules = new JsonScheduleRepository();
  for (const name of names) {
    const rows = await schedules.getSchedulesByTeam(name);
    if (rows.some((row) => includeInactive || row.status === 'active')) return true;
  }
  return false;
}

/** Restore owned native project histories before making the logical team visible. */
export async function restoreLogicalTeamWithContexts(
  teamName: unknown,
  restorePhysical: (teamName: string) => Promise<void>,
  restoreLogical: () => Promise<IpcResult<void>>,
  meta: LifecycleReader = new TeamMetaStore(),
  registry: TeamProjectContextRegistry = TeamProjectContextRegistry.fromCurrentApp()
): Promise<IpcResult<void>> {
  if (typeof teamName !== 'string' || !teamName.trim()) return restoreLogical();
  try {
    const contexts = await ownedHistoryContexts(teamName, meta, registry);
    if (contexts.some((row) => row.state !== 'ready')) {
      throw new Error('Cannot restore a team with an unreconciled project context');
    }
    for (const row of contexts) {
      await restorePhysical(row.executionTeamName);
    }
    const restored = await restoreLogical();
    if (restored.success && await registry.hasRetainedIndex(teamName)) {
      await registry.cancelSoftDelete(teamName);
    }
    return restored;
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
    try {
      if (await contextReader(meta, registry).getMode(team.teamName) !== 'per_project') continue;
      const entries = await registry.list(team.teamName);
      for (const row of entries) {
        if (row.state !== 'ready') continue;
        if (!projected.has(row.executionTeamName)) continue;
        // Keep the exact physical identity for the existing project-scoped
        // Tasks/Messages view and any active-runtime actions. Also expose the
        // logical name for the one visible team row in the teams list.
        projected.add(team.teamName);
      }
    } catch (error) {
      // One unreadable logical team must not suppress healthy teams' alive
      // status. Keep any unverified physical aliases visible as themselves.
      logger.warn('Cannot project team runtime names', { teamName: team.teamName, error });
    }
  }
  return Array.from(projected);
}
