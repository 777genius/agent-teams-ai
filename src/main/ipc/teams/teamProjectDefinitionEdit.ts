import {
  isConfirmedStoppedTeamRuntime,
  TeamProjectDefinitionEditor,
  TeamProjectLiveEditJournal,
} from '@features/team-project-context/main';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { createLogger } from '@shared/utils/logger';

import { createLaunchSettingsStore } from './teamLaunchSettingsStore';
import { createProjectContextRuntimeParts } from './teamProjectContextCreate';

import type { RuntimeRosterMutationMember } from './runtimeRosterMutationMember';
import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { TeamKind } from '@features/team-project-context/main';
import type { TeamIpcHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamViewSnapshot } from '@shared/types';
import type { IpcResult } from '@shared/types/ipc';
import type { IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:teams:definitionEdit');

/**
 * True for both kinds of copies: the copy of a team with separate history per
 * project (refreshed from its team) and a copy an ordinary team retained from
 * an earlier period (history only).
 */
export const PROJECT_COPY_EDIT_MESSAGE =
  'This is a project copy of a team (its history in one project). Edit that team instead; a project copy is never edited on its own.';

/** A definition write named a project copy. */
export class ProjectCopyEditError extends Error {
  constructor() {
    super(PROJECT_COPY_EDIT_MESSAGE);
    this.name = 'ProjectCopyEditError';
  }
}

/**
 * Saved lead instructions are part of the definition of a team with separate
 * history per project. An ordinary team keeps the prompt of its launch, which
 * its running lead already started from, so the edit dialog never changes it.
 */
export const NATIVE_LEAD_PROMPT_MESSAGE =
  'Lead instructions can be edited here only for teams with separate history per project; an ordinary team takes them from its launch settings';

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
  const { registry, resolver, gate } = createProjectContextRuntimeParts({
    data,
    runtime,
    run,
  });
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
      // The copies refreshed here are confirmed stopped: their lead identity follows too.
      launchSettings: createLaunchSettingsStore(undefined, { followLeadLaunchIdentity: true }),
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

/** Where a definition write goes; a project copy is refused (throws) here. */
export async function classifyDefinitionWrite(
  editor: TeamProjectDefinitionEditor,
  teamName: string
): Promise<'native' | 'logical'> {
  const target = await editor.classify(teamName);
  if (target === 'alias') throw new ProjectCopyEditError();
  return target;
}

/**
 * A write to the definition of a per-project (logical) team: under the
 * logical-team operation lock that launch admission takes, refused unless every
 * project is confirmed stopped, then the stopped project copies are refreshed
 * when the write changed something.
 */
export function runLogicalDefinitionWrite<R>(
  ports: Pick<DefinitionEditPorts, 'data'>,
  editor: TeamProjectDefinitionEditor,
  logicalName: string,
  write: () => Promise<R>,
  changed: (result: R) => boolean
): Promise<R> {
  return ports.data().runConfigurationOperation(logicalName, async () => {
    await editor.assertEditable(logicalName);
    const result = await write();
    if (changed(result)) await refreshProjectCopies(editor, logicalName);
    return result;
  });
}

/**
 * A live edit writes the definition first and then applies the same native operation to its one
 * active copy. The durable marker makes an interrupted or partially failed edit visible: no new
 * edit or launch is admitted until the runtime has stopped, after which launch projection repairs
 * the copy from the authoritative definition.
 */
async function runLogicalLiveDefinitionWrite<R>(
  ports: Pick<DefinitionEditPorts, 'data'>,
  editor: TeamProjectDefinitionEditor,
  journal: Pick<TeamProjectLiveEditJournal, 'hasPending' | 'begin' | 'clear'>,
  logicalName: string,
  write: (target: string) => Promise<IpcResult<R>>
): Promise<IpcResult<R>> {
  return ports.data().runConfigurationOperation(logicalName, async () => {
    const running = await editor.findRunningContextForEdit(logicalName);
    if (await journal.hasPending(logicalName)) {
      await editor.assertEditable(logicalName);
      await journal.clear(logicalName);
    }
    if (!running) {
      const result = await write(logicalName);
      if (result.success) await refreshProjectCopies(editor, logicalName);
      return result;
    }
    // The native roster/stop gate is reentrant for the same operation. Hold it across both
    // writes so an app-mediated stop cannot split the definition and active runtime updates.
    return ports.data().runConfigurationOperation(running.executionTeamName, async () => {
      const current = await editor.findRunningContextForEdit(logicalName);
      if (
        current?.executionTeamName !== running.executionTeamName ||
        current.runId !== running.runId
      ) {
        throw new Error('The project runtime changed while preparing this edit; retry');
      }
      await journal.begin(logicalName);
      try {
        const definition = await write(logicalName);
        if (!definition.success) {
          return {
            success: false,
            error: `${definition.error ?? 'Edit failed'}. Stop the team before retrying so the project copy can be reconciled.`,
          };
        }
        const stillRunning = await editor.findRunningContextForEdit(logicalName);
        if (
          stillRunning?.executionTeamName !== running.executionTeamName ||
          stillRunning.runId !== running.runId
        ) {
          throw new Error('The project runtime changed during the edit');
        }
        const active = await write(running.executionTeamName);
        if (!active.success) {
          return {
            success: false,
            error: `The team definition was saved, but its running project could not be updated (${active.error ?? 'unknown error'}). Stop the team before retrying; its project copy will be reconciled at the next launch.`,
          };
        }
        await journal.clear(logicalName, running.executionTeamName);
        await refreshProjectCopies(editor, logicalName, running.executionTeamName);
        return definition;
      } catch (error) {
        return {
          success: false,
          error: `The edit may be partially applied (${error instanceof Error ? error.message : String(error)}). Stop the team before retrying; its project copy will be reconciled at the next launch.`,
        };
      }
    });
  });
}

/**
 * Route every ordinary team definition writer (name/description/color, add,
 * replace, remove, restore and role of members) by what the team name means:
 * - a per-project (logical) team: hold the launch admission lock, write the
 *   definition and, when one ready project runs, apply the same handler under
 *   its runtime gate; then refresh stopped copies. A durable marker fences
 *   incomplete live edits until the runtime has stopped;
 * - a project copy (alias): refused, the definition lives in the logical team;
 * - anything else: the handler runs exactly as before;
 * - unreadable team metadata: refused (fail closed).
 */
export function createProjectDefinitionEditRouting(
  ports: DefinitionEditPorts,
  createEditor: (ports: DefinitionEditPorts) => TeamProjectDefinitionEditor = buildEditor,
  createJournal: () => Pick<TeamProjectLiveEditJournal, 'hasPending' | 'begin' | 'clear'> = () =>
    new TeamProjectLiveEditJournal()
) {
  /**
   * `refuseNative` lets a handler name the writes that exist only for a
   * per-project definition (it returns the refusal message when an ordinary
   * team is given such a write), so they cannot reach a native team, running
   * or not.
   */
  return function withProjectDefinitionEdit<R>(
    handler: EditHandler<R>,
    refuseNative?: (...rest: unknown[]) => string | null,
    refuseLogical?: (...rest: unknown[]) => string | null
  ): EditHandler<R> {
    return async (event, teamName, ...rest) => {
      const name = validateTeamName(teamName);
      if (!name.valid || !name.value) return handler(event, teamName, ...rest);
      const logicalName = name.value;
      const editor = createEditor(ports);
      let target: Exclude<TeamKind, 'alias'>;
      try {
        target = await classifyDefinitionWrite(editor, logicalName);
      } catch (error) {
        return failure(error);
      }
      const refusal = (target === 'native' ? refuseNative : refuseLogical)?.(...rest) ?? null;
      if (refusal) return { success: false, error: refusal };
      if (target === 'native') return handler(event, teamName, ...rest);
      try {
        return await runLogicalLiveDefinitionWrite(
          ports,
          editor,
          createJournal(),
          logicalName,
          (destination) => handler(event, destination, ...rest)
        );
      } catch (error) {
        return failure(error);
      }
    };
  };
}

/** Best effort: the definition is already saved, and a launch repeats the projection. */
export async function refreshProjectCopies(
  editor: TeamProjectDefinitionEditor,
  logicalName: string,
  excludedAlias?: string
): Promise<void> {
  try {
    const report = excludedAlias
      ? await editor.projectToAliases(logicalName, excludedAlias)
      : await editor.projectToAliases(logicalName);
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

/** Refusal for the update-config call: lead instructions exist only in a per-project definition. */
export function refuseLeadPromptOfNativeTeam(updates: unknown): string | null {
  return updates &&
    typeof updates === 'object' &&
    'prompt' in updates &&
    updates.prompt !== undefined
    ? NATIVE_LEAD_PROMPT_MESSAGE
    : null;
}

/**
 * A settings-originated relaunch persists settings into the team it relaunches.
 * A per-project team keeps them in its definition, which changes only while every
 * project is stopped, so the relaunch of one project must not write them.
 */
export const PROJECT_TEAM_SETTINGS_RELAUNCH_MESSAGE =
  'A team with separate history per project saves member settings in the team itself while every project is stopped; it cannot change them as part of a relaunch.';

/** Refusal for replace-members of a per-project team: a settings-originated relaunch. */
export function refuseSettingsRelaunchOfDefinition(request: unknown): string | null {
  return request &&
    typeof request === 'object' &&
    'memberSettingsRelaunch' in request &&
    request.memberSettingsRelaunch !== undefined
    ? PROJECT_TEAM_SETTINGS_RELAUNCH_MESSAGE
    : null;
}

/** The roster a live roster mutation rolls back to (empty for a per-project definition). */
export async function rosterOf(
  data: Pick<TeamDataService, 'getTeamData'>,
  teamName: string
): Promise<RuntimeRosterMutationMember[]> {
  return (await readRosterForMutation(data, teamName)).members as RuntimeRosterMutationMember[];
}
