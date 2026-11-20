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
 * - `project`: one project copy only. cwd and worktree name a place; trust
 *   (skipPermissions) and runtime arguments (extraCliArgs can grant tools or
 *   directories) must never travel from one project to another through the
 *   definition; launchIdentity belongs to one run.
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
  cwd: 'project',
  skipPermissions: 'project',
  worktree: 'project',
  extraCliArgs: 'project',
  launchIdentity: 'project',
  projectContextMode: 'lifecycle',
  runtimeSelectionVersion: 'lifecycle',
  deletedAt: 'lifecycle',
  createdAt: 'lifecycle',
} as const satisfies Record<
  TeamMetaField,
  'launch-definition' | 'display-definition' | 'project' | 'lifecycle'
>;

export type DefinitionLaunchSettingKey = {
  [K in TeamMetaField]: (typeof TEAM_META_FIELD_OWNER)[K] extends 'launch-definition' ? K : never;
}[TeamMetaField];

export const DEFINITION_LAUNCH_SETTING_KEYS = (
  Object.keys(TEAM_META_FIELD_OWNER) as TeamMetaField[]
).filter(
  (key): key is DefinitionLaunchSettingKey => TEAM_META_FIELD_OWNER[key] === 'launch-definition'
);

export type DefinitionLaunchSettings = Partial<Pick<TeamLaunchRequest, DefinitionLaunchSettingKey>>;

/** What a different provider cannot inherit: the native launch resets these on a provider change. */
const PROVIDER_SCOPED_KEYS = [
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'limitContext',
] as const satisfies readonly DefinitionLaunchSettingKey[];

/** Where the launch settings of a team are persisted (the definition and its project copies). */
export interface DefinitionLaunchSettingsStore {
  /** The saved settings of the team, every key present (undefined when unset). */
  read(teamName: string): Promise<DefinitionLaunchSettings>;
  /** Applies exactly these keys; a key set to undefined clears the saved value. */
  save(teamName: string, settings: DefinitionLaunchSettings): Promise<void>;
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
  const picked: Record<string, unknown> = {};
  for (const key of DEFINITION_LAUNCH_SETTING_KEYS) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  if (picked.providerId === undefined) {
    delete picked.providerId;
    delete picked.providerBackendId;
  }
  return picked as DefinitionLaunchSettings;
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
 * What a launch request means for the saved settings. Stated keys win. A
 * provider change drops what belonged to the old provider (model, effort, fast
 * mode, context limit, backend) unless the request states it again, exactly
 * as the native launch does.
 */
export function resolveLaunchSettings(
  request: Readonly<DefinitionLaunchSettings>,
  saved: Readonly<DefinitionLaunchSettings>
): DefinitionLaunchSettings {
  const settings = pickDefinitionLaunchSettings(request);
  if (settings.providerId !== undefined && settings.providerId !== saved.providerId) {
    const reset: Record<string, unknown> = {};
    for (const key of PROVIDER_SCOPED_KEYS) {
      if (!Object.hasOwn(settings, key)) reset[key] = undefined;
    }
    return { ...(reset as DefinitionLaunchSettings), ...settings };
  }
  return settings;
}

export interface RecordedLaunchSettings {
  /** Whether the definition was changed to what the launch stated. */
  recorded: boolean;
  /** The launched copy could not be brought to the same settings (the definition was). */
  copyFailure?: Error;
}

/**
 * What the user chose for a launch becomes the team's saved launch settings,
 * exactly as it does for an ordinary team, so the next launch (from any
 * project) and a schedule start from it. The copy that was launched follows at
 * once: a runtime provider that does not persist its own launch settings
 * would otherwise leave the copy one launch behind its definition. A failure
 * to save the definition throws; one to save the copy is reported in the
 * result, because the definition is already right and a later launch repairs
 * the copy.
 */
export async function recordLaunchSettings(
  store: DefinitionLaunchSettingsStore,
  target: { definition: string; copy: string },
  request: Readonly<DefinitionLaunchSettings>
): Promise<RecordedLaunchSettings> {
  if (Object.keys(pickDefinitionLaunchSettings(request)).length === 0) return { recorded: false };
  const settings = resolveLaunchSettings(request, await store.read(target.definition));
  await store.save(target.definition, settings);
  try {
    await store.save(target.copy, settings);
  } catch (copyFailure) {
    return {
      recorded: true,
      copyFailure: copyFailure instanceof Error ? copyFailure : new Error(String(copyFailure)),
    };
  }
  return { recorded: true };
}
