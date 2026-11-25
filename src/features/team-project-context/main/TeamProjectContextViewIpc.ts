import { validateTeamName } from '@main/ipc/guards';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { TEAM_PROJECT_CONTEXT_VIEW_CHANNEL, type TeamProjectContextView } from '../contracts';

import { readTeamProjectContextMode } from './projectContextMode';
import { isProjectCopyLaunching } from './projectCopyLaunches';
import { isStoppedTeamRuntime } from './TeamProjectContextLaunchGate';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { IpcResult, TeamRuntimeState } from '@shared/types';
import type { IpcMain } from 'electron';

interface ContextRuntimeReader {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(teamName: string): boolean;
}

async function pendingContext(
  executionTeamName: string,
  projectPath: string,
  runtime?: ContextRuntimeReader
): Promise<Extract<TeamProjectContextView, { state: 'pending' }>> {
  const view = {
    mode: 'per_project' as const,
    state: 'pending' as const,
    projectPath,
    runId: null,
  };
  // Tracking proves work is ongoing; only a validated runtime snapshot identifies its run.
  if (!runtime)
    return { ...view, reason: isProjectCopyLaunching(executionTeamName) ? 'launching' : 'unknown' };
  try {
    const state = await runtime.getRuntimeState(executionTeamName);
    if (
      state.teamName !== executionTeamName ||
      (state.progress &&
        (state.progress.teamName !== executionTeamName ||
          (state.runId !== null && state.progress.runId !== state.runId)))
    )
      return { ...view, reason: 'unknown' };
    const runId = state.runId ?? state.progress?.runId ?? null;
    if (isProjectCopyLaunching(executionTeamName)) return { ...view, runId, reason: 'launching' };
    // A persisted failed bootstrap can retain its historical run ID after restart.
    // Require proof that it stopped and that this app owns no ongoing launch/cleanup.
    const stopped = !runtime.hasProvisioningRun(executionTeamName) && isStoppedTeamRuntime(state);
    return { ...view, runId, reason: stopped ? 'incomplete' : 'unknown' };
  } catch {
    return { ...view, reason: isProjectCopyLaunching(executionTeamName) ? 'launching' : 'unknown' };
  }
}

/** Read-only; no project filesystem or native team is created from navigation. */
async function resolveContextView(
  teamName: unknown,
  projectPath: unknown,
  runtime?: ContextRuntimeReader
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
      const recovery = (await registry.list(checked.value!)).find(
        (row) => row.state === 'reserved'
      );
      return {
        success: true,
        data: {
          mode,
          state: 'needs_project',
          ...(recovery ? { recoveryProjectPath: recovery.projectPath } : {}),
        },
      };
    }
    const entry = await registry.inspect(checked.value!, projectPath);
    if (!entry) return { success: true, data: { mode, state: 'empty' } };
    if (entry.state === 'reserved') {
      return {
        success: true,
        data: await pendingContext(entry.executionTeamName, entry.projectPath, runtime),
      };
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
  runtime?: ContextRuntimeReader
): void {
  ipcMain.handle(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL, (_event, teamName, projectPath) =>
    resolveContextView(teamName, projectPath, runtime)
  );
}

export function unregisterTeamProjectContextViewHandler(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_PROJECT_CONTEXT_VIEW_CHANNEL);
}
