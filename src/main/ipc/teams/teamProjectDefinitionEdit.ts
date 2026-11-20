import {
  isConfirmedStoppedTeamRuntime,
  TeamProjectDefinitionEditor,
} from '@features/team-project-context/main';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { createLogger } from '@shared/utils/logger';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';

import type { RuntimeRosterMutationMember } from './runtimeRosterMutationMember';
import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { DefinitionEditTarget } from '@features/team-project-context/main';
import type { TeamIpcHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamViewSnapshot } from '@shared/types';
import type { IpcResult } from '@shared/types/ipc';
import type { IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:teams:definitionEdit');

export const PROJECT_COPY_EDIT_MESSAGE =
  'This is a project copy of a team. Edit the team itself; the copy is refreshed from it.';

type EditHandler<R> = (
  event: IpcMainInvokeEvent,
  teamName: unknown,
  ...rest: unknown[]
) => Promise<IpcResult<R>>;

/** Lazy getters: the services are created after this module is loaded. */
export interface DefinitionEditPorts {
  data: () => ProjectTeamRuntimePorts['data'];
  runtime: () => ProjectTeamRuntimePorts['runtime'];
  run: () => ProjectTeamRuntimePorts['run'];
}

export function buildEditor(ports: DefinitionEditPorts): TeamProjectDefinitionEditor {
  const data = ports.data();
  const runtime = ports.runtime();
  const run = ports.run();
  const { registry, resolver, gate } = createProjectContextRuntimeParts({ data, runtime, run });
  return new TeamProjectDefinitionEditor(
    registry,
    gate,
    {
      getMode: (teamName) => resolver.getMode(teamName),
      getSavedRequest: (teamName) => data.getSavedRequest(teamName),
      replaceMembers: (teamName, request) => data.replaceMembers(teamName, request),
      updateDisplayMetadata: async (teamName, update) => {
        await data.updateConfig(teamName, update);
      },
    },
    async (executionTeamName) => {
      if (
        run.hasProvisioningRun(executionTeamName) ||
        !isConfirmedStoppedTeamRuntime(await runtime.getRuntimeState(executionTeamName))
      ) {
        throw new Error('Stop this project runtime before applying team changes');
      }
    }
  );
}

function failure(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Route every ordinary team definition writer (name/description/color, add,
 * replace, remove, restore and role of members) by what the team name means:
 * - a per-project (logical) team: under the same logical-team operation lock
 *   that launch admission takes, refuse while any project runs, run the
 *   ordinary handler against the logical definition and refresh stopped
 *   copies, so a context cannot start between the check and the write;
 * - a project copy (alias): refused, the definition lives in the logical team;
 * - anything else: the handler runs exactly as before;
 * - unreadable team metadata: refused (fail closed).
 */
export function createProjectDefinitionEditRouting(
  ports: DefinitionEditPorts,
  createEditor: (ports: DefinitionEditPorts) => TeamProjectDefinitionEditor = buildEditor
) {
  return function withProjectDefinitionEdit<R>(handler: EditHandler<R>): EditHandler<R> {
    return async (event, teamName, ...rest) => {
      const name = validateTeamName(teamName);
      if (!name.valid || !name.value) return handler(event, teamName, ...rest);
      const logicalName = name.value;
      const editor = createEditor(ports);
      let target: DefinitionEditTarget;
      try {
        target = await editor.classify(logicalName);
      } catch (error) {
        return failure(error);
      }
      if (target === 'native') return handler(event, teamName, ...rest);
      if (target === 'alias') return { success: false, error: PROJECT_COPY_EDIT_MESSAGE };
      try {
        return await ports.data().runConfigurationOperation(logicalName, async () => {
          await editor.assertEditable(logicalName);
          const result = await handler(event, teamName, ...rest);
          if (result.success) await refreshProjectCopies(editor, logicalName);
          return result;
        });
      } catch (error) {
        return failure(error);
      }
    };
  };
}

/** Best effort: the definition is already saved, and a launch repeats the projection. */
export async function refreshProjectCopies(
  editor: TeamProjectDefinitionEditor,
  logicalName: string
): Promise<void> {
  try {
    const report = await editor.projectToAliases(logicalName);
    for (const failed of report.failed) {
      logger.warn(
        `Could not refresh project copy ${failed.executionTeamName} of ${logicalName}: ${failed.message}`
      );
    }
  } catch (error) {
    logger.warn(`Could not refresh project copies of ${logicalName}: ${String(error)}`);
  }
}

/**
 * Roster mutations read the previous roster from the team snapshot to roll
 * back a live change. A per-project team definition has no config.json and no
 * runtime, so there is nothing live to roll back to.
 */
export async function readRosterForMutation(
  data: Pick<TeamDataService, 'getTeamData'>,
  teamName: string
): Promise<Pick<TeamViewSnapshot, 'members'>> {
  try {
    return await data.getTeamData(teamName);
  } catch (error) {
    const missing = error instanceof Error && error.message === `Team not found: ${teamName}`;
    const meta = missing ? await new TeamMetaStore().getMeta(teamName) : null;
    if (meta?.projectContextMode === 'per_project') return { members: [] };
    throw error;
  }
}

let bound: { data: ProjectTeamRuntimePorts['data']; apis: TeamIpcHandlerApis } | null = null;

function requireBound(): NonNullable<typeof bound> {
  if (!bound) throw new Error('Team definition editing is not initialized');
  return bound;
}

/** Called once when the team handlers are initialized, with the services they use. */
export function bind(data: ProjectTeamRuntimePorts['data'], apis: TeamIpcHandlerApis): void {
  bound = { data, apis };
}

/** The router of the team handlers, bound to the services given to `bind`. */
export const route = createProjectDefinitionEditRouting({
  data: () => requireBound().data,
  runtime: () => requireBound().apis.runtime,
  run: () => requireBound().apis.provisioningRun,
});

/** The roster a live roster mutation rolls back to (empty for a per-project definition). */
export async function rosterOf(
  data: Pick<TeamDataService, 'getTeamData'>,
  teamName: string
): Promise<RuntimeRosterMutationMember[]> {
  return (await readRosterForMutation(data, teamName)).members as RuntimeRosterMutationMember[];
}
