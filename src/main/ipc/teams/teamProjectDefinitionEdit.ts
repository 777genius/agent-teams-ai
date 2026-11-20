import {
  isConfirmedStoppedTeamRuntime,
  TeamProjectDefinitionEditor,
} from '@features/team-project-context/main';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { createLogger } from '@shared/utils/logger';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
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

function buildEditor(ports: DefinitionEditPorts): TeamProjectDefinitionEditor {
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

/**
 * Route the ordinary team edit handlers (name/description/color, add, replace
 * and remove members) by what the team name means:
 * - a per-project (logical) team: refuse while any project runs, run the
 *   ordinary handler against the logical definition, refresh stopped copies;
 * - a project copy (alias): refused, the definition lives in the logical team;
 * - anything else: the handler runs exactly as before.
 */
export function createProjectDefinitionEditRouting(
  ports: DefinitionEditPorts,
  createEditor: (ports: DefinitionEditPorts) => TeamProjectDefinitionEditor = buildEditor
) {
  return function withProjectDefinitionEdit<R>(handler: EditHandler<R>): EditHandler<R> {
    return async (event, teamName, ...rest) => {
      const name = validateTeamName(teamName);
      if (!name.valid || !name.value) return handler(event, teamName, ...rest);
      const editor = createEditor(ports);
      const target = await editor.classify(name.value);
      if (target === 'native') return handler(event, teamName, ...rest);
      if (target === 'alias') return { success: false, error: PROJECT_COPY_EDIT_MESSAGE };
      try {
        await editor.assertEditable(name.value);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      const result = await handler(event, teamName, ...rest);
      if (result.success) {
        try {
          const report = await editor.projectToAliases(name.value);
          for (const failure of report.failed) {
            logger.warn(
              `Could not refresh project copy ${failure.executionTeamName} of ${name.value}: ${failure.message}`
            );
          }
        } catch (error) {
          logger.warn(`Could not refresh project copies of ${name.value}: ${String(error)}`);
        }
      }
      return result;
    };
  };
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
