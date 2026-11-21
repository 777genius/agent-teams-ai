import {
  DEFINITION_LAUNCH_SETTING_KEYS,
  pickDefinitionLaunchSettings,
} from '@features/team-project-context/main';
import { applyLeadRuntimeSettingsToLaunchIdentity } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeRestart';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';

import type { DefinitionLaunchSettingsStore } from '@features/team-project-context/main';

/**
 * The one reader and writer of team-level launch settings in a team's saved
 * metadata, for the logical definition (what a launch records) and for project
 * copies (what the projection refreshes). Fails when the team has no metadata
 * rather than inventing a file with an empty working directory.
 */
export function createLaunchSettingsStore(
  metaStore: Pick<TeamMetaStore, 'getMeta' | 'updateMeta'> = new TeamMetaStore(),
  options: {
    /**
     * For a stopped team only (the projection of a definition edit): a saved
     * lead model or effort also goes into the launch identity of its last run,
     * as a stopped ordinary team saves its lead (`applyLeadRuntimeSettingsToTeamMeta`),
     * so the team shows the lead it will start with. A launch replaces the
     * identity anyway, so the launch path leaves it to the runtime.
     */
    followLeadLaunchIdentity?: boolean;
  } = {}
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
        const next = { ...current, ...settings };
        const leadChanged = Object.hasOwn(settings, 'model') || Object.hasOwn(settings, 'effort');
        if (!options.followLeadLaunchIdentity || !leadChanged) return next;
        const launchIdentity = applyLeadRuntimeSettingsToLaunchIdentity(current.launchIdentity, {
          model: next.model ?? null,
          effort: isTeamEffortLevel(next.effort) ? next.effort : null,
        });
        return launchIdentity ? { ...next, launchIdentity } : next;
      });
    },
  };
}
