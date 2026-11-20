import { isDeepStrictEqual } from 'node:util';

import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

/**
 * The launch settings that belong to the team itself, not to one project:
 * which runtime and model the lead starts with and how it is configured.
 *
 * Deliberately NOT here (they stay with the project copy):
 * - cwd and worktree: they name a place inside one project;
 * - skipPermissions: trust is granted per project and must never travel
 *   from one project to another through the definition;
 * - launchIdentity and createdAt: derived by the runtime for one run;
 * - prompt, roster and display metadata: the definition projection owns them.
 */
export const DEFINITION_LAUNCH_SETTING_KEYS = [
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'syncModelsWithLead',
  'limitContext',
  'extraCliArgs',
] as const satisfies readonly (keyof TeamLaunchRequest & keyof TeamCreateRequest)[];

export type DefinitionLaunchSettingKey = (typeof DEFINITION_LAUNCH_SETTING_KEYS)[number];

export type DefinitionLaunchSettings = Partial<Pick<TeamLaunchRequest, DefinitionLaunchSettingKey>>;

/** Where the launch settings of a team definition are persisted. */
export interface DefinitionLaunchSettingsStore {
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
 * What the user chose for a launch becomes the team's saved launch settings,
 * exactly as it does for an ordinary team, so the next launch (from any
 * project) and a schedule start from it. The copy that was launched follows at
 * once: a runtime provider that does not persist its own launch settings
 * would otherwise leave the copy one launch behind its definition.
 * Returns whether anything was saved.
 */
export async function recordLaunchSettings(
  store: DefinitionLaunchSettingsStore,
  target: { definition: string; copy: string },
  request: Readonly<DefinitionLaunchSettings>
): Promise<boolean> {
  const settings = pickDefinitionLaunchSettings(request);
  if (Object.keys(settings).length === 0) return false;
  await store.save(target.definition, settings);
  await store.save(target.copy, settings);
  return true;
}
