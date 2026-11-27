import { isDeepStrictEqual } from 'node:util';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamLaunchRequest } from '@shared/types';

type TeamMetaField = Exclude<keyof TeamMetaFile, 'version'>;

/**
 * Who owns each saved field of a team with separate history per project.
 * Exhaustive on purpose: a new field of `team.meta.json` does not compile until
 * somebody decides where it belongs.
 *
 * - `launch-definition`: the team itself; follows it into every project copy
 *   (this module).
 * - `display-definition`: name, description, color and lead instructions of
 *   the team; projected by `projectDefinitionToAlias` with the roster.
 * - `project-launch`: a launch setting that belongs to one project copy. A
 *   worktree names a place inside one project; trust (skipPermissions) and
 *   runtime arguments (extraCliArgs can grant tools or directories) must never
 *   travel from one project to another through the definition. A launch
 *   records what it stated into its copy only (a schedule reads the copy), and
 *   a copy is first created from the whole definition once.
 * - `project`: one project copy only, never stated by a launch request: cwd
 *   names the project, launchIdentity belongs to one run.
 * - `board-definition`: the team itself, but what agents read is the task
 *   board of their project copy, so the review-flow feature copies it into the
 *   board of every copy when it is saved (running ones too, as an ordinary
 *   team's board is written while it runs) and into a copy when it is launched.
 *   It is never written into the metadata of a copy.
 * - `lifecycle`: identity and state of the definition itself.
 */
export const TEAM_META_FIELD_OWNER = {
  providerId: 'launch-definition',
  providerBackendId: 'launch-definition',
  model: 'launch-definition',
  effort: 'launch-definition',
  fastMode: 'launch-definition',
  syncModelsWithLead: 'launch-definition',
  limitContext: 'launch-definition',
  displayName: 'display-definition',
  description: 'display-definition',
  color: 'display-definition',
  prompt: 'display-definition',
  skipPermissions: 'project-launch',
  worktree: 'project-launch',
  extraCliArgs: 'project-launch',
  cwd: 'project',
  launchIdentity: 'project',
  reviewFlowSettings: 'board-definition',
  projectContextMode: 'lifecycle',
  runtimeSelectionVersion: 'lifecycle',
  deletedAt: 'lifecycle',
  createdAt: 'lifecycle',
} as const satisfies Record<
  TeamMetaField,
  | 'launch-definition'
  | 'display-definition'
  | 'project-launch'
  | 'project'
  | 'board-definition'
  | 'lifecycle'
>;

type KeysOwnedBy<Owner extends string> = {
  [K in TeamMetaField]: (typeof TEAM_META_FIELD_OWNER)[K] extends Owner ? K : never;
}[TeamMetaField];

const keysOwnedBy = <K extends TeamMetaField>(owner: string): K[] =>
  (Object.keys(TEAM_META_FIELD_OWNER) as TeamMetaField[]).filter(
    (key): key is K => TEAM_META_FIELD_OWNER[key] === owner
  );

export type DefinitionLaunchSettingKey = KeysOwnedBy<'launch-definition'>;
export type ProjectLaunchSettingKey = KeysOwnedBy<'project-launch'>;

export const DEFINITION_LAUNCH_SETTING_KEYS =
  keysOwnedBy<DefinitionLaunchSettingKey>('launch-definition');
export const PROJECT_LAUNCH_SETTING_KEYS = keysOwnedBy<ProjectLaunchSettingKey>('project-launch');

export type DefinitionLaunchSettings = Partial<Pick<TeamLaunchRequest, DefinitionLaunchSettingKey>>;
export type ProjectLaunchSettings = Partial<Pick<TeamLaunchRequest, ProjectLaunchSettingKey>>;

/** What a different provider cannot inherit: the native launch resets these on a provider change. */
const PROVIDER_SCOPED_KEYS = [
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'limitContext',
] as const satisfies readonly DefinitionLaunchSettingKey[];

/**
 * The native launch reads these two with `??`: an unset value in a request
 * means "keep what is saved", not "back to the default" as for the others.
 */
const KEEP_WHEN_UNSET_KEYS = [
  'syncModelsWithLead',
  'limitContext',
] as const satisfies readonly DefinitionLaunchSettingKey[];

/** The provider the native launch assumes for a team that has none saved. */
const DEFAULT_PROVIDER_ID = 'anthropic';

/** Where the launch settings of a team are persisted (the definition and its project copies). */
export interface DefinitionLaunchSettingsStore {
  /** The saved settings of the team, every key present (undefined when unset). */
  read(teamName: string): Promise<DefinitionLaunchSettings>;
  /** Applies exactly these keys; a key set to undefined clears the saved value. */
  save(teamName: string, settings: DefinitionLaunchSettings & ProjectLaunchSettings): Promise<void>;
}

/** The IPC layer reads a missing, null or empty provider as "not stated". */
const isUnsetProvider = (value: unknown): boolean => value == null || value === '';

function pickKeys<K extends string>(
  keys: readonly K[],
  source: Readonly<Partial<Record<K, unknown>>>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
}

