import {
  DEFINITION_LAUNCH_SETTING_KEYS,
  pickDefinitionLaunchSettings,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { DefinitionLaunchSettingsStore } from '@features/team-project-context/main';

/**
 * The one reader and writer of team-level launch settings in a team's saved
 * metadata, for the logical definition (what a launch records) and for project
 * copies (what the projection refreshes). Fails when the team has no metadata
 * rather than inventing a file with an empty working directory.
 */
export function createLaunchSettingsStore(
  metaStore: Pick<TeamMetaStore, 'getMeta' | 'updateMeta'> = new TeamMetaStore()
): DefinitionLaunchSettingsStore {
  return {
    async read(teamName) {
      const meta = await metaStore.getMeta(teamName);
      if (!meta) throw new Error(`Saved settings of team ${teamName} are missing`);
      return pickDefinitionLaunchSettings(
        Object.fromEntries(DEFINITION_LAUNCH_SETTING_KEYS.map((key) => [key, meta[key]]))
      );
    },
    async save(teamName, settings) {
      await metaStore.updateMeta(teamName, (current) => {
        if (!current) throw new Error(`Saved settings of team ${teamName} are missing`);
        return { ...current, ...settings };
      });
    },
  };
}
