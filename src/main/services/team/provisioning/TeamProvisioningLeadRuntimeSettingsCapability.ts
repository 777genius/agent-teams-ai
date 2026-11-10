import { TeamConfigReader } from '../TeamConfigReader';
import { TeamMetaStore } from '../TeamMetaStore';

import { applyLeadRuntimeSettingsToTeamMeta } from './TeamProvisioningLeadRuntimeRestart';

import type { EffortLevel } from '@shared/types';

type SupportedLeadProviderId = 'anthropic' | 'codex' | 'gemini';

interface LeadRuntimeSettings {
  providerId: SupportedLeadProviderId;
  model: string | null;
  effort: EffortLevel | null;
}

export interface TeamProvisioningLeadRuntimeSettingsCapability {
  isTeamAlive(teamName: string): boolean;
  assessLeadRuntimeRestart(input: {
    teamName: string;
    providerId: SupportedLeadProviderId;
    model: string | null;
    effort: EffortLevel | null;
  }): Promise<
    { outcome: 'ready'; token?: unknown } | { outcome: 'busy' } | { outcome: 'relaunch_required' }
  >;
  restartLeadRuntime(input: {
    teamName: string;
    expectedRunId: string;
    before: LeadRuntimeSettings;
    after: LeadRuntimeSettings;
  }): Promise<void>;
  persistLeadRuntimeSettings(input: {
    teamName: string;
    settings: LeadRuntimeSettings;
  }): Promise<void>;
}

type RuntimeOperations = Omit<
  TeamProvisioningLeadRuntimeSettingsCapability,
  'persistLeadRuntimeSettings'
>;

export function createTeamProvisioningLeadRuntimeSettingsCapability(
  runtime: RuntimeOperations,
  teamMetaStore: TeamMetaStore = new TeamMetaStore()
): TeamProvisioningLeadRuntimeSettingsCapability {
  return {
    ...runtime,
    persistLeadRuntimeSettings: async (input) => {
      await teamMetaStore.updateMeta(input.teamName, (meta) => {
        if (!meta) throw new Error(`Team metadata is unavailable: ${input.teamName}`);
        return applyLeadRuntimeSettingsToTeamMeta(
          meta,
          input.settings,
          meta.launchIdentity ?? null
        );
      });
      try {
        TeamConfigReader.invalidateTeam(input.teamName);
      } catch {
        // Metadata is committed; file watching remains the fallback refresh path.
      }
    },
  };
}
