import type {
  TeamToolApprovalErrorLogPort,
  TeamToolApprovalProjectionPort,
  TeamToolApprovalRendererSlice,
  TeamToolApprovalRendererState,
  TeamToolApprovalRendererStatePort,
  TeamToolApprovalResponseTransportPort,
  TeamToolApprovalSettingsLoadPort,
  TeamToolApprovalSettingsSyncPort,
} from '../ports/TeamToolApprovalRendererPorts';
import type { ToolApprovalSettings } from '@shared/types';

export interface TeamToolApprovalRendererSliceDependencies<
  StoreState extends TeamToolApprovalRendererState,
> {
  log: TeamToolApprovalErrorLogPort;
  persistedSettings: TeamToolApprovalSettingsLoadPort;
  projection: TeamToolApprovalProjectionPort<StoreState>;
  responseTransport: TeamToolApprovalResponseTransportPort;
  settingsSync: TeamToolApprovalSettingsSyncPort;
  state: TeamToolApprovalRendererStatePort<StoreState>;
}

type TeamToolApprovalSettingsSelectionDependencies<
  StoreState extends TeamToolApprovalRendererState,
> = Pick<
  TeamToolApprovalRendererSliceDependencies<StoreState>,
  'persistedSettings' | 'projection' | 'settingsSync' | 'state'
>;

export function loadTeamToolApprovalSettingsIntoRenderer<
  StoreState extends TeamToolApprovalRendererState,
>(
  dependencies: TeamToolApprovalSettingsSelectionDependencies<StoreState>,
  teamName: string
): ToolApprovalSettings {
  const settings = dependencies.persistedSettings.loadForTeam(teamName);
  dependencies.state.setState((state) =>
    dependencies.projection.project(state, teamName, settings, true)
  );
  dependencies.settingsSync.schedule(teamName, settings);
  return settings;
}

export function createTeamToolApprovalRendererSlice<
  StoreState extends TeamToolApprovalRendererState,
>(
  dependencies: TeamToolApprovalRendererSliceDependencies<StoreState>
): TeamToolApprovalRendererSlice {
  return {
    pendingApprovals: [],
    resolvedApprovals: new Map(),
    toolApprovalSettingsByTeam: dependencies.persistedSettings.loadAll(),
    toolApprovalSettings: dependencies.persistedSettings.loadLegacy(),

    updateToolApprovalSettings: async (patch, forTeam) => {
      const teamName = forTeam ?? dependencies.state.getState().selectedTeamName;
      const stateBeforeUpdate = dependencies.state.getState();
      const current = teamName
        ? (stateBeforeUpdate.toolApprovalSettingsByTeam[teamName] ??
          dependencies.persistedSettings.loadForTeam(teamName))
        : stateBeforeUpdate.toolApprovalSettings;
      const merged = { ...current, ...patch };

      dependencies.state.setState((latestState) =>
        teamName
          ? dependencies.projection.project(latestState, teamName, merged)
          : { toolApprovalSettings: merged }
      );
      dependencies.settingsSync.persistAndSchedule(teamName, merged);
    },

    respondToToolApproval: async (teamName, runId, requestId, allow, message) => {
      try {
        await dependencies.responseTransport.respond(teamName, runId, requestId, allow, message);
        dependencies.state.setState((state) => {
          const resolvedApprovals = new Map(state.resolvedApprovals);
          resolvedApprovals.set(requestId, allow);
          return {
            pendingApprovals: state.pendingApprovals.filter(
              (approval) => !(approval.runId === runId && approval.requestId === requestId)
            ),
            resolvedApprovals,
          };
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        dependencies.log.error(
          `respondToToolApproval failed for ${teamName}/${requestId}: ${detail}`
        );
        throw error;
      }
    },
  };
}
