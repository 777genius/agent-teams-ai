import { validateTeamName } from '@main/ipc/guards';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import {
  TEAM_PROJECT_CONTEXT_VIEW_CHANNEL,
  type TeamProjectContextView,
} from '../contracts';

import { registerTeamProjectContextModeHandler, unregisterTeamProjectContextModeHandler } from './TeamProjectContextModeIpc';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';
import { TeamProjectContextRuntimeResolver } from './TeamProjectContextRuntimeResolver';

import type {
  TeamProvisioningRunApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
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
    const resolver = new TeamProjectContextRuntimeResolver(new TeamMetaStore(), registry);
    const mode = await resolver.getMode(checked.value!);
    if (mode === 'shared') {
      const alias = await registry.resolveOwnedExecutionAlias(checked.value!);
      if (alias) {
        // A history-mode change only changes the destination for NEW work.
        // A verified old project task must still open its original physical
        // history, not silently redirect into the new shared workspace.
        const logicalMeta = await new TeamMetaStore().getMeta(alias.logicalTeamName);
        if (logicalMeta?.deletedAt) {
          return { success: false, error: 'TEAM_TRASHED: Restore the team before opening history' };
        }
        const logicalMode = await resolver.getMode(alias.logicalTeamName);
        if (logicalMode === 'shared') {
          if (alias.context.state !== 'ready') {
            return { success: false, error: 'Retained project context is not ready' };
          }
          return {
            success: true,
            data: {
              mode: 'per_project',
              state: 'retained',
              logicalTeamName: alias.logicalTeamName,
              executionTeamName: checked.value!,
              workContextId: alias.context.id,
              projectPath: alias.context.projectPath,
            },
          };
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

export function registerTeamProjectContextViewHandler(
  ipcMain: IpcMain,
  getPorts?: () => {
    data: Pick<TeamDataService, 'runConfigurationOperation'>;
    runtime: Pick<TeamRuntimeApi, 'getRuntimeState'>;
    run: Pick<TeamProvisioningRunApi, 'hasProvisioningRun'>;
  }
): void {
  ipcMain.handle(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL, (_event, teamName, projectPath) =>
    resolveContextView(teamName, projectPath));
  if (getPorts) {
    registerTeamProjectContextModeHandler(ipcMain, {
      withLogicalTeamLock: (name, operation) =>
        getPorts().data.runConfigurationOperation(name, operation),
      getRuntimeState: (name) => getPorts().runtime.getRuntimeState(name),
      hasProvisioningRun: (name) => getPorts().run.hasProvisioningRun(name),
    });
  }
}

export function unregisterTeamProjectContextViewHandler(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL);
  unregisterTeamProjectContextModeHandler(ipcMain);
}
