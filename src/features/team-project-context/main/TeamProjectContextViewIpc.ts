import { validateTeamName } from '@main/ipc/guards';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import {
  TEAM_PROJECT_CONTEXT_VIEW_CHANNEL,
  type TeamProjectContextView,
} from '../contracts';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';
import { TeamProjectContextRuntimeResolver } from './TeamProjectContextRuntimeResolver';

import type { IpcMain } from 'electron';
import type { IpcResult } from '@shared/types';

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
    const resolver = new TeamProjectContextRuntimeResolver(new TeamMetaStore(), registry);
    const mode = await resolver.getMode(checked.value!);
    if (mode === 'shared') {
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