/**
 * The settings a source states. A key counts only when the source has it as
 * its own property, so an omitted key means "keep what is saved" while an
 * explicit undefined means "back to the default" (the contract the native
 * launch already follows). The provider is never cleared: a saved selection
 * without a provider is unreadable, and the backend means nothing without it.
 */
export function pickDefinitionLaunchSettings(
  source: Readonly<DefinitionLaunchSettings>
): DefinitionLaunchSettings {
  const picked = pickKeys(DEFINITION_LAUNCH_SETTING_KEYS, source);
  if (isUnsetProvider(picked.providerId)) {
    delete picked.providerId;
    delete picked.providerBackendId;
  }
  return picked as DefinitionLaunchSettings;
}

/** The project-owned launch settings a source states (same own-key rule). */
export function pickProjectLaunchSettings(
  source: Readonly<ProjectLaunchSettings>
): ProjectLaunchSettings {
  return pickKeys(PROJECT_LAUNCH_SETTING_KEYS, source) as ProjectLaunchSettings;
}

/** The part of the definition's settings that a project copy does not have yet. */
export function changedDefinitionLaunchSettings(
  definition: Readonly<DefinitionLaunchSettings>,
  copy: Readonly<DefinitionLaunchSettings>
): DefinitionLaunchSettings {
  const wanted = pickDefinitionLaunchSettings(definition);
  const changed: Record<string, unknown> = {};
  for (const key of DEFINITION_LAUNCH_SETTING_KEYS) {
    if (Object.hasOwn(wanted, key) && !isDeepStrictEqual(wanted[key], copy[key])) {
      changed[key] = wanted[key];
    }
  }
  return changed as DefinitionLaunchSettings;
}

/**
 * What a launch request means for the saved settings, as the native launch
 * reads it: model, effort, fast mode and backend that are stated win, an
 * explicit undefined clears them; an unset syncModelsWithLead or limitContext
 * keeps the saved value. A provider change drops what belonged to the old
 * provider (model, effort, fast mode, context limit, backend) unless the
 * request states it again; a team with no saved provider counts as anthropic.
 * The native launch also consults the launchIdentity of the launched team to
 * find its previous provider; the definition has none, so its saved provider
 * is the base.
 */
export function resolveLaunchSettings(
  request: Readonly<DefinitionLaunchSettings>,
  saved: Readonly<DefinitionLaunchSettings>
): DefinitionLaunchSettings {
  const settings: Record<string, unknown> = { ...pickDefinitionLaunchSettings(request) };
  for (const key of KEEP_WHEN_UNSET_KEYS) {
    if (settings[key] === undefined) delete settings[key];
  }
  const stated = settings.providerId;
  if (stated !== undefined && stated !== (saved.providerId ?? DEFAULT_PROVIDER_ID)) {
    for (const key of PROVIDER_SCOPED_KEYS) {
      if (!Object.hasOwn(settings, key)) settings[key] = undefined;
    }
  }
  return settings as DefinitionLaunchSettings;
}

export interface RecordedLaunchSettings {
  /** Whether anything the launch stated was saved. */
  recorded: boolean;
  /** The launched copy could not be brought to the same settings (the definition was). */
  copyFailure?: Error;
}

/**
 * What the user chose for a launch is remembered, exactly as for an ordinary
 * team. The team-level settings become the saved settings of the definition
 * (so the next launch from any project and the dialog start from them), and
 * go to the launched copy at once: a runtime provider that does not persist
 * its own launch settings would otherwise leave the copy one launch behind.
 * The project-owned ones (trust, worktree, runtime arguments) go to the
 * launched copy only; a schedule of that project reads them from there. A
 * failure to save the definition throws; one to save the copy is reported in
 * the result, because the definition is already right and a later launch
 * repairs the copy.
 */
export async function recordLaunchSettings(
  store: DefinitionLaunchSettingsStore,
  target: { definition: string; copy: string },
  request: Readonly<DefinitionLaunchSettings & ProjectLaunchSettings>
): Promise<RecordedLaunchSettings> {
  const stated = pickDefinitionLaunchSettings(request);
  const projectSettings = pickProjectLaunchSettings(request);
  if (Object.keys(stated).length === 0 && Object.keys(projectSettings).length === 0) {
    return { recorded: false };
  }
  let teamSettings: DefinitionLaunchSettings = {};
  if (Object.keys(stated).length > 0) {
    teamSettings = resolveLaunchSettings(request, await store.read(target.definition));
    if (Object.keys(teamSettings).length > 0) await store.save(target.definition, teamSettings);
  }
  const copySettings = { ...teamSettings, ...projectSettings };
  if (Object.keys(copySettings).length === 0) return { recorded: false };
  try {
    await store.save(target.copy, copySettings);
  } catch (copyFailure) {
    return {
      recorded: true,
      copyFailure: copyFailure instanceof Error ? copyFailure : new Error(String(copyFailure)),
    };
  }
  return { recorded: true };
}
