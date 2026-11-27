import {
  isConfirmedStoppedTeamRuntime,
  TeamProjectContextLaunchConflictError,
  TeamProjectLiveEditJournal,
} from '@features/team-project-context/main';
import { TeamManagementError } from '@features/team-prompt-management/main';

import { buildEditor, runLogicalLiveDefinitionWrite } from './ipc/teams/teamProjectDefinitionEdit';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type {
  TeamDefinitionEdit,
  TeamProjectDefinitionPort,
} from '@features/team-prompt-management/main';
import type { ReplaceMembersRequest, TeamRuntimeState } from '@shared/types';

export interface TeamDefinitionNativeEdits {
  preflightMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  updateMetadata(
    teamName: string,
    updates: Extract<TeamDefinitionEdit, { kind: 'metadata' }>['updates']
  ): Promise<void>;
  invalidate(teamName: string): void;
}

/** A live owner must identify this exact ready run; an unknown/stopping owner is never editable. */
function assertNativeEditState(
  teamName: string,
  state: TeamRuntimeState,
  hasProvisioningRun: boolean
): string | null {
  if (
    state.teamName === teamName &&
    state.isAlive &&
    state.runId &&
    state.progress?.state === 'ready' &&
    state.progress.runId === state.runId &&
    state.progress.teamName === state.teamName &&
    !state.progress.retainedSecondaryRuntime
  )
    return state.runId;
  if (state.teamName === teamName && !hasProvisioningRun && isConfirmedStoppedTeamRuntime(state))
    return null;
  throw new TeamManagementError(
    'TEAM_RUNTIME_UNAVAILABLE',
    'The team is starting, stopping, or its current run cannot be confirmed. Check it in the app before editing'
  );
}

function rethrowEditRefusal(error: unknown): never {
  if (error instanceof TeamProjectContextLaunchConflictError) {
    throw new TeamManagementError(
      error.reason === 'launching'
        ? 'TEAM_PROVISIONING'
        : error.reason === 'unreconciled'
          ? 'TEAM_PROJECT_CONTEXT_UNRECONCILED'
          : 'TEAM_ACTIVE',
      error.message
    );
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    if (error.code === 'RESTART_REQUIRED' || error.code === 'TEAM_RUNTIME_CHANGED')
      throw new TeamManagementError(error.code, error.message);
  }
  throw error;
}

/** HTTP/MCP share the desktop logical/runtime gates, preflight and durable partial-write fence. */
export function createTeamDefinitionManagementEdit(
  ports: DefinitionEditPorts,
  native: TeamDefinitionNativeEdits
): NonNullable<TeamProjectDefinitionPort['applyEdit']> {
  const preflight = (name: string, edit: TeamDefinitionEdit) =>
    edit.kind === 'members' ? native.preflightMembers(name, edit.request) : Promise.resolve();
  const applyNative = async (name: string, edit: TeamDefinitionEdit) => {
    if (edit.kind === 'members') await native.replaceMembers(name, edit.request);
    else if (edit.kind === 'metadata') await native.updateMetadata(name, edit.updates);
    else {
      const updated = await ports.data().updateConfig(name, { prompt: edit.prompt });
      if (!updated) throw new Error('The running team configuration disappeared');
      native.invalidate(name);
    }
  };
  return async (teamName, edit, persistDefinition, assertCurrentRevision) => {
    try {
      return await ports.data().runConfigurationOperation(teamName, async () => {
        const editor = buildEditor(ports);
        const kind = await editor.classify(teamName);
        if (kind === 'alias')
          throw new TeamManagementError(
            'PROJECT_COPY_NOT_EDITABLE',
            'Edit the team itself; its project copies are updated from it'
          );
        let live = false;
        if (kind === 'logical') {
          const result = await runLogicalLiveDefinitionWrite(
            ports,
            editor,
            new TeamProjectLiveEditJournal(),
            teamName,
            async (destination) => {
              if (destination === teamName) {
                await assertCurrentRevision();
                await persistDefinition();
              } else {
                await applyNative(destination, edit);
                live = true;
              }
              return { success: true };
            },
            async (destination) => {
              await preflight(destination, edit);
              await assertCurrentRevision();
            }
          );
          if (!result.success)
            throw new TeamManagementError(
              'TEAM_MUTATION_UNCERTAIN',
              result.error ?? 'Read the team before retrying this edit',
              409,
              { state: 'partial' }
            );
        } else {
          const inspect = async () =>
            assertNativeEditState(
              teamName,
              await ports.runtime().getRuntimeState(teamName),
              ports.run().hasProvisioningRun(teamName)
            );
          const runId = await inspect();
          if (runId) {
            await preflight(teamName, edit);
            await assertCurrentRevision();
            if ((await inspect()) !== runId)
              throw new TeamManagementError(
                'TEAM_RUNTIME_CHANGED',
                'The current run changed while preparing this edit; read the team again'
              );
            try {
              await applyNative(teamName, edit);
            } catch (error) {
              throw new TeamManagementError(
                'TEAM_MUTATION_UNCERTAIN',
                error instanceof Error ? error.message : 'Read the team before retrying',
                409,
                { state: 'uncertain' }
              );
            }
            live = true;
          } else {
            await assertCurrentRevision();
            await persistDefinition();
          }
        }
        return edit.kind === 'leadInstructions' ? 'next_launch' : live ? 'live' : 'saved';
      });
    } catch (error) {
      return rethrowEditRefusal(error);
    }
  };
}
