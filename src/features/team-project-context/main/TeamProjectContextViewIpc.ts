import { validateTeamName } from '@main/ipc/guards';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import {
  TEAM_PROJECT_CONTEXT_VIEW_CHANNEL,
  type TeamProjectContextView,
} from '../contracts';

import { readTeamProjectContextMode } from './projectContextMode';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { IpcResult } from '@shared/types';
import type { IpcMain } from 'electron';

/** Read-only; no project filesystem or native team is created from navigation. */
async function resolveContextView(
  teamName: unknown,
  projectPath: unknown
): Promise<IpcResult<TeamProjectContextView>> {
  const checked = validateTeamName(teamName);
  if (!checked.valid) return { success: false, error: checked.error ?? 'Invalid team name' };
  if (
    projectPath !== null &&
    projectPath !== undefined &&
    (typeof projectPath !== 'string' || projectPath.length > 4096)
  ) {
    return { success: false, error: 'Invalid project path' };
  }
  try {
    const registry = TeamProjectContextRegistry.fromCurrentApp();
    const metaStore = new TeamMetaStore();
    const mode = await readTeamProjectContextMode(metaStore, checked.value!);
    if (mode === 'shared') {
      const alias = await registry.resolveOwnedExecutionAlias(checked.value!);
      if (alias) {
        const logicalMeta = await metaStore.getMeta(alias.logicalTeamName);
        if (logicalMeta?.deletedAt) {
          return { success: false, error: 'TEAM_TRASHED: Restore the team before opening history' };
        }
        const logicalMode = await readTeamProjectContextMode(metaStore, alias.logicalTeamName);
        // The mode is fixed when a team is created, so a project alias always
        // belongs to a per-project team. Never redirect into another history.
        if (logicalMode !== 'per_project') {
          return { success: false, error: 'Project history owner is not a per-project team' };
        }
        return {
          success: true,
          data: {
            mode: 'per_project',
            state: 'redirect',
            logicalTeamName: alias.logicalTeamName,
            projectPath: alias.context.projectPath,
          },
        };
      }
      return {
        success: true,
        data: { mode, state: 'ready', executionTeamName: checked.value! },
      };
    }
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      return { success: true, data: { mode, state: 'needs_project' } };
    }
    const entry = await registry.inspect(checked.value!, projectPath);
    if (!entry) return { success: true, data: { mode, state: 'empty' } };
    if (entry.state === 'reserved') {
      return { success: true, data: { mode, state: 'pending' } };
    }
    return {
      success: true,
      data: {
        mode,
        state: 'ready',
        workContextId: entry.id,
        projectPath: entry.projectPath,
        executionTeamName: entry.executionTeamName,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerTeamProjectContextViewHandler(ipcMain: IpcMain): void {
  ipcMain.handle(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL, (_event, teamName, projectPath) =>
    resolveContextView(teamName, projectPath));
}

export function unregisterTeamProjectContextViewHandler(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL);
}
